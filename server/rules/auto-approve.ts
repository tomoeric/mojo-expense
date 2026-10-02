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
import { exportInFlight } from "../emburse/export-scheduler.js";
import { flagOwner, getFlag, getLimit } from "../flags.js";
import { hasCredential, scopeFor } from "../emburse/credentials.js";
import { MINE, queueApprovalFor } from "../emburse/decisions.js";
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

  /**
   * Already decided, queued, or failed and waiting on a person — BY THE
   * PERSON WHOSE QUEUE THIS IS.
   *
   * Approval here is a chain: the receipt lands in Eric's Needs Review, Eric
   * approves, and it then goes to Brian's Needs Review. Same expense, same
   * seven fields, so the same `dedupe_key` — and `expense_decisions` has no
   * foreign key, deliberately, so Eric's approval outlives the purge and is
   * still sitting there when Brian's import brings the expense back as his.
   *
   * Asked without the reviewer, this says "already decided" about every
   * expense that reached the second stage, for ever. Brian's queue would
   * show Eric's approval as its own, the sweep would skip every row, and
   * nothing in the second half of the chain could ever be approved through
   * this app. One stage's decision does not discharge the next one's.
   *
   * A row nobody holds keeps the old reading — any decision counts — because
   * there is no reviewer to compare against and the alternative is offering
   * to approve something twice.
   */
  decided: `EXISTS (
          SELECT 1 FROM expense_decisions d
           WHERE d.dedupe_key = e.dedupe_key AND d.state IN ('pending','applied','failed')
             AND (e.reviewer = '' OR lower(d.decided_by) = lower(e.reviewer)))`,

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

  /**
   * No receipt stored at all — which should be impossible.
   *
   * Emburse will not accept an expense without one, so every row in the
   * queue has a receipt by the time it reaches us. A row with none means
   * the IMPORT lost it: the export's receipt pages are matched to rows,
   * and a page that matches nothing is skipped with a warning nobody
   * reads twice.
   *
   * Split out from `awaitingReceipt` because the two need opposite
   * things. Waiting is patience; this is a missing document on an expense
   * somebody is going to approve, and it was silently unapprovable for
   * ever while the queue showed it as plain Unflagged.
   */
  noReceipt: `NOT EXISTS (SELECT 1 FROM expense_receipts er WHERE er.dedupe_key = e.dedupe_key)`,

  /**
   * Every receipt on it was tried three times and could not be read.
   *
   * Also permanently unapprovable, also shown as Unflagged — and unlike
   * the one above it drops out of the queue's "Receipt being read" bucket
   * too, so nothing on screen marks it at all.
   */
  unreadableReceipt: `EXISTS (SELECT 1 FROM expense_receipts er WHERE er.dedupe_key = e.dedupe_key)
        AND NOT EXISTS (
              SELECT 1 FROM expense_receipts er
                JOIN receipt_readings rr ON rr.sha256 = er.sha256 AND rr.error IS NULL
               WHERE er.dedupe_key = e.dedupe_key)
        AND NOT EXISTS (
              SELECT 1 FROM expense_receipts er
               WHERE er.dedupe_key = e.dedupe_key
                 AND NOT EXISTS (SELECT 1 FROM receipt_readings rr WHERE rr.sha256 = er.sha256))`,
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
 * The first condition that holds, with the sentence that goes with it.
 *
 * Each test is either a plain boolean or a function, so the expensive ones
 * — a database read, a credential decrypt — are only run once the cheap
 * ones ahead of them have passed.
 */
async function firstReason(
  tests: [boolean | (() => Promise<boolean>), string][],
): Promise<string | null> {
  for (const [test, why] of tests) {
    if (typeof test === "function" ? await test() : test) return why;
  }
  return null;
}

/**
 * Read the setup and apply the refusals, without touching any expense.
 *
 * Shared by the pass and the report so the page cannot say one thing while
 * the automation does another.
 */
async function setup(who: string | null = null): Promise<Setup> {
  // A named reviewer reads their own switch; `null` is the global one.
  // Same function either way, so the per-person path cannot drift from the
  // path that has been approving real money for months.
  const mine = who
    ? await (async () => {
        const { reviewerImports } = await import("../emburse/export-scheduler.js");
        return (await reviewerImports().catch(() => []))
          .find((r) => r.userEmail.toLowerCase() === who.toLowerCase()) ?? null;
      })()
    : null;
  const on = who ? Boolean(mine?.autoApprove) : await getFlag("autoApprove").catch(() => false);
  const owner = who ?? (await flagOwner("autoApprove"));
  const perRun = Math.min(
    Math.max(1, (who ? mine?.autoApprovePerRun : null)
      ?? (await getLimit("autoApprove")) ?? DEFAULT_PER_RUN),
    MOST_PER_RUN);
  const rules = await activeRules();
  const receiptMatters = rules.some((r) =>
    [...r.when, ...(r.must ? [r.must] : [])].some(
      (c) => NEEDS_A_READING.has(c.field) || (c.compare && NEEDS_A_READING.has(c.compare)),
    ));

  // Standing aside for an import. It adds and removes expenses underneath
  // the very queue this reads, and the rules have not seen the new arrivals
  // yet — so anything queued mid-import is judged against a queue that is
  // changing as it is read. It resumes on its own when the run finishes;
  // nothing has to be remembered or switched back.
  // Written as a chain of reasons rather than one nested ternary: this list
  // only ever grows, and the ordering IS the meaning — the first thing that
  // would stop a run is the thing to say.
  const blocked = await firstReason([
    [!on, "automatic approvals are switched off"],
    // Paused by hand. Deliberately ahead of everything else: somebody has
    // said "not now", and no other detail is worth reporting over that.
    [async () => await getFlag("holdDecisions").catch(() => false),
      "everything is paused — nothing is being queued or sent to Emburse until it is resumed"],
    // Standing aside for an import. It adds and removes expenses underneath
    // the very queue this reads, and the rules have not seen the new
    // arrivals yet, so anything queued mid-import is judged against a queue
    // that is changing as it is read. It resumes on its own when the run
    // finishes; nothing has to be remembered or switched back.
    [async () => await exportInFlight().catch(() => false),
      "an import is running, so approvals wait until it has finished and the rules have run"],
    [!owner, "nobody owns the automatic approvals, so there is no login to make them under"],
    // The same rule as everywhere else: Emburse records an approval against
    // whoever signed in. No credential, no approval — never a shared one.
    [async () => Boolean(owner) && !(await hasCredential(owner!)),
      `${owner} switched automatic approvals on but has no Emburse login stored, so none can be made`],
    // No rules means nothing has been checked at all, and "no flags" is
    // vacuously true of every expense in the queue.
    [rules.length === 0, "no rules are enabled, so nothing has actually been checked"],
  ]);

  return { on, owner, perRun, rules: rules.length, receiptMatters, blocked };
}

/**
 * Queue approvals for clean expenses, up to the configured number.
 *
 * Returns rather than throws: this runs on the back of an import, and an
 * import must not fail because an optional automation could not run.
 */
export async function autoQueueApprovals(): Promise<AutoApproveResult> {
  // Everybody who has switched it on, each sweeping their own queue under
  // their own login. The global switch is one of them — the owner's — so a
  // single-reviewer deployment behaves exactly as it always has.
  let queued = 0;
  const skipped: string[] = [];
  for (const who of await owners()) {
    const r = await sweepFor(who);
    queued += r.queued;
    if (r.skipped) skipped.push(r.skipped);
  }
  return { queued, skipped: skipped.length ? skipped.join(" · ") : null };
}

/**
 * Everyone whose automatic approvals are on, the global owner included.
 *
 * The global switch stays exactly what it was — one person, one queue — and
 * the per-reviewer switches sit beside it rather than replacing it, because
 * a deployment with one reviewer should not have to learn a new control to
 * keep working.
 */
async function owners(): Promise<(string | null)[]> {
  /** Reviewers with a switch of their own, by lowered email. */
  const named = new Map<string, string>();
  try {
    const { reviewerImports } = await import("../emburse/export-scheduler.js");
    for (const r of await reviewerImports()) {
      if (r.autoApprove && r.userEmail) named.set(r.userEmail.toLowerCase(), r.userEmail);
    }
  } catch (err) {
    // The table may not exist yet on a cold install. The global switch is
    // unaffected, and an optional automation must not break the import it
    // runs on the back of. Logged, though: the previous bare `catch {}`
    // turned a permanent failure into a sweep that silently did nothing
    // for everybody with no line anywhere saying why.
    console.error("auto-approve: could not read the per-reviewer switches:", err);
  }

  const globalOwner = (await flagOwner("autoApprove").catch(() => null))?.trim().toLowerCase();

  /*
   * When one person has both switches, THEIRS wins.
   *
   * This filtered the other way round: it dropped the named entry and kept
   * `null`, which reads the GLOBAL switch. So a reviewer who happened to
   * own the global flag had their own setting ignored — their tab says on,
   * the sweep reads a different switch, and nothing is queued with nothing
   * logged. The per-reviewer switch is the more specific of the two and
   * the one somebody just pressed, so it is the one that counts.
   *
   * Sweeping both is not the answer either: same person, same queue, twice
   * the per-pass limit, and no way to tell from the outside.
   */
  const out: (string | null)[] = [];
  if (!globalOwner || !named.has(globalOwner)) out.push(null);
  for (const email of named.values()) out.push(email);
  return out;
}

/** One person's pass. `who` null means the global switch and its owner. */
async function sweepFor(who: string | null): Promise<AutoApproveResult> {
  const s = await setup(who);
  // Switched off is not a complaint. The others are: somebody turned this
  // on and it is not doing what they think it is doing.
  if (!s.on) return { queued: 0, skipped: null };
  if (s.blocked) return { queued: 0, skipped: s.blocked };

  // The owner's own queue, and nobody else's.
  //
  // This is the same rule as everywhere else and it bites hardest here: an
  // approval is applied by signing in as the owner, so approving another
  // reviewer's expense would either put the owner's name on a decision
  // about somebody else's queue or — more likely — fail after a minute of
  // browsing, because the row is not in the Needs Review it is reading.
  // Unattended and on a timer, that is the worst place in the app to get
  // "whose is this" wrong.
  const { reviewer, ownsBlanks } = await scopeFor(s.owner!);
  const { rows } = await db().query<{ dedupe_key: string }>(
    `SELECT e.dedupe_key
       FROM expenses e
      WHERE e.in_inbox = true
        AND ($3 = '' OR ${MINE(3, 4)})
        AND NOT ${TESTS.flagged}
        AND NOT ${TESTS.awaitingRules}
        AND NOT ${TESTS.decided}
        AND ($2::boolean = false OR NOT ${TESTS.awaitingReceipt})
      ORDER BY e.expense_date NULLS LAST, e.dedupe_key
      LIMIT $1`,
    [s.perRun, s.receiptMatters, reviewer, ownsBlanks],
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
  /**
   * The two that can never clear on their own, counted apart.
   *
   * Both sit inside `awaitingReceipt` above, and both are permanent — one
   * is a receipt the import lost, the other one the reader gave up on.
   * Lumped in with "waiting for a receipt to be read" they look like
   * patience; named, they are a short list for somebody to deal with.
   */
  stuck: { noReceipt: number; unreadable: number };
  /** Each other reviewer's share of the queue, and whether theirs is on. */
  others: { reviewer: string; count: number; on: boolean }[];
  /**
   * Expenses in the queue that belong to ANOTHER reviewer, counted apart
   * from everything above because the automation will never touch them.
   *
   * Deliberately outside `counts`, which sums to `inbox`. These are not a
   * reason the pass skipped something; they are expenses it cannot see. An
   * approval is made under the owner's Emburse login and only their own
   * Needs Review has the row in it.
   */
  elsewhere: number;
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
export async function autoApproveReport(who: string | null = null): Promise<AutoApproveReport> {
  const s = await setup(who);
  // The same scope as the pass, for the same reason the tests are shared: a
  // report counting expenses the pass will never look at names the wrong
  // reason with complete confidence.
  const { reviewer, ownsBlanks } = s.owner
    ? await scopeFor(s.owner)
    : { reviewer: "", ownsBlanks: false };
  const { rows } = await db().query<Record<string, string>>(
    `WITH q AS (
       SELECT ${TESTS.flagged}        AS flagged,
              ${TESTS.decided}        AS decided,
              ${TESTS.awaitingRules}  AS awaiting_rules,
              ($1::boolean AND ${TESTS.awaitingReceipt}) AS awaiting_receipt
         FROM expenses e
        WHERE e.in_inbox = true
          AND ($2 = '' OR ${MINE(2, 3)}))
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
    [s.receiptMatters, reviewer, ownsBlanks],
  );

  // The two permanent ones, named rather than left inside "waiting".
  const { rows: stuck } = await db().query<{ none: string; bad: string }>(
    `SELECT count(*) FILTER (WHERE ${TESTS.noReceipt})          AS none,
            count(*) FILTER (WHERE ${TESTS.unreadableReceipt})  AS bad
       FROM expenses e
      WHERE e.in_inbox = true
        AND ($1 = '' OR ${MINE(1, 2)})
        AND NOT ${TESTS.flagged}
        AND NOT ${TESTS.decided}`,
    [reviewer, ownsBlanks],
  );

  // Everybody else's, counted separately and never folded into the totals
  // above. It is the one number that explains a queue full of expenses and
  // an automation that does nothing: they are in another reviewer's Emburse
  // account, and only that person's login can approve them.
  const { rows: others } = await db().query<{ reviewer: string; n: string }>(
    `SELECT e.reviewer, count(*)::text AS n FROM expenses e
      WHERE e.in_inbox = true AND $1 <> '' AND NOT ${MINE(1, 2)}
      GROUP BY e.reviewer ORDER BY count(*) DESC`,
    [reviewer, ownsBlanks],
  );
  // And whether THEY have switched it on, which is the next question
  // anybody reading that number asks. The card used to end on "whoever they
  // belong to has to switch this on for themselves" with no way to see
  // whether they had.
  const switches = new Map<string, boolean>();
  try {
    const { reviewerImports } = await import("../emburse/export-scheduler.js");
    for (const r of await reviewerImports()) {
      switches.set(r.userEmail.toLowerCase(), r.autoApprove);
    }
  } catch { /* no table yet; everybody reads as off, which they are */ }
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
    stuck: {
      noReceipt: Number(stuck[0]?.none ?? 0),
      unreadable: Number(stuck[0]?.bad ?? 0),
    },
    elsewhere: others.reduce((a, r) => a + Number(r.n), 0),
    others: others.map((r) => ({
      reviewer: r.reviewer,
      count: Number(r.n),
      on: switches.get(r.reviewer.toLowerCase()) ?? false,
    })),
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
