import { db, ensureSchema } from "../db.js";

/**
 * What a person CONCLUDED about some events.
 *
 * Kept in its own table, deliberately, and this is the whole design:
 * `dm_audit` is append-only evidence, and nothing an investigator does
 * may touch it. Status, classification, notes and ownership all live
 * here, pointing AT events by id. So a wrong conclusion can be
 * corrected without altering what happened, and "confirmed incident"
 * is something a named person decided on a date rather than a label
 * the application applied to itself.
 *
 * Every change to an investigation is itself recorded, in
 * `dm_investigation_notes`, which is also append-only. The current
 * status is a column for querying; how it got there is the note trail.
 */

export const INVESTIGATION_STATUSES = [
  "new", "investigating", "resolved", "false-positive",
] as const;
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];

export const STATUS_LABEL: Record<InvestigationStatus, string> = {
  new: "New",
  investigating: "Investigating",
  resolved: "Resolved",
  "false-positive": "False positive",
};

/**
 * What it turned out to be.
 *
 * `confirmed-incident` is the only value in this application that
 * means a real attack, and nothing can set it except a person choosing
 * it here. No rule, no threshold and no event count may write it.
 */
export const CLASSIFICATIONS = [
  "unclassified", "benign", "suspicious", "confirmed-incident",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  unclassified: "Not yet classified",
  benign: "Benign",
  suspicious: "Suspicious — unproven",
  "confirmed-incident": "Confirmed incident",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_investigations (
  id          bigserial   PRIMARY KEY,
  title       text        NOT NULL,
  status      text        NOT NULL DEFAULT 'new',
  classification text     NOT NULL DEFAULT 'unclassified',
  /* Who owns it. Empty means nobody has picked it up. */
  assignee    text        NOT NULL DEFAULT '',
  opened_at   timestamptz NOT NULL DEFAULT now(),
  opened_by   text        NOT NULL DEFAULT '',
  closed_at   timestamptz,
  closed_by   text        NOT NULL DEFAULT '',
  /* Why it was closed the way it was. Required to resolve one. */
  resolution  text        NOT NULL DEFAULT '',
  /* Event ids from dm_audit. Pointers only; the events are never changed. */
  event_ids   bigint[]    NOT NULL DEFAULT '{}',
  /* What the detector saw, when one opened it rather than a person. */
  evidence    text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS dm_investigations_open
  ON dm_investigations (status, opened_at DESC);
CREATE TABLE IF NOT EXISTS dm_investigation_notes (
  id        bigserial   PRIMARY KEY,
  case_id   bigint      NOT NULL REFERENCES dm_investigations (id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  author    text        NOT NULL DEFAULT '',
  /* What changed, as words. Empty for a plain note. */
  change    text        NOT NULL DEFAULT '',
  body      text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS dm_investigation_notes_case
  ON dm_investigation_notes (case_id, at);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

export type InvestigationNote = {
  id: string; at: string; author: string; change: string; body: string;
};

export type Investigation = {
  id: string;
  title: string;
  status: InvestigationStatus;
  classification: Classification;
  assignee: string;
  openedAt: string;
  openedBy: string;
  closedAt: string | null;
  closedBy: string;
  resolution: string;
  eventIds: string[];
  evidence: string;
  notes?: InvestigationNote[];
};

type Db = {
  id: string; title: string; status: string; classification: string; assignee: string;
  opened_at: Date; opened_by: string; closed_at: Date | null; closed_by: string;
  resolution: string; event_ids: (string | number)[] | null; evidence: string;
};

const isStatus = (v: string): v is InvestigationStatus =>
  (INVESTIGATION_STATUSES as readonly string[]).includes(v);
const isClass = (v: string): v is Classification =>
  (CLASSIFICATIONS as readonly string[]).includes(v);

const shape = (r: Db): Investigation => ({
  id: String(r.id),
  title: r.title,
  status: isStatus(r.status) ? r.status : "new",
  classification: isClass(r.classification) ? r.classification : "unclassified",
  assignee: r.assignee,
  openedAt: r.opened_at.toISOString(),
  openedBy: r.opened_by,
  closedAt: r.closed_at ? r.closed_at.toISOString() : null,
  closedBy: r.closed_by,
  resolution: r.resolution,
  eventIds: (r.event_ids ?? []).map(String),
  evidence: r.evidence,
});

const COLS = `id, title, status, classification, assignee, opened_at, opened_by,
              closed_at, closed_by, resolution, event_ids, evidence`;

export async function listInvestigations(opts: {
  status?: InvestigationStatus | "all";
  limit?: number;
} = {}): Promise<Investigation[]> {
  await ensure();
  const open = opts.status && opts.status !== "all";
  const { rows } = await db().query<Db>(
    `SELECT ${COLS} FROM dm_investigations
      ${open ? "WHERE status = $1" : ""}
      ORDER BY opened_at DESC
      LIMIT ${Math.min(Math.max(opts.limit ?? 100, 1), 500)}`,
    open ? [opts.status] : []);
  return rows.map(shape);
}

export async function getInvestigation(id: string): Promise<Investigation | null> {
  await ensure();
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const { rows } = await db().query<Db>(
    `SELECT ${COLS} FROM dm_investigations WHERE id = $1`, [n]);
  if (!rows[0]) return null;
  const notes = await db().query<{
    id: string; at: Date; author: string; change: string; body: string;
  }>(
    `SELECT id, at, author, change, body FROM dm_investigation_notes
      WHERE case_id = $1 ORDER BY at, id`, [n]);
  return {
    ...shape(rows[0]),
    notes: notes.rows.map((x) => ({
      id: String(x.id), at: x.at.toISOString(), author: x.author,
      change: x.change, body: x.body,
    })),
  };
}

export async function openInvestigation(opts: {
  title: string;
  by: string;
  eventIds?: string[];
  evidence?: string;
  note?: string;
}): Promise<Investigation> {
  await ensure();
  const title = opts.title.trim().slice(0, 200);
  if (title === "") throw new Error("An investigation needs a title.");
  const ids = (opts.eventIds ?? [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  const { rows } = await db().query<Db>(
    `INSERT INTO dm_investigations (title, opened_by, event_ids, evidence)
          VALUES ($1, $2, $3::bigint[], $4)
       RETURNING ${COLS}`,
    [title, opts.by.toLowerCase(), ids, (opts.evidence ?? "").slice(0, 1000)]);
  const made = shape(rows[0]!);
  await note(made.id, opts.by, "opened", opts.note ?? "");
  return made;
}

/** One line in the case's own history. Append-only, like the events. */
async function note(
  caseId: string, author: string, change: string, body: string,
): Promise<void> {
  await db().query(
    `INSERT INTO dm_investigation_notes (case_id, author, change, body)
          VALUES ($1, $2, $3, $4)`,
    [Number(caseId), author.toLowerCase(), change.slice(0, 200), body.slice(0, 2000)]);
}

export type UpdateResult =
  | { ok: true; row: Investigation }
  | { ok: false; reason: string };

/**
 * Change a case — and say so, in its own trail.
 *
 * Resolving requires a reason. A case closed with no explanation is
 * indistinguishable from one nobody looked at, which defeats the point
 * of having statuses at all.
 */
export async function updateInvestigation(opts: {
  id: string;
  by: string;
  status?: InvestigationStatus;
  classification?: Classification;
  assignee?: string;
  resolution?: string;
  addEventIds?: string[];
  note?: string;
}): Promise<UpdateResult> {
  await ensure();
  const current = await getInvestigation(opts.id);
  if (!current) return { ok: false, reason: "No such investigation." };

  const closing = opts.status === "resolved" || opts.status === "false-positive";
  const resolution = (opts.resolution ?? current.resolution).trim();
  if (closing && resolution.length < 5) {
    return { ok: false, reason: "Say what you concluded before closing it." };
  }
  if (opts.classification === "confirmed-incident" && resolution.length < 5) {
    return {
      ok: false,
      reason: "A confirmed incident needs the supporting conclusion written down.",
    };
  }

  const status = opts.status ?? current.status;
  const changes: string[] = [];
  if (opts.status && opts.status !== current.status) {
    changes.push(`status ${current.status} to ${opts.status}`);
  }
  if (opts.classification && opts.classification !== current.classification) {
    changes.push(`classified ${opts.classification}`);
  }
  if (opts.assignee !== undefined && opts.assignee.toLowerCase() !== current.assignee) {
    changes.push(opts.assignee ? `assigned to ${opts.assignee}` : "unassigned");
  }
  const extra = (opts.addEventIds ?? [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (extra.length > 0) changes.push(`${extra.length} event(s) linked`);

  const { rows } = await db().query<Db>(
    `UPDATE dm_investigations
        SET status = $2,
            classification = $3,
            assignee = $4,
            resolution = $5,
            event_ids = (SELECT array_agg(DISTINCT e)
                           FROM unnest(event_ids || $6::bigint[]) AS e),
            closed_at = CASE WHEN $7 THEN coalesce(closed_at, now()) ELSE NULL END,
            closed_by = CASE WHEN $7 THEN $8 ELSE '' END
      WHERE id = $1
  RETURNING ${COLS}`,
    [Number(opts.id), status, opts.classification ?? current.classification,
      (opts.assignee ?? current.assignee).toLowerCase(), resolution.slice(0, 2000),
      extra, closing, opts.by.toLowerCase()]);

  await note(opts.id, opts.by, changes.join(" · "), opts.note ?? "");
  return { ok: true, row: shape(rows[0]!) };
}

export async function investigationCounts(): Promise<Record<string, number>> {
  await ensure();
  const { rows } = await db().query<{ status: string; n: string }>(
    "SELECT status, count(*) AS n FROM dm_investigations GROUP BY status");
  const out: Record<string, number> = {
    new: 0, investigating: 0, resolved: 0, "false-positive": 0, open: 0,
  };
  for (const r of rows) out[r.status] = Number(r.n);
  out.open = (out.new ?? 0) + (out.investigating ?? 0);
  return out;
}
