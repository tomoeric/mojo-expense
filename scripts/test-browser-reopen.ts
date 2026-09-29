/**
 * A batch whose browser cannot load the page reopens it, once.
 *
 *   pnpm exec tsx scripts/test-browser-reopen.ts
 *
 * A batch signs in once, so a wedged Chromium takes the whole batch with
 * it. One report had forty-one failures, twenty of them five-at-a-time
 * with identical timings, every one of them reading "the network is fine
 * and the BROWSER is what could not load the page — a corrupt profile, a
 * leftover process, or memory on this VM". The app had worked that out and
 * then done nothing at all with it.
 *
 * Throwing the context away and opening a fresh one is the remedy for
 * exactly that list of causes. What must NOT happen is retrying a network
 * outage: a second browser fails the same way and costs another two
 * minutes per batch, so the relaunch is gated on the app's own finding,
 * which it only reaches after proving with a plain fetch that the
 * container can reach Emburse.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";
// Short, or three attempts at ninety seconds each makes this untestable.
process.env.EMBURSE_OPEN_TIMEOUT_MS = "4000";
process.env.EMBURSE_STEP_TIMEOUT_MS = "8000";
process.env.EMBURSE_LOGIN_EMAIL ||= "bot@example.invalid";
process.env.EMBURSE_LOGIN_PASSWORD ||= "not-a-real-password";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const { startMock } = await import("./mock-emburse.js");
const mock = await startMock(5404, "/dev/null");
const { runDecisions } = await import("../server/emburse/decide.js");

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
const ITEM = {
  id: 1,
  decision: "approve" as const,
  reason: "",
  target: {
    employee: "Brianna Ruth", merchant: "DOORDASH INC.", amount: 26.4, date: "2026-09-13",
  },
};
const opens = (run: { steps: { name: string }[] } | undefined) =>
  (run?.steps ?? []).filter((s) => s.name === "open Emburse").length;

try {
  console.log("\n1. The browser cannot load the page, but the container can");
  mock.reset();
  // Three hangs exhausts openEmburse's attempts on the first browser; the
  // fresh one then gets a page that answers. Only Chromium is hung, so the
  // plain fetch still succeeds and the app reaches the finding that makes
  // reopening the right move.
  await fetch(`${mock.url}/__app?hangOpens=3`, { method: "POST" });
  {
    const out = await runDecisions([ITEM], SEL, mock.url, LOGIN, { dryRun: true });
    const run = out.get(1);
    check("the decision goes through after the browser is reopened", run?.ok === true,
      run?.steps.find((s) => !s.ok)?.detail?.slice(0, 160) ?? "no run");
    check("…and both attempts are on the record, not just the one that worked",
      opens(run) === 2, `${opens(run)} open step(s)`);
  }

  console.log("\n2. It reopens ONCE, not until it works");
  mock.reset();
  // Outlasts both browsers. The batch must give up rather than spend the
  // morning relaunching.
  await fetch(`${mock.url}/__app?hangOpens=99`, { method: "POST" });
  {
    const out = await runDecisions([ITEM], SEL, mock.url, LOGIN, { dryRun: true });
    const run = out.get(1);
    check("it fails rather than looping", run?.ok === false);
    check("…having tried exactly twice", opens(run) === 2, `${opens(run)} open step(s)`);
  }

  console.log("\n3. A container with no route out does NOT get a second browser");
  // The guard that makes this affordable. When the plain fetch fails too,
  // the browser is not the problem, a fresh one fails identically, and the
  // cost is another two minutes on every batch of a bad morning.
  mock.reset();
  await fetch(`${mock.url}/__app?hangAll=true`, { method: "POST" });
  {
    const out = await runDecisions([ITEM], SEL, mock.url, LOGIN, { dryRun: true });
    const run = out.get(1);
    check("it fails", run?.ok === false);
    check("…without reopening the browser at all", opens(run) === 1, `${opens(run)} open step(s)`);
    check("…and says the container has no route, not that Chromium is broken",
      /no route to Emburse/i.test(run?.steps.find((s) => !s.ok)?.detail ?? ""),
      run?.steps.find((s) => !s.ok)?.detail?.slice(0, 160) ?? "");
  }
  await fetch(`${mock.url}/__app?hangAll=false`, { method: "POST" });

  console.log("\n4. A batch that opens first time does not reopen anything");
  mock.reset();
  {
    const out = await runDecisions([ITEM], SEL, mock.url, LOGIN, { dryRun: true });
    const run = out.get(1);
    check("it goes through", run?.ok === true,
      run?.steps.find((s) => !s.ok)?.detail?.slice(0, 160) ?? "no run");
    check("…opening the browser once", opens(run) === 1, `${opens(run)} open step(s)`);
  }
} finally {
  await mock.close();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
