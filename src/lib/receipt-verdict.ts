/**
 * Does the receipt total agree with what was claimed?
 *
 * Worked out from the reading the importer already stored, not from a fresh
 * model call. The receipt is read once when it arrives — the total, the
 * items, the merchant, the date — so by the time anybody opens the drawer the
 * answer is a subtraction, not a question.
 *
 * There used to be a "Check N receipts" button that re-fetched each image and
 * re-asked the model for a total it already had, then threw the verdict away
 * on restart. It cost a model call per press, answered slower than the data
 * sitting beside it, and had to be remembered. A check somebody has to
 * remember to run is a check that does not happen.
 *
 * The honest framing is unchanged and matters: a difference is a PROMPT TO
 * LOOK, not proof of anything. Split bills, tips added after printing,
 * personal items excluded from the claim and currency conversion all produce
 * real differences.
 */

import type { AuditResult } from "@/lib/api";

/** Cents of slack before a difference is worth mentioning at all. */
const TOLERANCE_ABS = 0.02;
const TOLERANCE_PCT = 0.01;

const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;

/**
 * The verdict for one line, or null when there is nothing to say.
 *
 * Null rather than a "no idea" badge: a receipt that has not been read yet is
 * already described where the items would be, and a second placeholder beside
 * it says the same nothing twice.
 */
export function verdictFor(
  claimed: number,
  receiptTotal: number | null | undefined,
  lineId: string,
): AuditResult | null {
  if (receiptTotal === null || receiptTotal === undefined) return null;

  const difference = Number((receiptTotal - claimed).toFixed(2));
  const slack = Math.max(TOLERANCE_ABS, Math.abs(claimed) * TOLERANCE_PCT);
  const base = { lineId, claimed, receiptTotal, difference, checkedAt: "", demo: false };

  if (Math.abs(difference) <= slack) {
    return { ...base, verdict: "match", message: `Receipt total ${money(receiptTotal)} matches the claim.` };
  }
  // The direction matters. Claiming MORE than the receipt shows is the one
  // worth a reviewer's time; claiming less is usually a split bill.
  if (difference < 0) {
    return {
      ...base,
      verdict: "claimed-more",
      message: `Claim is ${money(difference)} more than the receipt total of ${money(receiptTotal)}.`,
    };
  }
  return {
    ...base,
    verdict: "claimed-less",
    message: `Receipt total is ${money(receiptTotal)}, ${money(difference)} more than claimed — often a split bill.`,
  };
}
