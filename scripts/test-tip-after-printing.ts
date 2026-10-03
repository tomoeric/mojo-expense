/**
 * A tip written on after the slip was printed is not an overclaim.
 *
 *   pnpm exec tsx scripts/test-tip-after-printing.ts
 *
 * Couyon's BBQ, Greg Kinder, $56.74 claimed. The slip prints:
 *
 *   Subtotal 43.95 · Tax 4.50 · NON CASH FEE 3.5% 1.70
 *   Dine In Total 50.15
 *   Amex #…1001   50.15
 *   Tip            6.59
 *   Total         56.74
 *
 * 50.15 + 6.59 = 56.74, which is what Amex was charged and exactly what was
 * claimed. The app flagged it "Over $6.59 — the receipt totals $50.15, less
 * than the $56.74 claimed", and told the reviewer "the printed total of
 * 56.74 is not what the card paid; the amount charged is 50.15" — backwards
 * in both halves.
 *
 * Two faults. The reader takes the card line as the charge, which is right
 * everywhere except a restaurant, where it is the PRE-AUTHORISATION. And
 * the comparison never considered the tip it had already read, so every
 * tipped meal in the queue was flagged — and a flag that is wrong about a
 * whole category of expense teaches people to wave that category through.
 *
 * Note the fee: 43.95 + 4.50 + 6.59 = 55.04, not 56.74. The parts-added-up
 * figure does NOT rescue this one, which is why the tipped total had to be
 * its own candidate.
 */

export {};

const { chargedTotal } = await import("../server/emburse/receipt-items.js");
const { chosenReceiptTotal } = await import("../server/rules/engine.js");
const { receiptTotalOf, verdictFor } = await import("../src/lib/receipt-verdict.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

type Read = { total: number | null; notes: string };

const reading = (over: Record<string, unknown> = {}) => ({
  model: "test", legible: true, merchant: "Couyon's", purchasedAt: "2026-09-03",
  currency: "USD", subtotal: 43.95, tax: 4.50, tip: 6.59, total: 56.74, paid: 50.15,
  items: [], notes: "", ...over,
} as never);

console.log("\n1. The reader keeps the printed total, not the pre-auth");
{
  const out: Read = chargedTotal(reading());
  check("the total stays 56.74", out.total === 56.74, String(out.total));
  check("…and it does not claim a correction it did not make",
    !/is not what the card paid/.test(out.notes), out.notes);
}

console.log("\n2. A card line that is NOT a pre-auth is still trusted");
{
  // No tip: the card line is the charge, as on every other receipt.
  const out: Read = chargedTotal(reading({ tip: null, total: 60.00, paid: 50.15 }));
  check("the card line still wins", out.total === 50.15, String(out.total));
  check("…and says so", /is not what the card paid/.test(out.notes), out.notes);

  // A tip that does NOT account for the gap must not rescue it either.
  const off: Read = chargedTotal(reading({ tip: 1.00, total: 60.00, paid: 50.15 }));
  check("a tip that does not reconcile does not rescue it", off.total === 50.15,
    String(off.total));
}

console.log("\n3. The comparison counts the tip, on both sides of the app");
{
  const claimed = 56.74;
  // What is already stored for this expense: total 50.15, tip 6.59.
  const stored = [{ total: 50.15, error: null, tip: 6.59 }];
  const client = receiptTotalOf(stored, claimed);
  check("the client reads it as 56.74", client === 56.74, String(client));

  const verdict = verdictFor(claimed, client, "x");
  check("…so the badge is a match", verdict?.verdict === "match", verdict?.message);

  // The server reaches the same figure through its arithmetic candidates,
  // which now carry total + tip as well as subtotal + tax + tip.
  const server = chosenReceiptTotal(5674, [5015], [5504, 5674]);
  check("the server agrees", server === 5674, String(server));
  check("…and the two halves match",
    (server === null ? null : server / 100) === client, `${server} vs ${client}`);
}

console.log("\n4. It cannot excuse a real overclaim");
{
  // Claimed 70.00 against a 50.15 receipt with a 6.59 tip: 56.74 is the
  // most the receipt can account for, and 70.00 is still over it.
  const stored = [{ total: 50.15, error: null, tip: 6.59 }];
  const client = receiptTotalOf(stored, 70);
  check("the tipped total does not answer, so it is not chosen",
    client === 50.15, String(client));
  const verdict = verdictFor(70, client, "x");
  check("…and the claim is still reported as over",
    verdict?.verdict === "claimed-more", verdict?.message);
}

console.log("\n4b. An invoice whose Total is the BALANCE DUE, not the charge");
/*
 * Gwinnett Chamber, $2,276.30 claimed. The invoice prints:
 *
 *   General Membership Dues … 2,276.30
 *   Upgrade Requested        -2,276.30
 *   Total 0.00 · Amt Paid 0.00 · Balance Due 0.00
 *
 * The card was charged $2,276.30. The printed total is what is still
 * OWED, which is nil because it was paid — and reading it as the receipt
 * total reported "$2,276.30 more than the receipt" against a receipt
 * that states the charge on its first line.
 */
{
  const claimed = 2276.30;
  const invoice = [{
    total: 0, error: null, tip: null,
    items: [{ amount: 2276.30 }, { amount: -2276.30 }],
  }];
  const client = receiptTotalOf(invoice, claimed);
  check("the lines answer the charge, so they are used", client === 2276.30, String(client));
  check("…and the badge is a match",
    verdictFor(claimed, client, "x")?.verdict === "match");

  // The server reaches the same figure through its arithmetic candidates.
  const server = chosenReceiptTotal(227630, [0], [227630]);
  check("the server agrees", server === 227630, String(server));

  // A genuinely zero receipt against a zero charge is untouched: there is
  // nothing to answer, and nothing is preferred over a printed 0.
  const comped = receiptTotalOf([{ total: 0, error: null, items: [{ amount: 0 }] }], 0);
  check("a zero receipt against a zero charge stays zero", comped === 0, String(comped));

  // And the lines must not rescue a claim they do not account for.
  const over = receiptTotalOf(invoice, 5000);
  check("lines that do not answer the claim are not chosen", over === 0, String(over));
  check("…so it is still reported as over",
    verdictFor(5000, over, "x")?.verdict === "claimed-more");
}

console.log("\n5. A receipt with no tip is untouched");
{
  const client = receiptTotalOf([{ total: 50.15, error: null, tip: null }], 56.74);
  check("still 50.15", client === 50.15, String(client));
  check("…and still flagged",
    verdictFor(56.74, client, "x")?.verdict === "claimed-more");
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
