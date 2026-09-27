/**
 * Approving the expenses no rule had anything to say about.
 *
 * This is the only path in the app that approves somebody's spending with
 * no human in the loop, so almost everything here is a fence.
 *
 * The one that is easy to miss, and the reason this is not simply "flags
 * is empty":
 *
 *   **An expense whose receipt has not been read yet is unflagged because
 *   nothing has been checked, not because everything passed.**
 *
 * A rule about alcohol, or a receipt total, or the business name on the
 * receipt, returns UNKNOWN when there is no reading — which is correct, and
 * means no flag. So the newest expenses, the ones the reader has not
 * reached, look cleanest of all. Auto-approving on that basis would
 * systematically approve exactly the expenses nothing had examined, and it
 * would look like it was working perfectly.
 *
 * So when any enabled rule depends on a receipt, an expense only qualifies
 * once its receipt has actually been read.
 *
 * WHEN it runs turned out to matter as much as what it approves. It ran in
 * two places only — after an import, and at the end of a receipt-reading
 * pass that read something — and both are silent on a settled queue: with
 * every receipt already read the reader returns before it reaches the call,
 * and no import runs until the next schedule. Switching the automation on
 * therefore did nothing observable for hours, which is indistinguishable
 * from a broken feature. Hence the sweep at the bottom of this file, and
 * `autoApproveReport`, which answers "why is nothing moving" now rather
 * than after the next sync.
 */

import { db } from "../db.js";
import { flagOwner, getFlag, getLimit } from "../flags.js";
import { hasCredential } from "../emburse/credentials.js";
import { queueApprovalFor } from "../emburse/decisions.js";
import { nudgeDecisionWorker } from "../emburse/decision-worker.js";
import { activeRules } from "./store.js";
import type { Field } from "./engine.js";

/** Fields that mean nothing until the receipt image has been read. */
const NEEDS_A_READING: ReadonlySet<Field> = new Set<Field>([
  "receiptItems", "receiptTotal", "receiptAlcohol", "receiptReadable",
  "receiptDate", "receiptMerchant",
]);

/** How many to queue in one pass when nobody has said. */
export const DEFAULT_PER_RUN = 10;

/** A hard ceiling regardless of what is typed in. */
export const MOST_PER_RUN = 100;

/**
 * The four tests an expense has to pass, as SQL against an `expenses e`.
 *
 * Written once and shared by the two queries below, because the second one
 * exists to explain the first. A report that classified expenses by
 * slightly different rules than the pass that skips them would be worse
 * than no report — it would confidently name the wrong reason.
 */
const TESTS = {
  /** Nothing any enabled rule caught. */
  flagged: `EXISTS (
          SELECT 1 FROM expense_rule_hits h
            JOIN expense_rules r ON r.id = h.rule_id AND r.enabled
           WHERE h.dedupe_key = e.dedupe_key AND h.verdict = 'fail')`,

  /**
   * Some enabled rule has not run since this expense arrived.
   *
   * NOT "it has a hit row": a rule that does not apply writes no row, so
   * the cleanest expenses have none at all. Without this test a row that
   * landed after the last rule pass would count as unflagged when nothing
   * had yet looked at it.
   */
  awaitingRules: `EXISTS (
          SELECT 1 FROM expense_rules r
           WHERE r.enabled
             AND (r.last_run_at IS NULL OR r.last_run_at < e.first_seen_at))`,

  /** Already decided, queued, or failed and waiting on a person. */
  decided: `EXISTS (
          SELECT 1 FROM expense_decisions d
           WHERE d.dedupe_key = e.dedupe_key AND d.state IN ('pending','applied','failed'))`,

  /**
   * A receipt on this expense has not been read — when that matters.
   *
   * Not "at least one has been read". An expense can carry several images,
   * and a rule about alcohol is answered by whichever one has the bar tab
   * on it. Passing on the strength of one readable receipt while another
   * sat unread would approve the expense on the evidence of the page that
   * happened to be legible.
   *
   * A receipt the reader gave up on stays unread for this purpose,
   * deliberately: three failures is a reason for a person to look, not a
   * reason to wave it through.
   */
  awaitingReceipt: `NOT (
          EXISTS (SELECT 1 FROM expense_receipts er WHERE er.dedupe_key = e.dedupe_key)
          AND NOT EXISTS (
                SELECT 1 FROM expense_receipts er
                 WHERE er.dedupe_key = e.dedupe_key
                   AND NOT EXISTS (
                         SELECT 1 FROM receipt_readings rr
                          WHERE rr.sha256 = er.sha256 AND rr.error IS NULL)))`,
} as const;

export type AutoApproveResult = {
  queued: number;
  /** Why it did nothing, when it did nothing. Shown, not just logged. */
  skipped: string | null;
};

/** What the switch is set to, and whether a run could do anything at all. */
type Setup = {
  on: boolean;
  owner: string | null;
  perRun: number;
  /** How many rules are enabled — zero is itself a refusal. */
  rules: number;
  /** Whether any enabled rule depends on a receipt having been read. */
  receiptMatters: boolean;
  /** Why a run would do nothing, when the reason is the setup itself. */
  blocked: string | null;
};

/**
 * Read the setup and apply the refusals, without touching any expense.
 *
 * Shared by the pass and the report so the page cannot say one thing while
 * the automation does another.
 */
async function setup(): Promise<Setup> {
  const on = await getFlag("autoApprove").catch(() => false);
  const owner = await flagOwner("autoApprove");
  const perRun = Math.min(Math.max(1, (await getLimit("autoApprove")) ?? DEFAULT_PER_RUN), MOST_PER_RUN);
  const rules = await activeRules();
  const receiptMatters = rules.some((r) =>
    [...r.when, ...(r.must ? [r.must] : [])].some(
      (c) => NEEDS_A_READING.has(c.field) || (c.compare && NEEDS_A_READING.has(c.compare)),
    ));

  const blocked = !on
    ? "automatic approvals are switched off"
    : !owner
      ? "nobody owns the automatic approvals, so there is no login to make them under"
      // The same rule as everywhere else: Emburse records an approval against
      // whoever signed in. No credential, no approval — never a shared one.
      : !(await hasCredential(owner))
        ? `${owner} switched automatic approvals on but has no Emburse login stored, so none can be made`
        : rules.length === 0
          // No rules means nothing has been checked at all, and "no flags" is
          // vacuously true of every expense in the queue.
          ? "no rules are enabled, so nothing has actually been checked"
          : null;

  return { on, owner, perRun, rules: rules.length, receiptMatters, blocked };
}

/**
 * Queue approvals for clean expenses, up to the configured number.
 *
 * Returns rather than throws: this runs on the back of an import, and an
 * import must not fail because an optional automation could not run.
 */
export async function autoQueueApprovals(): Promise<AutoApproveResult> {
  const s = await setup();
  // Switched off is not a complaint. The others are: somebody turned this
  // on and it is not doing what they think it is doing.
  if (!s.on) return { queued: 0, skipped: null };
  if (s.blocked) return { queued: 0, skipped: s.blocked };

  const { rows } = await db().query<{ dedupe_key: string }>(
    `SELECT e.dedupe_key
       FROM expenses e
      WHERE e.in_inbox = true
        AND NOT ${TESTS.flagged}
        AND NOT ${TESTS.awaitingRules}
        AND NOT ${TESTS.decided}
        AND ($2::boolean = false OR NOT ${TESTS.awaitingReceipt})
      ORDER BY e.expense_date NULLS LAST, e.dedupe_key
      LIMIT $1`,
    [s.perRun, s.receiptMatters],
  );

  if (rows.length === 0) return { queued: 0, skipped: null };

  let queued = 0;
  for (const r of rows) {
    // Through the same function a person's click uses. A machine does not
    // get a shorter path to somebody else's money than a human does.
    // Marked as the machine's, so the queue can say which approvals nobody
    // looked at. Same function a person's click uses, same checks.
    const result = await queueApprovalFor(r.dedupe_key, s.owner!, { automatic: true });
    if (result.ok) queued++;
  }
  if (queued > 0) {
    console.log(`auto-approve: queued ${queued} unflagged expense(s) as ${s.owner}`);
    nudgeDecisionWorker();
  }
  return { queued, skipped: null };
}

export type AutoApproveReport = {
  on: boolean;
  owner: string | null;
  perRun: number;
  rules: number;
  receiptMatters: boolean;
  blocked: string | null;
  /**
   * Every expense in the queue, in the bucket of the FIRST reason it does
   * not qualify. They sum to `inbox`, which is the point: a total that does
   * not add up is a reason to distrust the whole card.
   */
  counts: {
    inbox: number;
    flagged: number;
    decided: number;
    awaitingRules: number;
    awaitingReceipt: number;
    eligible: number;
  };
};

/**
 * Why nothing is moving.
 *
 * This exists because "On" plus an unchanging queue gives somebody no way
 * to tell a working automation with nothing to do from a broken one. Every
 * count here is a different answer with a different next step: flagged
 * means go look at the flags, awaiting rules means run the rules, awaiting
 * receipt means the reader is behind, eligible with a zero queued means
 * the pass has not run yet.
 */
export async function autoApproveReport(): Promise<AutoApproveReport> {
  const s = await setup();
  const { rows } = await db().query<Record<string, string>>(
    `WITH q AS (
       SELECT ${TESTS.flagged}        AS flagged,
              ${TESTS.decided}        AS decided,
              ${TESTS.awaitingRules}  AS awaiting_rules,
              ($1::boolean AND ${TESTS.awaitingReceipt}) AS awaiting_receipt
         FROM expenses e
        WHERE e.in_inbox = true)
     SELECT count(*)                                              AS inbox,
            count(*) FILTER (WHERE flagged)                       AS flagged,
            count(*) FILTER (WHERE NOT flagged AND decided)       AS decided,
            count(*) FILTER (WHERE NOT flagged AND NOT decided
                                   AND awaiting_rules)            AS awaiting_rules,
            count(*) FILTER (WHERE NOT flagged AND NOT decided
                                   AND NOT awaiting_rules
                                   AND awaiting_receipt)          AS awaiting_receipt,
            count(*) FILTER (WHERE NOT flagged AND NOT decided
                                   AND NOT awaiting_rules
                                   AND NOT awaiting_receipt)      AS eligible
       FROM q`,
    [s.receiptMatters],
  );
  const n = (k: string) => Number(rows[0]?.[k] ?? 0);
  return {
    on: s.on,
    owner: s.owner,
    perRun: s.perRun,
    rules: s.rules,
    receiptMatters: s.receiptMatters,
    blocked: s.blocked,
    counts: {
      inbox: n("inbox"),
      flagged: n("flagged"),
      decided: n("decided"),
      awaitingRules: n("awaiting_rules"),
      awaitingReceipt: n("awaiting_receipt"),
      eligible: n("eligible"),
    },
  };
}

/**
 * Come back and look, on a clock of its own.
 *
 * Fifteen minutes, and a pass that has nothing to do is four small reads
 * of the settings. The alternative — and what was here — was to let the
 * automation ride on the import and the receipt reader, which means it
 * fires when something arrives and never when the queue is merely sitting
 * there with work already in it.
 */
const SWEEP_MS = 15 * 60_000;

/** Long enough after boot that the first import and rule pass are done. */
const FIRST_SWEEP_MS = 3 * 60_000;

let timer: NodeJS.Timeout | null = null;

async function sweep(): Promise<void> {
  try {
    const { queued, skipped } = await autoQueueApprovals();
    // Only when there is something to say. A switched-off automation
    // logging every fifteen minutes is noise that hides real lines.
    if (queued > 0) console.log(`auto-approve: swept up ${queued}`);
    else if (skipped) console.log(`auto-approve: ${skipped}`);
  } catch (err) {
    console.error("auto-approve sweep:", err);
  } finally {
    timer = setTimeout(() => void sweep(), SWEEP_MS);
  }
}

export function startAutoApprove(): void {
  if (timer) return;
  timer = setTimeout(() => void sweep(), FIRST_SWEEP_MS);
  console.log("Automatic approvals sweeping every 15 minutes (does nothing unless switched on)");
}
