/**
 * The write-back can see page two. It could not, and said so wrong.
 *
 *   pnpm exec tsx scripts/test-writeback-paging.ts
 *
 * A real run, on a real tenant, failed with
 *
 *   0 of 13 rows match this expense, and a correction changes one
 *   record — there is no second correction coming to tidy up the
 *   others. Edit it in Emburse, or narrow what distinguishes these rows.
 *
 * Two faults in one line. The row was on page TWO: Emburse hands out ten
 * at a time, the decision path learned to page through it after the
 * Facebook Advertising failure, and the write-back — a separate copy of
 * the same hunt — never did. And the advice belongs to the opposite
 * case: with zero matches there is nothing to narrow, and the thirteen
 * reasons `rowMatches` had just worked out were all thrown away.
 *
 * The mock grid paginates for real now. It printed "1 - 10 of 14" and
 * served every row on one page, so this could not be reproduced against
 * it at all — the fixture agreed with the bug.
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

const mock = await startMock(5407, "/dev/null");
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
  gridPath: "/transactions/team",
  resultRow: "table tbody tr",
  approveButton: 'button:has-text("APPROVE")',
};
const LOGIN = { userId: null, email: "bot@example.invalid", password: "x" };
const TARGET: Target = {
  employee: "Brianna Ruth",
  merchant: "DOORDASH INC.",
  amount: 26.4,
  date: "2026-09-13",
};

const find = (steps: { name: string; ok: boolean; detail: string }[]) =>
  steps.find((s) => s.name === "find the expense");

try {
  console.log("1. The row is on page one — nothing changes");
  mock.reset();
  mock.set({ pageSize: 10 });
  {
    const run = await attachAndAnnotate(TARGET, {}, SEL, mock.url, LOGIN, {});
    const step = find(run.steps);
    check("it is found", step?.ok === true, step?.detail ?? "no find step at all");
  }

  console.log("\n2. The row is on page two — the failure from the screenshot");
  mock.reset();
  // Filler goes IN FRONT, so Brianna's row is pushed off page one.
  mock.set({ padRows: 12, pageSize: 5 });
  {
    const run = await attachAndAnnotate(TARGET, {}, SEL, mock.url, LOGIN, {});
    const step = find(run.steps);
    check("it is found, past the first page", step?.ok === true,
      step?.detail ?? "no find step at all");
    check("…and it says how far it looked",
      /matched 1 of \d+ rows/.test(step?.detail ?? ""), step?.detail ?? "");
    check("…having read more rows than one page holds",
      Number(/of (\d+) rows/.exec(step?.detail ?? "")?.[1] ?? 0) > 5,
      step?.detail ?? "");
  }

  console.log("\n3. Genuinely not there: the reason, not advice for the other case");
  mock.reset();
  mock.set({ pageSize: 5 });
  {
    const run = await attachAndAnnotate(
      { ...TARGET, amount: 4321.99 }, {}, SEL, mock.url, LOGIN, {});
    const step = find(run.steps);
    const why = step?.detail ?? "";
    check("it fails, since there is no such row", step?.ok === false, why.slice(0, 120));
    check("it does not tell you to narrow rows that do not exist",
      !/narrow what distinguishes/.test(why), why.slice(0, 200));
    check("it says what was being looked for",
      /4321\.99/.test(why) && /DOORDASH/i.test(why), why.slice(0, 200));
    check("it says WHY the rows were turned down",
      /turned down for/i.test(why), why.slice(0, 300));
    check("…and shows what the grid actually reads",
      /the grid reads/i.test(why), why.slice(0, 300));
  }
} finally {
  await mock.close();
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
