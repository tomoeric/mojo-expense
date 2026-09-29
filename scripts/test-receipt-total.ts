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

import { chargedTotal, type ReceiptReading } from "../server/emburse/receipt-items.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const base: ReceiptReading = {
  legible: true, itemised: true, merchant: "Texas Roadhouse", purchasedAt: "2026-09-25",
  currency: "USD", items: [], subtotal: 35.37, tax: 2.87, tip: 7.65, total: 38.24,
  paid: null, notes: "",
};

console.log("\n1. The real one");
{
  const out = chargedTotal(base);
  check("the tip is put back on a pre-tip total", out.total === 45.89, String(out.total));
  check("…and the note says so, because a silent correction is worse than none",
    /before the tip/.test(out.notes) && /38\.24/.test(out.notes) && /45\.89/.test(out.notes),
    out.notes);
}

console.log("\n2. Left alone unless the arithmetic proves it");
check("a total that already includes the tip is untouched",
  chargedTotal({ ...base, total: 45.89 }).total === 45.89);
check("…no tip, nothing to add", chargedTotal({ ...base, tip: null }).total === 38.24);
check("…a zero tip is not a tip", chargedTotal({ ...base, tip: 0 }).total === 38.24);
check("…no subtotal, so nothing can be proved", chargedTotal({ ...base, subtotal: null }).total === 38.24);
check("…no total at all stays null", chargedTotal({ ...base, total: null }).total === null);
// The guard that matters: if the numbers do not reconcile, we do not know
// what the total is made of, and adding the tip would be a guess.
check("…figures that do not reconcile are not 'corrected'",
  chargedTotal({ ...base, subtotal: 30.00 }).total === 38.24, String(chargedTotal({ ...base, subtotal: 30.00 }).total));
check("…and a penny of rounding is still allowed",
  chargedTotal({ ...base, subtotal: 35.38 }).total === 45.89, String(chargedTotal({ ...base, subtotal: 35.38 }).total));

console.log("\n2b. Menards: the word TOTAL against the PRE-TAX figure");
// TOTAL 12.49 / TAX 1.05 / TOTAL SALE 13.54. The reading took 12.49 and the
// app reported $1.05 of overclaiming — the tax, exactly.
{
  const menards: ReceiptReading = {
    ...base, merchant: "MENARDS - COTTAGE GROVE", tip: null,
    subtotal: 12.49, tax: 1.05, total: 12.49, paid: null,
  };
  const out = chargedTotal(menards);
  check("a total read from above the tax is corrected", out.total === 13.54, String(out.total));
  check("…and says which line it came off", /before the tax/.test(out.notes), out.notes);
}

console.log("\n2c. The payment line settles it outright");
{
  // What the card was charged, stated by the receipt itself. It beats the
  // arithmetic, and it is on both of the receipts that were misread.
  const carded = chargedTotal({ ...base, subtotal: null, tax: null, tip: null, total: 12.49, paid: 13.54 });
  check("the amount against the card wins", carded.total === 13.54, String(carded.total));
  check("…even with no subtotal to reconcile against",
    /is not what the card paid/.test(carded.notes), carded.notes);
  check("…and agreeing figures are left alone",
    chargedTotal({ ...base, total: 45.89, paid: 45.89 }).total === 45.89);
  check("…a zero on the payment line is not an amount",
    chargedTotal({ ...base, total: 38.24, paid: 0 }).total === 45.89);
}

console.log("\n3. A receipt with no tax");
check("subtotal plus tip, no tax line",
  chargedTotal({ ...base, subtotal: 38.24, tax: null, total: 38.24 }).total === 45.89);

console.log("\n4. Nothing is invented");
{
  const out = chargedTotal({ ...base, notes: "Two people on one bill." });
  check("an existing note is kept, not replaced",
    /Two people on one bill\./.test(out.notes) && /tip/.test(out.notes), out.notes);
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
