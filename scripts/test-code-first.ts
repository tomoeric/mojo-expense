/**
 * Emburse opening straight on a verification-code page.
 *
 *   pnpm exec tsx scripts/test-code-first.ts     (needs a browser)
 *
 * With a session already remembered, Emburse skips email and password and
 * opens on /code-authentication. Neither the sign-in form nor the app ever
 * appears — and `signIn` raced only those two, so it timed out and reported
 * "no sign-in form and the app is not loaded … Check the loginEmail selector"
 * while a code box sat on screen waiting to be filled in.
 *
 * That is not a selector problem and no amount of correcting selectors fixes
 * it. It is the one failure a person can clear in ten seconds, and it was
 * being described as the one thing they could not.
 */

export {};

// A fresh browser profile per run. The profile is where Emburse's
// "remember this device" cookie lives, so a second run against the same one
// is legitimately never asked for a code — and would pass this file for the
// wrong reason.
process.env.EMBURSE_PROFILE_DIR = `/tmp/mojo-code-first-${Date.now()}`;
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "12000";
process.env.EMBURSE_SIGN_IN_WAIT_MS ||= "20000";

const { startMock, GOOD_CODE } = await import("./mock-emburse.js");
const mock = await startMock(5408, "/dev/null");
process.env.EMBURSE_LOGIN_URL = mock.url;

const { signIn, DEFAULT_SELECTORS, openBrowser } = await import("../server/emburse/auto-export.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const login = { userId: "brian@example.invalid", email: "brian@example.invalid", password: "x" };
const sel = { ...DEFAULT_SELECTORS } as never;

async function attempt(onChallenge?: (ctx: {
  prompt: string; screenshot: string | null; attempt: number; lastError: string | null;
}) => Promise<string>) {
  await fetch(`${mock.url}/__reset`, { method: "POST" }).catch(() => {});
  await fetch(`${mock.url}/__outcome/code-first`, { method: "POST" }).catch(() => {});
  const opened = await openBrowser();
  const page = await opened.context.newPage();
  page.setDefaultTimeout(12000);
  try {
    await page.goto(mock.url, { waitUntil: "domcontentloaded" });
    const detail = await signIn(page, sel, login, mock.url, onChallenge);
    return { ok: true as const, detail };
  } catch (err) {
    return { ok: false as const, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await opened.close().catch(() => {});
  }
}

try {
  console.log("\nA code page reached before any sign-in form");

  // Nobody to ask: it must say a code is wanted, not blame a selector.
  const alone = await attempt();
  check("it is not reported as a selector problem",
    !/loginEmail selector/.test(alone.detail), alone.detail.slice(0, 140));
  check("…it says a verification code is being asked for",
    /verification code/i.test(alone.detail), alone.detail.slice(0, 140));
  check("…and says what to do about it",
    /start it yourself|code can be entered/i.test(alone.detail), alone.detail.slice(0, 140));

  // Somebody IS there: the code clears it and the sign-in completes.
  let asked = 0;
  const answered = await attempt(async (ctx) => {
    asked++;
    check("the prompt carries what the page says",
      /code/i.test(ctx.prompt), ctx.prompt.slice(0, 80));
    return GOOD_CODE;
  });
  check("a code was actually asked for", asked === 1, `asked ${asked} time(s)`);
  check("answering it signs in", answered.ok, answered.detail.slice(0, 160));
} finally {
  await mock.close();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
