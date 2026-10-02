/**
 * A run must be able to say WHO it is signed in as.
 *
 *   pnpm exec tsx scripts/test-signed-in-as.ts
 *
 * "Needs Review is scoped to each Emburse user account. How can it pull
 * both Eric and Brian at the same time? We use a background browser to log
 * in." Exactly the right question, and the run could not answer it: every
 * step reported the account we MEANT to use, and "sign in" returns early
 * on "already signed in" without looking at who. So a run could be signed
 * in as somebody else and print the right name at every stage, which is
 * precisely what a shared browser profile produced.
 *
 * The check needs no knowledge of Emburse's markup. If ANOTHER login we
 * hold is on the page and ours is not, that is proof, and the run stops
 * before a single row is exported.
 */

export {};

process.env.EMBURSE_PROFILE_DIR = `/tmp/mojo-whois-${Date.now()}`;
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "10000";
process.env.EMBURSE_SIGN_IN_WAIT_MS ||= "20000";

const { startMock } = await import("./mock-emburse.js");
const mock = await startMock(5411, "/dev/null");
process.env.EMBURSE_LOGIN_URL = mock.url;

const { runAutoExport, DEFAULT_SELECTORS } = await import("../server/emburse/auto-export.js");
const { DECISION_SELECTORS } = await import("../server/emburse/decide.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const BRIAN = "brian.c@example.invalid";
const ERIC = "eric.s@example.invalid";
const sel = { ...DEFAULT_SELECTORS, ...DECISION_SELECTORS } as Record<string, string>;
const settings = {
  sections: ["Needs Review"], receiptsOnly: true,
  schedule: { timezone: "UTC", firstRun: "02:00", retryHours: 4, attemptsPerDay: 4,
              graceMinutes: 90, allDay: true },
  sources: [], emburseUrl: mock.url,
} as never;

const step = (r: { steps: { name: string; ok: boolean; detail: string }[] }, name: string) =>
  r.steps.find((s) => s.name === name);

try {
  console.log("\nWith nobody else's address on the page, it proceeds and says so");
  {
    const run = await runAutoExport(settings, sel as never,
      { userId: BRIAN, email: BRIAN, password: "x" },
      { dryRun: true, otherLogins: [ERIC] });
    const who = step(run, "confirm who is signed in");
    check("the step runs", Boolean(who), run.steps.map((s) => s.name).join(" → "));
    check("…and does not fail the run", who?.ok === true, who?.detail);
    // Either answer is honest; what matters is that it never claims the
    // wrong one and never refuses on an absence of evidence.
    check("…saying either confirmed or could-not-confirm",
      /confirmed as|could not confirm/.test(who?.detail ?? ""), who?.detail);
  }

  console.log("\nThe browser is holding Eric's session while we run as Brian");
  /*
   * The exact run that went wrong, reproduced.
   *
   * "sign in — already signed in as brian.c@… — their session was still
   * open", 1.7 seconds, no password typed, and 95 rows exported of which 91
   * were Eric's. The session in Brian's profile was Eric's, carried there by
   * adopting the legacy device, and an open session was being treated as
   * proof of whose it was.
   *
   * What must happen now: Brian's credentials get used. Not a refusal — a
   * sign-in. The one thing that must never happen is the export going ahead
   * on somebody else's session.
   */
  await fetch(`${mock.url}/__whoami/${encodeURIComponent(ERIC)}`, { method: "POST" })
    .catch(() => {});
  {
    const run = await runAutoExport(settings, sel as never,
      { userId: BRIAN, email: BRIAN, password: "x" },
      { dryRun: true, otherLogins: [ERIC] });
    const signIn = step(run, "sign in");
    const who = step(run, "confirm who is signed in");

    check("it did not accept the open session",
      !/already signed in/.test(signIn?.detail ?? ""), signIn?.detail);
    check("…it signed Eric out and signed Brian in",
      signIn?.ok === true && (signIn?.detail ?? "").includes(BRIAN), signIn?.detail);
    check("…and the account menu now names Brian",
      who?.ok === true && (who?.detail ?? "").includes(BRIAN), who?.detail);
    // As far as reading a list, which is the point: the recovery is not a
    // refusal, it is a sign-in, and the run goes on to do its job. Not
    // `run.ok` — this mock's export dialog has its own unrelated gap, and
    // hanging an identity test on it would make it fail for the wrong
    // reason.
    check("…so the run carries on and reads a list",
      step(run, "read the item count")?.ok === true,
      run.steps.filter((x) => !x.ok).map((x) => x.name).join(", "));
    // The device cookie is what a wipe would have destroyed, and the person
    // who would then have to read out a code is not at the screen.
    const trusted = await fetch(`${mock.url}/__state`).then((r) => r.json())
      .catch(() => null) as { whoami?: string } | null;
    check("…and the session now belongs to Brian",
      trusted?.whoami === BRIAN, JSON.stringify(trusted?.whoami));
  }

  console.log("\nAnd if it cannot sign that session out, it stops");
  // The remaining danger: a tenant whose sign-out this does not know. The
  // answer is to export nothing, because the alternative is importing
  // Eric's expenses under Brian's name.
  await fetch(`${mock.url}/__no-sign-out/1`, { method: "POST" }).catch(() => {});
  await fetch(`${mock.url}/__whoami/${encodeURIComponent(ERIC)}`, { method: "POST" })
    .catch(() => {});
  {
    const run = await runAutoExport(settings, sel as never,
      { userId: BRIAN, email: BRIAN, password: "x" },
      { dryRun: true, otherLogins: [ERIC] });
    const signIn = step(run, "sign in");
    check("the run is stopped", run.ok === false);
    check("…at sign in, before anything is read", signIn?.ok === false,
      run.steps.filter((s) => !s.ok).map((s) => s.name).join(", "));
    check("…saying whose session it is", (signIn?.detail ?? "").includes(ERIC), signIn?.detail);
    check("…and nothing was exported",
      !run.steps.some((s) => s.name === "start the export" && s.ok));
  }
  await fetch(`${mock.url}/__no-sign-out/0`, { method: "POST" }).catch(() => {});

} finally {
  await mock.close();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
