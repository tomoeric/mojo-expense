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

console.log("\n3b. A credit is not a charge");
// Emburse writes a refund in accounting style — "($47.56)" — with no minus
// sign anywhere. Two bugs came out of that, and the second is the one that
// matters: "(" and "$" are neither digits nor separators, so they sailed
// through the boundary check and a $47.56 CHARGE matched a ($47.56) CREDIT.
// A car-rental row on a real grid reads ($47.56) with $636.79 under it — a
// charge sitting beside its own refund is ordinary, and this could have
// approved the wrong one.
{
  const at = (amount: number) =>
    ({ employee: "Brian Carroll", merchant: "NATIONAL CAR REN", amount, date: "2026-09-19" });
  const credit = "Sep 19, 2026 NATIONAL CAR REN... ($47.56) Credit Brian Carroll";
  const charge = "Sep 19, 2026 NATIONAL CAR REN... $47.56 rental Brian Carroll";
  const minus = "Sep 19, 2026 NATIONAL CAR REN... -$47.56 Credit Brian Carroll";

  check("a charge must NOT match the credit of the same size",
    !rowMatches(credit, at(47.56)).ok, rowMatches(credit, at(47.56)).why);
  check("…and says so, rather than 'not in the row' about a figure plainly there",
    /wrong sign/.test(rowMatches(credit, at(47.56)).why), rowMatches(credit, at(47.56)).why);
  check("a credit must NOT match the charge of the same size",
    !rowMatches(charge, at(-47.56)).ok, rowMatches(charge, at(-47.56)).why);
  // Before this, a refund could not be actioned at all: every approve or
  // deny of one failed with "amount -47.56 not in the row".
  check("a credit DOES match its own row, in brackets",
    rowMatches(credit, at(-47.56)).ok, rowMatches(credit, at(-47.56)).why);
  check("…and written with a minus sign instead",
    rowMatches(minus, at(-47.56)).ok, rowMatches(minus, at(-47.56)).why);
  check("an ordinary charge still matches its own row",
    rowMatches(charge, at(47.56)).ok, rowMatches(charge, at(47.56)).why);
  check("and a thousands separator is still read",
    rowMatches("NATIONAL CAR REN... $1,247.56 Brian Carroll Sep 19, 2026", at(1247.56)).ok);
}

console.log("\n3c. Merchants Emburse chopped in half");
// A real approval failed with "amount 39.94 not in the row" about a row
// plainly showing $39.94. Emburse truncates long merchant names mid-word,
// so the row read "… U-HAUL MOVING & STORAGE OU- $39.94" — and the trailing
// hyphen of the truncation was read as a MINUS SIGN, turning a charge into
// a credit. A hyphen inside a word is not a minus.
//
// The same row showed a second, older bug: punctuation was stripped from
// the merchant being looked FOR but not from the row looked IN, so "U-HAUL"
// became "UHAUL" and was hunted for in text containing "U-HAUL". No
// expense from a merchant whose first word carries punctuation could ever
// be matched — U-HAUL, 7-ELEVEN, McDonald's, any of them.
{
  const who = (employee: string, merchant: string, amount: number) =>
    ({ employee, merchant, amount, date: null });
  const truncated = "Sep 24, 2026 U-HAUL MOVING & STORAGE OU- $39.94 Palletizing SCHULTZ A HOWA";
  check("a hyphen from a chopped merchant name is not a minus sign",
    rowMatches(truncated, who("Howard Schultz", "U-HAUL MOVING & STORAGE", 39.94)).ok,
    rowMatches(truncated, who("Howard Schultz", "U-HAUL MOVING & STORAGE", 39.94)).why);
  check("…7-ELEVEN and friends are findable at all",
    rowMatches("Sep 24, 2026 7-ELEVEN #1234 $12.10 Snacks Howard Schultz",
      who("Howard Schultz", "7-ELEVEN #1234", 12.10)).ok);
  check("…and an ellipsis truncation still works",
    rowMatches("Sep 24, 2026 U-HAUL MOVING & ... $39.94 Palletizing SCHULTZ A HOWA",
      who("Howard Schultz", "U-HAUL MOVING & STORAGE", 39.94)).ok);
  // The point of the sign check must survive being loosened.
  check("a minus hard against the figure is still a minus",
    rowMatches("Sep 19, 2026 NATIONAL CAR REN -$47.56 Credit Brian Carroll",
      who("Brian Carroll", "NATIONAL CAR RENTAL", -47.56)).ok);
  check("…and one separated by a space",
    rowMatches("Sep 19, 2026 NATIONAL CAR REN - $47.56 Credit Brian Carroll",
      who("Brian Carroll", "NATIONAL CAR RENTAL", -47.56)).ok);
  check("…and a charge still does not match its own refund",
    !rowMatches("Sep 24, 2026 U-HAUL MOVING OU- $39.94 x SCHULTZ A HOWA",
      who("Howard Schultz", "U-HAUL MOVING", -39.94)).ok);
}

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

const { runDecision, DECISION_SELECTORS } = await import("../server/emburse/decide.js");

const SEL = {
  loginEmail: 'input[name="username"]',
  loginPassword: 'input[type="password"]',
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

console.log("\n10. A row selector that does not describe this tenant's grid");
// The failure a reviewer actually hit, after the grid gate was fixed: signed
// in, team view, grid on screen — "the search returned no rows". Which is
// true, and tells nobody what to do. The rows were there; "table tbody tr"
// simply did not describe them. So the message has to name what IS on the
// page, in enough detail to set the selector by hand.
mock.reset();
const blindRows = await runDecision(
  "approve", TARGET, "", { ...SEL, resultRow: "table tbody tr.no-such-class" },
  mock.url, LOGIN, { dryRun: true });
const why = blindRows.steps.find((s) => !s.ok)?.detail ?? "";
check("refused rather than guessing at a container", !blindRows.ok);
check("names the selector that found nothing", /no-such-class/.test(why), why.slice(0, 200));
check("…and lists what IS row-shaped on the page",
  /Row-shaped things that ARE here/.test(why) && /tr \u00d7/.test(why), why.slice(0, 300));
// Without a sample the counts are still a guessing game — "tr ×4" could be a
// nav bar. The text is what makes it identifiable as a grid row.
check("…with the text of one, so it can be identified as a grid row",
  /reads: /.test(why) && /DOORDASH/i.test(why), why.slice(0, 400));
// This sits one step from clicking APPROVE. Falling back to a broader
// selector is exactly how the wrong expense gets approved.
check("…and says plainly that nothing is guessed", /nothing is guessed here/.test(why));

console.log("\n11. A merchant search that returns a month of rows");
// What "search by name brings up all receipts" costs. DOORDASH returns
// everything anybody ordered; the target can be row 300. The read cap is
// real and has to be — but it used to report "none of the 340 rows match"
// after reading fifty, which is a false statement about the other 290, in
// the one place it matters: an expense that IS there gets reported missing.
mock.reset();
await fetch(`${mock.url}/__app?pad=300`, { method: "POST" });
const buried = await decide(TARGET);
const deep = buried.steps.find((s) => !s.ok)?.detail ?? "";
check("it does not claim to have checked rows it never read",
  !buried.ok && !/none of the \d+ rows match/.test(deep), deep.slice(0, 200));
check("…and says how many of how many it actually looked at",
  /looked at the first \d+ of \d+ rows/.test(deep), deep.slice(0, 220));
check("…naming the search that was too broad", /too broad/.test(deep) && /DOORDASH/i.test(deep),
  deep.slice(0, 260));

// And the cap is generous enough that an ordinary busy merchant still works.
mock.reset();
await fetch(`${mock.url}/__app?pad=100`, { method: "POST" });
const found = await decide(TARGET);
check("a hundred rows deep, it still finds the right one", found.ok,
  found.steps.find((s) => !s.ok)?.detail ?? "");
check("…and it is the right row", /26\.40/.test(found.matchedRow ?? "") &&
  /Brianna/.test(found.matchedRow ?? ""), found.matchedRow ?? "");

console.log("\n12. Emburse's real grid shape: divs with ARIA roles");
// spend.emburse.com does not build its transactions grid from a <table>.
// The shipped row selector was "table tbody tr" alone, so it matched
// nothing and every decision died at "the search returned no rows" — on a
// page that was fully loaded with the rows plainly on it.
mock.reset();
await fetch(`${mock.url}/__app?grid=divs`, { method: "POST" });
const divSel = { ...SEL, grid: '[role="grid"]', resultRow: DECISION_SELECTORS.resultRow };
const onDivs = await runDecision("approve", TARGET, "", divSel, mock.url, LOGIN, { dryRun: true });
check("the shipped row selector finds the row in a div grid", onDivs.ok,
  onDivs.steps.find((s) => !s.ok)?.detail ?? "");
check("…and it is the right one, not the $126.40 near-miss",
  /26\.40/.test(onDivs.matchedRow ?? "") && !/126\.40/.test(onDivs.matchedRow ?? ""),
  onDivs.matchedRow ?? "");
// The spacer row a virtualised grid puts in front of the data must not be
// mistaken for a row that failed to match.
check("…stepping over the empty spacer row rather than tripping on it",
  /matched 1 of/.test(onDivs.steps.find((s) => /search/.test(s.name))?.detail ?? ""),
  onDivs.steps.find((s) => /search/.test(s.name))?.detail ?? "");
// And the old shape still works — plenty of tenants are real tables.
mock.reset();
const onTable = await decide(TARGET);
check("a real <table> grid still works, so this is a widening not a swap",
  onTable.ok, onTable.steps.find((s) => !s.ok)?.detail ?? "");

console.log("\n13. Does DENY work, or only approve?");
// The dry run used to stop the instant the row was found, so it proved
// everything except the part most likely to break. Approve is one button
// inside the row; deny is a ⋮ menu, an item in it, a reason box and a
// confirm — four more selectors a green test never touched.
mock.reset();
const dryDeny = await runDecision("deny", TARGET, "over budget", SEL, mock.url, LOGIN, { dryRun: true });
check("a dry deny now reaches for the ⋮ menu and the Deny item", dryDeny.ok,
  dryDeny.steps.find((s) => !s.ok)?.detail ?? "");
check("…and says so, without denying anything",
  /opened its ⋮ menu and found Deny/.test(dryDeny.steps.at(-1)?.detail ?? ""),
  dryDeny.steps.at(-1)?.detail ?? "");

mock.reset();
const noMenu = await runDecision(
  "deny", TARGET, "x", { ...SEL, rowMenu: "button.no-such-menu" }, mock.url, LOGIN, { dryRun: true });
check("a missing ⋮ menu is caught BEFORE anything is denied", !noMenu.ok);
check("…and says approving would still work, so the two are not confused",
  /Approving would still work/.test(noMenu.steps.find((s) => !s.ok)?.detail ?? ""),
  noMenu.steps.find((s) => !s.ok)?.detail ?? "");

console.log("\n14. A click that lands on nothing must not report success");
// Both paths used to click, sleep 1.5s and say "approved in Emburse"
// whether or not anything happened — the worst failure available on an
// audit-relevant action: the queue says applied and the expense sits there.
mock.reset();
await fetch(`${mock.url}/__app?actions=dead`, { method: "POST" });
const deadClick = await runDecision("approve", TARGET, "", SEL, mock.url, LOGIN, {});
check("a dead APPROVE button is reported as a failure, not a success", !deadClick.ok,
  deadClick.steps.at(-1)?.detail ?? "");
check("…saying it may have gone through, since that is the honest state",
  /check the expense in Emburse/.test(deadClick.steps.find((s) => !s.ok)?.detail ?? ""),
  deadClick.steps.find((s) => !s.ok)?.detail ?? "");

console.log("\n15. And a click that works is confirmed, not assumed");
mock.reset();
const realApprove = await runDecision("approve", TARGET, "", SEL, mock.url, LOGIN, {});
check("approving is confirmed by the row leaving Needs Review", realApprove.ok,
  realApprove.steps.at(-1)?.detail ?? "");
check("…and says what confirmed it", /left Needs Review/.test(realApprove.steps.at(-1)?.detail ?? ""),
  realApprove.steps.at(-1)?.detail ?? "");

mock.reset();
const realDeny = await runDecision("deny", TARGET, "over budget", SEL, mock.url, LOGIN, {});
check("denying works end to end: menu, item, reason, confirm", realDeny.ok,
  realDeny.steps.at(-1)?.detail ?? "");
check("…and the reason is carried into the record",
  /over budget/.test(realDeny.steps.at(-1)?.detail ?? ""), realDeny.steps.at(-1)?.detail ?? "");

console.log("\n16. Progress while a batch runs");
// Three decisions take about three minutes, and with only a final result
// to go on the queue showed nothing for three minutes and then changed all
// three at once — which, while it is happening, is indistinguishable from
// nothing happening. Each one is now reported as it lands.
mock.reset();
const { runDecisions } = await import("../server/emburse/decide.js");
const asItLands: { id: number; ok: boolean; at: number }[] = [];
const batch = [
  { id: 1, decision: "approve" as const, target: TARGET, reason: null },
  { id: 2, decision: "approve" as const, target: { ...TARGET, amount: 999.99 }, reason: null },
  { id: 3, decision: "approve" as const,
    target: { ...TARGET, employee: "Kevin McBride" }, reason: null },
];
const out = await runDecisions(batch, SEL, mock.url, LOGIN, {
  dryRun: true,
  onResult: (id, run) => { asItLands.push({ id, ok: run.ok, at: Date.now() }); },
});
check("every decision is reported as it finishes, not only at the end",
  asItLands.length === 3, `${asItLands.length} reported`);
check("…in the order they were worked",
  asItLands.map((r) => r.id).join(",") === "1,2,3", asItLands.map((r) => r.id).join(","));
check("…before the batch as a whole returns",
  asItLands.every((r) => r.at <= Date.now()));
// The one that cannot be found must not take the others down with it.
check("a decision that fails does not stop the ones after it",
  out.get(1)?.ok === true && out.get(2)?.ok === false && out.get(3)?.ok === true,
  [1, 2, 3].map((i) => `${i}:${out.get(i)?.ok}`).join(" "));
// This is also what stops a batch that dies halfway leaving already-actioned
// decisions unrecorded.
check("…and each result is the same one the batch returns",
  asItLands.every((r) => out.get(r.id)?.ok === r.ok));

console.log("\n17. A hidden APPROVE ahead of the real one");
// What a real tenant produced: five green steps, then "approve —
// locator.click: Timeout 30000ms exceeded". A virtualised grid keeps hidden
// copies of its rows to measure them, so the FIRST APPROVE in the DOM is
// one that never becomes visible, and .first().click() waits out the whole
// timeout for it. The export has used a visible-only click for a long time;
// the decision path simply never got the same treatment.
mock.reset();
await fetch(`${mock.url}/__app?ghostButtons=true`, { method: "POST" });
const ghosted = await runDecision("approve", TARGET, "", SEL, mock.url, LOGIN, {});
check("it clicks the visible APPROVE, not the hidden one in front of it", ghosted.ok,
  ghosted.steps.find((s) => !s.ok)?.detail ?? "");
check("…and still confirms the row left Needs Review",
  /left Needs Review/.test(ghosted.steps.at(-1)?.detail ?? ""),
  ghosted.steps.at(-1)?.detail ?? "");

// And when EVERY match is hidden, it must say so rather than time out with
// a Playwright message that names no cause.
mock.reset();
await fetch(`${mock.url}/__app?ghostButtons=true`, { method: "POST" });
const allHidden = await runDecision(
  "approve", TARGET, "", { ...SEL, approveButton: 'button.ap[style*="none"]' },
  mock.url, LOGIN, {});
const hiddenWhy = allHidden.steps.find((s) => !s.ok)?.detail ?? "";
check("all-hidden is explained, not reported as a bare timeout", !allHidden.ok);
check("…naming them as the copies a grid renders to measure itself",
  /none of them is visible/.test(hiddenWhy) && !/Timeout \d+ms/.test(hiddenWhy),
  hiddenWhy.slice(0, 200));

// The dry run has to fail on it too, or it goes green and the real click
// times out — which is exactly how this shipped.
mock.reset();
await fetch(`${mock.url}/__app?ghostButtons=true`, { method: "POST" });
const dryHidden = await runDecision(
  "approve", TARGET, "", { ...SEL, approveButton: 'button.ap[style*="none"]' },
  mock.url, LOGIN, { dryRun: true });
check("a dry run does not go green on a button that can never be clicked",
  !dryHidden.ok, dryHidden.steps.at(-1)?.detail ?? "");
check("…and says approving would time out",
  /wait for it to appear and time out/.test(dryHidden.steps.find((s) => !s.ok)?.detail ?? ""),
  dryHidden.steps.find((s) => !s.ok)?.detail ?? "");

console.log("\n18. A PINNED Action column — the button is not inside the row");
// The real failure, after everything else was fixed: five green steps, the
// right row verified, then "no APPROVE button matched" on a page that
// visibly had APPROVE on that very row. Emburse pins the Action column, so
// it renders in its own container and the button is NOT a descendant of
// the row — only aligned with it on screen. True, and useless.
mock.reset();
await fetch(`${mock.url}/__app?grid=pinned`, { method: "POST" });
const pinnedSel = { ...SEL, grid: '[role="grid"]', resultRow: '[role="rowgroup"] [role="row"]' };
const dryPinned = await runDecision("approve", TARGET, "", pinnedSel, mock.url, LOGIN, { dryRun: true });
check("the dry run finds the button by the line it sits on", dryPinned.ok,
  dryPinned.steps.find((s) => !s.ok)?.detail ?? "");

mock.reset();
await fetch(`${mock.url}/__app?grid=pinned`, { method: "POST" });
const realPinned = await runDecision("approve", TARGET, "", pinnedSel, mock.url, LOGIN, {});
check("and approving actually goes through on a pinned grid", realPinned.ok,
  realPinned.steps.find((s) => !s.ok)?.detail ?? "");
check("…confirmed by the row leaving, not assumed",
  /left Needs Review/.test(realPinned.steps.at(-1)?.detail ?? ""),
  realPinned.steps.at(-1)?.detail ?? "");
check("…and it is the right row, not the $126.40 near-miss",
  /26\.40/.test(realPinned.matchedRow ?? "") && !/126\.40/.test(realPinned.matchedRow ?? ""),
  realPinned.matchedRow ?? "");

mock.reset();
await fetch(`${mock.url}/__app?grid=pinned`, { method: "POST" });
const denyPinned = await runDecision("deny", TARGET, "over budget", pinnedSel, mock.url, LOGIN, {});
check("denying works on a pinned grid too — the ⋮ is in the same column", denyPinned.ok,
  denyPinned.steps.find((s) => !s.ok)?.detail ?? "");

// The safety that must survive the new lookup: alignment is a heuristic,
// and two controls on one line means the rows are not what this thinks
// they are. Clicking either would pick somebody's expense at random.
mock.reset();
await fetch(`${mock.url}/__app?grid=pinned`, { method: "POST" });
const ambiguous = await runDecision(
  "approve", TARGET, "", { ...pinnedSel, approveButton: "button" }, mock.url, LOGIN, {});
check("two controls on one line is refused, not guessed at", !ambiguous.ok);
check("…saying which ones could not be told apart",
  /line up with this row/.test(ambiguous.steps.find((s) => !s.ok)?.detail ?? ""),
  ambiguous.steps.find((s) => !s.ok)?.detail ?? "");

await mock.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
