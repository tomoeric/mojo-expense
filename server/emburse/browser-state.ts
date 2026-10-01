import type { BrowserContext } from "playwright";
import { db, ensureSchema, isDbConfigured } from "../db.js";
import { open, seal } from "./credentials.js";

/**
 * The browser's cookies, kept somewhere a deployment does not erase.
 *
 * `EMBURSE_PROFILE_DIR` gave runs a persistent browser profile, which is what
 * makes Emburse's "remember this device for 30 days" mean anything. But it
 * lives in the application directory, and Replit rebuilds that on every
 * deploy — so the device was forgotten every time the app shipped, and whoever
 * owns the export was asked for a fresh code each time. During a week of
 * active development that is several codes a day, for a feature whose entire
 * promise was "once".
 *
 * The database survives deploys. So the cookie jar is written there after a
 * successful sign-in and restored into the browser before the next one. The
 * profile directory still helps within a deployment; this is what carries the
 * trust across them.
 *
 * These cookies are a live Emburse session — the same sensitivity as the
 * stored password sitting one table over, and treated the same way: sealed
 * with the same key, and never returned to any request.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS emburse_browser_state (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  state      bytea       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ONE JAR PER ACCOUNT. The table above holds exactly one row, by design,
-- from when one login was the whole app — and with two reviewers that is a
-- session belonging to whoever signed in last, handed to whoever runs next.
--
-- What that does is worse than losing the trust. Sign-in returns early on
-- "already signed in" when it finds a live session, so a run that restored
-- the other person's cookies skips the password step, reads THEIR Needs
-- Review, and reports success under the name it meant to use. Everything
-- else in this app can be scoped perfectly and a run can still come back
-- with the wrong person's expenses, intermittently, depending only on who
-- happened to export last.
--
-- Keyed by the app user, like the credential it belongs to. The old table
-- is left alone rather than migrated: its single row cannot say whose
-- session it holds, which is the entire problem, and guessing an owner for
-- it would be the same mistake in a different place. Everybody signs in
-- once more and the jars are right from then on.
CREATE TABLE IF NOT EXISTS emburse_browser_jars (
  user_email text PRIMARY KEY,
  state      bytea       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
  }));

/** What Playwright hands back from `storageState`, narrowed to what we keep. */
type Cookie = Parameters<BrowserContext["addCookies"]>[0][number];

/**
 * Put yesterday's cookies back into a fresh browser.
 *
 * Failure here is never fatal. A missing, unreadable or stale jar means the
 * run signs in the long way, which is the behaviour it had before any of this
 * existed — so it is logged and stepped over rather than thrown.
 */
export async function restoreCookies(
  context: BrowserContext,
  /**
   * Whose session to put back. No name, no cookies — deliberately.
   *
   * An unnamed run is one we cannot attribute, and handing it the last
   * session anybody saved is how a run ends up reading somebody else's
   * queue. Signing in the long way is slower and always correct.
   */
  userEmail = "",
): Promise<number> {
  // No database is a legitimate way to run — the app boots without one, and so
  // should this. Silently, because there is nothing wrong to report.
  if (!isDbConfigured()) return 0;
  const who = userEmail.trim().toLowerCase();
  if (!who) return 0;
  try {
    await ensure();
    const { rows } = await db().query<{ state: Buffer }>(
      "SELECT state FROM emburse_browser_jars WHERE user_email = $1", [who],
    );
    const sealed = rows[0]?.state;
    if (!sealed) return 0;

    const cookies = JSON.parse(open(sealed)) as Cookie[];
    // Expired cookies are not worth carrying, and a jar of nothing but expired
    // ones should read as "no jar" rather than as a restore that did nothing.
    const now = Date.now() / 1000;
    const live = cookies.filter((c) => !c.expires || c.expires < 0 || c.expires > now);
    if (live.length === 0) return 0;

    await context.addCookies(live);
    return live.length;
  } catch (err) {
    console.error("emburse: could not restore the saved browser cookies:", err);
    return 0;
  }
}

/**
 * Keep the cookies this run ended up with.
 *
 * Called after a sign-in that worked, because that is the moment the jar is
 * worth anything — it now contains whatever Emburse issued for passing the
 * device check.
 */
export async function rememberCookies(
  context: BrowserContext,
  /** Whose session this is. Unnamed is not saved, for the same reason. */
  userEmail = "",
): Promise<number> {
  if (!isDbConfigured()) return 0;
  const who = userEmail.trim().toLowerCase();
  if (!who) return 0;
  try {
    await ensure();
    const { cookies } = await context.storageState();
    if (cookies.length === 0) return 0;

    await db().query(
      `INSERT INTO emburse_browser_jars (user_email, state, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_email) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [who, seal(JSON.stringify(cookies))],
    );
    return cookies.length;
  } catch (err) {
    console.error("emburse: could not save the browser cookies:", err);
    return 0;
  }
}

/**
 * Is there still a device trusted under the old shared jar, and when?
 *
 * Only ever a transitional answer: before the jars were keyed there was
 * one, and it belongs to whoever last signed in — which the app cannot
 * know and a person can.
 */
export async function legacyDevice(): Promise<string | null> {
  if (!isDbConfigured()) return null;
  await ensure();
  const { rows } = await db().query<{ updated_at: Date }>(
    "SELECT updated_at FROM emburse_browser_state WHERE id");
  return rows[0] ? rows[0].updated_at.toISOString() : null;
}

/**
 * Hand the old shared device to the account it actually belongs to.
 *
 * The per-account jars are right and they have one cost nobody can pay:
 * the trust already earned sits in the shared row, and keying the jars
 * abandons it, so everybody enters a verification code again. For a second
 * reviewer that means interrupting somebody else's day to read out a code
 * — and "we entered in code already, that needs to stay" is a fair thing
 * to insist on.
 *
 * So it is not thrown away, it is assigned. Which account it belongs to is
 * the one question here that only a person can answer, so a person answers
 * it. Copied rather than moved, so a wrong answer is corrected by choosing
 * again rather than by hunting for a code.
 */
export async function adoptLegacyDevice(userEmail: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensure();
  const who = userEmail.trim().toLowerCase();
  if (!who) return false;
  const { rows } = await db().query<{ state: Buffer }>(
    "SELECT state FROM emburse_browser_state WHERE id");
  const sealed = rows[0]?.state;
  if (!sealed) return false;
  await db().query(
    `INSERT INTO emburse_browser_jars (user_email, state, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_email) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [who, sealed]);
  return true;
}

/**
 * Forget a remembered device — the escape hatch when a jar goes stale.
 *
 * One person's, when named. Unnamed clears everybody's, which is what the
 * button did when there was one jar and is still the right thing for "this
 * browser has gone strange".
 */
export async function forgetCookies(userEmail = ""): Promise<void> {
  if (!isDbConfigured()) return;
  await ensure();
  const who = userEmail.trim().toLowerCase();
  await db().query("DELETE FROM emburse_browser_state");
  await (who
    ? db().query("DELETE FROM emburse_browser_jars WHERE user_email = $1", [who])
    : db().query("DELETE FROM emburse_browser_jars"));
}

/** When a jar was last written, for showing whether a device is remembered. */
export async function cookiesSavedAt(userEmail = ""): Promise<string | null> {
  if (!isDbConfigured()) return null;
  await ensure();
  const who = userEmail.trim().toLowerCase();
  const { rows } = await db().query<{ updated_at: Date }>(
    who
      ? "SELECT updated_at FROM emburse_browser_jars WHERE user_email = $1"
      : "SELECT max(updated_at) AS updated_at FROM emburse_browser_jars",
    who ? [who] : [],
  );
  return rows[0]?.updated_at ? rows[0].updated_at.toISOString() : null;
}
