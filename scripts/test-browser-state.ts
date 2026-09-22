/**
 * Does a remembered device survive a deployment?
 *
 *   pnpm exec tsx scripts/test-browser-state.ts
 *
 * The profile directory is what makes Emburse's "remember this device" mean
 * anything — and Replit rebuilds that directory on every deploy. So the device
 * was forgotten each time the app shipped, and the person who owns the export
 * was asked for a fresh code, for a feature whose whole promise was "once".
 *
 * This proves the cookie jar in the database closes that gap: wipe the profile
 * the way a deploy does, and the next run must still be trusted.
 *
 * Needs DATABASE_URL and SESSION_SECRET, and a browser.
 */

import fs from "node:fs";
import { startMock, GOOD_CODE } from "./mock-emburse.js";

const PORT = 5403;
const mock = await startMock(PORT, "/dev/null");

process.env.EMBURSE_LOGIN_URL = mock.url;
process.env.EMBURSE_LOGIN_EMAIL ||= "bot@example.invalid";
process.env.EMBURSE_LOGIN_PASSWORD ||= "not-a-real-password";
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "15000";
process.env.EMBURSE_SIGN_IN_WAIT_MS ||= "20000";
process.env.EMBURSE_EXPORT_WAIT_MS ||= "60000";

const { runAutoExport, DEFAULT_SELECTORS } = await import("../server/emburse/auto-export.js");
const { forgetCookies, cookiesSavedAt } = await import("../server/emburse/browser-state.js");
import type { ExportSettings } from "../server/import/settings.js";

type Selectors = Parameters<typeof runAutoExport>[1];
const selectors: Selectors = {
  ...DEFAULT_SELECTORS,
  loginEmail: 'input[name="username"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"]',
  loggedIn: 'a:has-text("Transactions")',
  adminTab: 'a:has-text("ADMIN")',
  grid: "table",
  exportButton: 'a[href="/dialog"] button',
  formatSelect: 'a:has-text("Select a format")',
  exportsNav: 'a:has-text("Exports")',
  newestExportReady: 'tr:has-text("Complete")',
  newestExportDownload: 'tr:has-text("Complete") >> a:has-text("Download")',
};
const settings = { sections: ["Needs Review"], receiptsOnly: true } as ExportSettings;
const LOGIN = { userId: null, email: "bot@example.invalid", password: "not-a-real-password" };

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** What a Replit deploy does to the browser profile: removes it. */
const profileDir = process.env.EMBURSE_PROFILE_DIR ?? ".emburse-profile";
const deploy = () => fs.rmSync(profileDir, { recursive: true, force: true });

console.log("\n1. Passing the device check once");
await forgetCookies();
deploy();
mock.reset();
await fetch(`${mock.url}/__outcome/code`, { method: "POST" });

let run = await runAutoExport(settings, selectors, LOGIN, {
  dryRun: true,
  onChallenge: async () => GOOD_CODE,
});
check("the code was accepted", run.ok, run.steps.find((s) => s.name === "sign in")?.detail ?? "");
check("and the device was remembered by Emburse", mock.state().rememberedDevice);
check("and the cookies were kept somewhere a deploy cannot reach",
  (await cookiesSavedAt()) !== null, (await cookiesSavedAt()) ?? "nothing saved");

console.log("\n2. The app is redeployed, which wipes the browser profile");
deploy();
mock.reset();
await fetch(`${mock.url}/__outcome/code`, { method: "POST" });

const before = mock.state().codeAttempts;
run = await runAutoExport(settings, selectors, LOGIN, { dryRun: true });
check("the run signs straight in, with nobody there to ask", run.ok,
  run.steps.find((s) => s.name === "sign in")?.detail ?? "");
check("nobody was asked for another code", mock.state().codeAttempts === before,
  `${mock.state().codeAttempts - before} further attempt(s)`);

console.log("\n3. Forgetting the device works, or it could never be undone");
await forgetCookies();
deploy();
mock.reset();
await fetch(`${mock.url}/__outcome/code`, { method: "POST" });

run = await runAutoExport(settings, selectors, LOGIN, { dryRun: true });
check("an unattended run is stopped by the device check again", !run.ok);
check("…and says so", /verification code/i.test(run.steps.find((s) => s.name === "sign in")?.detail ?? ""),
  run.steps.find((s) => s.name === "sign in")?.detail?.slice(0, 90) ?? "");

await forgetCookies();
await fetch(`${mock.url}/__outcome/ok`, { method: "POST" });
await mock.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
