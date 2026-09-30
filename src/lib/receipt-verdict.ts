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

/**
 * The receipt total for a whole expense, chosen exactly as the rule engine
 * chooses it (`chosenReceiptTotal` in server/rules/engine.ts).
 *
 * This used to be `details[0].total` — the first receipt — while the rules
 * summed every receipt on the expense. On an expense carrying the same bill
 * three times, the badge here said "Match" against $312.44 and the rule
 * flagged "Amounts Off" against $937.32, at the same time, on the same row.
 * The two halves of the app have to answer with the same number or neither
 * is worth reading, so the choosing is written down once, in both places,
 * and a test pins them to each other.
 *
 * One receipt: that one. Several, and one of them IS the charge: that one.
 * Several, none of them the charge: the distinct ones added up.
 */
export function receiptTotalOf(
  details: { total: number | null; error: string | null }[] | undefined,
  claimed: number,
): number | null {
  if (!details || details.length === 0) return null;
  const cents: number[] = [];
  for (const d of details) {
    if (d.error !== null || d.total === null) continue;
    cents.push(Math.round(d.total * 100));
  }
  if (cents.length === 0) return null;
  // A refund prints as a positive total against a negative charge — see
  // chosenReceiptTotal in server/rules/engine.ts, which this mirrors. A
  // credit may be answered by a positive receipt; a charge may not be
  // answered by a negative one.
  const want = Math.round(claimed * 100);
  const refund = want < 0;
  const answers = (c: number): boolean =>
    Math.abs(refund ? Math.abs(c) - Math.abs(want) : c - want)
      <= Math.max(2, Math.round(Math.abs(want) * 0.01));
  const asCharged = (c: number): number => (refund ? -Math.abs(c) : c);

  if (cents.length === 1) {
    const only = cents[0]!;
    return (answers(only) ? asCharged(only) : only) / 100;
  }

  // The same slack the rules use: two cents, or one percent, whichever is
  // larger. Kept in step with MONEY_TOLERANCE_* in server/rules/engine.ts.
  let covers: number | null = null;
  for (const c of cents) {
    if (!answers(c)) continue;
    const off = Math.abs(Math.abs(c) - Math.abs(want));
    if (covers === null || off < Math.abs(Math.abs(covers) - Math.abs(want))) covers = c;
  }
  if (covers !== null) return asCharged(covers) / 100;

  let sum = 0;
  for (const c of new Set(cents)) sum += c;
  return sum / 100;
}
