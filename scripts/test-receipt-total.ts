/**
 * The total a receipt was CHARGED, not the one labelled "Total".
 *
 *   pnpm exec tsx scripts/test-receipt-total.ts
 *
 * A restaurant slip prints Total, then Tip, then Amount Paid, and the word
 * "Total" sits against the SMALLER figure:
 *
 *     Sub Total  35.37
 *     Tax         2.87
 *     Total      38.24      <- before the tip
 *     Tip         7.65
 *     Amount Paid 45.89     <- what was charged
 *
 * A real Texas Roadhouse receipt read 38.24 against a $45.89 charge, and the
 * app reported an ordinary meal as $7.65 of overclaiming. The prompt now
 * says which figure to take, but a prompt is a request; this is the
 * arithmetic that holds regardless.
 */

export {};

import { withTip, type ReceiptReading } from "../server/emburse/receipt-items.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const base: ReceiptReading = {
  legible: true, itemised: true, merchant: "Texas Roadhouse", purchasedAt: "2026-09-25",
  currency: "USD", items: [], subtotal: 35.37, tax: 2.87, tip: 7.65, total: 38.24, notes: "",
};

console.log("\n1. The real one");
{
  const out = withTip(base);
  check("the tip is put back on a pre-tip total", out.total === 45.89, String(out.total));
  check("…and the note says so, because a silent correction is worse than none",
    /before the 7.65 tip/.test(out.notes), out.notes);
}

console.log("\n2. Left alone unless the arithmetic proves it");
check("a total that already includes the tip is untouched",
  withTip({ ...base, total: 45.89 }).total === 45.89);
check("…no tip, nothing to add", withTip({ ...base, tip: null }).total === 38.24);
check("…a zero tip is not a tip", withTip({ ...base, tip: 0 }).total === 38.24);
check("…no subtotal, so nothing can be proved", withTip({ ...base, subtotal: null }).total === 38.24);
check("…no total at all stays null", withTip({ ...base, total: null }).total === null);
// The guard that matters: if the numbers do not reconcile, we do not know
// what the total is made of, and adding the tip would be a guess.
check("…figures that do not reconcile are not 'corrected'",
  withTip({ ...base, subtotal: 30.00 }).total === 38.24, String(withTip({ ...base, subtotal: 30.00 }).total));
check("…and a penny of rounding is still allowed",
  withTip({ ...base, subtotal: 35.38 }).total === 45.89, String(withTip({ ...base, subtotal: 35.38 }).total));

console.log("\n3. A receipt with no tax");
check("subtotal plus tip, no tax line",
  withTip({ ...base, subtotal: 38.24, tax: null, total: 38.24 }).total === 45.89);

console.log("\n4. Nothing is invented");
{
  const out = withTip({ ...base, notes: "Two people on one bill." });
  check("an existing note is kept, not replaced",
    /Two people on one bill\./.test(out.notes) && /tip/.test(out.notes), out.notes);
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
