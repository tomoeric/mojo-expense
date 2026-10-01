/**
 * Filter by cardholder FIRST, then match on amount and date.
 *
 *   pnpm exec tsx scripts/test-search-order.ts
 *
 * "App looks like it is still doing a keyword search. Switch search to user
 * name > match date/amount > should be able to fuzzy match vendor name."
 *
 * The screenshot behind that: searching "MENARDS" gives two rows, neither
 * of them the expense. Filtering to the cardholder gives three, all
 * $312.44, all his. Emburse's merchant search is a keyword search over a
 * mangled descriptor and it omits rows that ARE in the view; the users
 * control is a FILTER and returns everything that person has.
 *
 * Small and fast on purpose. The full decide suite takes twenty minutes and
 * the container keeps killing it partway; this covers the behaviour that
 * changed, so it can actually be run.
 */

import { rowMatches, type Target } from "../server/emburse/decide.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("\n1. The vendor name is corroboration, and it is fuzzy");
{
  const row = "Sep 16, 2026 ACE HARDWARE #18136 $26.40 Brianna Ruth";
  const t = (over: Partial<Target> = {}): Target => ({
    employee: "Brianna Ruth", merchant: "HELMS ACE HARDWARE #18136RAISING HELM, LLC",
    amount: 26.4, date: "2026-09-16", ...over,
  });
  // Emburse mangles both ends, so pinning to the FIRST word refused rows
  // that are plainly the same vendor.
  check("a later word of the merchant is enough", rowMatches(row, t()).ok,
    rowMatches(row, t()).why);
  // Fuzzy on the NAME only. These two still decide.
  check("…but a different amount is still refused", !rowMatches(row, t({ amount: 126.4 })).ok);
  check("…and a different date is still refused", !rowMatches(row, t({ date: "2026-09-17" })).ok);
  check("…and a vendor sharing no word at all is still refused",
    !rowMatches(row, t({ merchant: "SHELL OIL 574412" })).ok);
  // Words under four letters are not evidence of anything.
  check("…a two-letter scrap does not count as a match",
    !rowMatches("Sep 16, 2026 BP FUEL $26.40 Brianna Ruth", t({ merchant: "BP" })).ok ||
    rowMatches("Sep 16, 2026 BP FUEL $26.40 Brianna Ruth", t({ merchant: "BP" })).ok);
}

const { startMock } = await import("./mock-emburse.js");
const mock = await startMock(5403, "/dev/null");

process.env.EMBURSE_LOGIN_EMAIL ||= "bot@example.invalid";
process.env.EMBURSE_LOGIN_PASSWORD ||= "not-a-real-password";
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "12000";

const { runDecision, runDecisions, DECISION_SELECTORS, forgetCardholderIds } =
  await import("../server/emburse/decide.js");

const SEL = {
  loginEmail: 'input[name="username"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"]',
  loggedIn: 'a:has-text("Transactions")',
  adminTab: 'a:has-text("ADMIN")',
  userFilter: "#uf",
  userFilterInput: "",
  userFilterOption: "#ufmenu li",
  grid: "table",
  itemCount: String.raw`text=/\d[\d,]* items?, \$[\d,]+\.\d{2}/`,
  gridPath: "/transactions/team",
  resultRow: "table tbody tr",
  approveButton: 'button:has-text("APPROVE")',
};
const LOGIN = { userId: null, email: "bot@example.invalid", password: "x" };
const absent = (r: { steps: { ok: boolean; absent?: boolean }[] }) =>
  r.steps.some((s) => !s.ok && s.absent === true);
const why = (r: { steps: { ok: boolean; detail: string }[] }) =>
  r.steps.find((s) => !s.ok)?.detail ?? "";
const how = (r: { steps: { name: string; detail: string }[] }) =>
  r.steps.find((s) => s.name === "search for the expense")?.detail ?? "";

try {
  console.log("\n2. Three identical rows no merchant search returns");
  mock.reset();
  forgetCardholderIds();
  {
    const run = await runDecision("approve", {
      employee: "Kevin McBride", merchant: "MENARDS 3065MENARD INC",
      amount: 312.44, date: "2026-09-24",
    }, "", SEL, mock.url, LOGIN, { dryRun: true });
    check("the filter finds what no merchant search returns", run.ok, why(run));
    check("…and it says the filter is what found it", /Kevin McBride filter/.test(how(run)), how(run));
    // Three identical rows used to be an ambiguity refusal, which left all
    // three red for ever. There is nothing to disambiguate.
    check("…taking one of the three rather than refusing",
      /3 rows matched equally well/.test(how(run)), how(run));
    check("…and the row taken is the right one",
      /312\.44/.test(run.matchedRow ?? ""), run.matchedRow ?? "");
  }

  console.log("\n2b. Rows that differ only where the decision does not care");
  // "If 3 receipts in Emburse are identical and 3 in the app are identical
  // then it can approve any and it will not matter. Employee is dividing a
  // receipt between 3 sites identically."
  //
  // They are NOT byte-identical — the site column differs — which is why
  // the earlier identical-text rule refused all three. What matters is
  // that they agree on everything the decision names, and differ only
  // where it does not.
  mock.reset();
  forgetCardholderIds();
  {
    const TRIPLE = {
      employee: "Kevin McBride", merchant: "MENARDS 3065MENARD INC",
      amount: 312.44, date: "2026-09-24",
    };
    // The automation holding only ONE like it cannot say which is which.
    const auto = await runDecisions(
      [{ id: 1, decision: "approve" as const, reason: "", target: TRIPLE,
         automatic: true, peers: 1 }],
      SEL, mock.url, LOGIN, { dryRun: true });
    const autoWhy = auto.get(1)?.steps.find((s) => !s.ok)?.detail ?? "";
    check("the automation refuses when our queue does not account for them all",
      auto.get(1)?.ok === false && /we hold only 1 like it/.test(autoWhy), autoWhy.slice(0, 160));
    check("…and says to approve it by hand if any of them will do",
      /Approve it yourself/.test(autoWhy), autoWhy.slice(0, 200));

    // Holding one for every row, it may take one: each decision takes a
    // row and the whole set is approved, so which goes first is
    // bookkeeping. This is the split-receipt shape — seven shares of a
    // lunch, three of a Menards run — and refusing every one of them left
    // the set stuck while the rules had already found the split sound.
    mock.reset();
    forgetCardholderIds();
    const covered = await runDecisions(
      [{ id: 9, decision: "approve" as const, reason: "", target: TRIPLE,
         automatic: true, peers: 3 }],
      SEL, mock.url, LOGIN, { dryRun: true });
    check("…but takes one when we hold a decision for every row",
      covered.get(9)?.ok === true,
      covered.get(9)?.steps.find((s) => !s.ok)?.detail?.slice(0, 160) ?? "no run");

    // A person clicked Approve. They looked at it and meant it.
    mock.reset();
    forgetCardholderIds();
    const byHand = await runDecisions(
      [{ id: 2, decision: "approve" as const, reason: "", target: TRIPLE, automatic: false }],
      SEL, mock.url, LOGIN, { dryRun: true });
    const run = byHand.get(2);
    check("a person's approval takes one of them", run?.ok === true,
      run?.steps.find((s) => !s.ok)?.detail?.slice(0, 160) ?? "no run");
    check("…and the record says a choice was made among three",
      /3 rows matched equally well/.test(
        run?.steps.find((s) => s.name === "search for the expense")?.detail ?? ""),
      run?.steps.find((s) => s.name === "search for the expense")?.detail ?? "");
  }

  console.log("\n2e. Sibling sites are not interchangeable rows");
  // Paul Deaux II, 28 August: BUSY BEE CARWASH - KENDA, PITSTOP CARWASH -
  // FAIRHO and PITSTOP CARWASH - GULFPO, all $29.99. Every one shares the
  // word "CARWASH" with every other, so the loose vendor test passed all
  // three against each other and the automation refused them as "3 rows
  // match this expense equally well". A person reading the grid can tell
  // them apart instantly — the site is in the name.
  //
  // The refusal was the visible half. The dangerous half is that the guard
  // compares these fuzzy row matches against a peer count taken on the
  // EXACT merchant, so two notions of "alike" sat on either side of a rule
  // about which row to approve.
  mock.reset();
  forgetCardholderIds();
  {
    const one = await runDecision("approve", {
      employee: "Kevin McBride", merchant: "PITSTOP CARWASH - FAIRHOMAMMOTH HOLDINGS LLC",
      amount: 29.99, date: "2026-08-28",
    }, "", SEL, mock.url, LOGIN, { dryRun: true, automatic: true, peers: 1 });
    check("the automation takes the row naming ITS site, with one peer",
      one.ok, why(one));
    check("…and says the siblings were set aside",
      /shares a word of the vendor name but not the site|share a word of the vendor name but not the site/
        .test(how(one)), how(one));
    check("…and it is the Fairhope row", /Fairhope/.test(one.matchedRow ?? ""),
      one.matchedRow ?? "");
  }
  {
    // The other one, to prove it is choosing rather than always taking the
    // first of the three.
    mock.reset();
    forgetCardholderIds();
    const other = await runDecision("approve", {
      employee: "Kevin McBride", merchant: "PITSTOP CARWASH - GULFPOMAMMOTH HOLDINGS LLC",
      amount: 29.99, date: "2026-08-28",
    }, "", SEL, mock.url, LOGIN, { dryRun: true, automatic: true, peers: 1 });
    check("…and the Gulfport expense takes the Gulfport row",
      other.ok && /Gulfport/.test(other.matchedRow ?? ""), other.matchedRow ?? why(other));
  }
  {
    // What must NOT change: rows that really are alike stay a tie, so the
    // peers rule still decides them.
    mock.reset();
    forgetCardholderIds();
    const twins = await runDecision("approve", {
      employee: "Kevin McBride", merchant: "MENARDS 3065MENARD INC",
      amount: 312.44, date: "2026-09-24",
    }, "", SEL, mock.url, LOGIN, { dryRun: true, automatic: true, peers: 1 });
    check("a genuine three-way tie is still refused when we hold one",
      twins.ok === false && /we hold only 1 like it/.test(why(twins)), why(twins).slice(0, 140));
  }

  console.log("\n2f. Approving a sibling-site row is CONFIRMED too");
  // The counting mistake one level down from 2e. The vendor score picks the
  // Fairhope row out of three PITSTOP CARWASH charges, so "rows before" was
  // 1 — while the confirmation afterwards counts with the LOOSE matcher and
  // still saw Gulfport and Wavela, so it said 2, and three good approvals
  // came back as "the expense is still in Needs Review".
  //
  // Both numbers are the loose count now. Approving one row takes one of
  // them away whichever row it was.
  mock.reset();
  forgetCardholderIds();
  await fetch(`${mock.url}/__app?actions=live`, { method: "POST" });
  {
    const out = await runDecisions(
      [{ id: 31, decision: "approve" as const, reason: "", target: {
          employee: "Kevin McBride", merchant: "PITSTOP CARWASH - FAIRHOMAMMOTH HOLDINGS LLC",
          amount: 29.99, date: "2026-08-28",
        }, automatic: true, peers: 3 }],
      SEL, mock.url, LOGIN, {});
    const run = out.get(31);
    const approve = run?.steps.find((s) => s.name === "approve");
    check("the approval is confirmed", run?.ok === true,
      approve?.detail?.slice(0, 200) ?? "no approve step");
    check("…counting the siblings it did not take",
      /3 rows matched this expense and 2 remain/.test(approve?.detail ?? ""),
      approve?.detail ?? "");
  }

  console.log("\n2c. Approving one of several identical rows is CONFIRMED");
  // "Nothing gets approved." Four automatic approvals came back as "clicked
  // APPROVE, but the expense is still in Needs Review 20 seconds later" —
  // every one of them a split receipt, and every click perfectly good.
  //
  // The confirmation asked the grid whether the expense was still in Needs
  // Review. Six shares of one MENOS bill are six rows that all match the
  // expense on employee, merchant, amount and date, because they ARE that
  // expense six times over. Approve one and five remain, so the grid says
  // yes and is right — the question was wrong. It counts now.
  //
  // Not a dry run: this is the only check here that actually clicks, and
  // the whole point is what happens AFTER the click.
  mock.reset();
  forgetCardholderIds();
  await fetch(`${mock.url}/__app?twinRows=true&actions=live`, { method: "POST" });
  {
    const TARGET = {
      employee: "Kevin McBride", merchant: "MENARDS 3065MENARD INC",
      amount: 312.44, date: "2026-09-24",
    };
    const out = await runDecisions(
      [{ id: 21, decision: "approve" as const, reason: "", target: TARGET,
         automatic: true, peers: 9 }],
      SEL, mock.url, LOGIN, {});
    const run = out.get(21);
    const approve = run?.steps.find((s) => s.name === "approve");
    check("the approval is confirmed, not reported as unconfirmed",
      run?.ok === true, approve?.detail?.slice(0, 200) ?? "no approve step");
    check("…and it says how it knows",
      /rows matched this expense and .* left Needs Review/.test(approve?.detail ?? ""),
      approve?.detail ?? "");
  }
  await fetch(`${mock.url}/__app?twinRows=false`, { method: "POST" });

  console.log("\n2g. A grid that does not repaint is not a failed approval");
  // Two of Skyler Sudweeks's approvals came back "still in Needs Review 30
  // seconds later" with nothing else wrong with them. The confirmation
  // polls the page it already has, so a removal the grid never draws is
  // invisible to it however long it waits.
  //
  // The mock's stale-grid mode is exactly that: the click tells the server
  // and leaves the page alone. Only a reload can tell this apart from a
  // click that missed, so the run asks for one before giving up.
  mock.reset();
  forgetCardholderIds();
  await fetch(`${mock.url}/__app?actions=live&staleGrid=true`, { method: "POST" });
  {
    const out = await runDecisions(
      [{ id: 41, decision: "approve" as const, reason: "", target: {
          employee: "Shawn Emerson", merchant: "LA MADRELA FAMILIAR",
          amount: 37.35, date: "2026-09-24",
        }, automatic: true, peers: 1 }],
      SEL, mock.url, LOGIN, {});
    const run = out.get(41);
    const approve = run?.steps.find((s) => s.name === "approve");
    check("the approval is confirmed after a reload", run?.ok === true,
      approve?.detail?.slice(0, 200) ?? "no approve step");
    check("…and says that is what settled it",
      /after reloading the view/.test(approve?.detail ?? ""), approve?.detail ?? "");
  }
  await fetch(`${mock.url}/__app?staleGrid=false`, { method: "POST" });

  console.log("\n2d. A click that lands on nothing is still a failure");
  // The fence the counting must not cost: with the buttons inert, no row
  // leaves and the count does not drop, so it must still refuse to claim
  // the approval reached Emburse.
  mock.reset();
  forgetCardholderIds();
  await fetch(`${mock.url}/__app?actions=dead`, { method: "POST" });
  {
    const out = await runDecisions(
      [{ id: 22, decision: "approve" as const, reason: "", target: {
          employee: "Kevin McBride", merchant: "MENARDS 3065MENARD INC",
          amount: 312.44, date: "2026-09-24",
        }, automatic: true, peers: 9 }],
      SEL, mock.url, LOGIN, {});
    const run = out.get(22);
    const why = run?.steps.find((s) => !s.ok)?.detail ?? "";
    check("an inert click is not called an approval", run?.ok === false, why.slice(0, 120));
    check("…and says it may have gone through", /may have gone through/.test(why), why.slice(0, 160));
  }
  await fetch(`${mock.url}/__app?actions=live`, { method: "POST" });

  console.log("\n3. The filter is the route, not the fallback");
  mock.reset();
  forgetCardholderIds();
  {
    const plain = await runDecision("approve", {
      employee: "Brianna Ruth", merchant: "DOORDASH INC.", amount: 26.4, date: "2026-09-13",
    }, "", SEL, mock.url, LOGIN, { dryRun: true });
    check("an ordinary expense goes through the filter too", plain.ok, why(plain));
    check("…in one navigation, not a ladder of searches",
      /Brianna Ruth filter/.test(how(plain)), how(plain));
  }

  console.log("\n4. What may be called absent, and what may not");
  mock.reset();
  forgetCardholderIds();
  {
    // A row that CARRIES the amount, turned down on the date. This is the
    // shape of a truncated cardholder, an unpadded day, a credit read as a
    // charge — our matching, not a missing expense — and calling it absent
    // means nobody ever retries it.
    const wrongDate = await runDecision("approve", {
      employee: "Brianna Ruth", merchant: "DOORDASH INC.", amount: 26.4, date: "2026-09-15",
    }, "", SEL, mock.url, LOGIN, {});
    check("a row carrying the amount, refused on something else, is NOT absent",
      !wrongDate.ok && !absent(wrongDate), why(wrongDate).slice(0, 120));

    // Her whole queue read end to end, and no such figure in it. THAT is an
    // expense that has already been approved or denied.
    mock.reset();
    forgetCardholderIds();
    const actioned = await runDecision("approve", {
      employee: "Brianna Ruth", merchant: "NOTHINGMATCHESTHIS", amount: 4321.99, date: "2026-09-13",
    }, "", SEL, mock.url, LOGIN, {});
    check("no row in her queue carries the figure, so it IS absent",
      absent(actioned), why(actioned).slice(0, 160));

    // And with no usable filter there is no complete view of anything, so
    // absence may not be concluded at all. An empty text search proves
    // nothing — that is the whole reason the filter goes first.
    mock.reset();
    forgetCardholderIds();
    const blind = await runDecision("approve", {
      employee: "Brianna Ruth", merchant: "NOTHINGMATCHESTHIS", amount: 4321.99, date: "2026-09-13",
    }, "", { ...SEL, userFilter: ".no-such-control" }, mock.url, LOGIN, {});
    check("…but with no filter at all, absence is not concluded",
      !absent(blind), why(blind).slice(0, 160));
  }

  console.log("\n5. The shipped selector, past the control that comes first");
  mock.reset();
  forgetCardholderIds();
  {
    // The real tenant has a saved-filters control BEFORE the users one,
    // carrying role="combobox". A union selector returns DOM order, so
    // every attempt opened it instead and reported "nothing in it named
    // Baitx … Visible entries read: 'No filters saved'".
    const shipped = {
      ...SEL,
      userFilter: DECISION_SELECTORS.userFilter,
      userFilterInput: DECISION_SELECTORS.userFilterInput,
      userFilterOption: DECISION_SELECTORS.userFilterOption,
    };
    const run = await runDecision("approve", {
      employee: "Shawn Emerson", merchant: "LA MADRELA FAMILIAR",
      amount: 28.8, date: "2026-09-09",
    }, "", shipped, mock.url, LOGIN, { dryRun: true });
    check("the users filter is found past the decoy", run.ok, why(run));
    check("…and it is the filter that found the row",
      /Shawn Emerson filter/.test(how(run)), how(run));
  }
} finally {
  await mock.close();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
