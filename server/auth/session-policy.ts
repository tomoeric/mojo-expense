import { db, ensureSchema, isDbConfigured } from "../db.js";

/**
 * HOW LONG A SIGN-IN LASTS, as a setting rather than a constant.
 *
 * It was `SESSION_TTL_MS = 8 * 60 * 60 * 1000` in session.ts with
 * a comment reading "a working day" — a reasonable guess, and not
 * one anybody could change without a deploy. A finance console is
 * exactly the kind of screen somebody wants timed out sooner, or
 * left alone longer, depending on where it is running.
 *
 * It is an IDLE timeout, not a session length: the cookie is
 * re-issued while somebody is working, so the number means "log
 * out after this long without touching it" rather than "throw
 * them out mid-sentence N hours after they signed in". That is
 * what people mean by automatic sign-out, and the page says so.
 *
 * The bounds are deliberate. Five minutes is short enough to be
 * annoying and is somebody's real choice on a shared machine;
 * thirty days is the longest this will call a session, because a
 * cookie that outlives a laptop's ownership is not a session, it
 * is a key.
 */

export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MIN_SESSION_TTL_MS = 5 * 60 * 1000;
export const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text        NOT NULL DEFAULT ''
);
`;

let ready: Promise<void> | null = null;
const ensure = async (): Promise<void> => {
  if (!ready) ready = (async () => { await ensureSchema(); await db().query(SCHEMA); })();
  await ready;
};

/*
 * READ ON EVERY REQUEST, so it is cached.
 *
 * The middleware runs on every call this app serves, and a
 * database round trip there to fetch one integer would be a
 * query per request for a number that changes twice a year. Ten
 * seconds is short enough that a change takes effect while
 * somebody is still looking at the page they changed it on.
 */
let cached: { ms: number; at: number } | null = null;
const CACHE_MS = 10_000;

export function clean(given: unknown): number | null {
  const n = Number(given);
  if (!Number.isFinite(n) || n < MIN_SESSION_TTL_MS || n > MAX_SESSION_TTL_MS) return null;
  return Math.round(n);
}

/** The configured idle timeout, or the default. Never throws. */
export async function sessionTtlMs(): Promise<number> {
  if (!isDbConfigured()) return DEFAULT_SESSION_TTL_MS;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.ms;
  try {
    await ensure();
    const { rows } = await db().query<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'session_ttl_ms'");
    const ms = clean(rows[0]?.value) ?? DEFAULT_SESSION_TTL_MS;
    cached = { ms, at: Date.now() };
    return ms;
  } catch {
    // A sign-in must not depend on this read succeeding.
    return DEFAULT_SESSION_TTL_MS;
  }
}

/** What the middleware uses, without awaiting. Seeded by the read above. */
export function sessionTtlNow(): number {
  return cached?.ms ?? DEFAULT_SESSION_TTL_MS;
}

export async function setSessionTtlMs(ms: number, by: string): Promise<number> {
  await ensure();
  const value = clean(ms);
  if (value === null) {
    throw new Error(
      `An automatic sign-out between ${MIN_SESSION_TTL_MS / 60_000} minutes and `
      + `${MAX_SESSION_TTL_MS / 86_400_000} days, please.`);
  }
  await db().query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ('session_ttl_ms', $1, $2)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [String(value), by]);
  cached = { ms: value, at: Date.now() };
  return value;
}
