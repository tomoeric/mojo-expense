import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { db, ensureSchema } from "../db.js";
import { env } from "../env.js";
import { RFID_RE } from "./rfid-parse.js";

/**
 * Member signups — a dealer enrols a customer and an RFID tag goes with them.
 *
 * The whole feature turns on one moment: a tag leaves the pool and is
 * attached to a person. That has to happen exactly once, and it has to
 * happen with the member record or not at all. A signup saved whose tag
 * stayed in the pool hands the same tag to the next customer; a tag marked
 * used with no signup behind it is simply lost. So the claim and the insert
 * are ONE transaction, the claim is a conditional UPDATE rather than a read
 * followed by a write, and the database carries a unique index on the tag so
 * even a bug above it cannot assign one twice.
 *
 * Two internal marks ride along with each record:
 *
 *   submitted_at — the entry reached MOJO. Set when the row is created,
 *                  because here submission IS the handover: nothing exists
 *                  before Confirm & Submit. A separate always-true boolean
 *                  would only be a flag waiting to disagree with reality.
 *   completed_at — a MOJO employee has dealt with it. Nobody at the dealer
 *                  can set this; see `isMojoStaff`.
 */

/**
 * Who may mark a signup complete: see `isStaff` in `users.ts`.
 *
 * It used to be a test on the address ending in our domain. That was
 * correct only while every account came through Microsoft SSO. The moment
 * an administrator can invite an outside address, somebody invited as
 * anything@mojocarwash.com would have inherited the mark, so the test
 * moved to the DOOR they came through.
 */

/** The timezone the created date and time are shown in. */
export const DISPLAY_TZ = "America/Chicago";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_member_signups (
  guid             uuid        PRIMARY KEY,
  /** Minted when the blank form opens, not when it is saved. */
  created_at       timestamptz NOT NULL,
  display_timezone text        NOT NULL DEFAULT '${DISPLAY_TZ}',

  dlw_contract_id  text        NOT NULL,
  /** The dealer's own references, not always known at signup. */
  deal_number      text        NOT NULL DEFAULT '',
  customer_id      text        NOT NULL DEFAULT '',

  first_name       text        NOT NULL,
  last_name        text        NOT NULL,
  plate_dlw        text,
  plate_state      text,
  vehicle_make     text,
  vehicle_model    text,
  vehicle_year     text,
  vehicle_color    text,
  rfid             text        NOT NULL REFERENCES dm_rfid (number),

  /** Reached MOJO. Always set — the row only exists once it has. */
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  submitted_by     text        NOT NULL DEFAULT '',
  /** A MOJO employee has dealt with it. Null until one says so. */
  completed_at     timestamptz,
  completed_by     text
);
/**
 * The two middle steps of the tracker.
 *
 * notified_at is when the notification actually left — not when one was
 * meant to, so a step that never lights is a notification nobody got
 * rather than a setting somebody has to go and check.
 *
 * opened_at is somebody at MOJO OPENING THE RECORD, not opening the
 * email. Email-open tracking is a pixel, and a pixel lies in both
 * directions: blocked images read as never opened, and the scanners
 * that fetch everything read as opened before anybody saw it — the
 * exact failure that burned an invite here last week. Opening the
 * record is a real action by a real person.
 */
ALTER TABLE dm_member_signups ADD COLUMN IF NOT EXISTS notified_at timestamptz;
ALTER TABLE dm_member_signups ADD COLUMN IF NOT EXISTS opened_at timestamptz;
ALTER TABLE dm_member_signups ADD COLUMN IF NOT EXISTS opened_by text;
/*
 * Light the second step for signups that predate it.
 *
 * The notifications went out; there was simply no column to record it
 * in, so those rows would have shown a permanently grey "Email sent"
 * that was not true. The audit trail knows — it has carried a
 * notify.sent line, keyed on the signup, since before the columns
 * existed. Runs once: the WHERE clause stops matching as soon as it has.
 */
UPDATE dm_member_signups s
   SET notified_at = a.at
  FROM (SELECT subject, min(at) AS at FROM dm_audit
         WHERE action = 'notify.sent' GROUP BY subject) a
 WHERE s.notified_at IS NULL
   AND a.subject = s.guid::text;
-- A tag belongs to one member. The last line of defence, below every check
-- in application code, and the reason a double submission cannot double-assign.
ALTER TABLE dm_member_signups ADD COLUMN IF NOT EXISTS plate_state text;
CREATE UNIQUE INDEX IF NOT EXISTS dm_member_signups_rfid_once
  ON dm_member_signups (rfid);
CREATE INDEX IF NOT EXISTS dm_member_signups_recent
  ON dm_member_signups (submitted_at DESC);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

export type SignupRow = {
  guid: string;
  createdAt: string;
  displayTimezone: string;
  dealer: { dlwContractId: string; dealNumber: string; customerId: string };
  customer: {
    firstName: string; lastName: string;
    plateDlw: string | null;
    plateState: string | null;
    vehicleMake: string | null; vehicleModel: string | null;
    vehicleYear: string | null; vehicleColor: string | null;
    rfid: string;
  };
  submittedAt: string;
  submittedBy: string;
  notifiedAt: string | null;
  openedAt: string | null;
  openedBy: string | null;
  completedAt: string | null;
  completedBy: string | null;
};

/* ------------------------------------------------------------------ *
 * The generated values
 * ------------------------------------------------------------------ */

/**
 * The date, time and GUID are read-only in the form — and that has to be
 * true on the server too, or "read-only" is a styling choice. Rather than
 * keep a table of half-started drafts, the server signs what it minted and
 * checks the signature when the entry comes back. A client cannot forge a
 * creation time, cannot replay somebody else's GUID into a new entry, and
 * cannot invent one of its own.
 */
export type Handle = { guid: string; createdAt: string; token: string };

const sign = (guid: string, createdAt: string): string =>
  createHmac("sha256", env.sessionSecret || "mojo-expense")
    .update(`signup:${guid}:${createdAt}`)
    .digest("base64url");

export function newHandle(): Handle {
  const guid = randomUUID();
  const createdAt = new Date().toISOString();
  return { guid, createdAt, token: sign(guid, createdAt) };
}

function handleIsOurs(h: { guid?: unknown; createdAt?: unknown; token?: unknown }): boolean {
  const guid = String(h.guid ?? "");
  const createdAt = String(h.createdAt ?? "");
  const token = String(h.token ?? "");
  const want = Buffer.from(sign(guid, createdAt));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export type SignupInput = {
  guid: string; createdAt: string; token: string;
  dlwContractId: string; dealNumber: string; customerId: string;
  firstName: string; lastName: string;
  plateDlw: string; plateState: string;
  vehicleMake: string; vehicleModel: string;
  vehicleYear: string; vehicleColor: string;
  rfid: string;
};

/**
 * Trim the edges and nothing else.
 *
 * Contract IDs, deal numbers, plates and tags are identifiers, not numbers:
 * `0041` is not `41`, and anything that "tidies" them loses a leading zero
 * somebody will have to chase down later.
 */
const t = (v: unknown): string => String(v ?? "").trim();

/**
 * The plate's state, as the two letters on the registration.
 *
 * A fixed list rather than free text: a plate is only unique within its
 * state, so "OH" and "Ohio" and "oh" being three different answers makes
 * the pair useless for matching a vehicle later.
 */
export const STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
  "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

export const isState = (v: string): boolean => (STATES as readonly string[]).includes(v);

const FIELD_LABEL: Record<string, string> = {
  dlwContractId: "DLW Contract ID",
  dealNumber: "Deal #",
  customerId: "Customer ID #",
  plateState: "State",
  firstName: "First Name",
  lastName: "Last Name",
  vehicleYear: "Vehicle Year",
  rfid: "RFID",
};

/** Field-by-field, so the form can point at the one that is wrong. */
export function validateSignup(raw: Partial<SignupInput>): {
  clean: SignupInput;
  errors: Record<string, string>;
} {
  const clean: SignupInput = {
    guid: t(raw.guid), createdAt: t(raw.createdAt), token: String(raw.token ?? ""),
    dlwContractId: t(raw.dlwContractId),
    dealNumber: t(raw.dealNumber),
    customerId: t(raw.customerId),
    firstName: t(raw.firstName),
    lastName: t(raw.lastName),
    plateDlw: t(raw.plateDlw),
    plateState: t(raw.plateState).toUpperCase(),
    vehicleMake: t(raw.vehicleMake),
    vehicleModel: t(raw.vehicleModel),
    vehicleYear: t(raw.vehicleYear),
    vehicleColor: t(raw.vehicleColor),
    rfid: t(raw.rfid),
  };

  const errors: Record<string, string> = {};
  // Deal # and Customer ID # are the dealer's own references and are not
  // always known at the moment somebody is signed up.
  for (const k of ["dlwContractId", "firstName", "lastName", "rfid"] as const) {
    if (clean[k] === "") errors[k] = `${FIELD_LABEL[k]} is required.`;
  }
  if (clean.plateState !== "" && !isState(clean.plateState)) {
    errors.plateState = "Pick a state from the list.";
  }
  // Optional, but four digits if it is there at all.
  if (clean.vehicleYear !== "" && !/^\d{4}$/.test(clean.vehicleYear)) {
    errors.vehicleYear = "Vehicle Year must be four digits.";
  }
  if (clean.rfid !== "" && !RFID_RE.test(clean.rfid)) {
    errors.rfid = "That is not an RFID number.";
  }
  return { clean, errors };
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

type Db = {
  guid: string; created_at: Date; display_timezone: string;
  dlw_contract_id: string; deal_number: string; customer_id: string;
  first_name: string; last_name: string;
  plate_dlw: string | null; plate_state: string | null;
  vehicle_make: string | null; vehicle_model: string | null;
  vehicle_year: string | null; vehicle_color: string | null; rfid: string;
  submitted_at: Date; submitted_by: string;
  notified_at: Date | null; opened_at: Date | null; opened_by: string | null;
  completed_at: Date | null; completed_by: string | null;
};

const shape = (r: Db): SignupRow => ({
  guid: r.guid,
  createdAt: r.created_at.toISOString(),
  displayTimezone: r.display_timezone,
  dealer: {
    dlwContractId: r.dlw_contract_id,
    dealNumber: r.deal_number,
    customerId: r.customer_id,
  },
  customer: {
    firstName: r.first_name,
    lastName: r.last_name,
    plateDlw: r.plate_dlw,
    plateState: r.plate_state,
    vehicleMake: r.vehicle_make,
    vehicleModel: r.vehicle_model,
    vehicleYear: r.vehicle_year,
    vehicleColor: r.vehicle_color,
    rfid: r.rfid,
  },
  submittedAt: r.submitted_at.toISOString(),
  submittedBy: r.submitted_by,
  notifiedAt: r.notified_at?.toISOString() ?? null,
  openedAt: r.opened_at?.toISOString() ?? null,
  openedBy: r.opened_by,
  completedAt: r.completed_at?.toISOString() ?? null,
  completedBy: r.completed_by,
});

const COLS = `guid, created_at, display_timezone, dlw_contract_id, deal_number,
  customer_id, first_name, last_name, plate_dlw, vehicle_make, vehicle_model,
  vehicle_year, vehicle_color, rfid, submitted_at, submitted_by,
  notified_at, opened_at, opened_by, completed_at, completed_by`;

export async function listSignups(opts: {
  status?: "all" | "new" | "review" | "complete";
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{
  rows: SignupRow[];
  total: number;
  counts: { new: number; review: number; complete: number; total: number };
}> {
  await ensure();
  const where: string[] = [];
  const args: unknown[] = [];
  // Three states, and they do not overlap: nobody has looked yet,
  // somebody has looked but not finished, finished.
  if (opts.status === "new") where.push("completed_at IS NULL AND opened_at IS NULL");
  if (opts.status === "review") where.push("completed_at IS NULL AND opened_at IS NOT NULL");
  if (opts.status === "complete") where.push("completed_at IS NOT NULL");
  const search = (opts.search ?? "").trim();
  if (search !== "") {
    args.push(`%${search.toLowerCase()}%`);
    where.push(`(lower(first_name || ' ' || last_name) LIKE $${args.length}
       OR lower(dlw_contract_id) LIKE $${args.length}
       OR lower(deal_number) LIKE $${args.length}
       OR lower(customer_id) LIKE $${args.length}
       OR lower(rfid) LIKE $${args.length})`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const rows = await db().query<Db>(
    `SELECT ${COLS} FROM dm_member_signups ${clause}
      ORDER BY submitted_at DESC LIMIT ${limit} OFFSET ${offset}`, args);
  const total = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM dm_member_signups ${clause}`, args);
  const counts = await db().query<{ n: string; done: string; looked: string }>(
    `SELECT count(*) AS n,
            count(completed_at) AS done,
            count(*) FILTER (WHERE completed_at IS NULL AND opened_at IS NOT NULL) AS looked
       FROM dm_member_signups`);

  const all = Number(counts.rows[0]?.n ?? 0);
  const done = Number(counts.rows[0]?.done ?? 0);
  const review = Number(counts.rows[0]?.looked ?? 0);
  return {
    rows: rows.rows.map(shape),
    total: Number(total.rows[0]?.n ?? 0),
    counts: { new: all - done - review, review, complete: done, total: all },
  };
}

export async function getSignup(guid: string): Promise<SignupRow | null> {
  await ensure();
  const { rows } = await db().query<Db>(
    `SELECT ${COLS} FROM dm_member_signups WHERE guid = $1`, [guid]);
  return rows[0] ? shape(rows[0]) : null;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export type CreateResult =
  | { ok: true; row: SignupRow; alreadyExisted: boolean }
  | { ok: false; kind: "validation"; errors: Record<string, string> }
  | { ok: false; kind: "rfid-taken"; reason: string }
  | { ok: false; kind: "bad-handle"; reason: string };

/**
 * One member, one tag, one transaction.
 *
 * The tag is claimed with a CONDITIONAL update — `WHERE status = 'active'`
 * — so when two submissions race, the database decides and the loser gets
 * no rows back rather than a stale read. The insert uses `ON CONFLICT
 * (guid) DO NOTHING`, which makes a retry or a double-click idempotent:
 * the second attempt finds the row already there and reports success
 * without touching another tag.
 */
export async function createSignup(raw: Partial<SignupInput>, by: string): Promise<CreateResult> {
  await ensure();
  const { clean, errors } = validateSignup(raw);
  if (Object.keys(errors).length > 0) return { ok: false, kind: "validation", errors };
  if (!handleIsOurs(clean)) {
    return {
      ok: false, kind: "bad-handle",
      reason: "This entry's generated details did not come from the server. Start a new entry.",
    };
  }

  // A retry of a submission that already landed. Answering from here keeps
  // the claim below from running a second time against a different tag.
  const existing = await getSignup(clean.guid);
  if (existing) return { ok: true, row: existing, alreadyExisted: true };

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query<{ number: string }>(
      `UPDATE dm_rfid
          SET status = 'used', used_at = now(), used_by = $2, used_for = $3
        WHERE number = $1 AND status = 'active'
      RETURNING number`,
      [clean.rfid, by, `Member signup ${clean.guid}`]);
    if (claim.rowCount === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false, kind: "rfid-taken",
        reason: `RFID ${clean.rfid} is no longer available — it has been used or held back `
          + "since this form was opened. Choose another one.",
      };
    }

    const ins = await client.query<Db>(
      `INSERT INTO dm_member_signups (
         guid, created_at, display_timezone,
         dlw_contract_id, deal_number, customer_id,
         first_name, last_name, plate_dlw, plate_state, vehicle_make, vehicle_model,
         vehicle_year, vehicle_color, rfid, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''),
               NULLIF($13, ''), NULLIF($14, ''), $15, $16)
       ON CONFLICT (guid) DO NOTHING
       RETURNING ${COLS}`,
      [clean.guid, clean.createdAt, DISPLAY_TZ,
        clean.dlwContractId, clean.dealNumber, clean.customerId,
        clean.firstName, clean.lastName, clean.plateDlw, clean.plateState,
        clean.vehicleMake, clean.vehicleModel, clean.vehicleYear, clean.vehicleColor,
        clean.rfid, by]);

    if (ins.rowCount === 0) {
      // Two submissions of the SAME entry, overlapping. The other one won
      // and holds the tag; this one's claim must go back.
      await client.query("ROLLBACK");
      const row = await getSignup(clean.guid);
      if (row) return { ok: true, row, alreadyExisted: true };
      return { ok: false, kind: "rfid-taken", reason: "That entry was already submitted." };
    }

    await client.query("COMMIT");
    return { ok: true, row: shape(ins.rows[0]!), alreadyExisted: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // The unique index on rfid. Reachable only if the conditional claim
    // above was somehow bypassed, which is exactly when it matters.
    if (String(err).includes("dm_member_signups_rfid_once")) {
      return {
        ok: false, kind: "rfid-taken",
        reason: `RFID ${clean.rfid} is already assigned to another member. Choose another one.`,
      };
    }
    throw err;
  } finally {
    client.release();
  }
}

/** The notification went out. Recorded so a step that never lights means something. */
export async function markNotified(guid: string): Promise<void> {
  await ensure();
  await db().query(
    "UPDATE dm_member_signups SET notified_at = now() WHERE guid = $1 AND notified_at IS NULL",
    [guid]).catch(() => {});
}

/**
 * Somebody at MOJO opened the record.
 *
 * First open only — the step is "has anybody looked at this", and
 * rewriting it on every view would turn a milestone into a last-seen
 * timestamp that tells nobody whether it has been dealt with.
 */
export async function markOpened(guid: string, by: string): Promise<SignupRow | null> {
  await ensure();
  const { rows } = await db().query<Db>(
    `UPDATE dm_member_signups SET opened_at = now(), opened_by = $2
      WHERE guid = $1 AND opened_at IS NULL
    RETURNING ${COLS}`, [guid, by]);
  return rows[0] ? shape(rows[0]) : null;
}

/**
 * The MOJO-side mark.
 *
 * Reversible, because the alternative to an undo is a wrong record nobody
 * can correct; who set it and when are kept either way.
 */
export async function setComplete(
  guid: string, complete: boolean, by: string,
): Promise<SignupRow | null> {
  await ensure();
  const { rows } = await db().query<Db>(
    `UPDATE dm_member_signups
        SET completed_at = ${complete ? "now()" : "NULL"},
            completed_by = ${complete ? "$2" : "NULL"}
      WHERE guid = $1
    RETURNING ${COLS}`,
    complete ? [guid, by] : [guid]);
  return rows[0] ? shape(rows[0]) : null;
}
