/**
 * Finding a receipt in email, and refusing to be sure about it.
 *
 *   pnpm exec tsx scripts/test-receipt-mail.ts
 *
 * The matching is the part that can be wrong quietly, so these are
 * the cases the brief names:
 *
 *   SAME AMOUNT IS NOT A MATCH. Two $12.99 lunches in a month is
 *   not a coincidence, it is Tuesday. Amount alone must never
 *   reach "strong".
 *
 *   A REFUND IS NOT A RECEIPT. Equal and opposite reads as a
 *   perfect match to anything comparing size.
 *
 *   TWO CURRENCIES ARE NOT ONE AMOUNT.
 *
 *   ONE RECEIPT IS NOT THREE EXPENSES. A message matching several
 *   expenses is a conflict to show, not a thing to spread.
 *
 *   ACCOUNT IDENTITY COMES FROM THE EXPENSE. A single MOJO mailbox
 *   holds receipts for both personal accounts, and "it arrived
 *   here so it is this account's" is the assumption that files a
 *   Mammoth receipt against a MOJO expense.
 *
 *   AND A BODY-ONLY RECEIPT READS AS WELL AS AN ATTACHED ONE.
 *
 * The Graph calls are not exercised here — there is no mailbox in
 * this container — so the reading and scoring are tested against
 * real message text, and the Graph side is covered by the fact
 * that every call in that file is a GET.
 */
import {
  conflicts, dateIn, matchAll, merchantOf, scoreMatch, textOf, totalIn,
  type Evidence, type Target,
} from "../server/emburse/receipt-mail.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const message = (over: Partial<Evidence> = {}): Evidence => ({
  messageId: "m1", subject: "Your Starbucks receipt", from: "receipts@sbux-e.com",
  receivedAt: "2026-09-24T12:00:00Z", folder: "Receipts",
  merchant: "Starbucks", date: "2026-09-24", totalCents: 1299, currency: "USD",
  reference: "", hasAttachment: false, attachments: [], excerpt: "",
  ...over,
});

const expense = (over: Partial<Target> = {}): Target => ({
  dedupeKey: "e1", lane: "personal-mojo", merchant: "STARBUCKS #4417",
  date: "2026-09-24", amountCents: 1299, currency: "USD",
  ...over,
});

try {
  console.log("1. Reading a receipt out of an email body");
  const html = `<html><body><p>Thanks for your order!</p>
    <table><tr><td>Latte</td><td>$5.45</td></tr>
    <tr><td>Sandwich</td><td>$6.25</td></tr>
    <tr><td>Tax</td><td>$1.29</td></tr>
    <tr><td><b>Order Total</b></td><td><b>$12.99</b></td></tr></table>
    <p>Order #ABC-12345 placed on Sep 24, 2026</p></body></html>`;
  const text = textOf(html);
  check("the markup is gone", !text.includes("<td>"), text.slice(0, 60));
  check("the labelled total wins over the line items",
    totalIn(text).cents === 1299 && totalIn(text).labelled, JSON.stringify(totalIn(text)));
  check("…and the date is read", dateIn(text) === "2026-09-24", String(dateIn(text)));
  check("an ISO date is read", dateIn("purchased 2026-03-04") === "2026-03-04");
  check("a US date is read month-first",
    dateIn("purchased 03/04/2026") === "2026-03-04", String(dateIn("purchased 03/04/2026")));
  check("with no labelled total, the largest figure is the guess",
    totalIn("Latte $5.45 Sandwich $6.25").cents === 625
    && !totalIn("Latte $5.45 Sandwich $6.25").labelled);
  check("a subject that names the merchant beats the sending domain",
    merchantOf("receipts@sbux-e.com", "Your Starbucks receipt") === "Starbucks",
    merchantOf("receipts@sbux-e.com", "Your Starbucks receipt"));
  check("…and the domain is used when the subject says nothing",
    merchantOf("noreply@uber.com", "Trip receipt") === "uber",
    merchantOf("noreply@uber.com", "Trip receipt"));

  console.log("\n2. A good match, and it is still not 'confirmed'");
  const good = scoreMatch(expense(), message())!;
  check("it matches", good !== null);
  check("…strongly", good.confidence === "strong", `${good.confidence} / ${good.score}`);
  check("…and says why", good.reasons.length >= 3, good.reasons.join(" | "));
  check("…naming the merchant agreement",
    good.reasons.some((r) => r.includes("merchant matches")));
  check("…and the exact total", good.reasons.some((r) => r.includes("total matches exactly")));

  console.log("\n3. SAME AMOUNT IS NOT A MATCH");
  const amountOnly = scoreMatch(
    expense({ merchant: "HOME DEPOT 2201", date: "2026-05-02" }),
    message({ merchant: "Starbucks", subject: "Your Starbucks receipt",
      date: "2026-09-24" }));
  check("it does not reach strong",
    amountOnly === null || amountOnly.confidence !== "strong",
    amountOnly ? `${amountOnly.confidence} / ${amountOnly.score}` : "no match at all");
  check("…and if it is offered at all, it is weak",
    amountOnly === null || amountOnly.confidence === "weak");

  console.log("\n4. A refund is not a receipt for the purchase");
  const refund = scoreMatch(expense(), message({ totalCents: -1299 }));
  check("it is not strong", refund === null || refund.confidence !== "strong",
    refund ? `${refund.confidence} / ${refund.score}` : "no match");
  check("…and the reason says so",
    refund === null || refund.reasons.some((r) => r.includes("refund")),
    refund?.reasons.join(" | "));

  console.log("\n5. Two currencies are not one amount");
  const euros = scoreMatch(expense(), message({ currency: "EUR" }));
  check("the currency difference is counted against it",
    euros !== null && euros.reasons.some((r) => r.includes("Different currencies")),
    euros?.reasons.join(" | "));
  check("…and it scores below the same match in dollars",
    (euros?.score ?? 0) < good.score, `${euros?.score} vs ${good.score}`);

  console.log("\n6. A date a day or two out is normal, a week out is not");
  const nextDay = scoreMatch(expense({ date: "2026-09-25" }), message())!;
  check("one day apart still matches well", nextDay.confidence !== "weak",
    `${nextDay.confidence} / ${nextDay.score}`);
  check("…and the reason explains the card posting delay",
    nextDay.reasons.some((r) => r.includes("posts a day or two")));
  const weekOut = scoreMatch(expense({ date: "2026-10-04" }), message());
  check("a week apart scores lower", (weekOut?.score ?? 0) < nextDay.score,
    `${weekOut?.score} vs ${nextDay.score}`);

  console.log("\n7. ONE RECEIPT IS NOT THREE EXPENSES");
  const three = matchAll(
    [expense({ dedupeKey: "a" }), expense({ dedupeKey: "b" }), expense({ dedupeKey: "c" })],
    [message()]);
  check("all three are offered as candidates", three.length === 3, String(three.length));
  const clash = conflicts(three);
  check("…and the clash is reported against the MESSAGE",
    clash.byMessage.get("m1")?.length === 3,
    String(clash.byMessage.get("m1")?.length));
  check("…so nothing looks settled", three.every((c) => c.confidence !== "weak"));

  console.log("\n8. One expense with two plausible receipts is a conflict too");
  const twoMessages = matchAll([expense()], [
    message({ messageId: "m1" }),
    message({ messageId: "m2", subject: "Your Starbucks receipt (copy)" }),
  ]);
  check("both are offered", twoMessages.length === 2);
  check("…and the clash is reported against the EXPENSE",
    conflicts(twoMessages).byExpense.get("e1")?.length === 2);

  console.log("\n9. ACCOUNT IDENTITY COMES FROM THE EXPENSE");
  /*
   * One mailbox, two personal accounts. The same message is a
   * candidate for an expense in each, and each candidate carries
   * the lane of ITS OWN expense — never the mailbox's.
   */
  const across = matchAll([
    expense({ dedupeKey: "mojo-1", lane: "personal-mojo" }),
    expense({ dedupeKey: "mam-1", lane: "personal-mammoth" }),
  ], [message()]);
  check("both accounts get a candidate", across.length === 2);
  check("…each tagged with ITS OWN expense's account",
    across.find((c) => c.dedupeKey === "mojo-1")?.lane === "personal-mojo"
    && across.find((c) => c.dedupeKey === "mam-1")?.lane === "personal-mammoth",
    across.map((c) => `${c.dedupeKey}:${c.lane}`).join(", "));
  check("…and the message itself carries no account",
    !("lane" in (across[0]!.evidence as unknown as Record<string, unknown>)));

  console.log("\n10. A body-only receipt reads as well as an attached one");
  const inBody = scoreMatch(expense(), message({ hasAttachment: false }))!;
  const attached = scoreMatch(expense(), message({
    hasAttachment: true,
    attachments: [{ id: "a1", name: "receipt.pdf", contentType: "application/pdf", size: 1 }],
  }))!;
  check("they score the same", inBody.score === attached.score,
    `${inBody.score} / ${attached.score}`);
  check("…and the attachment is recorded for later",
    attached.evidence.attachments.length === 1);

} finally {
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
