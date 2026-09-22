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
// Short, so the abandonment path can actually be tested. Five real minutes of
// waiting is the right default for a person reading a text and the wrong one
// for a test suite.
process.env.EMBURSE_CHALLENGE_TIMEOUT_MS ||= "20000";

const { runAutoExport, DEFAULT_SELECTORS, challengeKind, credentialsRejected, isCredentialFault, safeUrl, inApp } =
  await import("../server/emburse/auto-export.js");
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

/**
 * Throw away the browser's memory of this device — all of it.
 *
 * The profile is shared by every run here, which is the point of section 7 —
 * and a nuisance everywhere after it, because a device trusted once is never
 * asked again. Any section that needs to meet a challenge has to arrive as a
 * stranger, so it says so out loud rather than depending on what ran before.
 *
 * There are two places that memory lives, and forgetting one is not enough:
 * the profile directory, and the cookie jar in the database that was added
 * precisely because a deploy wipes the directory. Clearing only the directory
 * made every challenge section here pass trivially — a good sign for the
 * feature, and a useless test.
 */
const profileDir = process.env.EMBURSE_PROFILE_DIR ?? ".emburse-profile";
const { forgetCookies } = await import("../server/emburse/browser-state.js");
const forgetDevice = async () => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  // No database configured is a fine way to run this suite; there is then no
  // jar to clear and nothing to report.
  await forgetCookies().catch(() => {});
};
await forgetDevice();

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// --------------------------------------------- reading the page, and the URL
// No browser needed. These are the rules that decide what a stuck sign-in is,
// and every one of them has been wrong in production at least once.
console.log("\n0. Telling one kind of stuck sign-in from another");

// The real failure: parked on Emburse's own verification page, reported as a
// wrong password, because only the page text was read and the address — which
// says /code-authentication in plain words — was thrown away.
const CODE_URL = "https://account.emburse.app/code-authentication?session_token=eyJhbGciOiJIUzI1NiJ9.abc";
check("the address alone identifies a code page", challengeKind("", CODE_URL) === "code");
check("…even when the page text has not rendered yet",
  challengeKind("", CODE_URL) === "code");
check("…and it is not called a password problem", !isCredentialFault("", CODE_URL));

// "Try again" ends half the error screens on the internet, including code
// screens. On its own it is not evidence about the password.
check("“try again” alone is not a rejected password",
  !credentialsRejected("Didn't get a code? Try again."));
check("a real rejection still reads as one",
  credentialsRejected("Wrong email or password. Please try again."));
check("…and a code page wins over one that says both",
  !isCredentialFault("Wrong password. Try again.", CODE_URL));

// PKCE puts `code_challenge` in the query string of a perfectly ordinary
// sign-in redirect. Matching the whole URL rather than its path would call
// every OAuth hand-off a verification screen.
check("an OAuth redirect is not mistaken for a challenge",
  challengeKind("", "https://account.emburse.app/?code_challenge=abc&response_type=code") === null);

// A session_token is a bearer credential for a half-open sign-in, and this
// string gets stored on the credential row and rendered in the page.
check("a session token is never shown or stored",
  !safeUrl(CODE_URL).includes("eyJhbGciOiJIUzI1NiJ9"), safeUrl(CODE_URL));
check("…while the part that carries the meaning survives",
  safeUrl(CODE_URL).includes("/code-authentication"), safeUrl(CODE_URL));

// ---------------------------------------------------------------- clean run
console.log("\n1. A clean run, with the chips starting out wrong");
mock.reset();
let detail = "";
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
// No longer "already correct": that was a claim the step used to make without
// having read a chip. It now reports what is on, and the absence of any +/-
// is what says nothing was touched.
detail = run.steps.find((s) => s.name === "set the sections")?.detail ?? "";
check("left the chips alone the second time", detail === "on: Needs Review, Needs Manager Review",
  detail);

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
  ["mfa", /asking for a verification code/],
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
detail = run.steps.find((s) => s.name === "sign in")?.detail ?? "";
check("the first run is stopped by the device check", !run.ok);
check("and names it as a device check", /verify this device/.test(detail), detail.slice(0, 100));
check("…and not as a code prompt, which it is not",
  !/asking for a verification code/.test(detail), detail.slice(0, 100));

// Second run: the cookie the first run was given should now be presented.
run = await runAutoExport(settings, selectors, LOGIN, {});
detail = run.steps.find((s) => s.name === "sign in")?.detail ?? "";
check(
  "the second run gets past it, because the profile kept the cookie",
  run.ok,
  detail.slice(0, 120),
);
await fetch(`${mock.url}/__outcome/ok`, { method: "POST" });

// ------------------------------------------------ the code a person types in
console.log("\n8. A verification code, entered by a person");
const { GOOD_CODE } = await import("./mock-emburse.js");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__outcome/code`, { method: "POST" });

// Unattended: no hook, so the run must fail rather than park a browser that
// nobody is going to answer. This is the 6am case, and getting it wrong means a
// scheduled run sits on the profile lock for five minutes every morning.
run = await runAutoExport(settings, selectors, LOGIN, {});
check("without somebody to ask, the run just fails", !run.ok);
check("and nothing was submitted to the code screen", mock.state().codeAttempts === 0,
  `${mock.state().codeAttempts} attempt(s)`);

// Attended: the hook stands in for the person at the keyboard. The first code
// is wrong on purpose — a run that gives up after one bad digit would be worse
// than no feature at all.
const given: { prompt: string; attempt: number; lastError: string | null }[] = [];
const answers = ["000000", GOOD_CODE];
run = await runAutoExport(settings, selectors, LOGIN, {
  onChallenge: async (ctx) => {
    given.push({ prompt: ctx.prompt, attempt: ctx.attempt, lastError: ctx.lastError });
    return answers[ctx.attempt - 1] ?? GOOD_CODE;
  },
});
for (const s of run.steps) console.log(`     ${s.ok ? "·" : "✗"} ${s.name.padEnd(34)} ${s.detail.slice(0, 90)}`);

check("the run completed once the code was given", run.ok);
check("it asked twice — the first code was wrong", given.length === 2, `asked ${given.length} time(s)`);
check("the prompt quoted what Emburse was asking",
  /verification code/i.test(given[0]?.prompt ?? ""), given[0]?.prompt?.slice(0, 70) ?? "none");
check("the first ask had no error to report", given[0]?.lastError === null);
check("the retry said the code had been refused",
  /did not accept that code/i.test(given[1]?.lastError ?? ""), given[1]?.lastError?.slice(0, 70) ?? "none");

// The one that matters. A code submitted without ticking "remember this
// device" gets in today and is a stranger again tomorrow — the feature would
// look like it worked while changing nothing.
check("it ticked “remember this device”", mock.state().rememberedDevice);
check("…and said so in the step detail",
  /device is now remembered/.test(run.steps.find((st) => st.name === "sign in")?.detail ?? ""),
  run.steps.find((st) => st.name === "sign in")?.detail?.slice(0, 90) ?? "");

// And therefore: the next run needs no code at all, attended or not.
const before = mock.state().codeAttempts;
run = await runAutoExport(settings, selectors, LOGIN, {});
check("the next unattended run signs straight in", run.ok);
check("without being asked for another code", mock.state().codeAttempts === before,
  `${mock.state().codeAttempts - before} further attempt(s)`);

// --------------------------------------------- the registry the web page uses
// Sections 8 drove the hook directly. The app does not: it parks the run in a
// registry and lets a separate HTTP request answer it. That hand-off is where
// the rules live — who may answer, how many guesses, what happens when nobody
// comes back — so it is exercised as the app uses it, through waitForCode.
console.log("\n9. Answering through the registry, as the app does");
const { waitForCode, answerChallenge, cancelChallenge, currentChallenge } =
  await import("../server/emburse/challenge.js");

await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__outcome/code`, { method: "POST" });

const OWNER = "eric@example.invalid";

const runPromise = runAutoExport(settings, selectors, LOGIN, {
  onChallenge: (ctx) => waitForCode({ ...ctx, owner: OWNER }),
});

// Wait for the run to park, the way the page does: by polling. Generous,
// because this includes a cold browser start against a profile that was just
// deleted — a tight window here fails as "the challenge never appeared", which
// is the same symptom as the feature being broken and wastes an afternoon.
const parked = async () => {
  for (let i = 0; i < 600; i++) {
    if (currentChallenge()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

check("the run parks and the challenge becomes visible", await parked());
const view = currentChallenge();
check("the challenge names its owner", view?.owner === OWNER, view?.owner ?? "none");
check("and carries a picture of the page", (view?.screenshot?.length ?? 0) > 1000);
check("and says how many guesses are left", view?.attemptsLeft === 3, String(view?.attemptsLeft));

// Nobody else gets to finish somebody's half-open sign-in — not even another
// administrator. This is the check that keeps a parked browser from being a
// way into a finance system.
let answer = answerChallenge(GOOD_CODE, "someone.else@example.invalid");
check("a different person cannot answer it", !answer.ok);
check("…and is told whose it is", /eric@example.invalid/.test(answer.ok ? "" : answer.error),
  answer.ok ? "" : answer.error);
check("…and the challenge is still waiting", currentChallenge() !== null);

// Something that could not be a code at all must not cost one of three guesses.
answer = answerChallenge("12", OWNER);
check("a malformed code is refused without spending an attempt", !answer.ok);
check("…and the challenge is still waiting", currentChallenge() !== null);

// Answered the way it will really arrive: pasted out of a text message, spaces
// and all. Rejecting that as malformed would be the most annoying possible bug
// in a box somebody is typing into while holding a phone.
answer = answerChallenge(`${GOOD_CODE.slice(0, 3)} ${GOOD_CODE.slice(3)}`, OWNER);
check("the owner can answer, spaces and all", answer.ok);
run = await runPromise;
check("and the run completes", run.ok);
check("the challenge is cleared afterwards", currentChallenge() === null);

// Somebody who walks away. The run must end rather than hold the browser open
// on a server nobody is looking at — this is also what the timeout does when
// it fires, by the same path.
console.log("\n10. Nobody answers");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__outcome/code`, { method: "POST" });

const abandoned = runAutoExport(settings, selectors, LOGIN, {
  onChallenge: (ctx) => waitForCode({ ...ctx, owner: OWNER }),
});
check("it parked again", await parked());
check("a stranger cannot cancel it either", !cancelChallenge("nope", "someone.else@example.invalid").ok);
check("the owner can", cancelChallenge("Cancelled from the app.", OWNER).ok);

run = await abandoned;
check("the run fails rather than hanging", !run.ok);
check("and says it was abandoned",
  /Cancelled from the app/.test(run.steps.find((st) => st.name === "sign in")?.detail ?? ""),
  run.steps.find((st) => st.name === "sign in")?.detail?.slice(0, 90) ?? "");
check("and the browser is not still holding a challenge", currentChallenge() === null);
check("nothing is waiting, so there is nothing to answer", !answerChallenge(GOOD_CODE, OWNER).ok);

// The case nobody presses a button for: somebody starts a run, walks off, and
// the browser must let go by itself. Without this the server keeps a half-open
// sign-in and the profile lock indefinitely, and the next run cannot start.
console.log("\n11. Nobody comes back at all");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__outcome/code`, { method: "POST" });

const forgotten = runAutoExport(settings, selectors, LOGIN, {
  onChallenge: (ctx) => waitForCode({ ...ctx, owner: OWNER }),
});
check("it parked", await parked());
run = await forgotten; // no answer, no cancel — only the timeout ends this
detail = run.steps.find((st) => st.name === "sign in")?.detail ?? "";
check("the run ends on its own", !run.ok);
check("and says nobody entered a code", /Nobody entered the verification code/.test(detail),
  detail.slice(0, 90));
check("…in words, not “0 minutes”", !/\b0 (minutes|seconds)\b/.test(detail), detail.slice(0, 90));
check("and the challenge is gone", currentChallenge() === null);
await fetch(`${mock.url}/__outcome/ok`, { method: "POST" });

// --------------------------------------- a signed-in app that is slow, or renamed
// Both halves of a real failure: the run signed in successfully, spent thirty
// seconds looking at a dashboard that had not painted, and reported that the
// app never appeared. The screenshot taken a second later showed it loaded.
console.log("\n12. A signed-in app that has not painted yet");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__app?paintMs=6000`, { method: "POST" });

run = await runAutoExport(settings, selectors, LOGIN, { dryRun: true });
detail = run.steps.find((st) => st.name === "sign in")?.detail ?? "";
check("waits for the app rather than judging a blank page", run.ok, detail.slice(0, 90));
check("and reports a plain sign-in", /signed in as bot@example.invalid$/.test(detail), detail);

console.log("\n13. A signed-in app the loggedIn selector no longer matches");
await forgetDevice();
mock.reset();
// The app is there and rendered; only the word the selector looks for is gone.
await fetch(`${mock.url}/__app?nav=false`, { method: "POST" });

run = await runAutoExport(settings, selectors, LOGIN, { dryRun: true });
detail = run.steps.find((st) => st.name === "sign in")?.detail ?? "";
check("the run continues — being in the app is evidence enough", run.ok, detail.slice(0, 110));
check("but it says the selector needs correcting",
  /loggedIn selector did not match/.test(detail), detail.slice(0, 110));

// The guard against that becoming a free pass: somewhere that is NOT the app
// must still fail, however much text is on it.
console.log("\n14. Being somewhere else is still a failure");
check("the identity host is not the app",
  !inApp("https://account.emburse.app/code-authentication", "https://spend.emburse.com"));
check("a logged-out page on the right host is not the app",
  !inApp("https://spend.emburse.com/logged-out?next=x", "https://spend.emburse.com"));
check("the dashboard is", inApp("https://spend.emburse.com/home", "https://spend.emburse.com"));
await fetch(`${mock.url}/__app?paintMs=0&nav=true`, { method: "POST" });

// ------------------------------------------- a grid that is not a <table>
// The real failure: the grid was on screen, with "34 items, $42,249.94" printed
// above it, and the run timed out waiting for `table` to become visible.
console.log("\n15. Grids that do not look like a <table>");

for (const [shape, why] of [
  ["ghost", "a hidden measuring table comes first in the DOM"],
  ["divs", "there is no <table> at all, only ARIA roles"],
] as const) {
  await forgetDevice();
  mock.reset();
  await fetch(`${mock.url}/__app?grid=${shape}`, { method: "POST" });

  run = await runAutoExport(settings, selectors, LOGIN, { dryRun: true });
  const gridStep = run.steps.find((st) => st.name === "open the filtered grid");
  check(`the grid is found when ${why}`, gridStep?.ok === true, gridStep?.detail?.slice(0, 90) ?? "no step");
  check(`…and the run gets past it`, run.ok, run.steps.find((st) => !st.ok)?.name ?? "");
}

// And the guard: a page with no grid and no count line must still fail, or
// "look harder" quietly becomes "accept anything".
await forgetDevice();
mock.reset();
run = await runAutoExport(settings, { ...selectors, grid: "#nothing-here", itemCount: "#nor-here" },
  LOGIN, { dryRun: true });
detail = run.steps.find((st) => st.name === "open the filtered grid")?.detail ?? "";
check("a page with neither still fails", !run.ok);
check("…and names both things it looked for",
  /#nothing-here/.test(detail) && /#nor-here/.test(detail), detail.slice(0, 110));
await fetch(`${mock.url}/__app?grid=table`, { method: "POST" });

// ------------------------------------ a failed click must say what it wanted
// The real failure read, in full: "locator.click: Timeout 30000ms exceeded."
// That names neither the thing it wanted nor what was on screen instead —
// and every one of these selectors is a guess about somebody else's markup,
// so the failure is the only place a better guess can come from.
console.log("\n16. A click that cannot happen explains itself");
await forgetDevice();
mock.reset();

run = await runAutoExport(settings, { ...selectors, formatSelect: "#no-such-dropdown" }, LOGIN,
  { dryRun: true });
detail = run.steps.find((st) => st.name === "choose PDF")?.detail ?? "";
check("the run stops at the format step", run.steps.find((st) => !st.ok)?.name === "choose PDF",
  run.steps.find((st) => !st.ok)?.name ?? "nothing failed");
check("it names what it was looking for", /the format dropdown/.test(detail), detail.slice(0, 100));
check("…and the selector that missed", /#no-such-dropdown/.test(detail), detail.slice(0, 100));
check("…and quotes the dialog, so the real wording can be read off it",
  /Export Expenses/.test(detail), detail.slice(0, 140));
check("…rather than a bare Playwright timeout", !/^locator\.click/.test(detail), detail.slice(0, 60));

// The second half of the step is a separate guess and fails separately.
await forgetDevice();
mock.reset();
run = await runAutoExport(settings, { ...selectors, formatOption: "#no-such-option" }, LOGIN,
  { dryRun: true });
detail = run.steps.find((st) => st.name === "choose PDF")?.detail ?? "";
check("a missing PDF option is reported on its own", /PDF in the format list/.test(detail),
  detail.slice(0, 100));
check("…and the format was left alone", mock.state().format !== "PDF", mock.state().format);

// ---------------------------------------- a format control that is a <select>
// The failure this was written for: a native dropdown. Its <option>s are not
// clickable, so clicking one waits for something that can never be actionable
// and times out at exactly the step timeout — which is what the run reported,
// with no hint that clicking was the wrong verb entirely.
console.log("\n17. A format control that is a native dropdown");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__app?format=select`, { method: "POST" });

run = await runAutoExport(settings, selectors, LOGIN, {});
detail = run.steps.find((st) => st.name === "choose PDF")?.detail ?? "";
check("the run gets through the format step", run.ok, run.steps.find((st) => !st.ok)?.name ?? "");
check("PDF was actually chosen", mock.state().format === "PDF", mock.state().format);
check("and it says how", /chose "PDF" in a dropdown/.test(detail), detail.slice(0, 90));

// The dialog has a template dropdown too, and it comes first. Taking the
// first <select> on the page would leave the format untouched and say nothing.
check("the template dropdown was not mistaken for it",
  mock.state().format === "PDF", mock.state().format);

// The link-driven shape still works — the native path must not swallow it.
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__app?format=links`, { method: "POST" });
run = await runAutoExport(settings, selectors, LOGIN, {});
check("a dropdown made of links still works", run.ok && mock.state().format === "PDF",
  mock.state().format);

// ------------------------ the section chips, when they cannot be read at all
// The failure that matters most, because it is invisible in the result: the
// chip selector matched nothing, every chip was skipped in silence, and the
// step reported "already correct" while the dialog had the wrong sections.
// The PDF that comes out of that is valid, parses, and reconciles against its
// own printed total. Only the rows are wrong.
console.log("\n18. Section chips that cannot be read");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__app?chips=unmatchable`, { method: "POST" });

run = await runAutoExport(settings, selectors, LOGIN, {});
detail = run.steps.find((st) => st.name === "set the sections")?.detail ?? "";
check("the run refuses rather than exporting the wrong sections", !run.ok);
check("it stops at the sections step",
  run.steps.find((st) => !st.ok)?.name === "set the sections",
  run.steps.find((st) => !st.ok)?.name ?? "nothing failed");
check("…and never says “already correct”", !/already correct/.test(detail), detail.slice(0, 90));
check("…and names the sections it could not find",
  /Needs Review/.test(detail) && /Needs Manager Review/.test(detail), detail.slice(0, 120));
check("…and no export was requested", mock.state().requestedAt === null);

// And when they can be read, the detail says what is actually on — a claim
// that can be checked at a glance, rather than "already correct".
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__app?chips=normal`, { method: "POST" });
run = await runAutoExport(settings, selectors, LOGIN, { dryRun: true });
detail = run.steps.find((st) => st.name === "set the sections")?.detail ?? "";
check("a readable dialog reports what ended up on",
  /on: Needs Review, Needs Manager Review/.test(detail), detail.slice(0, 110));

// ------------------------------- a format control behind an unclickable label
console.log("\n19. A format control whose label cannot be clicked");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__app?format=mui`, { method: "POST" });

run = await runAutoExport(settings, selectors, LOGIN, {});
detail = run.steps.find((st) => st.name === "choose PDF")?.detail ?? "";
check("the run gets through the format step", run.ok, run.steps.find((st) => !st.ok)?.name ?? "");
check("PDF was actually chosen", mock.state().format === "PDF", mock.state().format);
check("…and it did not settle for the template dropdown above it",
  /was CSV/.test(detail), detail.slice(0, 90));
await fetch(`${mock.url}/__app?format=links`, { method: "POST" });

// ------------------------------- a dialog that has not finished drawing itself
// The check added above fired on the real Emburse — and was wrong. It peeked
// the instant the dialog opened, found a dialog whose entire text was
// "Export Expenses", and reported the chips missing in 0.0s. The title renders
// before the body. Waiting for a condition, not sampling one: the rule this
// file has now had to learn three times.
console.log("\n20. A dialog whose body arrives after its title");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__app?bodyMs=4000`, { method: "POST" });

run = await runAutoExport(settings, selectors, LOGIN, { dryRun: true });
detail = run.steps.find((st) => st.name === "set the sections")?.detail ?? "";
check("it waits for the chips instead of declaring them missing", run.ok,
  run.steps.find((st) => !st.ok)?.detail?.slice(0, 90) ?? "");
check("and sets them", /on: Needs Review, Needs Manager Review/.test(detail), detail.slice(0, 100));
check("…and did not give up instantly",
  (run.steps.find((st) => st.name === "set the sections")?.ms ?? 0) > 500,
  `${run.steps.find((st) => st.name === "set the sections")?.ms ?? 0}ms`);

console.log("\n21. A dialogRoot that only wraps the title");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__app?bodyMs=0&dialogRoot=header`, { method: "POST" });

run = await runAutoExport(settings, selectors, LOGIN, { dryRun: true });
detail = run.steps.find((st) => st.name === "set the sections")?.detail ?? "";
check("the chips are still found, outside the dialog", run.ok,
  run.steps.find((st) => !st.ok)?.detail?.slice(0, 90) ?? "");
check("…and it says the scope is worth correcting", /worth correcting/.test(detail),
  detail.slice(0, 110));
await fetch(`${mock.url}/__app?dialogRoot=whole`, { method: "POST" });

// ------------------------------------ chips that say nothing in text or ARIA
// The real failure: "would not settle after +Needs Review +Needs Review
// +Needs Review +Needs Review +Needs Review +Needs Review". Emburse's chips
// show selection with a filled background and an icon — nothing in the text,
// nothing in aria-pressed — so every read came back "off" and every pass
// decided the chip still needed turning on. It was toggled six times and left
// wherever the parity landed.
console.log("\n22. Chips that show their state with an icon, not with words");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__app?chipState=icon`, { method: "POST" });

run = await runAutoExport(settings, selectors, LOGIN, { dryRun: true });
detail = run.steps.find((st) => st.name === "set the sections")?.detail ?? "";
check("the chips are read correctly", run.ok,
  run.steps.find((st) => !st.ok)?.detail?.slice(0, 110) ?? "");
check("…and end up as configured",
  JSON.stringify(mock.state().sections) === JSON.stringify({
    "Needs Review": true, "Needs Manager Review": true,
    "Pending Submission": false, Denied: false, Completed: false,
  }), JSON.stringify(mock.state().sections));
check("…without clicking the same chip twice",
  !/\+Needs Review/.test(detail), detail.slice(0, 110));

console.log("\n23. Chips whose state reads wrong");
await forgetDevice();
mock.reset();
await fetch(`${mock.url}/__app?chipState=mute`, { method: "POST" });
const startedAs = JSON.stringify(mock.state().sections);

run = await runAutoExport(settings, selectors, LOGIN, {});
detail = run.steps.find((st) => st.name === "set the sections")?.detail ?? "";
check("the run refuses", !run.ok);
check("…after a single click, not six",
  /did not turn it on|cannot tell whether/.test(detail), detail.slice(0, 110));
check("…naming the chip it gave up on", /Needs Review/.test(detail), detail.slice(0, 110));
// The point of stopping: a chip toggled an unknown number of times is worse
// than a run that stopped. Two clicks return a toggle to where it started,
// which is the one thing that can be said for certain when the read is wrong.
check("…and the chips were left exactly as they were",
  JSON.stringify(mock.state().sections) === startedAs,
  JSON.stringify(mock.state().sections));
check("…and no export was requested", mock.state().requestedAt === null);
await fetch(`${mock.url}/__app?chipState=aria`, { method: "POST" });

await mock.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
