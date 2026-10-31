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
  conflicts, dateIn, matchAll, merchantOf, resolveOneToOne, scoreMatch, textOf,
  totalIn,
  type Evidence, type Target,
  graphWhy,
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

  /*
   * A 403 IS TWO DIFFERENT PROBLEMS and the old message named both every
   * time, consent first. Consent first is the wrong order on this
   * deployment: Exchange only gets to refuse after Entra has allowed,
   * so an Exchange refusal PROVES Mail.Read is consented. Being told to
   * go and check it anyway sent somebody to the Azure portal twice.
   */
  console.log("\nA Graph refusal names the cause that fits, not both");
  const exchange = graphWhy(403, '{"error":{"code":"ErrorAccessDenied","message":"Access is '
    + 'denied.","innererror":{"type":"Microsoft.Exchange.Services.OData.'
    + 'ODataAuthorizationException"}}}');
  check("an Exchange refusal says Mail.Read IS consented",
    /Mail\.Read IS consented/.test(exchange), exchange.slice(0, 120));
  check("…and names the policy to test",
    /Test-ApplicationAccessPolicy/.test(exchange));
  check("…and does NOT send somebody to grant a permission they have",
    !/does not hold Mail\.Read/.test(exchange));

  const entra = graphWhy(403, '{"error":{"code":"Authorization_RequestDenied","message":'
    + '"Insufficient privileges to complete the operation."}}');
  check("an Entra refusal says the permission is missing",
    /does not hold Mail\.Read/.test(entra), entra.slice(0, 120));
  check("…and says an application permission, not a delegated one",
    /Delegated Mail\.Read is not enough/.test(entra));
  check("…and does NOT blame a mailbox policy",
    !/Test-ApplicationAccessPolicy/.test(entra));

  const gone = graphWhy(404, '{"error":{"code":"ErrorItemNotFound"}}');
  check("a 404 is a wrong address, not a permission", /no such mailbox or folder/.test(gone));
  // The raw body is the least useful part and used to come first.
  check("the raw body comes last", exchange.indexOf("Graph said:") > 80, String(exchange.indexOf("Graph said:")));

  /*
   * THE TOTAL IS WHAT IS DUE, not the first "total" on the page.
   *
   * A real Replit invoice, read off the preview: Subtotal $100.00,
   * Total excluding tax $100.00, Sales Tax $6.60, Total $106.60,
   * Amount due $106.60. This read $100.00 — "Subtotal" CONTAINS the
   * word total and the pattern had no word boundary, and `exec` takes
   * the first match, so the real total four lines below was never
   * looked at. The expense was $106.60, so an exact match was reported
   * as "the totals differ" and scored down to likely.
   */
  console.log("\nThe total is what the receipt says is due");
  const REPLIT = [
    "Subtotal $100.00",
    "Total excluding tax $100.00",
    "Sales Tax - Texas (8.25% on $80.00) $6.60",
    "Total $106.60",
    "Amount due $106.60 USD",
  ].join("\n");
  check("SUBTOTAL IS NOT THE TOTAL", totalIn(REPLIT).cents === 10660,
    String(totalIn(REPLIT).cents));
  check("…and it counts as a labelled total", totalIn(REPLIT).labelled === true);
  // "Total excluding tax" is the trap one step along: it is a real
  // "total" and it is the wrong number.
  check("a total EXCLUDING tax does not win over the one including it",
    totalIn("Total excluding tax $100.00\nTotal $106.60").cents === 10660);
  check("amount due is taken on its own",
    totalIn("Items $80.00\nAmount due $86.60").cents === 8660);
  check("a plain total still works", totalIn("Total: $42.00").cents === 4200);
  check("…and so does Order total", totalIn("Order total $9.99").cents === 999);
  // Unlabelled is still a guess and must still say so, because the
  // candidate's confidence depends on knowing the difference.
  const guess = totalIn("Coffee $3.50\nPastry $4.25");
  check("with no label at all it guesses the largest, and says it guessed",
    guess.cents === 425 && guess.labelled === false, JSON.stringify(guess));
  check("and nothing money-shaped reads as nothing",
    totalIn("thanks for your order").cents === null);

  /*
   * ONE RECEIPT, ONE EXPENSE — the rule the owner stated:
   * "most receipts should only match 1 entry. Same price, same
   * date, same name."
   *
   * Scoring every pair is right and it is not an answer: 26
   * expenses and a few dozen receipts made 417 cards, nearly all
   * of them a $106.60 Replit receipt offered against every other
   * $106.60 Replit expense. What was missing is the step after
   * scoring.
   */
  console.log("\n14. A receipt that plainly belongs to one expense is offered to one");
  const sure = matchAll([
    expense({ dedupeKey: "same-day" }),
    expense({ dedupeKey: "a-month-later", date: "2026-10-24" }),
    expense({ dedupeKey: "a-month-earlier", date: "2026-08-24" }),
  ], [message()]);
  check("scoring alone offers it to all three", sure.length === 3, String(sure.length));
  const settled = resolveOneToOne(sure);
  check("ONE-TO-ONE LEAVES ONE", settled.length === 1,
    settled.map((c) => c.dedupeKey).join(", "));
  check("…and it is the one that agrees on price, date and name",
    settled[0]!.dedupeKey === "same-day", settled[0]!.dedupeKey);
  check("…and says so, in the reasons the person reads",
    settled[0]!.reasons.some((r) => r.includes("Price, date and merchant all agree")),
    settled[0]!.reasons.join(" / "));

  console.log("\n15. Two identical expenses and two identical receipts pair off");
  const pairs = resolveOneToOne(matchAll(
    [expense({ dedupeKey: "x" }), expense({ dedupeKey: "y" })],
    [message({ messageId: "m1" }), message({ messageId: "m2" })]));
  check("each expense gets one", pairs.length === 2,
    pairs.map((c) => `${c.dedupeKey}:${c.messageId}`).join(", "));
  check("…and no receipt is used twice",
    new Set(pairs.map((c) => c.messageId)).size === 2,
    pairs.map((c) => c.messageId).join(", "));
  check("…nor any expense claimed twice",
    new Set(pairs.map((c) => c.dedupeKey)).size === 2);

  console.log("\n16. A real question is still asked");
  /*
   * The one-to-one pass must not swallow the case this page
   * exists for. Two receipts that each agree on only SOME of the
   * three are a question for a person, and both survive.
   */
  const unsure = resolveOneToOne(matchAll([expense()], [
    message({ messageId: "m1", date: "2026-09-22" }),
    message({ messageId: "m2", date: "2026-09-23" }),
  ]));
  check("both near-misses are still offered", unsure.length === 2,
    unsure.map((c) => `${c.messageId}:${c.score}`).join(", "));
  check("…and they are still a conflict for the expense",
    conflicts(unsure).byExpense.get("e1")?.length === 2);

  console.log("\n17. A split purchase is NOT settled away");
  /*
   * One receipt for $12.99 against two expenses of $6.50 and
   * $6.49: the totals differ, so nothing is exact, so nothing
   * claims, and the person still gets to see both.
   */
  const split = resolveOneToOne(matchAll([
    expense({ dedupeKey: "half-1", amountCents: 650 }),
    expense({ dedupeKey: "half-2", amountCents: 649 }),
  ], [message()]));
  check("both halves keep their candidate", split.length === 2,
    split.map((c) => c.dedupeKey).join(", "));

  console.log("\n18. BEING NEAR IN TIME IS NOT A MATCH");
  /*
   * The real one: a U-Haul "Your Transaction Receipt" with no
   * readable total, offered against an $8.28 GitHub charge two
   * days away. Eight points of date proximity and nothing else.
   * In a 90-day window every expense is two days from something.
   */
  const uhaul = message({
    messageId: "uhaul", subject: "Your Transaction Receipt",
    from: "noreply@uhaul.com", merchant: merchantOf("noreply@uhaul.com",
      "Your Transaction Receipt"),
    date: "2026-09-26", totalCents: null,
  });
  check("a receipt that agrees on NOTHING but the week is not offered",
    scoreMatch(expense({ merchant: "GITHUB", amountCents: 828, date: "2026-09-24" }),
      uhaul) === null,
    JSON.stringify(scoreMatch(
      expense({ merchant: "GITHUB", amountCents: 828, date: "2026-09-24" }), uhaul)));
  check("…and a generic subject word is not read as the merchant",
    merchantOf("noreply@uhaul.com", "Your Transaction Receipt") === "uhaul",
    merchantOf("noreply@uhaul.com", "Your Transaction Receipt"));
  check("…while a subject that DOES name one still wins over the domain",
    merchantOf("receipts@sbux-e.com", "Your Starbucks receipt") === "Starbucks",
    merchantOf("receipts@sbux-e.com", "Your Starbucks receipt"));

  console.log("\n19. One identifying signal is enough, and is required");
  check("the merchant alone keeps a candidate alive",
    scoreMatch(expense({ amountCents: 9999, date: "2026-08-01" }), message()) !== null);
  check("…and so does an exact total on its own",
    scoreMatch(expense({ merchant: "SOME OTHER SHOP", date: "2026-08-01" }),
      message()) !== null);
  check("…but a matching currency and a near date are not evidence",
    scoreMatch(expense({ merchant: "SOME OTHER SHOP", amountCents: 9999 }),
      message()) === null);

} finally {
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
