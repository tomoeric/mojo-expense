import { db } from "../db.js";
import { centsDiffer } from "../rules/engine.js";
import { subjects } from "../rules/store.js";
import { canReadReceipts, extractReceipt } from "./receipt-items.js";

/**
 * Read a flagged receipt a second time, once, before a person is asked to
 * look at it.
 *
 * Nearly every "Amounts Off" that turned out to be wrong was the reader
 * having taken the wrong line off the image — the printed total instead of
 * the handwritten one, the subtotal instead of the total, the pre-tax
 * figure. In each case pressing Read again fixed it on the spot, which
 * means the work was always automatable and we were charging a person for
 * it: open the row, press the button, watch the figure correct itself, and
 * the flag disappear.
 *
 * So it happens by itself now. A flagged expense whose receipt total does
 * not match the charge gets ONE more reading, and the rules run again on
 * what it turned out to say. If the figures now agree the flag clears with
 * nobody involved; if they still disagree the flag stays, and it is worth
 * more than it was — a mismatch that survived a second reading is evidence
 * rather than a guess.
 *
 * ONCE, deliberately. Each reading is a vision call, a second one that
 * disagrees with the first is unlikely to be settled by a third, and a
 * "keep trying until it matches" loop over a genuine overclaim is both
 * expensive and exactly the wrong instinct: the flag is the point. The mark
 * goes on BEFORE the read, so a crash mid-read cannot turn "once" into a
 * loop, and it is never cleared.
 */

/** Re-reads per pass. Each is a vision call, so a backlog arrives in slices. */
const PER_PASS = 10;

export type RereadPass = {
  /** Flagged expenses whose receipt total disagreed with the charge. */
  mismatched: number;
  /** Images re-read this pass. */
  reread: number;
  /** Of those expenses, how many came out of the flag. */
  cleared: number;
};

const empty = (): RereadPass => ({ mismatched: 0, reread: 0, cleared: 0 });

/** Expenses carrying a live flag from an enabled rule, still in the inbox. */
async function flaggedKeys(): Promise<string[]> {
  const { rows } = await db().query<{ dedupe_key: string }>(
    `SELECT DISTINCT h.dedupe_key
       FROM expense_rule_hits h
       JOIN expense_rules r ON r.id = h.rule_id
       JOIN expenses e ON e.dedupe_key = h.dedupe_key
      WHERE h.verdict = 'fail' AND r.enabled AND e.in_inbox`);
  return rows.map((r) => r.dedupe_key);
}

/**
 * `read` exists so the pass can be driven without a vision call. The logic
 * worth testing is which receipts are chosen, that each is marked before it
 * is read, and that a failure still counts as the one attempt — none of
 * which involves the model, and all of which is what goes wrong.
 */
export async function rereadMismatched(
  opts: { limit?: number; read?: (sha256: string) => Promise<unknown> } = {},
): Promise<RereadPass> {
  const limit = opts.limit ?? PER_PASS;
  const read = opts.read ?? ((sha: string) => extractReceipt(sha, { force: true }));
  const result = empty();
  if (!canReadReceipts()) return result;

  const flagged = await flaggedKeys();
  if (flagged.length === 0) return result;

  // Whether the amounts disagree is decided by the same code the rule uses,
  // via `subjects`, rather than by a second opinion written in SQL. Two
  // answers to "do these match" is the bug this whole area keeps producing.
  const mismatched = (await subjects(db(), flagged)).filter(
    (s) => s.receiptTotalCents !== null && centsDiffer(s.receiptTotalCents, s.amountCents));
  result.mismatched = mismatched.length;
  if (mismatched.length === 0) return result;

  const { rows } = await db().query<{ dedupe_key: string; sha256: string }>(
    `SELECT er.dedupe_key, er.sha256
       FROM expense_receipts er
       JOIN receipt_readings rr ON rr.sha256 = er.sha256
      WHERE er.dedupe_key = ANY($1::text[])
        AND rr.auto_reread_at IS NULL
        AND rr.error IS NULL
      ORDER BY rr.extracted_at
      LIMIT $2`,
    [mismatched.map((s) => s.dedupeKey), limit]);
  if (rows.length === 0) return result;

  const touched = new Set<string>();
  for (const { dedupe_key, sha256 } of rows) {
    touched.add(dedupe_key);
    // Before the read, not after. A read that throws still counts as the one
    // attempt this receipt gets — otherwise a receipt that fails reliably is
    // retried on every pass, for ever, at a vision call each.
    await db().query(
      "UPDATE receipt_readings SET auto_reread_at = now() WHERE sha256 = $1", [sha256]);
    try {
      await read(sha256);
      result.reread++;
    } catch (err) {
      console.error(`reread: could not re-read ${sha256.slice(0, 8)}:`, err);
    }
  }

  // And judge them again on what the receipts NOW say. Without this the
  // corrected total sits in the database while the old flag sits on screen,
  // which is the complaint this is meant to answer.
  const keys = [...touched];
  const { runRules } = await import("../rules/run.js");
  await runRules({ keys });

  const still = await db().query<{ n: string }>(
    `SELECT count(DISTINCT h.dedupe_key) AS n
       FROM expense_rule_hits h
       JOIN expense_rules r ON r.id = h.rule_id
      WHERE h.dedupe_key = ANY($1::text[]) AND h.verdict = 'fail' AND r.enabled`,
    [keys]);
  result.cleared = keys.length - Number(still.rows[0]?.n ?? keys.length);
  return result;
}
