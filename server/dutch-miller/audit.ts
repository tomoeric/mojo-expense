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
  "notify.sent", "notify.failed", "notify.changed",
  "approved.sent", "approved.failed",
  "role.saved", "role.removed",
  "bulk.uploaded", "bulk.committed",
  "reminder.sent", "reminder.failed", "reminder.changed",
  /* Sign-in attempts worth looking at. See `SUSPICIOUS` below. */
  "login.unknown", "signin.denied", "session.rejected",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The ones that count toward a lockout. */
const FAILURES: AuditAction[] = ["login.rejected", "code.failed", "login.requested"];

/**
 * What belongs on the security log.
 *
 * Only things that FAILED or are worth a second look. A log of
 * successful sign-ins is a list nobody reads, and burying four real
 * attempts in nine hundred ordinary ones is how they get missed.
 *
 *   login.unknown    an address nobody ever invited asked for a link
 *   signin.denied    a real tenant account that is not on the allow-list
 *   login.rejected   a link that was expired, spent, or for a dead account
 *   code.failed      a wrong confirmation code
 *   locked.out       too many of the above, so the address is refused
 *   session.rejected a session cookie that no longer matches its account
 */
export const SUSPICIOUS: AuditAction[] = [
  "login.unknown", "signin.denied", "login.rejected", "code.failed",
  "locked.out", "session.rejected",
];

/**
 * The security log, newest first.
 *
 * Deliberately unaggregated — an administrator reading this wants the
 * raw attempts with their addresses, times and IPs. The grouping that
 * makes a pattern obvious is done above it, in `signInSummary`.
 */
export async function listSecurityLog(opts: {
  days?: number;
  limit?: number;
} = {}): Promise<AuditEntry[]> {
  await ensure();
  const days = Math.min(Math.max(Number(opts.days) || 30, 1), 365);
  const limit = Math.min(Math.max(Number(opts.limit) || 300, 1), 2000);
  const { rows } = await db().query<DbEntry>(
    `SELECT id, at, actor, action, subject, detail, ip, user_agent, path, forwarded
       FROM dm_audit
      WHERE action = ANY($1::text[]) AND at > now() - ($2 || ' days')::interval
      ORDER BY at DESC, id DESC LIMIT ${limit}`,
    [SUSPICIOUS, String(days)]);
  return rows.map(shapeEntry);
}

/**
 * The shape of it: who is being tried, and from where.
 *
 * One IP against many addresses is the pattern that matters — a person
 * mistyping their own code looks nothing like somebody working through
 * a list, and only the grouping tells them apart.
 */
export async function securitySummary(days = 30): Promise<{
  byAddress: { subject: string; attempts: number; last: string }[];
  byIp: { ip: string; attempts: number; addresses: number; last: string }[];
  total: number;
}> {
  await ensure();
  const window = String(Math.min(Math.max(days, 1), 365));
  const base = `FROM dm_audit WHERE action = ANY($1::text[])
                  AND at > now() - ($2 || ' days')::interval`;

  const byAddress = await db().query<{ subject: string; n: string; last: Date }>(
    `SELECT subject, count(*) AS n, max(at) AS last ${base} AND subject <> ''
      GROUP BY subject ORDER BY n DESC, last DESC LIMIT 50`, [SUSPICIOUS, window]);
  const byIp = await db().query<{ ip: string; n: string; addrs: string; last: Date }>(
    `SELECT ip, count(*) AS n, count(DISTINCT subject) AS addrs, max(at) AS last ${base}
        AND ip <> ''
      GROUP BY ip ORDER BY addrs DESC, n DESC LIMIT 50`, [SUSPICIOUS, window]);
  const total = await db().query<{ n: string }>(`SELECT count(*) AS n ${base}`,
    [SUSPICIOUS, window]);

  return {
    byAddress: byAddress.rows.map((r) => ({
      subject: r.subject, attempts: Number(r.n), last: r.last.toISOString(),
    })),
    byIp: byIp.rows.map((r) => ({
      ip: r.ip, attempts: Number(r.n), addresses: Number(r.addrs),
      last: r.last.toISOString(),
    })),
    total: Number(total.rows[0]?.n ?? 0),
  };
}

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
/**
 * Enough to tell two attempts apart, and to recognise a tool.
 *
 * The user agent lies freely — that is rather the point of recording
 * it. A browser claims to be a browser; curl, a script and a scanner
 * mostly do not bother, and a run of attempts sharing one odd agent
 * string is a pattern an address and a time alone do not show.
 *
 * The forwarded chain is kept apart from the ip column because that
 * column is only the first hop, and a chain of three says something
 * the first one does not.
 */
ALTER TABLE dm_audit ADD COLUMN IF NOT EXISTS user_agent text NOT NULL DEFAULT '';
ALTER TABLE dm_audit ADD COLUMN IF NOT EXISTS path text NOT NULL DEFAULT '';
ALTER TABLE dm_audit ADD COLUMN IF NOT EXISTS forwarded text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS dm_audit_ip ON dm_audit (ip, at DESC);
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
  userAgent: string;
  path: string;
  /** The whole X-Forwarded-For chain, when there was more than one hop. */
  forwarded: string;
};

/**
 * Everything worth keeping about where a request came from.
 *
 * Taken from the request rather than passed in by each caller, so a
 * new route cannot quietly log less than the others.
 */
export function requestMeta(req: {
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string };
  path?: string;
  method?: string;
}): { ip: string; userAgent: string; path: string; forwarded: string } {
  const chain = String(req.headers["x-forwarded-for"] ?? "").trim();
  const first = chain.split(",")[0]?.trim() ?? "";
  return {
    ip: first || req.socket?.remoteAddress || "",
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
    path: `${req.method ?? ""} ${req.path ?? ""}`.trim(),
    // Only when it adds something: one hop is already in `ip`.
    forwarded: chain.includes(",") ? chain.slice(0, 300) : "",
  };
}

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
  userAgent?: string;
  path?: string;
  forwarded?: string;
}): Promise<void> {
  try {
    await ensure();
    await db().query(
      `INSERT INTO dm_audit (actor, action, subject, detail, ip, user_agent, path, forwarded)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [(e.actor ?? "").toLowerCase(), e.action, (e.subject ?? "").toLowerCase(),
        (e.detail ?? "").slice(0, 500), e.ip ?? "",
        (e.userAgent ?? "").slice(0, 300), (e.path ?? "").slice(0, 200),
        (e.forwarded ?? "").slice(0, 300)]);
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
    user_agent: string; path: string; forwarded: string;
  }>(
    `SELECT id, at, actor, action, subject, detail, ip, user_agent, path, forwarded
       FROM dm_audit
      ${subject ? "WHERE subject = $1 OR actor = $1" : ""}
      ORDER BY at DESC, id DESC LIMIT ${limit}`,
    subject ? [subject] : []);
  return rows.map(shapeEntry);
}

type DbEntry = {
  id: string; at: Date; actor: string; action: string;
  subject: string; detail: string; ip: string;
  user_agent: string; path: string; forwarded: string;
};

const shapeEntry = (r: DbEntry): AuditEntry => ({
  id: String(r.id),
  at: r.at.toISOString(),
  actor: r.actor,
  action: r.action,
  subject: r.subject,
  detail: r.detail,
  ip: r.ip,
  userAgent: r.user_agent,
  path: r.path,
  forwarded: r.forwarded,
});

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
