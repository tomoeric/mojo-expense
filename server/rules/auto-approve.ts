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

export type AutoApproveResult = {
  queued: number;
  /** Why it did nothing, when it did nothing. Shown, not just logged. */
  skipped: string | null;
};

/**
 * Queue approvals for clean expenses, up to the configured number.
 *
 * Returns rather than throws: this runs on the back of an import, and an
 * import must not fail because an optional automation could not run.
 */
export async function autoQueueApprovals(): Promise<AutoApproveResult> {
  const on = await getFlag("autoApprove").catch(() => false);
  if (!on) return { queued: 0, skipped: null };

  const owner = await flagOwner("autoApprove");
  if (!owner) {
    return { queued: 0, skipped: "nobody owns the automatic approvals, so there is no login to make them under" };
  }
  // The same rule as everywhere else: Emburse records an approval against
  // whoever signed in. No credential, no approval — never a shared one.
  if (!(await hasCredential(owner))) {
    return {
      queued: 0,
      skipped: `${owner} switched automatic approvals on but has no Emburse login stored, so none can be made`,
    };
  }

  const perRun = Math.min(Math.max(1, (await getLimit("autoApprove")) ?? DEFAULT_PER_RUN), MOST_PER_RUN);

  // Does anything enabled depend on a receipt having been read?
  const rules = await activeRules();
  if (rules.length === 0) {
    // No rules means nothing has been checked at all, and "no flags" is
    // vacuously true of every expense in the queue.
    return { queued: 0, skipped: "no rules are enabled, so nothing has actually been checked" };
  }
  const receiptMatters = rules.some((r) =>
    [...r.when, ...(r.must ? [r.must] : [])].some(
      (c) => NEEDS_A_READING.has(c.field) || (c.compare && NEEDS_A_READING.has(c.compare)),
    ));

  const { rows } = await db().query<{ dedupe_key: string }>(
    `SELECT e.dedupe_key
       FROM expenses e
      WHERE e.in_inbox = true
        -- Nothing any enabled rule caught.
        AND NOT EXISTS (
              SELECT 1 FROM expense_rule_hits h
                JOIN expense_rules r ON r.id = h.rule_id AND r.enabled
               WHERE h.dedupe_key = e.dedupe_key AND h.verdict = 'fail')
        -- Every enabled rule has run since this expense arrived. Without
        -- this, a row that landed after the last rule pass would count as
        -- unflagged when nothing had yet looked at it.
        --
        -- NOT "it has a hit row": a rule that does not apply writes no row,
        -- so the cleanest expenses have none at all.
        AND NOT EXISTS (
              SELECT 1 FROM expense_rules r
               WHERE r.enabled
                 AND (r.last_run_at IS NULL OR r.last_run_at < e.first_seen_at))
        -- Nothing already decided, queued, or failed and waiting on a person.
        AND NOT EXISTS (
              SELECT 1 FROM expense_decisions d
               WHERE d.dedupe_key = e.dedupe_key AND d.state IN ('pending','applied','failed'))
        -- And, when any rule reads receipts, one that was actually read.
        AND ($2::boolean = false OR EXISTS (
              SELECT 1 FROM expense_receipts er
                JOIN receipt_readings rr ON rr.sha256 = er.sha256
               WHERE er.dedupe_key = e.dedupe_key AND rr.error IS NULL))
      ORDER BY e.expense_date NULLS LAST, e.dedupe_key
      LIMIT $1`,
    [perRun, receiptMatters],
  );

  if (rows.length === 0) return { queued: 0, skipped: null };

  let queued = 0;
  for (const r of rows) {
    // Through the same function a person's click uses. A machine does not
    // get a shorter path to somebody else's money than a human does.
    const result = await queueApprovalFor(r.dedupe_key, owner);
    if (result.ok) queued++;
  }
  if (queued > 0) {
    console.log(`auto-approve: queued ${queued} unflagged expense(s) as ${owner}`);
    nudgeDecisionWorker();
  }
  return { queued, skipped: null };
}
