/**
 * A sign-in stranded on Emburse's error page clears the saved session.
 *
 *   pnpm exec tsx scripts/test-stranded-signin.ts
 *
 * Emburse signs in through an OIDC redirect chain, and an OIDC flow is
 * stateful: its `state` nonce is tied to a cookie set at the start of the
 * flow. We restore a saved cookie jar into a fresh browser before every run,
 * so a jar carrying a dead session gives the identity host something it
 * cannot reconcile and it answers with "Oops! Something went wrong — the
 * page is missing or the url has been assembled incorrectly".
 *
 * Two things were wrong with that. The run reported "check the loginEmail
 * selector against that page", about a page with no form on it at all —
 * which cost a day spent looking for an Emburse account lockout that did not
 * exist. And the state was PERMANENT: the jar that caused it is the jar
 * restored next time, so one reviewer sat stuck across eight scheduled runs
 * over a full day while the other healed on his own, for no reason but which
 * jar happened to be stale.
 */
import { chromium } from "playwright";
import { DECISION_SELECTORS } from "../server/emburse/decide.js";
import { signIn, StrandedAtIdentity } from "../server/emburse/auto-export.js";
import { cookiesSavedAt, rememberCookies } from "../server/emburse/browser-state.js";
import { db } from "../server/db.js";

const WHO = `stranded-${Date.now()}@example.invalid`;

/** Emburse's error page, in its own words. */
const OOPS = `<h1>Oops! Something went wrong...</h1>
  <p>The page is missing or the url has been assembled incorrectly.
     Please try again or <a href="/login">click here</a> to log in to our products.</p>`;
const PAGE = `data:text/html,${encodeURIComponent(`<body>${OOPS}</body>`)}`;

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
});
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(2_000);

try {
  // A jar that looks exactly like the stale one: saved, and about to poison
  // the very next run.
  await page.goto(PAGE);
  await context.addCookies([
    { name: "_session", value: "stale", domain: "example.invalid", path: "/" },
  ]);
  await rememberCookies(context, WHO);
  check("there is a saved session to begin with", (await cookiesSavedAt(WHO)) !== null);

  console.log("\n1. Stranded on Emburse's error page");
  let thrown: unknown = null;
  await page.goto(PAGE);
  try {
    await signIn(page, DECISION_SELECTORS as never,
      { userId: null, email: WHO, password: "x" }, PAGE, undefined, [], "the scheduled import");
  } catch (err) { thrown = err; }

  check("the sign-in fails rather than claiming success", thrown !== null);
  check("…as its own kind of failure, not a generic one",
    thrown instanceof StrandedAtIdentity);
  const said = thrown instanceof Error ? thrown.message : String(thrown);
  check("…saying Emburse answered with its error page", /error page/i.test(said));
  check("…and NOT blaming the loginEmail selector", !/loginEmail/i.test(said), said.slice(0, 120));

  console.log("\n2. The stale session is thrown away, so the next run starts clean");
  // Without this the state is permanent: the jar that caused it is the jar
  // restored next time, which is why one reviewer stayed stuck for a day.
  check("the saved session is gone", (await cookiesSavedAt(WHO)) === null);
} finally {
  await db().query("DELETE FROM emburse_browser_jars WHERE user_email = $1",
    [WHO.toLowerCase()]).catch(() => {});
  await db().end().catch(() => {});
  await browser.close();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
