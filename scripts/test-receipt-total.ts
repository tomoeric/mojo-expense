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
  legible: true, itemised: true, substitute: false,
  merchant: "Texas Roadhouse", purchasedAt: "2026-09-25",
  currency: "USD", items: [], subtotal: 35.37, tax: 2.87, tip: 7.65, total: 38.24,
  paid: null, totals: [], notes: "",
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

console.log("\n2d. The summary block, transcribed and chosen from in code");
// The Menards receipt that survived every earlier fix: the reading put
// 12.49 in `total`, NOTHING in `subtotal` and nothing in `paid`, so the
// arithmetic had nothing to work from — while "TOTAL SALE 13.54" and
// "AMERICAN EXPRESS 1002  13.54" sat on the page in plain sight.
//
// Asking which figure is "the total" is a judgement, and it has now been
// got wrong twice in opposite directions. Asking for the lines as printed
// is transcription, and the choosing happens here where it can be tested.
{
  const menards: ReceiptReading = {
    ...base, merchant: "MENARDS - COTTAGE GROVE", subtotal: null, tax: 1.05, tip: null,
    total: 12.49, paid: null,
    totals: [
      { label: "TOTAL", amount: 12.49 },
      { label: "TAX WASHINGTON-MN 8.375%", amount: 1.05 },
      { label: "TOTAL SALE", amount: 13.54 },
      { label: "AMERICAN EXPRESS 1002", amount: 13.54 },
    ],
  };
  const out = chargedTotal(menards);
  check("the payment line in the block wins", out.total === 13.54, String(out.total));
  check("…and says where it came from",
    /not the last figure on the receipt/.test(out.notes), out.notes);

  // The climb: subtotal, total, total-with-tip. The end of it is the charge.
  const unlabelled = chargedTotal({
    ...menards,
    totals: [{ label: "TOTAL", amount: 12.49 }, { label: "TAX", amount: 1.05 }, { label: "", amount: 13.54 }],
  });
  check("…and with no payment label, the largest line is taken",
    unlabelled.total === 13.54, String(unlabelled.total));

  // A change line is bigger than the purchase and is not the purchase.
  const withChange = chargedTotal({
    ...menards,
    totals: [
      { label: "TOTAL SALE", amount: 13.54 },
      { label: "CASH TENDERED", amount: 20.00 },
      { label: "CHANGE", amount: 6.46 },
    ],
  });
  check("…while change and cash tendered are never the purchase",
    withChange.total === 13.54, String(withChange.total));

  // A rebate receipt prints a total that is not what was paid for goods.
  const rebate = chargedTotal({
    ...menards,
    totals: [{ label: "TOTAL SALE", amount: 13.54 }, { label: "REBATE RECEIPTS", amount: 50.05 }],
  });
  check("…nor is a rebate line", rebate.total === 13.54, String(rebate.total));

  check("…and a block that agrees with the reading changes nothing",
    chargedTotal({ ...menards, total: 13.54 }).total === 13.54);
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
