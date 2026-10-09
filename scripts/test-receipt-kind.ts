/**
 * Two things a reviewer needs to ask of an uploaded "receipt".
 *
 *   pnpm exec tsx scripts/test-receipt-kind.ts
 *
 * "I need a rule that flags receipt uploads that are lost receipt forms,
 * and another for non-itemised receipts (paper)."
 *
 * Neither could be written before. The reader already decided `itemised`
 * but only ever folded it into `receiptReadable`, so "the receipt does not
 * say what was bought" could only be asked as "the receipt is not readable"
 * — a different sentence, and one that is false about a perfectly crisp
 * card slip. And nothing at all distinguished a Missing Receipt Affidavit
 * from a receipt: it reads cleanly, itemises nothing, and sailed through as
 * an unremarkable non-itemised upload.
 *
 * The fail-safe matters more here than the match. An unread receipt must
 * answer NEITHER question rather than answering "no" to both, or the first
 * rule somebody writes flags the whole queue on the strength of readings
 * that have not happened yet.
 */
import { evaluate, type RuleBody, type Subject } from "../server/rules/engine.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const expense = (over: Partial<Subject> = {}): Subject => ({
  dedupeKey: "k", employee: "Pat Lee", title: "", merchant: "HOME DEPOT",
  note: "Parts", category: "Repairs & Maintenance", location: "Richland",
  department: "Operations and Field", method: "Corporate card", amountCents: 11655,
  hasReceipt: true, receiptItems: "", inInbox: true,
  receiptTotalCents: 11655, receiptTotalsCents: [11655],
  receiptAlcohol: false, receiptReadable: true,
  receiptItemised: true, receiptSubstitute: false, receiptFuel: false,
  receiptSharedWith: 1, receiptSplitAddsUp: false, countsTowardsDay: true,
  receiptDate: "2026-09-23", receiptMerchant: "Home Depot",
  date: "2026-09-23", ...over,
});

const rule = (over: Partial<RuleBody>): RuleBody => ({
  name: "r", enabled: true, match: "all", when: [], must: null,
  action: "flag", message: "", ...over,
});

const verdict = (r: RuleBody, s: Subject) => evaluate(s, r);

console.log("1. Flag a lost-receipt form");
const LOST = rule({
  name: "Lost receipt form",
  when: [{ field: "receiptSubstitute", op: "is", value: "yes" }],
  message: "This is a lost-receipt form, not a receipt.",
});
check("a declaration the employee filled in is flagged",
  verdict(LOST, expense({ receiptSubstitute: true })) === "fail");
check("…and a real receipt is left alone",
  verdict(LOST, expense({ receiptSubstitute: false })) === "not-applicable");
// The whole point of the field: a form reads perfectly and itemises
// nothing, so without it the only rule that caught it was one about
// itemisation, which says the wrong thing to the employee.
check("…even though a form reads cleanly",
  verdict(LOST, expense({ receiptSubstitute: true, receiptReadable: true })) === "fail");

console.log("\n2. Flag a receipt that does not say what was bought");
const PAPER = rule({
  name: "Not itemised",
  when: [{ field: "receiptItemised", op: "is", value: "no" }],
  message: "The receipt shows a total but not what was bought.",
});
check("a card slip with only a total is flagged",
  verdict(PAPER, expense({ receiptItemised: false })) === "fail");
check("…and an itemised till receipt is not",
  verdict(PAPER, expense({ receiptItemised: true })) === "not-applicable");

console.log("\n3. Neither rule may act on a receipt nobody has read");
// This is the one that would hurt. Null means "not known", and a rule that
// reads it as "no" flags every expense whose receipt is still in the queue
// to be read — which, after an import, is all of them.
check("an unread receipt is not a lost-receipt form",
  verdict(LOST, expense({ receiptSubstitute: null })) === "not-applicable");
check("…and is not an un-itemised one either",
  verdict(PAPER, expense({ receiptItemised: null })) === "not-applicable");
check("“is not yes” does not catch it either",
  verdict(rule({ when: [{ field: "receiptSubstitute", op: "is_not", value: "yes" }] }),
    expense({ receiptSubstitute: null })) === "not-applicable");

console.log("\n4. And there is still a way to ASK for the unanswered ones");
check("is blank finds a receipt nobody has read",
  verdict(rule({ when: [{ field: "receiptItemised", op: "is_blank", value: "" }] }),
    expense({ receiptItemised: null })) === "fail");
check("…and not one that has been",
  verdict(rule({ when: [{ field: "receiptItemised", op: "is_blank", value: "" }] }),
    expense({ receiptItemised: false })) === "not-applicable");

console.log("\n5. The two are independent");
// A form is not merely un-itemised and an un-itemised receipt is not a
// form. Collapsing them would tell half the employees the wrong thing.
check("a form that happens to list items is still a form",
  verdict(LOST, expense({ receiptSubstitute: true, receiptItemised: true })) === "fail");
check("…and an un-itemised real receipt is not a form",
  verdict(LOST, expense({ receiptSubstitute: false, receiptItemised: false })) === "not-applicable");

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
