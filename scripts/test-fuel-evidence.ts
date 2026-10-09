/**
 * "Gas powered pressure washer" is not a fuel purchase.
 *
 *   pnpm exec tsx scripts/test-fuel-evidence.ts
 *
 * The Gas Category rule asked the NOTE alone — contains "gas", category
 * is not Auto Fee & Fuel, flag it. So a $114.40 invoice from a
 * cleaning-systems supplier for two 10" foam tires and two caps, noted
 * "Replacing gas powered pressure washer wheels", came back as "Fuel
 * Category Is Wrong". The auto-category sweep then correctly refused to
 * touch it, because it asks for a witness on the paper as well — and the
 * two numbers disagreeing with no way to explain the gap is its own
 * problem.
 *
 * A note is the submitter's words ABOUT a purchase, never evidence of
 * what was bought. The receipt and the merchant are evidence, so this is
 * the question a rule should be able to ask, and it is now the same
 * question the sweep asks.
 */
import { fuelEvidence, FUEL_LINE, NOTE_SAYS_FUEL } from "../server/rules/fuel.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};
const read = (lines: string, merchantText = "") =>
  fuelEvidence({ lines, merchantText, read: true });

console.log("1. The invoice that started this");
// Undertmark Cleaning Systems, $114.40: 10" Foam Tire x2, Cap x2.
const UNDERTMARK = '10" Foam Tire | Cap';
check("two foam tires and a cap are not fuel",
  read(UNDERTMARK, "HUNDERTMARK CLEANING SYSTEMS") === false);
check("…even though the note says gas",
  NOTE_SAYS_FUEL.test("Replacing gas powered pressure washer wheels")
  && read(UNDERTMARK, "HUNDERTMARK CLEANING SYSTEMS") === false);

console.log("\n2. Real fuel still reads as fuel");
check("a pump line on the receipt", read("UNLD CR #08 20.287G SELF @ 3.999/G") === true);
check("diesel", read("DIESEL #2  14.009 GAL") === true);
check("a fuel merchant with an unreadable slip",
  fuelEvidence({ lines: "", merchantText: "SHELL OIL PRODUCTS US", read: false }) === true);
check("…and a forecourt brand the card feed mangles",
  read("", "RW6708RACETRAC INC") === true);

console.log("\n3. Words that merely contain a fuel word");
// A substring match is why this is regex and word-bounded: a maintenance
// team buys these, and each one would otherwise read as fuel.
check("galvanised pipe is not gallons", read("GALVANISED PIPE 3/4") === false);
check("a defrost timer is not DEF", read("DEFROST TIMER ASSY") === false);
check("a gasket is not gas",
  read("HEAD GASKET SET") === false && !NOTE_SAYS_FUEL.test("gasket replacement"));
check("…and the note test is word-bounded too",
  NOTE_SAYS_FUEL.test("gas for the truck") && !NOTE_SAYS_FUEL.test("gaskets and seals"));

console.log("\n4. Nothing read yet is never a 'no'");
// The failure that would hurt: right after an import nothing has been
// read, and a rule reading null as "no" acts on the whole queue.
check("an unread receipt from an unknown merchant says nothing",
  fuelEvidence({ lines: "", merchantText: "MENARDS 3192", read: null }) === null);
check("…but a fuel merchant is evidence without any reading",
  fuelEvidence({ lines: "", merchantText: "CIRCLE K #5368", read: null }) === true);
check("…and a reading that produced no usable lines still says nothing",
  fuelEvidence({ lines: "", merchantText: "MENARDS 3192", read: false }) === null);

console.log("\n5. The line test itself");
check("gallons", FUEL_LINE.test("12.004 GALLONS"));
check("price per gallon", FUEL_LINE.test("PRICE/G 3.459"));
check("not a gallon of paint by accident", !FUEL_LINE.test("GALLERY FRAME 11X14"));

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
