import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { db, ensureSchema } from "../db.js";
import { LOCKOUT } from "./audit.js";

/**
 * One-time links, and the codes that go with them.
 *
 * Rules the whole thing rests on, none of which are optional:
 *
 *   NOTHING IS STORED IN THE CLEAR. The database holds SHA-256 of the
 *   token and of the code. A leaked backup is then a list of hashes, not a
 *   set of working keys. There is no reason to ever read one back, so
 *   there is no reason to keep one.
 *
 *   SINGLE USE, claimed with a conditional UPDATE — the same trick as the
 *   RFID tags. Two clicks, a mail scanner pre-fetching the URL, or a retry
 *   cannot all succeed; exactly one does.
 *
 *   SHORT LIVED, and asking for a new link kills the old one, so there is
 *   never more than one live link per person.
 *
 *   BOUND TO THE BROWSER THAT ASKED, softly. A login link opened in the
 *   browser that requested it signs straight in. Opened anywhere else —
 *   forwarded, pasted into a chat, picked up from a shared history — it
 *   asks for the six-digit code as well. That keeps a leaked URL on its
 *   own worthless without breaking the ordinary "asked on my laptop, read
 *   mail on my phone" case.
 *
 * An invite cannot be browser-bound at all: an admin asks for it and
 * somebody else opens it. Invites therefore ALWAYS require the code, which
 * is also how the address gets verified.
 */

export const INVITE_TTL_MINUTES = 60 * 24 * 7; // A week — an admin sends it, a person gets to it.
export const LOGIN_TTL_MINUTES = 15;
export const CODE_TTL_MINUTES = 15;

export type TokenKind = "invite" | "login";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_login_tokens (
  id           uuid        PRIMARY KEY,
  email        text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('invite', 'login')),
  /** SHA-256 of the token. The token itself exists only in the email. */
  token_hash   text        NOT NULL UNIQUE,
  /** SHA-256 of a nonce cookie set in the browser that asked. Null for invites. */
  browser_hash text,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text        NOT NULL DEFAULT '',
  ip           text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS dm_login_tokens_live ON dm_login_tokens (email, kind, used_at);

CREATE TABLE IF NOT EXISTS dm_verify_codes (
  email      text        PRIMARY KEY,
  /** SHA-256 of the six digits. */
  code_hash  text        NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   integer     NOT NULL DEFAULT 0,
  sent_at    timestamptz NOT NULL DEFAULT now()
);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

const hash = (v: string): string => createHash("sha256").update(v).digest("hex");
const clean = (email: string) => email.trim().toLowerCase();

/** Constant-time, and safe when the lengths differ. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ------------------------------------------------------------------ *
 * Links
 * ------------------------------------------------------------------ */

export type IssuedToken = {
  /** Goes in the email. Never stored, never logged. */
  token: string;
  /** Goes in a cookie on the browser that asked. Null for an invite. */
  browserNonce: string | null;
  expiresAt: string;
};

export async function issueToken(opts: {
  email: string;
  kind: TokenKind;
  by?: string;
  ip?: string;
  /** False for an invite, where the browser asking is not the one opening. */
  bindBrowser?: boolean;
}): Promise<IssuedToken> {
  await ensure();
  const email = clean(opts.email);
  const ttl = opts.kind === "invite" ? INVITE_TTL_MINUTES : LOGIN_TTL_MINUTES;

  // At most one live link per person per kind. Asking again replaces the
  // previous one rather than adding to a pile of working keys.
  await db().query(
    `UPDATE dm_login_tokens SET used_at = now()
      WHERE email = $1 AND kind = $2 AND used_at IS NULL`, [email, opts.kind]);

  // 32 bytes. Long enough that guessing is not a strategy, short enough to
  // survive a mail client wrapping the URL.
  const token = randomBytes(32).toString("base64url");
  const browserNonce = opts.bindBrowser === false ? null : randomBytes(16).toString("base64url");
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  await db().query(
    `INSERT INTO dm_login_tokens
       (id, email, kind, token_hash, browser_hash, expires_at, created_by, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), email, opts.kind, hash(token),
      browserNonce ? hash(browserNonce) : null, expiresAt, opts.by ?? "", opts.ip ?? ""]);

  return { token, browserNonce, expiresAt: expiresAt.toISOString() };
}

export type Redeemed =
  | { ok: true; email: string; kind: TokenKind; sameBrowser: boolean }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Spend a link.
 *
 * The claim is `WHERE used_at IS NULL AND expires_at > now()` in one
 * statement, so a second click — or a mail scanner that fetched the URL
 * before the person did — gets nothing back rather than a second sign-in.
 * Expired and already-used are told apart only so the page can say which.
 */
export async function redeemToken(token: string, browserNonce: string | undefined): Promise<Redeemed> {
  await ensure();
  if (!token) return { ok: false, reason: "unknown" };
  const { rows } = await db().query<{
    email: string; kind: TokenKind; browser_hash: string | null;
  }>(
    `UPDATE dm_login_tokens SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
    RETURNING email, kind, browser_hash`, [hash(token)]);

  const row = rows[0];
  if (!row) {
    // Nothing was spent. Say which of the three it was, for the page only.
    const { rows: look } = await db().query<{ used_at: Date | null; expires_at: Date }>(
      "SELECT used_at, expires_at FROM dm_login_tokens WHERE token_hash = $1", [hash(token)]);
    if (!look[0]) return { ok: false, reason: "unknown" };
    return { ok: false, reason: look[0].used_at ? "used" : "expired" };
  }

  const sameBrowser = row.browser_hash === null
    ? false
    : Boolean(browserNonce) && sameHash(row.browser_hash, hash(browserNonce!));
  return { ok: true, email: row.email, kind: row.kind, sameBrowser };
}

/** Housekeeping: spent and expired links are of no further use to anyone. */
export async function purgeOldTokens(): Promise<number> {
  await ensure();
  const { rowCount } = await db().query(
    "DELETE FROM dm_login_tokens WHERE expires_at < now() - interval '30 days'");
  return rowCount ?? 0;
}

/* ------------------------------------------------------------------ *
 * Codes
 * ------------------------------------------------------------------ */

/**
 * Six digits, uniformly drawn.
 *
 * `randomInt` rather than arithmetic on `Math.random`, which is neither
 * uniform nor unpredictable — and predictable is the only property that
 * matters here.
 */
export async function issueCode(email: string): Promise<string> {
  await ensure();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db().query(
    `INSERT INTO dm_verify_codes (email, code_hash, expires_at, attempts, sent_at)
          VALUES ($1, $2, now() + ($3 || ' minutes')::interval, 0, now())
     ON CONFLICT (email) DO UPDATE
        SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
            attempts = 0, sent_at = now()`,
    [clean(email), hash(code), String(CODE_TTL_MINUTES)]);
  return code;
}

export type CodeCheck =
  | { ok: true }
  | { ok: false; reason: "none" | "expired" | "wrong" | "too-many"; attemptsLeft: number };

/**
 * Check a code, and count the attempt.
 *
 * The attempt is counted BEFORE the comparison, so a wrong guess costs
 * something even if the request is abandoned halfway. Running out burns
 * the code rather than locking the address — the person asks for another
 * one and carries on, while an attacker gets a handful of guesses at a
 * million-wide number and then a fresh one to start over on.
 */
export async function verifyCode(email: string, code: string): Promise<CodeCheck> {
  await ensure();
  const who = clean(email);
  const { rows } = await db().query<{ code_hash: string; attempts: number; expired: boolean }>(
    `UPDATE dm_verify_codes SET attempts = attempts + 1
      WHERE email = $1
    RETURNING code_hash, attempts, (expires_at <= now()) AS expired`, [who]);
  const row = rows[0];
  if (!row) return { ok: false, reason: "none", attemptsLeft: 0 };

  const left = Math.max(0, LOCKOUT.maxCodeAttempts - row.attempts);
  if (row.expired) {
    await db().query("DELETE FROM dm_verify_codes WHERE email = $1", [who]);
    return { ok: false, reason: "expired", attemptsLeft: 0 };
  }
  if (row.attempts > LOCKOUT.maxCodeAttempts) {
    await db().query("DELETE FROM dm_verify_codes WHERE email = $1", [who]);
    return { ok: false, reason: "too-many", attemptsLeft: 0 };
  }
  if (!sameHash(row.code_hash, hash(String(code ?? "").trim()))) {
    return { ok: false, reason: "wrong", attemptsLeft: left };
  }
  // Spent. One code, one verification.
  await db().query("DELETE FROM dm_verify_codes WHERE email = $1", [who]);
  return { ok: true };
}
