/**
 * A personal tab reads the person's OWN expenses, never the team grid.
 *
 *   pnpm exec tsx scripts/test-personal-grid.ts
 *
 * Two bugs, one symptom. A run started from a personal tab clicked the
 * MANAGER/ADMIN tab and then exported /transactions/team — the approver's
 * queue, which is other people's expenses filed under the tab's own name.
 *
 *   1. `attemptExport` looked its reviewer's import settings up by EMAIL
 *      alone, while `reviewerImports()` returns one row per (person, tab).
 *      So a personal tab got the MANAGER row: its list, its stages and its
 *      receipt filter. The manager row stores no path, so the run fell
 *      through to the deployment default — the team grid. Covered by the
 *      lane-aware lookup in `importFor`, tested here.
 *   2. Even pointed at /transactions, the browser reached for the team view
 *      twice on its own: it clicks the team tab before opening anything, and
 *      a path that fails to load is retried as "<path>/team". Both are right
 *      for an approver. `personalQueue` turns them off, and the steps say so.
 *
 * No database and no tenant: the second half runs against the mock, which is
 * the only thing that can show what the browser actually did.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMock } from "./mock-emburse.js";
import type { ExportSettings } from "../server/import/settings.js";
import { gridPathFor, MANAGER_GRID, PERSONAL_GRID } from "../server/emburse/export-scheduler.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ----------------------------------------------------------- the lookup
// The bug was choosing the wrong ROW, so this is about rows, not browsers.
console.log("\n1. A tab's own list is the one the run reads");

const TRANSACTIONS = { path: MANAGER_GRID };
const managerRow = { gridPath: null };
const personalRow = { gridPath: PERSONAL_GRID };

check("the manager tab inherits the deployment's team grid",
  gridPathFor("", TRANSACTIONS, managerRow) === MANAGER_GRID,
  String(gridPathFor("", TRANSACTIONS, managerRow)));
check("a personal tab reads its own list",
  gridPathFor("", TRANSACTIONS, personalRow) === PERSONAL_GRID,
  String(gridPathFor("", TRANSACTIONS, personalRow)));
// This is the one that was wrong. Handed the manager row — which is what
// an email-only lookup returns for somebody who has both tabs — the
// personal run comes back pointed at the approver's queue.
check("…and the manager row is NOT what a personal tab would resolve to",
  gridPathFor("", TRANSACTIONS, managerRow) !== PERSONAL_GRID);

const { importFor } = await import("../server/emburse/export-scheduler.js");
check("the lookup the run uses takes a tab, not just a person",
  importFor.length >= 2, `importFor takes ${importFor.length} arguments`);

// ------------------------------------------------------- and the browser
console.log("\n2. The run itself does not go looking for the team view");

const PORT = 5402;
// The download is only checked to be a PDF, so the smallest valid one will
// do — this test is about the steps before it and needs no fixture.
const pdfPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pgrid-")), "export.pdf");
fs.writeFileSync(pdfPath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const mock = await startMock(PORT, pdfPath);

process.env.EMBURSE_LOGIN_URL = mock.url;
process.env.EMBURSE_LOGIN_EMAIL ||= "bot@example.invalid";
process.env.EMBURSE_LOGIN_PASSWORD ||= "not-a-real-password";
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "15000";
process.env.EMBURSE_EXPORT_WAIT_MS ||= "60000";

const { runAutoExport, DEFAULT_SELECTORS } = await import("../server/emburse/auto-export.js");
type Selectors = Parameters<typeof runAutoExport>[1];

const LOGIN = { userId: null, email: "bot@example.invalid", password: "not-a-real-password" };
const base: Selectors = {
  ...DEFAULT_SELECTORS,
  loginEmail: 'input[name="username"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"]',
  loggedIn: 'a:has-text("Transactions")',
  // MANAGER, not ADMIN: the mock renders what the real tenant renders,
  // deliberately, because a default saying ADMIN matched nothing there for
  // weeks. The grid page below does say ADMIN, but the tab is clicked on
  // the page sign-in lands on.
  adminTab: 'a:has-text("MANAGER")',
  exportButton: 'a[href="/dialog"] button',
  formatSelect: 'a:has-text("Select a format")',
  exportsNav: 'a:has-text("Exports")',
  newestExportReady: 'tr:has-text("Complete")',
  newestExportDownload: 'tr:has-text("Complete") >> a:has-text("Download")',
};
// The host, in the SETTINGS rather than the environment. env.ts reads
// process.env once, when it is first imported, and the static imports at
// the top of this file pull it in before the mock has a port — so setting
// EMBURSE_LOGIN_URL here is too late and the run goes to the real Emburse.
// `settings.emburseUrl` is read per run and wins outright.
const settings = {
  sections: ["Needs Review"], receiptsOnly: false, emburseUrl: mock.url,
} as ExportSettings;

const detailOf = (steps: { name: string; detail: string }[], name: string) =>
  steps.find((s) => s.name === name)?.detail ?? "";

try {
  // The manager tab, unchanged: it still clicks the team tab, and the mock
  // records that it was pressed. If this stops being true the guard below
  // has been written too wide and the approvers' import is broken.
  mock.reset();
  const asManager = await runAutoExport(
    settings, { ...base, gridPath: MANAGER_GRID }, LOGIN, {});
  for (const s of asManager.steps) console.log(`     ${s.ok ? "·" : "✗"} ${s.name.padEnd(30)} ${s.detail}`);
  check("the manager tab still switches to the team view",
    /clicked the team-wide tab/.test(detailOf(asManager.steps, "switch to the team view")),
    detailOf(asManager.steps, "switch to the team view"));
  check("…and Emburse saw the tab pressed", mock.state().admin === true);

  // A personal tab: the same run, told what it is.
  mock.reset();
  const asPersonal = await runAutoExport(
    settings, { ...base, gridPath: PERSONAL_GRID }, LOGIN, { personalQueue: true });
  for (const s of asPersonal.steps) console.log(`     ${s.ok ? "·" : "✗"} ${s.name.padEnd(30)} ${s.detail}`);
  const why = detailOf(asPersonal.steps, "switch to the team view");
  check("a personal tab skips the team view, and says why",
    /^skipped — this is a personal tab/.test(why), why);
  check("…and the tab was never pressed, so Emburse does not reopen there",
    mock.state().admin === false, `admin=${mock.state().admin}`);
  check("…and the grid it opened was the person's own",
    /\/transactions(\?|$)/.test(detailOf(asPersonal.steps, "open the filtered grid"))
    || !/team/.test(detailOf(asPersonal.steps, "open the filtered grid")),
    detailOf(asPersonal.steps, "open the filtered grid"));

  // The second reach for the team view: the "<path>/team" retry. Point the
  // run at a list the tenant does not have and the manager tab is entitled
  // to try its team-wide variant; a personal tab is not, because that
  // variant is somebody else's expenses.
  console.log("\n3. A list that does not load is not answered with the team grid");
  mock.reset();
  const stray = await runAutoExport(
    settings, { ...base, gridPath: "/nothing-here" }, LOGIN, { personalQueue: true });
  const grid = detailOf(stray.steps, "open the filtered grid");
  const failed = stray.steps.find((s) => s.name === "open the filtered grid");
  check("the personal run did not fall back to a team list",
    !/\/team\b/.test(grid), grid || "(the step failed, which is the honest outcome)");
  check("…and it failed rather than exporting the wrong queue",
    failed?.ok === false, `ok=${failed?.ok}`);
  /*
   * 4. A SECTION THIS LIST DOES NOT HAVE.
   *
   * "inbox" is the TEAM list's value for Needs Review. Asked of a personal
   * list that has no such section, Emburse does not 404 and does not come
   * back empty — it sits on "Loading…" for ever. Every outward sign then
   * points at the two things that are right: the path and the grid
   * selector. The run drops the filter and carries on, and says so, because
   * the setting and what it actually did now differ.
   */
  console.log("\n4. A section the list does not have is dropped, not blamed on a selector");
  mock.reset();
  await fetch(`${mock.url}/__hang-on-section/on`, { method: "POST" }).catch(() => {});
  const hung = await runAutoExport(
    settings, { ...base, gridPath: PERSONAL_GRID, gridSection: "inbox" }, LOGIN,
    { personalQueue: true });
  for (const st of hung.steps) console.log(`     ${st.ok ? "·" : "✗"} ${st.name.padEnd(30)} ${st.detail}`);
  const gridStep = hung.steps.find((st) => st.name === "open the filtered grid");
  check("the grid step passes anyway", gridStep?.ok === true, gridStep?.detail);
  check("…and says the section filter was what stopped it",
    /only loaded once the section filter was dropped/.test(gridStep?.detail ?? ""),
    gridStep?.detail);
  check("…naming the section to clear", /"inbox"/.test(gridStep?.detail ?? ""), gridStep?.detail);
  await fetch(`${mock.url}/__hang-on-section/off`, { method: "POST" }).catch(() => {});

  /*
   * 5. THE FAILURE NAMES THE PAGE THE RUN ASKED FOR.
   *
   * It used to report `page.url()`, and the probes that look for a
   * misconfigured path NAVIGATE — so a run that asked for /transactions,
   * failed, and then followed the nav link reported "the grid did not
   * appear at /transactions/team". Days went into "it is still opening the
   * manager tab", about a run whose setting had been right all along and
   * whose own message was describing a page it had wandered to while
   * looking for the answer.
   */
  console.log("\n5. A failure names the page the run asked for");
  mock.reset();
  const lost = await runAutoExport(
    settings, { ...base, gridPath: "/nowhere-at-all" }, LOGIN, { personalQueue: true });
  const said = lost.steps.find((st) => st.name === "open the filtered grid")?.detail ?? "";
  check("the asked-for path is the one named", said.includes("/nowhere-at-all"), said);
  check("…and no team list is reported as what it read",
    !/did not appear at \S*\/team/.test(said), said);

} finally {
  await mock.close();
}

console.log(failures === 0 ? "\nAll good." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
