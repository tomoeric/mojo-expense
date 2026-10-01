/**
 * Changing a category in Emburse.
 *
 * "Flag for incorrect category — want option to correct the category, send
 * update to Emburse." A fuel purchase at an Exxon filed under Travel ·
 * Mileage & Ground Transportation is not a thing to deny: the spend is fine
 * and the coding is wrong.
 *
 * This is the only path in the app that CHANGES a finance record rather than
 * deciding on one, so what it refuses matters as much as what it does. Needs
 * a browser; drives the mock.
 */

export {};

process.env.EMBURSE_PROFILE_DIR ||= `/tmp/mojo-fixcat-${Date.now()}`;
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "8000";
process.env.EMBURSE_OPEN_TIMEOUT_MS ||= "20000";
process.env.EMBURSE_SIGN_IN_WAIT_MS ||= "20000";
process.env.SESSION_SECRET ||= "t";

const { startMock } = await import("./mock-emburse.js");
const { correctCategory, DECISION_SELECTORS } = await import("../server/emburse/decide.js");

const mock = await startMock(5407, "/dev/null");
// The mock's own markup, as the other browser suites give it. Without the
// sign-in selectors every run fails at the sign-in and the refusals below
// would pass for entirely the wrong reason.
const SEL = {
  ...DECISION_SELECTORS,
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
  // The edit form's own markup, as every other browser suite here gives the
  // mock's. The shipped defaults are a starting point by design — they
  // cannot be known from outside a tenant — so what this proves is the
  // mechanism, with the selectors set the way a tenant would set them.
  editMenuItem: "#menu .ed",
  editCategory: '#edit select[name="category"]',
  editCategoryOption: "#edit option",
  editSave: "#edit .sv",
} as Record<string, string>;
const LOGIN = { userId: null, email: "bot@example.invalid", password: "x" };

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};
const why = (r: { steps: { ok: boolean; detail: string }[] }) =>
  r.steps.find((s) => !s.ok)?.detail ?? r.steps.at(-1)?.detail ?? "";

try {
  console.log("\nThe case this exists for: a fuel purchase coded as Travel");
  mock.reset();
  {
    const run = await correctCategory(
      { employee: "Brianna Ruth", merchant: "SHELL OIL", amount: 44.1, date: "2026-09-13" },
      "Auto Fee & Fuel", SEL, mock.url, LOGIN);
    check("the category is changed", run.ok === true, why(run).slice(0, 200));
    // Said rather than assumed. A save that silently did nothing looks
    // exactly like one that worked, and this is the finance record.
    // Against the mock's own record, not the page: what matters is that
    // the save reached the server, which is the thing a reload would show.
    check("…and Emburse has the new category",
      [...mock.state().categories.values()].includes("Auto Fee & Fuel"),
      JSON.stringify([...mock.state().categories.entries()]));
    check("…and the run checked the row rather than assuming",
      /the row now reads/.test(run.steps.find((s) => s.name === "check it took")?.detail ?? ""),
      run.steps.find((s) => s.name === "check it took")?.detail ?? "no check step");
  }

  console.log("\nA category that the form does not offer is refused");
  mock.reset();
  {
    const run = await correctCategory(
      { employee: "Brianna Ruth", merchant: "SHELL OIL", amount: 44.1, date: "2026-09-13" },
      "Not A Real Category", SEL, mock.url, LOGIN);
      check("the sign-in itself worked, or nothing below proves anything",
      run.steps.find((s) => s.name === "sign in")?.ok === true,
      run.steps.find((s) => s.name === "sign in")?.detail ?? "no sign-in step");
    check("it does not claim to have changed anything", run.ok === false, why(run).slice(0, 120));
    // The refusal has to be actionable. "It did not work" about a form
    // nobody can see is how somebody ends up editing in Emburse anyway.
    check("…and says what the form DID offer, or what is on it",
      /offered|What IS on the form|does not offer/i.test(why(run)), why(run).slice(0, 220));
  }

  console.log("\nAn expense that is not exactly one row is refused");
  // Three identical Menards rows. A decision may take one of them because
  // each has its own decision queued; a correction changes ONE record and
  // nothing is coming to tidy up the others.
  mock.reset();
  {
    const run = await correctCategory(
      { employee: "Kevin McBride", merchant: "MENARDS 3065MENARD INC", amount: 312.44, date: "2026-09-24" },
      "Meals", SEL, mock.url, LOGIN);
    check("three interchangeable rows are not edited", run.ok === false, why(run).slice(0, 140));
    check("…and it says why that is different from approving",
      /no second correction/i.test(why(run)), why(run).slice(0, 220));
  }

  console.log("\nA row the text search cannot return is still correctable");
  // The gap my own test found: this started out searching for the merchant,
  // and Emburse's text search misses rows that are in the view. "MENARDS
  // 3065MENARD" returns nothing while the row sits one filter away — so the
  // expenses most in need of a correction were the ones it could not find.
  mock.reset();
  {
    const run = await correctCategory(
      { employee: "Shawn Emerson", merchant: "LA MADRELA FAMILIAR", amount: 28.8, date: "2026-09-09" },
      "Meals", SEL, mock.url, LOGIN);
    check("a shy row is found through the cardholder filter", run.ok === true, why(run).slice(0, 200));
  }

  console.log("\nAn expense Emburse does not have is refused");
  mock.reset();
  {
    const run = await correctCategory(
      { employee: "Brianna Ruth", merchant: "SHELL OIL", amount: 4321.99, date: "2026-09-13" },
      "Meals", SEL, mock.url, LOGIN);
    check("nothing is edited when nothing matches", run.ok === false, why(run).slice(0, 120));
  }
} finally {
  await mock.close();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
