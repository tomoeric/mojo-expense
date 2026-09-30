/**
 * Signing in through an auto-submitting OAuth page.
 *
 *   pnpm exec tsx scripts/test-oidc-hop.ts
 *
 * Fourteen decisions failed with "no sign-in form and the app is not
 * loaded after waiting — at https://spend.emburse.com/login/oidc/assertion"
 * and "— at https://spend.emburse.com/home". Both were true about the
 * instant they were asked and false about the sign-in, which was working.
 *
 * I caused it. Opening the page used to wait for domcontentloaded; I
 * changed it to "commit" — which returns as soon as the navigation is
 * accepted, before a single byte of script has run — on the reasoning that
 * every caller waits for something real afterwards. Emburse's OAuth chain
 * ends on an assertion page whose only job is to replace itself with
 * JavaScript, so committing returned ON that page and the sign-in check
 * started racing for a form and an app on a document that was leaving.
 *
 * Two things are pinned here, because one of them is a load state and load
 * states are easy to change again: the open waits for the document to
 * parse, and the sign-in waits out the chain even if it finds itself
 * standing in the middle of it.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";
process.env.EMBURSE_LOGIN_EMAIL ||= "bot@example.invalid";
process.env.EMBURSE_LOGIN_PASSWORD ||= "not-a-real-password";
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "12000";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const { startMock } = await import("./mock-emburse.js");
const mock = await startMock(5405, "/dev/null");
const { testConnection } = await import("../server/emburse/decide.js");

const SEL = {
  loginEmail: 'input[name="username"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"]',
  loggedIn: 'a:has-text("Transactions")',
  adminTab: 'a:has-text("ADMIN")',
  grid: "table",
  gridPath: "/transactions/team",
  resultRow: "table tbody tr",
};
const LOGIN = { userId: null, email: "bot@example.invalid", password: "x" };
const why = (r: { steps: { ok: boolean; name: string; detail: string }[] }) =>
  r.steps.find((s) => !s.ok)?.detail ?? "";

try {
  console.log("\n1. Straight in, with no OAuth hop in the way");
  mock.reset();
  {
    const run = await testConnection(SEL, mock.url, LOGIN, {});
    check("it signs in", run.ok, why(run).slice(0, 160));
  }

  console.log("\n2. Through an assertion page that replaces itself");
  mock.reset();
  await fetch(`${mock.url}/__app?oidcHop=true`, { method: "POST" });
  {
    const run = await testConnection(SEL, mock.url, LOGIN, {});
    check("it waits the hop out rather than reading the page it is on",
      run.ok, why(run).slice(0, 200));
    // The exact sentence fourteen decisions came back with. If it ever
    // reappears here, this has regressed.
    check("…and does not report the sign-in form as missing",
      !/no sign-in form and the app is not loaded/.test(why(run)), why(run).slice(0, 200));
    check("…nor blames the loginEmail selector",
      !/loginEmail selector/.test(why(run)), why(run).slice(0, 200));
  }
} finally {
  await mock.close();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
