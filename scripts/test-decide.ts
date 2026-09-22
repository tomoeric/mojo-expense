/**
 * Check the rule that decides a grid row is the expense you clicked.
 *
 *   pnpm exec tsx scripts/test-decide.ts
 *
 * This is the only thing standing between "approve this expense" and
 * "approve some other person's expense that happened to come up in the same
 * search". A false negative is a refusal somebody notices; a false positive is
 * money approved that nobody chose, discovered later if at all. The cases below
 * are weighted accordingly — most of them are near-misses that must be refused.
 */

import { rowMatches, type Target } from "../server/emburse/decide.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const TARGET: Target = {
  employee: "Brianna Ruth",
  merchant: "DOORDASH INC.",
  amount: 26.4,
  date: "2026-09-13",
};

const accepts = (label: string, row: string, target: Target = TARGET) => {
  const r = rowMatches(row, target);
  check(label, r.ok, r.ok ? r.why : `refused: ${r.why}`);
};
const refuses = (label: string, row: string, target: Target = TARGET) => {
  const r = rowMatches(row, target);
  check(label, !r.ok, r.ok ? "ACCEPTED — it should not have" : r.why);
};

console.log("\n1. The row it should match");
accepts("the obvious form", "9/13/2026 DOORDASH INC. Brianna Ruth Meals $26.40");
accepts("zero-padded date", "09/13/2026 DOORDASH INC. Brianna Ruth Meals $26.40");
accepts("short month form", "Sep 13 DOORDASH INC. Brianna Ruth Meals $26.40");
accepts("merchant truncated by the grid", "9/13/2026 DOORDASHDOORDASH,… Brianna Ruth $26.40");
accepts("odd whitespace", "  9/13/2026\n DOORDASH INC.\tBrianna  Ruth   $26.40 ");

console.log("\n2. Near misses that must be refused");
refuses("same everything, different amount", "9/13/2026 DOORDASH INC. Brianna Ruth $26.41");
refuses("a transposed amount", "9/13/2026 DOORDASH INC. Brianna Ruth $24.60");
refuses("same amount, different person", "9/13/2026 DOORDASH INC. Kevin McBride $26.40");
refuses("same amount and person, different day", "9/14/2026 DOORDASH INC. Brianna Ruth $26.40");
refuses("same amount and person, different merchant", "9/13/2026 SHELL OIL Brianna Ruth $26.40");
refuses("an empty row", "");
refuses("a header row", "Transaction Date Merchant Amount Employee");

console.log("\n3. The amount is matched exactly, not loosely");
refuses("26.40 must not match 126.40", "9/13/2026 DOORDASH INC. Brianna Ruth $126.40",
  { ...TARGET, amount: 6.4 });
refuses("26.40 must not match inside 1,226.40",
  "9/13/2026 DOORDASH INC. Brianna Ruth $1,226.40");
accepts("…while the row it really belongs to still matches",
  "9/13/2026 DOORDASH INC. Brianna Ruth $1,226.40", { ...TARGET, amount: 1226.4 });

console.log("\n4. Missing fields do not silently pass");
refuses("no amount at all", "9/13/2026 DOORDASH INC. Brianna Ruth Meals");
refuses("amount present but nothing else", "$26.40");

console.log("\n5. A target with no date still needs the rest");
const undated: Target = { ...TARGET, date: null };
accepts("matches when the date is unknown", "DOORDASH INC. Brianna Ruth $26.40", undated);
refuses("but not a different person", "DOORDASH INC. Kevin McBride $26.40", undated);

console.log("\n6. Short merchant names are not used as evidence");
const bp: Target = { ...TARGET, merchant: "BP" };
// "BP" would appear inside thousands of unrelated words, so a merchant
// shorter than four characters is deliberately not part of the test.
accepts("a two-letter merchant is skipped rather than mismatched",
  "9/13/2026 SOMETHING ELSE Brianna Ruth $26.40", bp);
check("…and the row still had to match on person, amount and date",
  !rowMatches("9/13/2026 SOMETHING ELSE Kevin McBride $26.40", bp).ok);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
