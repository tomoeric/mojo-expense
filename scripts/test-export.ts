/**
 * Exercise the export automation without an Emburse tenant.
 *
 *   pnpm exec tsx scripts/test-export.ts <an-export.pdf>
 *
 * What this proves and what it does not:
 *
 *   PROVES — Chromium launches on this host, the step machinery works, a live
 *   session skips sign-in, section chips are read before being clicked and
 *   converge on the configured set in both directions, the run refuses when the
 *   dialog is scoped to a row selection, a queued export is polled rather than
 *   assumed ready, and the download is checked to be a PDF.
 *
 *   DOES NOT PROVE — that the selectors match the real Emburse. Nothing outside
 *   their tenant can. That is what a dry run against the live site is for.
 *
 * The first of those is the one worth running before anything else: if Chromium
 * will not start on the host, no amount of correct selectors matters.
 */

import fs from "node:fs";
import { startMock } from "./mock-emburse.js";
import type { ExportSettings } from "../server/import/settings.js";

const pdfPath = process.argv[2];
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error("Usage: pnpm exec tsx scripts/test-export.ts <an-export.pdf>");
  console.error("Any real Emburse export PDF will do — it is only served as the download.");
  process.exit(2);
}

const PORT = 5399;
const mock = await startMock(PORT, pdfPath);

// env.ts reads process.env once, when it is first imported, so the mock's URL
// has to be in place before anything pulls it in — hence the dynamic import
// below rather than a static one at the top. Pointing at the real Emburse by
// accident is not a harmless test failure.
process.env.EMBURSE_LOGIN_URL = mock.url;
process.env.EMBURSE_LOGIN_EMAIL ||= "bot@example.invalid";
process.env.EMBURSE_LOGIN_PASSWORD ||= "not-a-real-password";
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "15000";
process.env.EMBURSE_EXPORT_WAIT_MS ||= "60000";

const { runAutoExport, DEFAULT_SELECTORS } = await import("../server/emburse/auto-export.js");
type Selectors = Parameters<typeof runAutoExport>[1];

// The credential the runner signs in with. In the app this comes from what
// somebody stored under their user menu; here it only has to be non-empty.
const LOGIN = { userId: null, email: "bot@example.invalid", password: "not-a-real-password" };

// Tuned to the mock's markup. The real ones live in the app's settings.
const selectors: Selectors = {
  ...DEFAULT_SELECTORS,
  loginEmail: 'input[name="username"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"]',
  loggedIn: 'a:has-text("Transactions")',
  adminTab: 'a:has-text("ADMIN")',
  transactionsNav: 'a:has-text("Transactions")',
  grid: "table",
  exportButton: 'a[href="/dialog"] button',
  formatSelect: 'a:has-text("Select a format")',
  exportsNav: 'a:has-text("Exports")',
  newestExportReady: 'tr:has-text("Complete")',
  newestExportDownload: 'tr:has-text("Complete") >> a:has-text("Download")',
};

const settings = {
  sections: ["Needs Review", "Needs Manager Review"],
  receiptsOnly: true,
} as ExportSettings;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- clean run
console.log("\n1. A clean run, with the chips starting out wrong");
mock.reset();
let run = await runAutoExport(settings, selectors, LOGIN, {});
for (const s of run.steps) console.log(`     ${s.ok ? "·" : "✗"} ${s.name.padEnd(34)} ${s.detail}`);

check("stayed on the mock, never the real Emburse",
  run.steps[0]?.detail.includes("127.0.0.1") ?? false, run.steps[0]?.detail ?? "");
check("run succeeded", run.ok);
check("downloaded a PDF", (run.pdf?.length ?? 0) > 1000, `${((run.pdf?.length ?? 0) / 1e6).toFixed(1)} MB`);
check("captured the item count", /items, \$/.test(run.itemLine ?? ""), run.itemLine ?? "none");

let after = mock.state();
check("switched ADMIN on", after.admin);
check("applied the receipts filter", after.receiptsFilter);
check("format is PDF", after.format === "PDF", after.format);
check(
  "sections match the configuration exactly",
  JSON.stringify(after.sections) ===
    JSON.stringify({
      "Needs Review": true, "Needs Manager Review": true,
      "Pending Submission": false, Denied: false, Completed: false,
    }),
  JSON.stringify(after.sections),
);

// -------------------------------------------------------- already signed in
console.log("\n2. A second run against a live session");
run = await runAutoExport(settings, selectors, LOGIN, {});
check("run succeeded", run.ok);
check(
  "skipped sign-in rather than failing on a missing form",
  run.steps.find((s) => s.name === "sign in")?.detail === "already signed in",
);
check(
  "left the chips alone the second time",
  run.steps.find((s) => s.name === "set the sections")?.detail === "already correct",
);

// ------------------------------------------------------------ row selection
console.log("\n3. A run with a row ticked, which must refuse");
mock.reset();
await fetch(`${mock.url}/tick`, { method: "POST" });
run = await runAutoExport(settings, selectors, LOGIN, {});

check("run failed", !run.ok);
check(
  "failed at the scope check",
  run.steps.find((s) => !s.ok)?.name === "confirm the scope is everything",
  run.steps.find((s) => !s.ok)?.name ?? "nothing failed",
);
check("never requested an export", mock.state().requestedAt === null);
check("returned a screenshot to look at", (run.screenshot?.length ?? 0) > 1000);

// -------------------------------------------------------------------- dry run
console.log("\n4. A dry run, which must set everything up and stop");
mock.reset();
run = await runAutoExport(settings, selectors, LOGIN, { dryRun: true });
check("run succeeded", run.ok);
check("never requested an export", mock.state().requestedAt === null);
check("still set the format", mock.state().format === "PDF", mock.state().format);

// ---------------------------------------- a wrong selector must not look fine
console.log("\n5. A wrong loginEmail selector must fail, not report success");
// Last, because resetting drops the session the "already signed in" case needs.
mock.reset();
run = await runAutoExport(settings, { ...selectors, loginEmail: "input#not-a-real-field" }, LOGIN, {});
check("run failed", !run.ok);
const signIn = run.steps.find((s) => s.name === "sign in");
check("it failed at sign in rather than skipping it", signIn?.ok === false, signIn?.detail ?? "no step");
check(
  "and said the form was missing rather than claiming a session",
  /no sign-in form/.test(signIn?.detail ?? ""),
  signIn?.detail ?? "",
);

// ------------------------------------------- the diagnosis must be specific
console.log("\n6. A failed sign-in must say which failure it was");
for (const [kind, expect] of [
  ["rejected", /rejected the credentials/],
  ["mfa", /second factor/],
] as const) {
  mock.reset();
  await fetch(`${mock.url}/__outcome/${kind}`, { method: "POST" });
  run = await runAutoExport(settings, selectors, LOGIN, {});
  const detail = run.steps.find((s) => s.name === "sign in")?.detail ?? "";
  check(`a ${kind} sign-in is named as such`, expect.test(detail), detail.slice(0, 120));
  check(`…and quotes what the page said`, /It says: "/.test(detail));
  // The device-check wording once swallowed this case: "Verify it is you" heads
  // both screens, so a pattern loose enough to catch one caught the other and
  // sent people to fix a device they had never been asked about.
  check(`…and is not mistaken for a device check`, !/verify this device/.test(detail), detail.slice(0, 120));
}
await fetch(`${mock.url}/__outcome/ok`, { method: "POST" });

// ------------------------------------------- the profile must carry a cookie
console.log("\n7. A trusted device must stay trusted between runs");
mock.reset();
await fetch(`${mock.url}/__outcome/device`, { method: "POST" });

// First run meets the device check and is told about it in those words.
run = await runAutoExport(settings, selectors, LOGIN, {});
let detail = run.steps.find((s) => s.name === "sign in")?.detail ?? "";
check("the first run is stopped by the device check", !run.ok);
check("and names it as a device check", /verify this device/.test(detail), detail.slice(0, 100));
check("…and not as a code prompt, which it is not", !/second factor/.test(detail), detail.slice(0, 100));

// Second run: the cookie the first run was given should now be presented.
run = await runAutoExport(settings, selectors, LOGIN, {});
detail = run.steps.find((s) => s.name === "sign in")?.detail ?? "";
check(
  "the second run gets past it, because the profile kept the cookie",
  run.ok,
  detail.slice(0, 120),
);
await fetch(`${mock.url}/__outcome/ok`, { method: "POST" });

await mock.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
