import { db, ensureSchema } from "../db.js";
import {
  EVENT_CATEGORIES, SEVERITY_RANK, SIGNIN_ACTIONS, SUSPICIOUS, actionsIn, metaFor,
  type AuditAction, type EventCategory, type Outcome, type Severity,
} from "./event-catalog.js";

/**
 * The event trail, and the lockout that reads from it.
 *
 * One table for everything — security, access and the day's work — with
 * views over it rather than three logs. They are the same data asked
 * different questions, and an investigator's first question is almost
 * always "what else happened around then", which three separate tables
 * cannot answer.
 *
 * APPEND-ONLY. Nothing in this module updates or deletes a row. What an
 * investigator decides about an event lives in `investigations.ts`, in
 * its own auditable records, so a conclusion can never be mistaken for
 * evidence or quietly overwrite it.
 *
 * What is NOT written here: tokens, codes, links, cookies, credentials,
 * or anything derived from them. An audit log that records the
 * credential is a credential store with a nicer name. `audit()` strips
 * them on the way in rather than trusting every caller — see `redact`.
 */

export {
  EVENT_CATEGORIES, SUSPICIOUS, SIGNIN_ACTIONS, metaFor,
  type AuditAction, type EventCategory, type Outcome, type Severity,
};
export { AUDIT_ACTIONS } from "./event-catalog.js";

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
/**
 * Enough to tell two attempts apart, and to recognise a tool.
 *
 * The user agent is self-reported and can say anything, which is rather
 * the point of recording it: a run of attempts sharing one odd agent
 * string is a pattern an address and a time alone do not show. It is a
 * clue, never an identity.
 *
 * The forwarded chain is kept apart from the ip column because that
 * column is only the first hop, and a chain of three says something
 * the first one does not.
 */
ALTER TABLE dm_audit ADD COLUMN IF NOT EXISTS user_agent text NOT NULL DEFAULT '';
ALTER TABLE dm_audit ADD COLUMN IF NOT EXISTS path text NOT NULL DEFAULT '';
ALTER TABLE dm_audit ADD COLUMN IF NOT EXISTS forwarded text NOT NULL DEFAULT '';
/*
 * The real person, when a view is on.
 *
 * The actor column is the EFFECTIVE identity — who the app was acting
 * as. This one is
 * who was at the keyboard. Both are kept because an action taken during
 * a view belongs to both of them, and a trail that records only one of
 * the two cannot answer either question afterwards.
 */
ALTER TABLE dm_audit ADD COLUMN IF NOT EXISTS actor_real text NOT NULL DEFAULT '';
/* What it happened TO, when that is not a person: a signup guid, a tag. */
ALTER TABLE dm_audit ADD COLUMN IF NOT EXISTS resource text NOT NULL DEFAULT '';
/*
 * When it HAPPENED, as against when the row was written.
 *
 * The same for anything this app records itself, and deliberately
 * separate anyway: an event imported from somewhere else later would
 * otherwise land on the timeline at the moment of import, which is the
 * one time it is certain not to have happened.
 */
ALTER TABLE dm_audit ADD COLUMN IF NOT EXISTS occurred_at timestamptz;
CREATE INDEX IF NOT EXISTS dm_audit_ip ON dm_audit (ip, at DESC);
CREATE INDEX IF NOT EXISTS dm_audit_recent ON dm_audit (at DESC);
CREATE INDEX IF NOT EXISTS dm_audit_subject ON dm_audit (subject, action, at DESC);
CREATE INDEX IF NOT EXISTS dm_audit_action ON dm_audit (action, at DESC);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

export type AuditEntry = {
  id: string;
  /** When the row was written. */
  receivedAt: string;
  /** When it happened. The same thing for events this app records itself. */
  at: string;
  /** The effective identity — who the app was acting as. */
  actor: string;
  /** The person actually at the keyboard, when a view was on. */
  actorReal: string;
  action: string;
  subject: string;
  resource: string;
  detail: string;
  ip: string;
  userAgent: string;
  path: string;
  /** The whole X-Forwarded-For chain, when there was more than one hop. */
  forwarded: string;
  /* Derived from the action, never stored — see `event-catalog.ts`. */
  category: EventCategory;
  outcome: Outcome;
  severity: Severity;
  label: string;
};

/**
 * Everything worth keeping about where a request came from.
 *
 * Taken from the request rather than passed in by each caller, so a
 * new route cannot quietly log less than the others.
 *
 * The address is the first hop of X-Forwarded-For, which is only
 * trustworthy because this app sits behind one proxy that sets it. It
 * is still a clue and not an identity: anything in front of that proxy
 * can put what it likes in the chain, which is why the whole chain is
 * kept separately rather than collapsed into one "the IP is" claim.
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
    path: safePath(`${req.method ?? ""} ${req.path ?? ""}`.trim()),
    // Only when it adds something: one hop is already in `ip`.
    forwarded: chain.includes(",") ? chain.slice(0, 300) : "",
  };
}

/**
 * A path with its query string removed.
 *
 * Sign-in links and confirmation codes travel in query strings, so a
 * route recorded whole is how a one-time credential ends up in the log
 * that is supposed to prove nothing leaked. Dropped at the boundary
 * rather than per caller.
 */
const safePath = (p: string): string => (p.split("?")[0] ?? "").slice(0, 200);

/**
 * Strip anything that looks like a secret out of free text.
 *
 * A belt to the brace of callers being careful: nothing here is meant
 * to carry a token, and this is what happens when something does. The
 * patterns are deliberately broad — a redacted detail line is a small
 * loss, and a logged credential is not.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:token|code|secret|password|authorization|bearer|cookie)\s*[=:]\s*\S+/gi,
      (m) => `${m.split(/[=:]/)[0]!}=[redacted]`)
    .replace(/[?&](?:token|code|t|c)=[^\s&]+/gi, "?[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .slice(0, 500);
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
  /** The effective identity. During a view, that is the VIEWED person. */
  actor?: string;
  /** Who was really at the keyboard. Only differs during a view. */
  actorReal?: string;
  /** A signup guid, an RFID number — what it was done to, if not a person. */
  resource?: string;
  detail?: string;
  ip?: string;
  userAgent?: string;
  path?: string;
  forwarded?: string;
  /** When it happened, if that is not now. */
  occurredAt?: Date;
}): Promise<void> {
  try {
    await ensure();
    await db().query(
      `INSERT INTO dm_audit
         (actor, actor_real, action, subject, resource, detail, ip, user_agent,
          path, forwarded, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [(e.actor ?? "").toLowerCase(), (e.actorReal ?? "").toLowerCase(), e.action,
        (e.subject ?? "").toLowerCase(), (e.resource ?? "").slice(0, 200),
        redact(e.detail ?? ""), e.ip ?? "",
        (e.userAgent ?? "").slice(0, 300), safePath(e.path ?? ""),
        (e.forwarded ?? "").slice(0, 300), e.occurredAt ?? null]);
  } catch (err) {
    console.error("audit write failed:", err instanceof Error ? err.message : err);
  }
}

const COLS = `id, at, occurred_at, actor, actor_real, action, subject, resource,
              detail, ip, user_agent, path, forwarded`;

type DbEntry = {
  id: string; at: Date; occurred_at: Date | null; actor: string; actor_real: string;
  action: string; subject: string; resource: string; detail: string; ip: string;
  user_agent: string; path: string; forwarded: string;
};

const shapeEntry = (r: DbEntry): AuditEntry => {
  const m = metaFor(r.action);
  return {
    id: String(r.id),
    receivedAt: r.at.toISOString(),
    at: (r.occurred_at ?? r.at).toISOString(),
    actor: r.actor,
    actorReal: r.actor_real,
    action: r.action,
    subject: r.subject,
    resource: r.resource,
    detail: r.detail,
    ip: r.ip,
    userAgent: r.user_agent,
    path: r.path,
    forwarded: r.forwarded,
    category: m.category,
    outcome: m.outcome,
    severity: m.severity,
    label: m.label,
  };
};

export type EventQuery = {
  /** One of the three views. Omitted searches everything. */
  category?: EventCategory | "all";
  /** Narrower than a category — the Sign-ins view, or a triage feed. */
  preset?: "signins" | "suspicious";
  /** Matched against subject, actor and the real actor. */
  who?: string;
  ip?: string;
  action?: string;
  outcome?: Outcome;
  /** This severity and above. */
  minSeverity?: Severity;
  resource?: string;
  /** Free text over the detail line and the address. */
  search?: string;
  days?: number;
  limit?: number;
  offset?: number;
};

/**
 * The one read everything goes through.
 *
 * Severity is derived rather than stored, so it is filtered after the
 * rows come back — fine at this size, and worth the price of never
 * having a stored severity that disagrees with the catalogue.
 */
export async function listEvents(q: EventQuery = {}): Promise<{
  rows: AuditEntry[]; total: number;
}> {
  await ensure();
  const where: string[] = [];
  const args: unknown[] = [];

  const actions = q.preset === "signins" ? SIGNIN_ACTIONS
    : q.preset === "suspicious" ? SUSPICIOUS
      : q.category && q.category !== "all" ? actionsIn(q.category)
        : null;
  if (actions) {
    args.push(actions);
    where.push(`action = ANY($${args.length}::text[])`);
  }
  if (q.action) {
    args.push(q.action);
    where.push(`action = $${args.length}`);
  }
  if (q.who?.trim()) {
    args.push(q.who.trim().toLowerCase());
    where.push(`(subject = $${args.length} OR actor = $${args.length}
                 OR actor_real = $${args.length})`);
  }
  if (q.ip?.trim()) {
    args.push(q.ip.trim());
    where.push(`ip = $${args.length}`);
  }
  if (q.resource?.trim()) {
    args.push(q.resource.trim());
    where.push(`resource = $${args.length}`);
  }
  if (q.search?.trim()) {
    args.push(`%${q.search.trim().toLowerCase()}%`);
    where.push(`(lower(detail) LIKE $${args.length} OR lower(subject) LIKE $${args.length}
                 OR lower(actor) LIKE $${args.length})`);
  }
  const days = Math.min(Math.max(Number(q.days) || 90, 1), 3650);
  args.push(String(days));
  where.push(`at > now() - ($${args.length} || ' days')::interval`);

  const clause = `WHERE ${where.join(" AND ")}`;
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 2000);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const { rows } = await db().query<DbEntry>(
    `SELECT ${COLS} FROM dm_audit ${clause}
      ORDER BY coalesce(occurred_at, at) DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}`, args);
  const total = Number((await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM dm_audit ${clause}`, args)).rows[0]?.n ?? 0);

  let out = rows.map(shapeEntry);
  if (q.outcome) out = out.filter((r) => r.outcome === q.outcome);
  if (q.minSeverity) {
    const floor = SEVERITY_RANK[q.minSeverity];
    out = out.filter((r) => SEVERITY_RANK[r.severity] >= floor);
  }
  return { rows: out, total };
}

/** One account's or one record's history — a filtered view of the same data. */
export async function listAudit(opts: {
  subject?: string;
  resource?: string;
  limit?: number;
} = {}): Promise<AuditEntry[]> {
  const { rows } = await listEvents({
    who: opts.subject, resource: opts.resource,
    limit: opts.limit ?? 200, days: 3650,
  });
  return rows;
}

/** Kept for the security page's existing feed: blocked security events only. */
export async function listSecurityLog(opts: {
  days?: number; limit?: number;
} = {}): Promise<AuditEntry[]> {
  const { rows } = await listEvents({
    preset: "suspicious", days: opts.days ?? 30, limit: opts.limit ?? 300,
  });
  return rows;
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

/** How far back the trail actually goes, and how much of it there is. */
export async function collectionHealth(): Promise<{
  total: number;
  oldest: string | null;
  newest: string | null;
  byCategory: { category: EventCategory; events: number; last: string | null }[];
}> {
  await ensure();
  const span = await db().query<{ n: string; oldest: Date | null; newest: Date | null }>(
    "SELECT count(*) AS n, min(at) AS oldest, max(at) AS newest FROM dm_audit");
  const byCategory = await Promise.all(EVENT_CATEGORIES.map(async (category) => {
    const r = await db().query<{ n: string; last: Date | null }>(
      "SELECT count(*) AS n, max(at) AS last FROM dm_audit WHERE action = ANY($1::text[])",
      [actionsIn(category)]);
    return {
      category,
      events: Number(r.rows[0]?.n ?? 0),
      last: r.rows[0]?.last ? r.rows[0]!.last!.toISOString() : null,
    };
  }));
  return {
    total: Number(span.rows[0]?.n ?? 0),
    oldest: span.rows[0]?.oldest ? span.rows[0]!.oldest!.toISOString() : null,
    newest: span.rows[0]?.newest ? span.rows[0]!.newest!.toISOString() : null,
    byCategory,
  };
}

/* ------------------------------------------------------------------ *
 * Lockout
 * ------------------------------------------------------------------ */

/**
 * How much failing is too much.
 *
 * Counted per ADDRESS over a rolling window rather than per IP, which
 * is the deliberate choice: a dealership is one office behind one
 * address, so locking an IP would take a showroom offline because one
 * person mistyped a code. Generous enough that somebody fumbling a code
 * twice and asking for a fresh link never notices it.
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
