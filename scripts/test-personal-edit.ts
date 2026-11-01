/**
 * The personal list has no ⋮ — the row IS the way in.
 *
 *   pnpm exec tsx scripts/test-personal-edit.ts
 *
 * The write-back was written against the approver's queue, where every
 * row carries a ⋮ menu with Edit on it. A photograph of the real
 * PERSONAL list shows no such thing: its Action column holds SUBMIT, or
 * QUEUE while a transaction is still pending. So a run there reported
 *
 *   found 11 row menu(s) matching … but none of them is visible — they
 *   are probably the hidden copies a grid renders to measure itself
 *
 * which is true, and about a control that is not on that page at all.
 * Eleven hidden matches and no real one is exactly what "this layout
 * does not have one" looks like from inside a selector.
 *
 * Two routes now, and the step says which was taken — "the edit form is
 * open" tells nobody which of the two layouts they are looking at when
 * the NEXT step fails.
 */
import { startMock } from "./mock-emburse.js";
import type { Target } from "../server/emburse/decide.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

process.env.EMBURSE_LOGIN_EMAIL ||= "bot@example.invalid";
process.env.EMBURSE_LOGIN_PASSWORD ||= "not-a-real-password";
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "12000";

const mock = await startMock(5411, "/dev/null");
const { attachAndAnnotate } = await import("../server/emburse/decide.js");

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
  gridPath: "/transactions/me",
  resultRow: "table tbody tr",
  approveButton: 'button:has-text("APPROVE")',
};
const LOGIN = { userId: null, email: "bot@example.invalid", password: "x" };
const TARGET: Target = {
  employee: "Brianna Ruth", merchant: "DOORDASH INC.", amount: 26.4, date: "2026-09-13",
};

/*
 * Unique across the whole grid, on purpose.
 *
 * TARGET is not: Brianna and Kevin McBride each have a DOORDASH $26.40
 * on 9/13, and with the cardholder check off — which is right for a
 * one-person list — both of them match. Section 4 is about exactly
 * that; sections 2 and 3 are about the route to the form and must not
 * trip over it first.
 */
const LONE: Target = {
  employee: "Shawn Emerson", merchant: "MAVERIK #5074MAVERIK COUNTRY STORE",
  amount: 21.67, date: "2026-09-08",
};

const opened = (steps: { name: string; ok: boolean; detail: string }[]) =>
  steps.find((s) => s.name === "open the edit form");

/** Printed on a failure: a step list with no detail diagnoses nothing. */
const trace = (steps: { name: string; ok: boolean; detail: string }[]) =>
  steps.map((s) => `${s.ok ? "." : "X"} ${s.name}: ${s.detail.slice(0, 180)}`).join("\n     ");

try {
  console.log("1. A queue WITH a ⋮ menu is unchanged");
  mock.reset();
  {
    const run = await attachAndAnnotate(TARGET, {}, SEL, mock.url, LOGIN, {});
    const step = opened(run.steps);
    check("the form opens", step?.ok === true, step?.detail ?? "no such step");
    check("…by the menu, and it says so",
      /⋮ menu/.test(step?.detail ?? ""), step?.detail ?? "");
  }

  console.log("\n2. The personal list: no ⋮ anywhere, the row opens the expense");
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: true, pageSize: 10 });
  {
    const run = await attachAndAnnotate(LONE, {}, SEL, mock.url, LOGIN, {
      personalQueue: true,
    });
    const step = opened(run.steps);
    check("THE FORM STILL OPENS", step?.ok === true, step?.detail ?? "no such step");
    check("…by opening the expense, and it says so",
      /opened the expense itself/.test(step?.detail ?? ""), step?.detail ?? "");
    check("…and the run gets past it",
      run.steps.some((s) => s.name === "read what is there now"),
      `\n     ${trace(run.steps)}`);
  }

  console.log("\n3. Neither route: say what IS on the row, do not widen a selector");
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: false });
  {
    const run = await attachAndAnnotate(LONE, {}, SEL, mock.url, LOGIN, {
      personalQueue: true,
    });
    const step = opened(run.steps);
    const why = step?.detail ?? "";
    check("it fails rather than pretending", step?.ok === false, why.slice(0, 100));
    check("…saying the menu was not the problem it looked like",
      /Clicking the expense did not bring up an edit form/.test(why), why.slice(0, 200));
    check("…and listing what can actually be clicked there",
      /What is clickable on that row/.test(why) && /APPROVE/i.test(why),
      why.slice(-220));
  }
  console.log("\n3b. All five fields, on the form as it really is");
  /*
   * Written down by the owner after opening one:
   *
   *   Category is a drop down list – fuzzy match if necessary
   *   Business purpose is a text box
   *   Location/site is a dropdown
   *   Department is a drop down but matches when typed in
   *   Comment requires Add detail to be clicked – click comment to add box
   *
   * Four of those five had never been driven by a test, because the
   * fixture had a Category select and nothing else. Two of them could
   * not have been guessed: the comment's two presses, and a Category
   * list that truncates its own entries so the full name never matches
   * exactly.
   */
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: true, personalForm: true });
  {
    const run = await attachAndAnnotate(LONE, {
      fields: [
        { field: "category", value: "Software, Licenses, and Subscriptions" },
        { field: "purpose", value: "AI Development and Use" },
        { field: "location", value: "Corporate-Pure Magic" },
        { field: "department", value: "IT & Compliance" },
        { field: "comment", value: "ESS" },
      ],
    }, SEL, mock.url, LOGIN, { personalQueue: true });
    const said = (name: string) => run.steps.find((s) => s.name === name);
    check("THE WHOLE VISIT SUCCEEDS", run.ok, `\n     ${trace(run.steps)}`);
    check("Category matched loosely against a truncated option",
      /matched loosely/.test(said("set Category")?.detail ?? ""),
      said("set Category")?.detail ?? "no such step");
    check("Business Purpose went into the text box",
      said("set Business Purpose")?.ok === true,
      said("set Business Purpose")?.detail ?? "no such step");
    check("Location / Site chose from the dropdown",
      said("set Location / Site")?.ok === true,
      said("set Location / Site")?.detail ?? "no such step");
    check("Department chose from the dropdown",
      said("set Department")?.ok === true,
      said("set Department")?.detail ?? "no such step");
    check("Comment pressed ADD DETAIL then COMMENT to get its box",
      /Add detail/i.test(said("set Comment")?.detail ?? "")
      && /Comment/.test(said("set Comment")?.detail ?? ""),
      said("set Comment")?.detail ?? "no such step");
    check("…and then typed into it", said("set Comment")?.ok === true,
      said("set Comment")?.detail ?? "");
    check("it saved", said("save it")?.ok === true, said("save it")?.detail ?? "");
  }

  console.log("\n3c. A form that shows the comment box outright is not pressed twice");
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: true, personalForm: true });
  {
    // Nothing to reveal when the box is already up: the second write in
    // one visit must not go hunting for ADD DETAIL again.
    const run = await attachAndAnnotate(LONE, {
      fields: [
        { field: "comment", value: "ESS" },
        { field: "comment", value: "ESS again" },
      ],
    }, SEL, mock.url, LOGIN, { personalQueue: true });
    const both = run.steps.filter((s) => s.name === "set Comment");
    check("both writes land", both.length === 2 && both.every((s) => s.ok),
      both.map((s) => s.detail).join(" | "));
    check("…and only the first had anything to press",
      /Add detail/i.test(both[0]?.detail ?? "") && !/Add detail/i.test(both[1]?.detail ?? ""),
      both.map((s) => s.detail).join(" | "));
  }

  console.log("\n3d. The GRID cannot pass for the edit form");
  /*
   * It did. The grid carries controls of its own — row checkboxes and
   * an Accounting Category column — so "is one of the form's controls
   * visible" was already true before anything was clicked. The run
   * called the form open, went looking for a Description box, and
   * reported what was on "the form":
   *
   *   input aria-label=Select all rows | input aria-label=Select row |
   *   input aria-label=Select row | …
   *
   * which is the grid, and was the whole diagnosis. The test now is
   * that the page CHANGED — more to type into than there was a moment
   * ago — which holds without knowing one selector of the detail view.
   */
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: false, gridDecoys: true });
  {
    const run = await attachAndAnnotate(LONE, { note: "x" }, SEL, mock.url, LOGIN, {
      personalQueue: true,
    });
    const step = opened(run.steps);
    check("the decoys do not count as an open form", step?.ok === false,
      step?.detail?.slice(0, 140) ?? "no such step");
    check("…so it stops here instead of hunting a Description box on the grid",
      !run.steps.some((s) => s.name === "set the description"),
      run.steps.map((s) => s.name).join(" → "));
  }
  // And with the decoys still there, a row that DOES open still works:
  // the rule is "the page changed", not "the grid has no controls".
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: true, gridDecoys: true, personalForm: true });
  {
    const run = await attachAndAnnotate(LONE, {
      fields: [{ field: "purpose", value: "AI Development and Use" }],
    }, SEL, mock.url, LOGIN, { personalQueue: true });
    check("a real open is still recognised past the decoys", run.ok,
      `\n     ${trace(run.steps)}`);
  }

  console.log("\n3e. One absent field does not take the others down with it");
  /*
   * The description was the first write on the form, so a tenant
   * without a Description box failed all five — five writes, five
   * sign-ins, every one reporting the same missing box. One attempt
   * now names every field that is missing.
   *
   * And nothing is saved when any of them failed: a form left
   * part-filled and abandoned is the safe end, because Emburse keeps
   * what it had and the whole visit can be retried.
   */
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: true, personalForm: true });
  {
    const run = await attachAndAnnotate(LONE, {
      // The personal form has no Description box; the rest it has.
      note: "Receipt: stripe - 2026-10-28",
      fields: [
        { field: "purpose", value: "AI Development and Use" },
        { field: "department", value: "IT & Compliance" },
      ],
    }, SEL, mock.url, LOGIN, { personalQueue: true });
    const names = run.steps.map((s) => s.name);
    check("the description is tried and fails", names.includes("set the description"));
    check("…and the other fields are STILL tried",
      names.includes("set Business Purpose") && names.includes("set Department"),
      names.join(" → "));
    check("…which worked, so only the one box is the problem",
      run.steps.find((s) => s.name === "set Business Purpose")?.ok === true
      && run.steps.find((s) => s.name === "set Department")?.ok === true,
      `\n     ${trace(run.steps)}`);
    const stop = run.steps.find((s) => s.name === "stop: nothing was saved");
    check("it stops without saving", stop !== undefined && !run.ok,
      stop?.detail?.slice(0, 120) ?? "no stop step");
    check("…naming the field that is missing",
      /Description/.test(stop?.detail ?? ""), stop?.detail?.slice(0, 160) ?? "");
    check("…and nothing was saved", !names.includes("save it"), names.join(" → "));
  }

  console.log("\n3f. SUBMIT is never pressed, and SAVE DRAFT is the save");
  /*
   * The real form ends CANCEL · SUBMIT · SAVE DRAFT. The shipped
   * selector included button[type="submit"], and the fallback was "the
   * last enabled button that matched" — so the only thing between an
   * edit and SUBMITTING somebody's expense for approval was which
   * order those two happened to be in the DOM. The promise on the card
   * is that it attaches and edits and never submits, approves or
   * denies; that has to hold for the fallback too.
   */
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: true, personalForm: true });
  {
    const run = await attachAndAnnotate(LONE, {
      fields: [{ field: "purpose", value: "AI Development and Use" }],
    }, SEL, mock.url, LOGIN, { personalQueue: true });
    check("it saves", run.steps.find((s) => s.name === "save it")?.ok === true,
      run.steps.find((s) => s.name === "save it")?.detail ?? "no save step");
    check("…AND SUBMIT WAS NEVER PRESSED", mock.state().submitted === 0,
      `pressed ${mock.state().submitted} time(s)`);
  }
  // Even when SAVE DRAFT is the only thing missing, SUBMIT is not a
  // fallback: better to fail loudly than to submit somebody's expense.
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: true, personalForm: true });
  {
    const run = await attachAndAnnotate(LONE, {
      fields: [{ field: "purpose", value: "AI Development and Use" }],
    }, { ...SEL, editSave: 'button[type="submit"]' }, mock.url, LOGIN,
    { personalQueue: true });
    check("a selector pointing AT submit still does not press it",
      mock.state().submitted === 0, `pressed ${mock.state().submitted} time(s)`);
    check("…and it says why rather than going quiet",
      /submits or decides the expense/.test(
        run.steps.find((s) => s.name === "save it")?.detail ?? ""),
      run.steps.find((s) => s.name === "save it")?.detail ?? "no save step");
  }

  console.log("\n3g. A warning that mentions receipts is not a receipt");
  /*
   * "a receipt is already attached" — and so the upload was SKIPPED,
   * the one thing the visit was for — on an expense whose own dialog
   * reads "There are no receipts attached to this expense". The
   * selector was [class*="receipt" i] and the form carries a Warnings
   * block saying "Expenses must have a receipt".
   */
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: true, personalForm: true });
  {
    const run = await attachAndAnnotate(LONE, {
      receipt: { name: "r.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4") },
    }, SEL, mock.url, LOGIN, { personalQueue: true });
    check("the warning is not mistaken for an attachment", !run.alreadyAttached,
      run.steps.find((s) => s.name === "read what is there now")?.detail ?? "");
    check("…so the upload is actually attempted",
      run.steps.some((s) => s.name === "attach the receipt"
        && !/skipped/.test(s.detail)),
      run.steps.find((s) => s.name === "attach the receipt")?.detail ?? "no attach step");
  }

  console.log("\n3h. A warning in a list is not a dropdown option");
  /*
   * The option selector ended in a bare `li`, and the form's Warnings
   * block is a list — so "Expenses must have a receipt" was offered as
   * a choice. Business Purpose is a TEXT BOX, and that is the only
   * reason it failed: it looked like a dropdown whose list did not
   * hold what we wanted.
   *
   *   the Business Purpose list does not offer "AI Development and
   *   Use"; it offered: Expenses must have a receipt
   */
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: true, personalForm: true });
  {
    const run = await attachAndAnnotate(LONE, {
      fields: [{ field: "purpose", value: "AI Development and Use" }],
    }, SEL, mock.url, LOGIN, { personalQueue: true });
    const said = run.steps.find((s) => s.name === "set Business Purpose");
    check("the text box is typed into", said?.ok === true, said?.detail ?? "no such step");
    check("…not treated as a list offering the warning",
      !/Expenses must have a receipt/.test(said?.detail ?? ""), said?.detail ?? "");
    check("…and the visit saves", run.ok, `\n     ${trace(run.steps)}`);
  }

  console.log("\n4. Two people's identical rows are REFUSED, not guessed between");
  /*
   * The cost of dropping the cardholder check, and the net under it.
   *
   * On a genuinely personal list there is one person and nothing to
   * disambiguate. If the run is ever pointed at a mixed grid — which
   * is not hypothetical, it was reading the approver's 35-row queue
   * until a day ago — Brianna's DOORDASH $26.40 on 9/13 and Kevin
   * McBride's DOORDASH $26.40 on 9/13 become indistinguishable.
   *
   * That must stay a refusal. Editing one of two possible expenses is
   * worse than editing none, and the one-of-N guard is what makes
   * dropping the check safe rather than merely convenient.
   */
  mock.reset();
  mock.set({ menuStyle: "none", rowOpens: true });
  {
    const run = await attachAndAnnotate(TARGET, {}, SEL, mock.url, LOGIN, {
      personalQueue: true,
    });
    const found = run.steps.find((s) => s.name === "find the expense");
    check("it refuses rather than picking one", found?.ok === false,
      found?.detail?.slice(0, 120) ?? "no such step");
    check("…saying two rows match, so a correction cannot choose",
      /2 of \d+ rows match/.test(found?.detail ?? ""), found?.detail?.slice(0, 160) ?? "");
    check("…and nothing was opened or written", !run.ok);
  }
} finally {
  await mock.close();
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
