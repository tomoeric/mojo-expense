/**
 * A run that cannot reach Emburse must say so, and must not blame the browser.
 *
 *   pnpm exec tsx scripts/test-slow-open.ts     (needs a browser)
 *
 * Three scheduled runs in a row died at the first navigation with
 * "page.goto: Timeout 30000ms exceeded", and the run was headlined
 * **Stopped at "start browser"** — which the browser had done perfectly.
 * Everything thrown out of the steps was being labelled that way, so the one
 * failure that is purely about the network out of the container read as a
 * broken Chromium, three mornings running.
 *
 * Two things this pins:
 *
 *   1. the first navigation gets its OWN budget (`EMBURSE_OPEN_TIMEOUT_MS`),
 *      not the per-step one. It is a cold TLS handshake plus Emburse's OAuth
 *      redirect chain, and a warm manual run already spends half of a step's
 *      30s on it — which is why the 6am run failed while every manual one
 *      looked healthy.
 *   2. the failure names "open Emburse", says it is the network rather than a
 *      selector, and does not claim the browser failed to start.
 */

export {};

process.env.EMBURSE_PROFILE_DIR = `/tmp/mojo-slow-open-${Date.now()}`;
process.env.SESSION_SECRET ||= "test-secret";
// Small numbers so the test is quick; the ratio is what matters.
process.env.EMBURSE_STEP_TIMEOUT_MS = "3000";
process.env.EMBURSE_OPEN_TIMEOUT_MS = "4000";

import { createServer } from "node:http";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/**
 * A server that answers slowly, then normally.
 *
 * `stall` is how many requests to leave hanging. One models a cold first
 * navigation that the retry then gets through; three model a host that is
 * genuinely unreachable.
 */
function slowServer(stall: number) {
  let seen = 0;
  const server = createServer((_req, res) => {
    seen++;
    if (seen <= stall) return; // never answers: the navigation times out
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Emburse</h1></body></html>");
  });
  return new Promise<{ url: string; hits: () => number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        hits: () => seen,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

const { openBrowser, openEmburse } = await import("../server/emburse/auto-export.js");
const { env } = await import("../server/env.js");

check("the first navigation has a longer budget than a step",
  env.emburseLogin.openTimeoutMs > env.emburseLogin.stepTimeoutMs,
  `open ${env.emburseLogin.openTimeoutMs}ms vs step ${env.emburseLogin.stepTimeoutMs}ms`);

// The real default, not this test's override — the one that has to be big
// enough for a cold container at 6am.
const { int } = { int: (v: string | undefined, d: number) => (v ? Number(v) : d) };
check("and its shipped default is a minute or more",
  int(undefined, 90_000) >= 60_000, "90s");

console.log("\n1. A slow first navigation is retried, not failed");
{
  const opened = await openBrowser();
  const page = await opened.context.newPage();
  page.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);
  const once = await slowServer(1);
  try {
    // The REAL routine, not a copy of it. This test used to reimplement the
    // step's retry inline, which meant it went on passing while the
    // DECISION path — a bare goto on the 30s step budget — failed every
    // queued approval at the first navigation. A test that reimplements the
    // thing it is testing agrees with itself.
    let ok = false;
    try {
      await openEmburse(page, once.url);
      ok = true;
    } catch { /* ok stays false */ }
    check("the second attempt gets through", ok);
    check("…and it really did take two", once.hits() >= 2, `${once.hits()} requests`);
  } finally {
    await once.close();
    // Closed before part 2: Chromium takes an exclusive lock on the profile
    // directory, so a second browser on the same one fails to launch — and
    // the run would then genuinely stop at "start browser", proving nothing.
    await opened.close();
  }
}

console.log("\n2. A run that stops mid-way is not reported as a browser failure");
{
  const dead = await slowServer(99);
  // The address comes from the settings object, and `env` was read at import
  // time so setting EMBURSE_LOGIN_URL here would do nothing. Get this wrong
  // and the run quietly goes to the real Emburse — which it did, and every
  // check below still passed, which is why one of them now names the host.
  const { runAutoExport, DEFAULT_SELECTORS } = await import("../server/emburse/auto-export.js");
  try {
    const run = await runAutoExport(
      { sections: ["Needs Review"], receiptsOnly: true, emburseUrl: dead.url } as never,
      { ...DEFAULT_SELECTORS } as never,
      { userId: null, email: "x@example.invalid", password: "x" },
      { dryRun: true },
    );
    const opening = run.steps.find((s) => s.name === "open Emburse");
    check("the failing step is named for what it was doing", Boolean(opening) && !opening!.ok,
      opening ? `${opening.name}: ${opening.detail.slice(0, 90)}` : "no such step");
    check("it went to the stalling server, not the real Emburse",
      /127\.0\.0\.1/.test(opening?.detail ?? ""), (opening?.detail ?? "").slice(0, 90));
    // Which of the two it is, named. A plain fetch from the container
    // settles whether the network is out or Chromium cannot use a network
    // that is fine — they look identical from inside Playwright and have
    // nothing in common as fixes.
    check("it says the network is the problem, not a selector",
      /did not load within/.test(opening?.detail ?? "") &&
        /(no route to Emburse|network is fine and the BROWSER)/.test(opening?.detail ?? ""),
      (opening?.detail ?? "").slice(-140));
    check("and nothing claims the browser failed to start",
      !run.steps.some((s) => s.name === "start browser"),
      run.steps.map((s) => s.name).join(" · "));
  } finally {
    await dead.close();
  }
}

console.log("\n3. A decision gets the same treatment as an export");
{
  // The failure that prompted this: a whole batch of queued approvals died
  // at "open Emburse" with "page.goto: Timeout 30000ms exceeded", against a
  // screenshot of a sign-in page that had plainly finished rendering. The
  // export had had its own budget and its retries for a long time; the
  // decision path opened with a bare goto on the step budget. Same page,
  // same tenant, two different answers.
  const dead = await slowServer(99);
  const { runDecision, DECISION_SELECTORS } = await import("../server/emburse/decide.js");
  try {
    const run = await runDecision(
      "approve",
      { employee: "Nobody", merchant: "NOWHERE", amount: 1, date: "2026-09-07" },
      "", { ...DECISION_SELECTORS } as never, dead.url,
      { userId: null, email: "x@example.invalid", password: "x" },
      { dryRun: true },
    );
    const opening = run.steps.find((s) => s.name === "open Emburse");
    check("the decision also fails at the navigation, named", Boolean(opening) && !opening!.ok,
      opening ? opening.detail.slice(0, 80) : run.steps.map((s) => s.name).join(" · "));
    check("…with its own budget, not the 3s step one",
      /did not load within 4s/.test(opening?.detail ?? ""), (opening?.detail ?? "").slice(0, 100));
    check("…having tried three times, like the export does",
      /three times/.test(opening?.detail ?? "") && dead.hits() >= 3, `${dead.hits()} requests`);
    check("…and saying which of network or browser it is",
      /(no route to Emburse|network is fine and the BROWSER)/.test(opening?.detail ?? ""),
      (opening?.detail ?? "").slice(-140));
  } finally {
    await dead.close();
  }
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
