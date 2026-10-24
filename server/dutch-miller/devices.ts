import { createHash, randomBytes } from "node:crypto";
import { db, ensureSchema } from "../db.js";

/**
 * Trusted devices, for the people who sign in with an emailed link.
 *
 * The rule, in one sentence: the FIRST sign-in from a browser asks for a
 * code, and that browser is then trusted for two weeks.
 *
 * It replaces an earlier per-request browser binding, which only asked
 * whether a link was opened where it was requested. That answered a
 * narrow question and answered it again from scratch every time. This
 * answers the useful one — is this a machine we have seen this person
 * use? — and asks for the code only when the answer is no.
 *
 * Trust is a ROW, not just a cookie, so it can be taken away. Revoking
 * somebody's sessions or switching their account off clears their
 * devices too; otherwise "signed out everywhere" would leave every
 * machine they had ever used able to walk back in without a code.
 *
 * The cookie holds a random secret and the table holds its SHA-256, the
 * same way the links do: a leaked backup is a list of hashes.
 */

export const DEVICE_COOKIE = "dm_device";

/** Two weeks, then the code is asked for again. */
export const TRUST_DAYS = 14;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_trusted_devices (
  /** SHA-256 of the cookie's secret. The secret itself is only ever in the browser. */
  id         text        PRIMARY KEY,
  email      text        NOT NULL,
  trusted_at timestamptz NOT NULL DEFAULT now(),
  /** Fixed at two weeks from when trust was granted — it does not roll forward. */
  expires_at timestamptz NOT NULL,
  last_use   timestamptz NOT NULL DEFAULT now(),
  /** Enough to tell two machines apart in a list. Never used to decide anything. */
  label      text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS dm_devices_email ON dm_trusted_devices (email, expires_at);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

const hash = (v: string): string => createHash("sha256").update(v).digest("hex");
const clean = (email: string) => email.trim().toLowerCase();

/**
 * A short, human-readable name for the machine.
 *
 * From the user agent, which lies freely — so it is used for the list an
 * administrator reads and for nothing else. No decision anywhere depends
 * on it.
 */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const os = /Windows/i.test(ua) ? "Windows"
    : /iPhone|iPad|iOS/i.test(ua) ? "iOS"
      : /Android/i.test(ua) ? "Android"
        : /Mac OS X|Macintosh/i.test(ua) ? "Mac"
          : /Linux/i.test(ua) ? "Linux" : "";
  const browser = /Edg\//i.test(ua) ? "Edge"
    : /OPR\//i.test(ua) ? "Opera"
      : /Chrome\//i.test(ua) ? "Chrome"
        : /Safari\//i.test(ua) ? "Safari"
          : /Firefox\//i.test(ua) ? "Firefox" : "";
  return [browser, os].filter(Boolean).join(" on ") || "Unknown device";
}

/**
 * Is this browser already trusted for this person?
 *
 * Both halves matter. A device secret alone is not enough — it has to be
 * trusted for the address being signed in to, or a shared machine would
 * let one person's trust carry another person past the code.
 */
export async function isTrusted(email: string, secret: string | undefined): Promise<boolean> {
  await ensure();
  if (!secret) return false;
  const { rowCount } = await db().query(
    `UPDATE dm_trusted_devices SET last_use = now()
      WHERE id = $1 AND email = $2 AND expires_at > now()`,
    [hash(secret), clean(email)]);
  return (rowCount ?? 0) > 0;
}

/**
 * Trust this browser for two weeks. Returns the secret for the cookie.
 *
 * A fresh secret every time rather than extending the old row, so the
 * two weeks run from this sign-in and a secret that leaked earlier does
 * not get a new lease along with it.
 */
export async function trustDevice(email: string, label: string): Promise<{
  secret: string;
  maxAgeMs: number;
}> {
  await ensure();
  const secret = randomBytes(32).toString("base64url");
  const maxAgeMs = TRUST_DAYS * 24 * 60 * 60 * 1000;
  await db().query(
    `INSERT INTO dm_trusted_devices (id, email, expires_at, label)
          VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)
     ON CONFLICT (id) DO NOTHING`,
    [hash(secret), clean(email), String(TRUST_DAYS), label.slice(0, 80)]);
  return { secret, maxAgeMs };
}

/** Every machine this person has been trusted on, for an administrator. */
export async function listDevices(email: string): Promise<{
  label: string; trustedAt: string; expiresAt: string; lastUse: string;
}[]> {
  await ensure();
  const { rows } = await db().query<{
    label: string; trusted_at: Date; expires_at: Date; last_use: Date;
  }>(
    `SELECT label, trusted_at, expires_at, last_use FROM dm_trusted_devices
      WHERE email = $1 AND expires_at > now() ORDER BY last_use DESC`, [clean(email)]);
  return rows.map((r) => ({
    label: r.label,
    trustedAt: r.trusted_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    lastUse: r.last_use.toISOString(),
  }));
}

/**
 * Forget every machine this person is trusted on.
 *
 * Called wherever sessions are revoked or an account is switched off. A
 * sign-out that left the devices trusted would mean the next link they
 * were sent walked straight in with no code — which is not what anybody
 * pressing "revoke" is asking for.
 */
export async function forgetDevices(email: string): Promise<number> {
  await ensure();
  const { rowCount } = await db().query(
    "DELETE FROM dm_trusted_devices WHERE email = $1", [clean(email)]);
  return rowCount ?? 0;
}

/** Housekeeping: trust that ran out is of no use to anybody. */
export async function purgeDevices(): Promise<number> {
  await ensure();
  const { rowCount } = await db().query(
    "DELETE FROM dm_trusted_devices WHERE expires_at < now() - interval '30 days'");
  return rowCount ?? 0;
}
