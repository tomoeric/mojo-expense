/**
 * Does the receipt total agree with the claim?
 *
 *   pnpm exec tsx scripts/test-receipt-verdict.ts
 *
 * This used to be a button. It re-fetched every receipt image and re-asked
 * the model for a total the importer had already read and stored, threw the
 * answer away on restart, and only ran when somebody remembered to press it
 * — so most expenses were never checked at all. It is a subtraction over
 * data that is already there.
 *
 * The direction is the whole point. Claiming MORE than the receipt shows is
 * worth a reviewer's time; claiming less is usually a split bill. Getting
 * the sign backwards would turn the useful half into noise and hide the rest.
 */

export {};

const { verdictFor } = await import("../src/lib/receipt-verdict.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("\nAgreement");
check("the same figure matches", verdictFor(141.24, 141.24, "a")?.verdict === "match");
check("a cent of rounding is not news", verdictFor(141.24, 141.25, "a")?.verdict === "match");
// 1% of a large claim is more than 2c, and a receipt read off a photograph
// is not a bank statement.
check("a proportional wobble on a big claim is tolerated",
  verdictFor(1000, 1007, "a")?.verdict === "match", verdictFor(1000, 1007, "a")?.verdict);

console.log("\nDisagreement, and which way round");
const more = verdictFor(200, 150, "a");
check("claiming MORE than the receipt is called out as that",
  more?.verdict === "claimed-more", more?.verdict);
check("…and the message says by how much", more?.message.includes("$50.00") === true, more?.message);
const less = verdictFor(150, 200, "a");
check("claiming LESS is a different verdict, not the same one",
  less?.verdict === "claimed-less", less?.verdict);
check("…and is named as the split bill it usually is",
  less?.message.includes("split bill") === true, less?.message);

console.log("\nNothing to say");
// A receipt nobody has read yet already says so where the items would be. A
// second badge beside it saying "unknown" is the same nothing twice.
check("an unread receipt gets no verdict rather than a bad one",
  verdictFor(141.24, null, "a") === null);
check("…and undefined behaves the same", verdictFor(141.24, undefined, "a") === null);
// Zero is a real total, not a missing one — a fully discounted receipt.
check("a genuine zero IS a verdict", verdictFor(141.24, 0, "a")?.verdict === "claimed-more",
  String(verdictFor(141.24, 0, "a")?.verdict));

console.log("\nThe numbers it reports");
const v = verdictFor(100, 80, "line-1");
check("the difference is receipt minus claim", v?.difference === -20, String(v?.difference));
check("it carries the line it is about", v?.lineId === "line-1");
check("and both figures, so the badge need not recompute them",
  v?.claimed === 100 && v?.receiptTotal === 80);

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
