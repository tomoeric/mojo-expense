import type pg from "pg";
import { db } from "../db.js";
import { queueDecision, decisionsFor } from "../emburse/decisions.js";
import { hasCredential } from "../emburse/credentials.js";
import { nudgeDecisionWorker } from "../emburse/decision-worker.js";
import { applies, evaluate, explain, fires, type Group, type RuleBody, type Subject } from "./engine.js";
import { activeRules, ensureRules, subjects, type Rule } from "./store.js";

/**
 * Running the rules over the expenses, and doing what they say.
 *
 * Flagging is free and reversible, so every rule is evaluated against
 * everything every time. Approving and denying are neither — they reach real
 * Emburse records under a real person's login — so they are fenced in four
 * ways, and all four have to hold:
 *
 *   1. The expense is still in the Emburse inbox. Anything that has left has
 *      been actioned already, by a person or by an earlier run.
 *   2. Nothing is already queued or applied for it. A rule never overrides a
 *      human decision, and never stacks a second one behind its own.
 *   3. The rule's owner has a stored Emburse login. Emburse records an
 *      approval against whoever signed in, so a decision with no owner would
 *      put the wrong name on it — there is no shared fallback account.
 *   4. No more than `MAX_DECISIONS_PER_RUN` in one run, per rule. A rule that
 *      matches far more than expected stops and says so rather than working
 *      its way through the queue.
 *
 * The fourth is the one that matters most. A mistyped condition is not an
 * unlikely event, it is the normal first draft of a rule, and the difference
 * between catching it at 25 expenses and catching it at 400 is whether the
 * morning is spent reversing approvals in Emburse by hand.
 */

export const MAX_DECISIONS_PER_RUN = 25;

export type RunResult = {
  rulesRun: number;
  expenses: number;
  failed: number;
  passed: number;
  approved: number;
  denied: number;
  warnings: string[];
};

const empty = (): RunResult => ({
  rulesRun: 0, expenses: 0, failed: 0, passed: 0, approved: 0, denied: 0, warnings: [],
});

/**
 * Evaluate every enabled rule.
 *
 * `keys` narrows it to the expenses an import just touched; omitted, it is a
 * full re-run, which is what a rule change needs.
 */
export async function runRules(opts: { keys?: string[]; decide?: boolean } = {}): Promise<RunResult> {
  await ensureRules();
  const rules = await activeRules();
  const result = empty();
  if (rules.length === 0) return result;

  const rows = await subjects(db(), opts.keys);
  result.rulesRun = rules.length;
  result.expenses = rows.length;
  if (rows.length === 0) return result;

  // Decisions are opt-in per run so an import can evaluate without deciding —
  // and so the preview on the Rules page can never act by accident.
  const deciding = opts.decide !== false;

  const verdicts: { key: string; ruleId: number; verdict: "pass" | "fail"; detail: string }[] = [];
  /** Offenders (or compliers, for approve) per rule, in the order they were seen. */
  const acting = new Map<number, { subject: Subject; detail: string }[]>();

  for (const rule of rules) {
    const groups = groupsFor(rows, rule);
    for (const subject of rows) {
      const group = groups.get(dayKey(subject));
      const verdict = evaluate(subject, rule, group);
      if (verdict === "not-applicable") continue;

      const detail = verdict === "fail" ? explain(subject, rule, group) : "";
      verdicts.push({ key: subject.dedupeKey, ruleId: rule.id, verdict, detail });
      if (verdict === "fail") result.failed++;
      else result.passed++;

      if (rule.action !== "flag" && fires(verdict, rule.action) && subject.inInbox) {
        const bucket = acting.get(rule.id);
        if (bucket) bucket.push({ subject, detail });
        else acting.set(rule.id, [{ subject, detail }]);
      }
    }
  }

  await writeVerdicts(db(), verdicts);
  await db().query(
    `UPDATE expense_rules SET last_run_at = now() WHERE id = ANY($1::bigint[])`,
    [rules.map((r) => r.id)]);

  if (deciding) {
    for (const rule of rules) {
      const targets = acting.get(rule.id);
      if (!targets || targets.length === 0) continue;
      await decide(rule, targets, result);
    }
    if (result.approved + result.denied > 0) nudgeDecisionWorker();
  }

  return result;
}

/** One person, one day — the unit "three meals in a day" is counted over. */
const dayKey = (s: Subject): string => `${s.employee.trim().toLowerCase()}|${s.date ?? ""}`;

/**
 * How many of the expenses this rule matched fall on the same person's same
 * day, and what they add up to.
 *
 * Computed per rule, from the WHEN only: "three meals in a day" counts the
 * meals, not everything that day. An expense with no date is counted in its
 * own bucket rather than lumped with every other undated one.
 */
function groupsFor(rows: Subject[], rule: RuleBody): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const s of rows) {
    if (!applies(s, rule)) continue;
    const k = dayKey(s);
    const g = out.get(k) ?? { count: 0, totalCents: 0 };
    g.count += 1;
    g.totalCents += s.amountCents;
    out.set(k, g);
  }
  return out;
}

async function writeVerdicts(
  client: Pick<pg.PoolClient, "query">,
  verdicts: { key: string; ruleId: number; verdict: string; detail: string }[],
): Promise<void> {
  if (verdicts.length === 0) return;
  // One statement: a full re-run over a year of expenses is tens of thousands
  // of rows, and a round trip each would take minutes.
  await client.query(
    `INSERT INTO expense_rule_hits (dedupe_key, rule_id, verdict, detail)
     SELECT * FROM unnest($1::text[], $2::bigint[], $3::text[], $4::text[])
     ON CONFLICT (dedupe_key, rule_id) DO UPDATE
       SET verdict = EXCLUDED.verdict,
           detail  = EXCLUDED.detail,
           checked_at = now(),
           -- first_seen is when this rule STARTED failing on this expense, so
           -- a run that finds it still failing must not move it.
           first_seen = CASE WHEN expense_rule_hits.verdict = EXCLUDED.verdict
                             THEN expense_rule_hits.first_seen ELSE now() END`,
    [verdicts.map((v) => v.key), verdicts.map((v) => v.ruleId),
     verdicts.map((v) => v.verdict), verdicts.map((v) => v.detail)],
  );
}

async function decide(
  rule: Rule,
  targets: { subject: Subject; detail: string }[],
  result: RunResult,
): Promise<void> {
  const owner = rule.createdBy ?? "";
  if (!owner || !(await hasCredential(owner))) {
    result.warnings.push(
      `“${rule.name}” would ${rule.action} ${targets.length} expense${targets.length === 1 ? "" : "s"}, ` +
      `but ${owner || "its owner"} has no stored Emburse login. Emburse records a decision against whoever ` +
      `signs in, so it was not applied.`);
    return;
  }

  // Anything a person — or an earlier run — has already decided is left alone.
  const existing = await decisionsFor(targets.map((t) => t.subject.dedupeKey));
  const fresh = targets.filter((t) => !existing.get(t.subject.dedupeKey));
  if (fresh.length === 0) return;

  const capped = fresh.slice(0, MAX_DECISIONS_PER_RUN);
  if (fresh.length > MAX_DECISIONS_PER_RUN) {
    result.warnings.push(
      `“${rule.name}” matched ${fresh.length} undecided expenses, over the ${MAX_DECISIONS_PER_RUN} a rule may ` +
      `${rule.action} in one run. ${MAX_DECISIONS_PER_RUN} were queued; the rest were left for a person. ` +
      `Check the rule is saying what you meant before running it again.`);
  }

  for (const { subject, detail } of capped) {
    const reason = rule.message.trim() || detail || `Rule: ${rule.name}`;
    const queued = await queueDecision({
      dedupeKey: subject.dedupeKey,
      decision: rule.action === "approve" ? "approve" : "deny",
      reason: `${reason} (rule: ${rule.name})`,
      decidedBy: owner,
      target: {
        employee: subject.employee,
        merchant: subject.merchant,
        amount: subject.amountCents / 100,
        date: subject.date,
      },
    });
    if (queued.ok) {
      if (rule.action === "approve") result.approved++;
      else result.denied++;
      await db().query(
        "UPDATE expense_rule_hits SET acted = true WHERE dedupe_key = $1 AND rule_id = $2",
        [subject.dedupeKey, rule.id]);
    } else if (!/already waiting/i.test(queued.error)) {
      result.warnings.push(`“${rule.name}” could not ${rule.action} ${subject.merchant}: ${queued.error}`);
    }
  }
}

/**
 * What a rule would do, without doing any of it.
 *
 * The same evaluation as a real run, decisions and all — but nothing is
 * written and nothing is queued. This is how a rule gets checked before it is
 * switched on, which for an approve or deny rule is the difference between a
 * typo and a morning of undoing.
 */
export async function previewRule(rule: Rule, limit = 50): Promise<{
  matched: number;
  failing: number;
  passing: number;
  wouldAct: number;
  sample: { dedupeKey: string; employee: string; merchant: string; amountCents: number;
            category: string; note: string; verdict: "pass" | "fail"; detail: string; inInbox: boolean }[];
}> {
  await ensureRules();
  const rows = await subjects(db());
  const sample: Awaited<ReturnType<typeof previewRule>>["sample"] = [];
  let failing = 0;
  let passing = 0;
  let wouldAct = 0;

  const groups = groupsFor(rows, rule);
  for (const subject of rows) {
    const group = groups.get(dayKey(subject));
    const verdict = evaluate(subject, rule, group);
    if (verdict === "not-applicable") continue;
    if (verdict === "fail") failing++;
    else passing++;
    if (fires(verdict, rule.action) && (rule.action === "flag" || subject.inInbox)) wouldAct++;
    if (sample.length < limit) {
      sample.push({
        dedupeKey: subject.dedupeKey,
        employee: subject.employee,
        merchant: subject.merchant,
        amountCents: subject.amountCents,
        category: subject.category,
        note: subject.note,
        verdict,
        detail: verdict === "fail" ? explain(subject, rule, group) : "",
        inInbox: subject.inInbox,
      });
    }
  }

  // Failures first: they are what the rule is for, and a preview that opens
  // with fifty passes hides the one line that says the rule is wrong.
  sample.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "fail" ? -1 : 1));
  return { matched: failing + passing, failing, passing, wouldAct, sample };
}
