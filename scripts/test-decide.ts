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


// ---------------------------------------------------------------------------
// The browser half. Runs against the stand-in Emburse, whose grid deliberately
// contains rows that differ from the target by one field each — a different
// person at the same amount, and the same person at $126.40 against $26.40.
// ---------------------------------------------------------------------------

const { startMock } = await import("./mock-emburse.js");
const mock = await startMock(5402, "/dev/null");

process.env.EMBURSE_LOGIN_EMAIL ||= "bot@example.invalid";
process.env.EMBURSE_LOGIN_PASSWORD ||= "not-a-real-password";
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "12000";

const { runDecision } = await import("../server/emburse/decide.js");

const SEL = {
  loginEmail: 'input[name="email"]',
  loginPassword: 'input[name="password"]',
  loginSubmit: 'button[type="submit"]',
  loggedIn: 'a:has-text("Transactions")',
  adminTab: 'a:has-text("ADMIN")',
  grid: "table",
  gridPath: "/transactions/team",
  resultRow: "table tbody tr",
  approveButton: 'button:has-text("APPROVE")',
};
const LOGIN = { userId: null, email: "bot@example.invalid", password: "x" };

const decide = (t: Target, dry = true) =>
  runDecision("approve", t, "", SEL, mock.url, LOGIN, { dryRun: dry });

console.log("\n7. Finding the row in a real grid");
mock.reset();
let run = await decide(TARGET);
for (const s of run.steps) console.log(`     ${s.ok ? "·" : "✗"} ${s.name.padEnd(28)} ${s.detail.slice(0, 80)}`);
check("found and verified the right row", run.ok);
check("the matched row is Brianna's $26.40",
  /Brianna Ruth/.test(run.matchedRow ?? "") && /26\.40/.test(run.matchedRow ?? ""),
  run.matchedRow ?? "none");
check("it is not the $126.40 row", !/126\.40/.test(run.matchedRow ?? ""));

console.log("\n8. An expense that is not there");
run = await decide({ ...TARGET, amount: 999.99 });
check("refused", !run.ok);
check("said none matched", /none of the .* rows match/.test(run.steps.find((s) => !s.ok)?.detail ?? ""),
  run.steps.find((s) => !s.ok)?.detail ?? "");

console.log("\n9. A person whose expense it is not");
run = await decide({ ...TARGET, employee: "Nobody Here" });
check("refused rather than taking the same-amount row", !run.ok);

await mock.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
