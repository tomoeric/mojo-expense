import type { BrowserContext } from "playwright";
import { db, ensureSchema } from "../db.js";
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
export async function restoreCookies(context: BrowserContext): Promise<number> {
  try {
    await ensure();
    const { rows } = await db().query<{ state: Buffer }>(
      "SELECT state FROM emburse_browser_state WHERE id",
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
export async function rememberCookies(context: BrowserContext): Promise<number> {
  try {
    await ensure();
    const { cookies } = await context.storageState();
    if (cookies.length === 0) return 0;

    await db().query(
      `INSERT INTO emburse_browser_state (id, state, updated_at) VALUES (true, $1, now())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [seal(JSON.stringify(cookies))],
    );
    return cookies.length;
  } catch (err) {
    console.error("emburse: could not save the browser cookies:", err);
    return 0;
  }
}

/** Forget the remembered device — the escape hatch when a jar goes stale. */
export async function forgetCookies(): Promise<void> {
  await ensure();
  await db().query("DELETE FROM emburse_browser_state");
}

/** When the jar was last written, for showing whether a device is remembered. */
export async function cookiesSavedAt(): Promise<string | null> {
  await ensure();
  const { rows } = await db().query<{ updated_at: Date }>(
    "SELECT updated_at FROM emburse_browser_state WHERE id",
  );
  return rows[0] ? rows[0].updated_at.toISOString() : null;
}
