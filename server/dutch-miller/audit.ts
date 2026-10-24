import { db, ensureSchema } from "../db.js";

/**
 * The audit trail, and the lockout that reads from it.
 *
 * One table for both, because they are the same data asked two ways: the
 * trail is "what happened", and a lockout is "how much of this happened
 * recently". Keeping a separate counter would mean a second thing to keep
 * in step, and a counter that disagrees with the log is worse than no
 * counter.
 *
 * What is NOT written here: tokens, codes, or anything derived from them.
 * An audit log that records the credential is a credential store with a
 * nicer name. The subject is the address; the detail is what was done.
 */

export const AUDIT_ACTIONS = [
  "invite.sent", "invite.resent", "invite.redeemed", "invite.expired",
  "login.requested", "login.sent", "login.redeemed", "login.rejected",
  "code.sent", "code.verified", "code.failed",
  "account.activated", "account.created", "account.updated",
  "account.disabled", "account.enabled", "account.removed",
  "sessions.revoked", "locked.out",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The ones that count toward a lockout. */
const FAILURES: AuditAction[] = ["login.rejected", "code.failed", "login.requested"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_audit (
  id      bigserial   PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  /** Who did it. Empty for an attempt by somebody not signed in. */
  actor   text        NOT NULL DEFAULT '',
  action  text        NOT NULL,
  /** Who or what it was done to — an email address, normally. */
  subject text        NOT NULL DEFAULT '',
  /** Short free text. Never a token, a code, or anything derived from one. */
  detail  text        NOT NULL DEFAULT '',
  ip      text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS dm_audit_recent ON dm_audit (at DESC);
CREATE INDEX IF NOT EXISTS dm_audit_subject ON dm_audit (subject, action, at DESC);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

export type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  subject: string;
  detail: string;
  ip: string;
};

/**
 * Write one line.
 *
 * Never throws and never blocks the caller's own work: an audit write that
 * can fail a sign-in turns a logging problem into an outage. A failure is
 * logged to the console, which is the one place left to put it.
 */
export async function audit(e: {
  action: AuditAction;
  subject?: string;
  actor?: string;
  detail?: string;
  ip?: string;
}): Promise<void> {
  try {
    await ensure();
    await db().query(
      `INSERT INTO dm_audit (actor, action, subject, detail, ip)
            VALUES ($1, $2, $3, $4, $5)`,
      [(e.actor ?? "").toLowerCase(), e.action, (e.subject ?? "").toLowerCase(),
        (e.detail ?? "").slice(0, 500), e.ip ?? ""]);
  } catch (err) {
    console.error("audit write failed:", err instanceof Error ? err.message : err);
  }
}

export async function listAudit(opts: {
  subject?: string;
  limit?: number;
} = {}): Promise<AuditEntry[]> {
  await ensure();
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
  const subject = (opts.subject ?? "").trim().toLowerCase();
  const { rows } = await db().query<{
    id: string; at: Date; actor: string; action: string;
    subject: string; detail: string; ip: string;
  }>(
    `SELECT id, at, actor, action, subject, detail, ip FROM dm_audit
      ${subject ? "WHERE subject = $1 OR actor = $1" : ""}
      ORDER BY at DESC, id DESC LIMIT ${limit}`,
    subject ? [subject] : []);
  return rows.map((r) => ({ ...r, id: String(r.id), at: r.at.toISOString() }));
}

/* ------------------------------------------------------------------ *
 * Lockout
 * ------------------------------------------------------------------ */

/**
 * How much failing is too much.
 *
 * Counted per address over a rolling window rather than per session or per
 * browser, because the attacker chooses those and not the address they are
 * trying to reach. Generous enough that somebody mistyping a code twice
 * and asking for a fresh link never notices it.
 */
export const LOCKOUT = {
  /** Failed codes, rejected links and link requests, together. */
  maxFailures: 8,
  windowMinutes: 15,
  /** How long the address is refused once it trips. */
  lockMinutes: 15,
  /** Wrong codes allowed against one live code before it is burned. */
  maxCodeAttempts: 5,
} as const;

export type LockState = { locked: boolean; until: string | null; recent: number };

/**
 * Is this address locked, and for how much longer?
 *
 * Derived from the trail rather than stored, so it cannot drift from it —
 * and so it clears by itself as the window moves, with nothing to sweep up
 * and no row that can be left behind locking somebody out for good.
 */
export async function lockState(email: string): Promise<LockState> {
  await ensure();
  const who = email.trim().toLowerCase();
  const { rows } = await db().query<{ n: string; last: Date | null }>(
    `SELECT count(*) AS n, max(at) AS last
       FROM dm_audit
      WHERE subject = $1
        AND action = ANY($2::text[])
        AND at > now() - ($3 || ' minutes')::interval`,
    [who, FAILURES, String(LOCKOUT.windowMinutes)]);
  const recent = Number(rows[0]?.n ?? 0);
  const last = rows[0]?.last ?? null;
  if (recent < LOCKOUT.maxFailures || !last) return { locked: false, until: null, recent };
  const until = new Date(last.getTime() + LOCKOUT.lockMinutes * 60_000);
  return until > new Date()
    ? { locked: true, until: until.toISOString(), recent }
    : { locked: false, until: null, recent };
}

/** Minutes left, rounded up, for a message somebody has to read. */
export const minutesLeft = (until: string | null): number =>
  until ? Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60_000)) : 0;
