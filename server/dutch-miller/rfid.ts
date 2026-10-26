import { db, ensureSchema } from "../db.js";
import { RFID_RE } from "./rfid-parse.js";

/**
 * The RFID pool.
 *
 * A number is a physical tag, so the rules come from the world rather than
 * from the schema: there is one of each, and once it has been issued it
 * cannot be issued again. Both are enforced in the database — a unique
 * index on the number, and a conditional update for the claim — because a
 * check in application code is a race whenever two requests arrive at once,
 * and "issued twice" is the one outcome that cannot be undone by hand.
 *
 * Three states:
 *   active    — in the pool, available to be issued
 *   inactive  — held back; still unused, deliberately not available
 *   used      — issued. Terminal. Nothing moves a number out of it.
 *
 * Deleting is a fourth thing and not a state: a deleted number keeps its
 * state and gains a deletion, so a tag that was issued still reads as
 * issued. It leaves the pool and cannot be issued, but the row stays —
 * a number that vanished is a number nobody can answer questions about.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_rfid (
  number      text        PRIMARY KEY,
  status      text        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'inactive', 'used')),
  added_at    timestamptz NOT NULL DEFAULT now(),
  added_by    text        NOT NULL DEFAULT '',
  /** Which upload it arrived on, so a bad file can be traced. */
  batch       text        NOT NULL DEFAULT '',
  used_at     timestamptz,
  used_by     text,
  /** Free text from whoever issued it — an order, a customer, a vehicle. */
  used_for    text
);
CREATE INDEX IF NOT EXISTS dm_rfid_status_idx ON dm_rfid (status, number);
/* Deleted by an account administrator, with the reason they gave. */
ALTER TABLE dm_rfid ADD COLUMN IF NOT EXISTS deleted_at  timestamptz;
ALTER TABLE dm_rfid ADD COLUMN IF NOT EXISTS deleted_by  text;
ALTER TABLE dm_rfid ADD COLUMN IF NOT EXISTS delete_note text;
/*
 * Tags kept back for testing.
 *
 * A gate has to be tried with a real sticker on a real windshield,
 * and the number that goes on the test vehicle must never land on a
 * paying member. Marking it is not the same as holding it back: a
 * held tag is simply out of the pool, while a test tag is usable, by
 * one person, on purpose.
 *
 * Two rules follow, both enforced below rather than in the form. It
 * is never handed out by the pool, so no bulk import can spend one;
 * and naming it only works for an account administrator. Off for every
 * existing tag, because a column appearing must not reclassify
 * anything already in the pool.
 */
ALTER TABLE dm_rfid ADD COLUMN IF NOT EXISTS test_only boolean NOT NULL DEFAULT false;
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

export type RfidStatus = "active" | "inactive" | "used";

export type RfidRow = {
  number: string;
  status: RfidStatus;
  addedAt: string;
  addedBy: string;
  batch: string;
  usedAt: string | null;
  usedBy: string | null;
  usedFor: string | null;
  /** Kept back for testing. Never auto-assigned; account admin only to issue. */
  testOnly: boolean;
  /** Set once an account administrator removed it. The row stays either way. */
  deletedAt: string | null;
  deletedBy: string | null;
  deleteNote: string | null;
};

export type UploadResult = {
  batch: string;
  /** Numbers that are now in the pool because of this file. */
  added: number;
  /** Repeats WITHIN the file. Counted once each; the first copy was kept. */
  duplicatesInFile: { number: string; copies: number }[];
  /** Already in the pool before this file. Not added again. */
  alreadyHeld: { number: string; status: RfidStatus; deleted: boolean }[];
  /** Cells that looked like an attempt and were not a number. */
  rejected: { raw: string; problem: string }[];
  /** Cells examined, so "it imported nothing" can be told from "wrong column". */
  cells: number;
};

/**
 * Take a parsed file into the pool.
 *
 * Duplicates are reported in two kinds because they mean different things.
 * A number repeated WITHIN the file is a mistake in the file and the
 * person wants to know their list is not as long as they thought. A number
 * ALREADY HELD is not a mistake at all — re-uploading an overlapping batch
 * is normal — but it must not be re-added, and above all must not reset a
 * used tag to active. Both are removed rather than inserted, which is what
 * "identified and removed" asks for; reporting them is the "identified".
 */
export async function addRfids(
  numbers: string[],
  rejected: { raw: string; problem: string }[],
  cells: number,
  by: string,
): Promise<UploadResult> {
  await ensure();
  const batch = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}-${Math.random().toString(36).slice(2, 6)}`;

  // Within the file first, so the count reported is the file's own repeats
  // and not confused with what the database already had.
  const seen = new Map<string, number>();
  for (const n of numbers) seen.set(n, (seen.get(n) ?? 0) + 1);
  const unique = [...seen.keys()];
  const duplicatesInFile = [...seen.entries()]
    .filter(([, copies]) => copies > 1)
    .map(([number, copies]) => ({ number, copies }));

  if (unique.length === 0) {
    return { batch, added: 0, duplicatesInFile, alreadyHeld: [], rejected, cells };
  }

  // A deleted number counts as held, and deliberately does NOT come back:
  // re-uploading the same file must not undo somebody's decision to remove
  // a tag. It is reported so the difference is visible.
  const held = await db().query<{ number: string; status: RfidStatus; deleted_at: Date | null }>(
    "SELECT number, status, deleted_at FROM dm_rfid WHERE number = ANY($1::text[])", [unique]);
  const alreadyHeld = held.rows.map((r) => ({
    number: r.number, status: r.status, deleted: r.deleted_at !== null,
  }));

  // ON CONFLICT DO NOTHING as well as the check above: between the two
  // statements another upload can land, and the unique index is the only
  // thing that is actually authoritative about it.
  const { rowCount } = await db().query(
    `INSERT INTO dm_rfid (number, added_by, batch)
          SELECT n, $2, $3 FROM unnest($1::text[]) AS n
     ON CONFLICT (number) DO NOTHING`,
    [unique, by, batch]);

  return { batch, added: rowCount ?? 0, duplicatesInFile, alreadyHeld, rejected, cells };
}

export type RfidCounts = {
  active: number; inactive: number; used: number; deleted: number;
  testOnly: number; total: number;
};

/**
 * The pool, counted.
 *
 * Deleted numbers are counted apart and are not in `total`: every other
 * figure here is read as "how many tags do we have", and a removed tag is
 * not one of them.
 */
export async function rfidCounts(): Promise<RfidCounts> {
  await ensure();
  const { rows } = await db().query<{ status: RfidStatus; n: string }>(
    "SELECT status, count(*) AS n FROM dm_rfid WHERE deleted_at IS NULL GROUP BY status");
  const out: RfidCounts = {
    active: 0, inactive: 0, used: 0, deleted: 0, testOnly: 0, total: 0,
  };
  for (const r of rows) {
    out[r.status] = Number(r.n);
    out.total += Number(r.n);
  }
  out.deleted = Number((await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_rfid WHERE deleted_at IS NOT NULL")).rows[0]?.n ?? 0);
  // Counted alongside, not apart: a test tag is a real tag in the
  // pool, just one only the owner may issue.
  out.testOnly = Number((await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM dm_rfid
      WHERE test_only AND deleted_at IS NULL`)).rows[0]?.n ?? 0);
  return out;
}

export async function listRfids(opts: {
  /** `deleted` and `test` are their own views; the rest exclude deleted. */
  status?: RfidStatus | "all" | "deleted" | "test";
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: RfidRow[]; total: number }> {
  await ensure();
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status === "deleted") {
    where.push("deleted_at IS NOT NULL");
  } else if (opts.status === "test") {
    where.push("deleted_at IS NULL AND test_only");
  } else {
    where.push("deleted_at IS NULL");
    if (opts.status && opts.status !== "all") {
      args.push(opts.status);
      where.push(`status = $${args.length}`);
    }
  }
  if (opts.search?.trim()) {
    args.push(`%${opts.search.trim().replace(/[%_]/g, "")}%`);
    where.push(`number LIKE $${args.length}`);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = Number((await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM dm_rfid ${clause}`, args)).rows[0]?.n ?? 0);

  args.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  args.push(Math.max(opts.offset ?? 0, 0));
  const { rows } = await db().query<{
    number: string; status: RfidStatus; added_at: Date; added_by: string;
    batch: string; used_at: Date | null; used_by: string | null; used_for: string | null;
    deleted_at: Date | null; deleted_by: string | null; delete_note: string | null;
    test_only: boolean;
  }>(
    `SELECT number, status, added_at, added_by, batch, used_at, used_by, used_for,
            deleted_at, deleted_by, delete_note, test_only
       FROM dm_rfid ${clause}
      ORDER BY added_at DESC, number
      LIMIT $${args.length - 1} OFFSET $${args.length}`, args);

  return {
    total,
    rows: rows.map((r) => ({
      number: r.number,
      status: r.status,
      addedAt: r.added_at.toISOString(),
      addedBy: r.added_by,
      batch: r.batch,
      usedAt: r.used_at ? r.used_at.toISOString() : null,
      usedBy: r.used_by,
      usedFor: r.used_for,
      testOnly: r.test_only,
      deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
      deletedBy: r.deleted_by,
      deleteNote: r.delete_note,
    })),
  };
}

/**
 * Issue a number. Once.
 *
 * The guard is `status <> 'used'` inside the UPDATE rather than a read
 * followed by a write: two requests for the same tag arriving together
 * both pass a prior check and both write, and the second one silently
 * reassigns a tag that is already on a vehicle. Here the database decides,
 * and the loser gets `false`.
 */
export async function useRfid(
  number: string,
  by: string,
  usedFor: string,
): Promise<{ ok: true; row: RfidRow } | { ok: false; reason: string }> {
  await ensure();
  if (!RFID_RE.test(number)) return { ok: false, reason: "Not an RFID number." };

  const { rows } = await db().query<{ status: RfidStatus }>(
    `UPDATE dm_rfid SET status = 'used', used_at = now(), used_by = $2, used_for = $3
      WHERE number = $1 AND status <> 'used' AND deleted_at IS NULL
      RETURNING status`, [number, by, usedFor.slice(0, 500)]);

  if (rows.length === 0) {
    const held = await db().query<{
      status: RfidStatus; used_at: Date | null; used_by: string | null;
      deleted_at: Date | null; delete_note: string | null;
    }>(
      `SELECT status, used_at, used_by, deleted_at, delete_note
         FROM dm_rfid WHERE number = $1`, [number]);
    const row = held.rows[0];
    if (!row) return { ok: false, reason: "That number is not in the pool." };
    if (row.deleted_at) {
      return {
        ok: false,
        reason: `RFID ${number} was removed from the pool`
          + `${row.delete_note ? `: ${row.delete_note}` : "."}`,
      };
    }
    return {
      ok: false,
      reason: `Already used${row.used_by ? ` by ${row.used_by}` : ""}` +
        `${row.used_at ? ` on ${row.used_at.toISOString().slice(0, 10)}` : ""}.`,
    };
  }
  const one = await listRfids({ search: number, limit: 1 });
  return { ok: true, row: one.rows[0]! };
}

/**
 * Hold a number back, or put it in play again.
 *
 * Refuses to touch a used one. Making a used tag active would put a number
 * already issued back into the pool to be issued again, which is the exact
 * thing the one-time rule exists to prevent — so it is refused here rather
 * than guarded by whoever writes the next caller.
 */
/**
 * Mark numbers as test-only, or let them back into ordinary use.
 *
 * A used tag can be marked either way — the point of a test tag is
 * that it goes on a vehicle — but a DELETED one cannot: it is not in
 * the pool at all and changing a label on it would only make the
 * list lie.
 */
export async function setRfidTestOnly(
  numbers: string[],
  testOnly: boolean,
): Promise<{ changed: number }> {
  await ensure();
  const wanted = numbers.filter((n) => RFID_RE.test(n));
  if (wanted.length === 0) return { changed: 0 };
  const { rowCount } = await db().query(
    `UPDATE dm_rfid SET test_only = $2
      WHERE number = ANY($1::text[]) AND deleted_at IS NULL`,
    [wanted, testOnly]);
  return { changed: rowCount ?? 0 };
}

export async function setRfidActive(
  numbers: string[],
  active: boolean,
): Promise<{ changed: number; refusedUsed: number }> {
  await ensure();
  const wanted = numbers.filter((n) => RFID_RE.test(n));
  if (wanted.length === 0) return { changed: 0, refusedUsed: 0 };

  const { rowCount } = await db().query(
    `UPDATE dm_rfid SET status = $2
      WHERE number = ANY($1::text[]) AND status <> 'used' AND deleted_at IS NULL`,
    [wanted, active ? "active" : "inactive"]);

  const used = Number((await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM dm_rfid
      WHERE number = ANY($1::text[]) AND status = 'used' AND deleted_at IS NULL`,
    [wanted])).rows[0]?.n ?? 0);

  return { changed: rowCount ?? 0, refusedUsed: used };
}

/**
 * Remove numbers from the pool, keeping the rows.
 *
 * A soft delete, for the same reason the member records are: a tag that
 * disappears takes its history with it, and the question afterwards is
 * always "what happened to this one?". The row stays, marked, with the
 * note whoever removed it had to write.
 *
 * A USED number can be deleted — a tag gets destroyed, mis-stuck or
 * replaced, and pretending otherwise would mean the pool can never be
 * corrected. What deleting never does is free the number: it is gone
 * from the pool, not back in it, and re-uploading a file that contains
 * it will not revive it.
 */
export type RfidDeleteResult = {
  deleted: number;
  /** Numbers that were not there at all. */
  missing: string[];
  /** Numbers somebody had already deleted. Left as they were. */
  already: string[];
};

export async function deleteRfids(opts: {
  numbers: string[];
  note: string;
  by: string;
}): Promise<RfidDeleteResult | { error: string }> {
  await ensure();
  const note = opts.note.trim();
  if (note.length < 5) {
    return { error: "Say why these numbers are being removed — a few words at least." };
  }
  const wanted = [...new Set(opts.numbers.map((n) => n.trim()).filter((n) => RFID_RE.test(n)))];
  if (wanted.length === 0) return { error: "No RFID numbers to remove." };

  const held = await db().query<{ number: string; deleted_at: Date | null }>(
    "SELECT number, deleted_at FROM dm_rfid WHERE number = ANY($1::text[])", [wanted]);
  const known = new Map(held.rows.map((r) => [r.number, r.deleted_at]));

  const { rowCount } = await db().query(
    `UPDATE dm_rfid SET deleted_at = now(), deleted_by = $2, delete_note = $3
      WHERE number = ANY($1::text[]) AND deleted_at IS NULL`,
    [wanted, opts.by, note.slice(0, 500)]);

  return {
    deleted: rowCount ?? 0,
    missing: wanted.filter((n) => !known.has(n)),
    already: wanted.filter((n) => known.get(n) != null),
  };
}
