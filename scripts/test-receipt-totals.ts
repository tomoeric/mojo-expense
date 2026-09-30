/**
 * Four real receipts, four wrong flags, one family of fault.
 *
 * Each is a screenshot of the queue saying "Amounts Off" about a purchase
 * that was not off at all, and each broke at a different point in the chain
 * that turns an image into a figure. They are kept together because fixing
 * any one of them in isolation is how the next one appears.
 *
 *   QuikTrip     $80.00 charged, flagged at $60.00 — the reader said the
 *                image was ILLEGIBLE and returned a total anyway, and the
 *                rules used it.
 *   Chipotle     $13.82 charged, flagged at $14.70 — a promotion line, so
 *                the largest figure in the summary block is a PRE-DISCOUNT
 *                running total, not the answer.
 *   Airline      $159.61 charged, flagged at $171.44 — an invoice whose
 *                "Subtotal" already includes the tax, corrected upwards by
 *                arithmetic in the teeth of a payment line saying 159.61.
 *   Dollar Tree  $6.37 charged, flagged at $5.37 — a crumpled slip whose
 *                6 read as a 5 in all three places it was printed, while
 *                its own items and tax added to exactly the charge.
 *
 * No vision call. Three of the four are decided by pure functions and are
 * checked directly; the QuikTrip one is a rule about what the rules layer
 * may READ, so it needs a database (set DATABASE_URL, or that section is
 * skipped and says so).
 */

import { chargedTotal, isAlcohol } from "../server/emburse/receipt-items.js";
import { chosenReceiptTotal } from "../server/rules/engine.js";

let failures = 0;
function check(label: string, got: unknown, want: unknown): void {
  const ok = Object.is(got, want);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${String(got)}, want ${String(want)}`}`);
  if (!ok) failures++;
}

const read = (r: Partial<Parameters<typeof chargedTotal>[0]>) =>
  chargedTotal({
    legible: true, itemised: true, merchant: null, purchased_at: null, currency: null,
    items: [], subtotal: null, tax: null, tip: null, total: null, paid: null,
    totals: [], notes: "",
    ...r,
  } as Parameters<typeof chargedTotal>[0]);

console.log("\nChipotle — a promotion puts the biggest figure ABOVE the discount");
{
  const r = read({
    subtotal: 12.75, tax: 1.07, tip: 0, total: 13.82,
    totals: [
      { label: "Bag Total", amount: 14.70 },
      { label: "FREE CHIPS", amount: -1.95 },
      { label: "Subtotal", amount: 12.75 },
      { label: "Tax", amount: 1.07 },
      { label: "Crew Tip", amount: 0 },
      { label: "Total", amount: 13.82 },
    ],
  });
  check("the reconciled total stands", r.total, 13.82);
  check("…and no correction is announced", r.notes, "");
}

console.log("\nAirline Hydraulics — an invoice whose Subtotal already has the tax in it");
{
  const r = read({
    subtotal: 159.61, tax: 11.83, total: 159.61, paid: 159.61,
    totals: [
      { label: "Freight", amount: 10.68 },
      { label: "Tax Amount", amount: 11.83 },
      { label: "Subtotal", amount: 159.61 },
      { label: "Stripe Payment", amount: 159.61 },
      { label: "Balance Due", amount: 0 },
    ],
  });
  check("the card settles it", r.total, 159.61);
  check("…and the tax is not added on top", r.notes, "");
}

console.log("\nStill correcting the two it was written for");
{
  // Texas Roadhouse: Total 38.24 is before the tip; Amount Paid 45.89.
  const tip = read({ subtotal: 35.37, tax: 2.87, tip: 7.65, total: 38.24, paid: 45.89 });
  check("a total before the tip is still corrected", tip.total, 45.89);
  // Menards labels its PRE-TAX figure "TOTAL"; TOTAL SALE 13.54 is the charge.
  const tax = read({
    subtotal: null, tax: null, total: 12.49, paid: null,
    totals: [
      { label: "TOTAL", amount: 12.49 },
      { label: "TAX WASHINGTON-MN 8.375%", amount: 1.05 },
      { label: "TOTAL SALE", amount: 13.54 },
    ],
  });
  check("a total before the tax is still corrected", tax.total, 13.54);
}

console.log("\nDollar Tree — the charge decides between the print and the arithmetic");
{
  // 4 × 1.50 = 6.00, tax 0.37. The total printed 5.37 in all three places;
  // the crumple turned one digit. Nothing in the receipt alone can say
  // which figure is right — only the charge can.
  const printed = 537;
  const arithmetic = 637;
  check("the arithmetic answers the $6.37 charge",
    chosenReceiptTotal(637, [printed], [arithmetic]), 637);
  check("…and the print still answers a $5.37 one",
    chosenReceiptTotal(537, [printed], [arithmetic]), 537);
  check("…while neither answering leaves the printed figure to be flagged",
    chosenReceiptTotal(900, [printed], [arithmetic]), 537);
  // Airline again, through the same door: arithmetic says 171.44 and the
  // charge says 159.61, so the arithmetic must not win.
  check("an arithmetic figure never beats a print that answers the charge",
    chosenReceiptTotal(15961, [15961], [17144]), 15961);
}

console.log("\nChipotle's soda is not a drink anybody has to look at");
{
  check("soda/iced tea", isAlcohol("22 fl oz Soda/Iced Tea", true), false);
  check("…but a vodka soda is", isAlcohol("VODKA SODA", true), true);
}

console.log("\nQuikTrip — an illegible reading is evidence of nothing");
if (!process.env.DATABASE_URL && !process.env.NEON_DATABASE_URL
    && !process.env.EXTERNAL_DATABASE_URL) {
  console.log("  --   skipped: no DATABASE_URL");
} else {
  const { db } = await import("../server/db.js");
  const { ensureReceiptItems } = await import("../server/emburse/receipt-items.js");
  const store = await import("../server/rules/store.js");
  await ensureReceiptItems();

  const TAG = `zz-illegible-${Date.now()}`;
  const clean = async (): Promise<void> => {
    await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
    await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE $1", [`${TAG}%`]);
    await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`]);
  };
  await clean();
  try {
    // The faded QuikTrip slip: $80.00 on the pump, $80.00 sub-total, $80.00
    // total, $80.00 on the Amex line — and a reading that said "too faded to
    // read" and put 60.00 in the total anyway. The drawer showed BOTH, one
    // under the other: "could not be read", and "Receipt total $60.00 does
    // not equal Amount $80.00".
    await db().query(
      `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
       VALUES ($1,'image/jpeg',1,'\\x00'::bytea) ON CONFLICT DO NOTHING`, [`${TAG}-a`]);
    await db().query(
      `INSERT INTO receipt_readings
         (sha256, model, legible, itemised, total_cents, merchant, purchased_at, error)
       VALUES ($1,'test',false,false,6000,'QUIKTRIP','2026-09-22',NULL)`, [`${TAG}-a`]);
    await db().query(
      `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                             category, department, location, note, method, in_inbox)
       VALUES ($1,'Test Person','2026-09-22','QUIKTRIP #837',8000,'Auto Fee & Fuel',
               'Maintenance','Corporate-Mammoth','fuel','Corporate Card',true)`, [`${TAG}-1`]);
    await db().query(
      "INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2)",
      [`${TAG}-1`, `${TAG}-a`]);

    const s1 = (await store.subjects(db(), [`${TAG}-1`]))[0]!;
    check("no total is offered from an unreadable image", s1.receiptTotalCents, null);
    check("…and none is listed behind it", s1.receiptTotalsCents.length, 0);
    check("…nor a date read off it", s1.receiptDate, null);
    check("…nor a business name", s1.receiptMerchant, "");
    // The one thing it DOES answer, and the honest flag for this expense.
    check("…but it still reports that it could not be read", s1.receiptReadable, false);
  } finally {
    await clean();
    await db().end();
  }
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
