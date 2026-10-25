import { db, ensureSchema } from "../db.js";
import { isMailConfigured, sendMail } from "../mail.js";

/**
 * Sending one message, once, with a bounded number of tries.
 *
 * Three things this exists for, each of which the plain `sendMail`
 * could not give:
 *
 *   BOUNDED RETRIES. Graph fails transiently — a 429, a 503, a dropped
 *   connection — and a notification lost to one of those is a dealer
 *   waiting on an email that is never coming. Retried a small fixed
 *   number of times with a growing pause, and then it STOPS. An
 *   unbounded retry is a way to turn one bad address into a mail loop.
 *
 *   DUPLICATE PROTECTION. A retry whose first attempt actually
 *   succeeded but whose response was lost would send twice. Each
 *   message is claimed by key first — resource, recipient, kind — and
 *   a claim that is already `sent` is not sent again. This also makes
 *   the whole thing safe to call twice from anywhere.
 *
 *   A VISIBLE FINAL STATE. When it does give up, that is recorded
 *   against the member rather than only in a log line, so the record
 *   can say "we could not reach the reviewer" instead of showing a
 *   grey step nobody can explain.
 *
 * What it deliberately does NOT claim: that anything arrived. Graph
 * ACCEPTING a message is the last fact available to this application.
 * Delivery, bounces and whether a person read it are not observable
 * here, and the UI says so rather than implying otherwise.
 */

export const RETRY = {
  /** Total attempts, first included. Three is enough for a blip. */
  maxAttempts: 3,
  /** Milliseconds before the second and third tries. */
  backoffMs: [2000, 8000],
} as const;

export type DeliveryState = "sending" | "sent" | "failed";

export type DeliveryRow = {
  id: string;
  resource: string;
  kind: string;
  email: string;
  audience: string;
  state: DeliveryState;
  attempts: number;
  firstAt: string;
  lastAt: string;
  error: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_mail_sends (
  id        bigserial   PRIMARY KEY,
  /* What it is about: a signup guid, usually. */
  resource  text        NOT NULL DEFAULT '',
  /* Which message: signup, approved, reminder. */
  kind      text        NOT NULL,
  email     text        NOT NULL,
  /* reviewer, notifier, submitter — why they are getting it. */
  audience  text        NOT NULL DEFAULT '',
  state     text        NOT NULL DEFAULT 'sending',
  attempts  integer     NOT NULL DEFAULT 0,
  first_at  timestamptz NOT NULL DEFAULT now(),
  last_at   timestamptz NOT NULL DEFAULT now(),
  /* Why it finally failed. Never a token or a link. */
  error     text        NOT NULL DEFAULT ''
);
/*
 * One row per message, which is what makes a resend idempotent.
 *
 * Without this a retry whose first attempt succeeded but whose reply
 * was lost sends the thing twice, and the reviewer gets two emails
 * about one member with no way to tell which is the real one.
 */
CREATE UNIQUE INDEX IF NOT EXISTS dm_mail_sends_once
  ON dm_mail_sends (resource, kind, email);
CREATE INDEX IF NOT EXISTS dm_mail_sends_resource
  ON dm_mail_sends (resource, first_at DESC);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Worth trying again?
 *
 * A refused address, a mailbox that does not exist or a permission
 * problem will fail identically three times, so retrying them only
 * delays the honest answer. Rate limits and server errors are exactly
 * what a retry is for.
 */
function transient(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  if (/\b(429|500|502|503|504)\b/.test(m)) return true;
  if (/timeout|timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(m)) {
    return true;
  }
  // Not configured, forbidden, bad address: the answer will not change.
  return false;
}

export type SendResult = {
  email: string;
  state: DeliveryState;
  attempts: number;
  /** Already sent earlier; nothing was sent now. */
  duplicate: boolean;
  error: string;
};

/**
 * Send one message to one person, at most once ever.
 *
 * `resource` + `kind` + `email` is the identity of the message. Called
 * again with the same three, it does nothing and says so.
 */
export async function sendOnce(opts: {
  resource: string;
  kind: string;
  email: string;
  audience?: string;
  subject: string;
  html: string;
  /**
   * How to actually send it. Defaults to Graph.
   *
   * A seam for the tests, which are about the retry bound, the
   * duplicate guard and the final state — none of which should need a
   * real mailbox to check, and a test that sends real mail is a test
   * nobody runs. An ES module namespace cannot be monkey-patched, so
   * the alternative was no coverage of any of it.
   */
  transport?: (to: string, subject: string, html: string) => Promise<void>;
  configured?: () => boolean;
}): Promise<SendResult> {
  await ensure();
  const email = opts.email.trim().toLowerCase();

  // Claim it. ON CONFLICT DO NOTHING means the second caller for the
  // same message gets no row back and knows to stand down.
  const claim = await db().query<{ id: string; state: string; attempts: number }>(
    `INSERT INTO dm_mail_sends (resource, kind, email, audience, state)
          VALUES ($1, $2, $3, $4, 'sending')
     ON CONFLICT (resource, kind, email) DO NOTHING
       RETURNING id, state, attempts`,
    [opts.resource, opts.kind, email, opts.audience ?? ""]);

  if (claim.rows.length === 0) {
    const held = await db().query<{ id: string; state: string; attempts: number; error: string }>(
      `SELECT id, state, attempts, error FROM dm_mail_sends
        WHERE resource = $1 AND kind = $2 AND email = $3`,
      [opts.resource, opts.kind, email]);
    const row = held.rows[0];
    // Already delivered, or still being tried by somebody else. Either
    // way this call must not send a second copy.
    if (row && row.state !== "failed") {
      return {
        email, state: row.state as DeliveryState, attempts: row.attempts,
        duplicate: true, error: "",
      };
    }
    // It failed before and somebody is asking again — a deliberate
    // resend. Reopen the same row rather than making a second one.
    await db().query(
      `UPDATE dm_mail_sends SET state = 'sending', last_at = now(), error = ''
        WHERE resource = $1 AND kind = $2 AND email = $3`,
      [opts.resource, opts.kind, email]);
  }

  const send = opts.transport ?? sendMail;
  const ready = opts.configured ?? isMailConfigured;
  if (!ready()) {
    await finish(opts, email, "failed", 0, "email is not configured");
    return { email, state: "failed", attempts: 0, duplicate: false, error: "not configured" };
  }

  let attempts = 0;
  let last = "";
  while (attempts < RETRY.maxAttempts) {
    attempts += 1;
    try {
      await send(email, opts.subject, opts.html);
      await finish(opts, email, "sent", attempts, "");
      return { email, state: "sent", attempts, duplicate: false, error: "" };
    } catch (err) {
      last = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
      if (!transient(err) || attempts >= RETRY.maxAttempts) break;
      await sleep(RETRY.backoffMs[attempts - 1] ?? 8000);
    }
  }
  // Out of tries. A final state somebody can see, not a silent gap.
  await finish(opts, email, "failed", attempts, last);
  return { email, state: "failed", attempts, duplicate: false, error: last };
}

async function finish(
  opts: { resource: string; kind: string },
  email: string,
  state: DeliveryState,
  attempts: number,
  error: string,
): Promise<void> {
  await db().query(
    `UPDATE dm_mail_sends
        SET state = $4, attempts = $5, last_at = now(), error = $6
      WHERE resource = $1 AND kind = $2 AND email = $3`,
    [opts.resource, opts.kind, email, state, attempts, error.slice(0, 300)]);
}

/** Every attempt made about one record, newest first. */
export async function deliveriesFor(resource: string): Promise<DeliveryRow[]> {
  await ensure();
  const { rows } = await db().query<{
    id: string; resource: string; kind: string; email: string; audience: string;
    state: string; attempts: number; first_at: Date; last_at: Date; error: string;
  }>(
    `SELECT id, resource, kind, email, audience, state, attempts, first_at, last_at, error
       FROM dm_mail_sends WHERE resource = $1 ORDER BY first_at DESC, id DESC LIMIT 100`,
    [resource]);
  return rows.map((r) => ({
    id: String(r.id),
    resource: r.resource,
    kind: r.kind,
    email: r.email,
    audience: r.audience,
    state: (r.state === "sent" || r.state === "failed" ? r.state : "sending"),
    attempts: r.attempts,
    firstAt: r.first_at.toISOString(),
    lastAt: r.last_at.toISOString(),
    error: r.error,
  }));
}
