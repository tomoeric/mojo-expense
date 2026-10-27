import { db, ensureSchema } from "../db.js";
import type { BlockPage, RegisteredItem } from "./blocks.js";

/**
 * Fields the template defines, and the data each account puts in them.
 *
 * The buckets arrange items the APPLICATION registered: a field it
 * already reads from a column, a piece of content it already
 * renders. That vocabulary is fixed on purpose and it is also not
 * enough — a partner asks for "Deal Jacket #" and the honest answer
 * cannot be "ship a column".
 *
 * So a field can be defined in the TEMPLATE, once, and it behaves
 * like every other template thing: one definition, shared, reaching
 * every account on the next load. What differs per account is the
 * DATA, and that is the whole risk this file exists to contain:
 *
 *   A value is stored against (account, page, subject, field). The
 *   account is in the primary key, so one partner's answer cannot be
 *   read by another even by asking for the same subject id — there
 *   is no query here that is not account-scoped.
 *
 *   A field is never deleted, only retired. Values written against it
 *   stay, because somebody typed them and a definition change is not
 *   a reason to lose them. Bringing the field back brings them back.
 *
 *   A custom key is minted as `cf_…`, so it cannot collide with a
 *   code-registered key now or after somebody registers a new one.
 *
 * WHAT A CUSTOM FIELD IS NOT. It is a place to type and a place to
 * keep what was typed. It does not join a workflow, gate a
 * submission, or appear in an export that was not told about it. A
 * field that a rule depends on is code, and marked essential there.
 */

/** How a custom field is typed into. */
export const INPUTS = ["text", "textarea", "number", "date", "select", "checkbox"] as const;
export type FieldInput = (typeof INPUTS)[number];
export const isInput = (v: unknown): v is FieldInput =>
  typeof v === "string" && (INPUTS as readonly string[]).includes(v);

export type CustomField = {
  key: string;
  page: BlockPage;
  label: string;
  input: FieldInput;
  /** The choices, when the input is a select. Empty otherwise. */
  options: string[];
  /** Help text under the label. */
  note: string;
  archivedAt: string | null;
  /** Shown as New until this moment. Null means it never was. */
  newUntil: string | null;
  createdAt: string;
  createdBy: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_template_fields (
  key         text        PRIMARY KEY,
  page        text        NOT NULL,
  label       text        NOT NULL,
  input       text        NOT NULL DEFAULT 'text',
  options     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  note        text        NOT NULL DEFAULT '',
  archived_at timestamptz,
  new_until   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS dm_template_fields_page
  ON dm_template_fields (page, archived_at);

/**
 * One account's answers.
 *
 * The account is the first column of the primary key and of every
 * query in this file, which is what makes isolation a property of
 * the schema rather than of remembering a WHERE clause.
 *
 * SUBJECT is what the value is about: a member record's id on a page
 * that lists records, or the empty string on a page that is itself
 * one thing (registration). Keeping it as text means a page that
 * grows a second kind of subject does not need a second table.
 */
CREATE TABLE IF NOT EXISTS dm_custom_values (
  account_id text        NOT NULL,
  page       text        NOT NULL,
  subject    text        NOT NULL DEFAULT '',
  field_key  text        NOT NULL,
  value      text        NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text        NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, page, subject, field_key)
);
CREATE INDEX IF NOT EXISTS dm_custom_values_field
  ON dm_custom_values (field_key);

/**
 * "This is new."
 *
 * A flag on something that already exists — a bucket, a field the
 * application registered years ago, a custom field. Kept apart from
 * the thing it marks so that EXISTING content can be flagged without
 * a column on every table that might hold some, and so that clearing
 * every flag is one DELETE.
 *
 * It is a presentation mark and nothing else: it changes no access,
 * no validation and no order. It expires by itself, because a "New"
 * badge that somebody has to remember to take down is a badge that
 * is still there in March.
 */
CREATE TABLE IF NOT EXISTS dm_new_marks (
  page      text        NOT NULL,
  item_key  text        NOT NULL,
  kind      text        NOT NULL DEFAULT 'field',
  new_until timestamptz NOT NULL,
  note      text        NOT NULL DEFAULT '',
  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by text        NOT NULL DEFAULT '',
  PRIMARY KEY (page, item_key)
);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

/** For a test that needs the schema re-asserted against a fresh database. */
export const resetFieldsCache = (): void => { ready = null; };

/** Every custom key starts here, so it can never shadow a code one. */
export const CUSTOM_PREFIX = "cf_";
export const isCustomKey = (key: string): boolean => key.startsWith(CUSTOM_PREFIX);

type DbField = {
  key: string; page: BlockPage; label: string; input: string; options: unknown;
  note: string; archived_at: Date | null; new_until: Date | null;
  created_at: Date; created_by: string;
};

const shape = (r: DbField): CustomField => ({
  key: r.key,
  page: r.page,
  label: r.label,
  input: isInput(r.input) ? r.input : "text",
  options: Array.isArray(r.options) ? (r.options as unknown[]).map(String) : [],
  note: r.note,
  archivedAt: r.archived_at?.toISOString() ?? null,
  newUntil: r.new_until?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
});

const F_COLS = `key, page, label, input, options, note, archived_at, new_until,
                created_at, created_by`;

/** Every custom field defined for a page, retired ones included. */
export async function listFields(page?: BlockPage): Promise<CustomField[]> {
  await ensure();
  const { rows } = page
    ? await db().query<DbField>(
      `SELECT ${F_COLS} FROM dm_template_fields WHERE page = $1 ORDER BY created_at`, [page])
    : await db().query<DbField>(
      `SELECT ${F_COLS} FROM dm_template_fields ORDER BY page, created_at`);
  return rows.map(shape);
}

export type FieldDraft = {
  key?: string;
  page: BlockPage;
  label: string;
  input?: string;
  options?: string[];
  note?: string;
  /** Flag it as new for this many days. 0 or absent leaves the flag alone. */
  newForDays?: number;
};

export type FieldResult =
  | { ok: true; field: CustomField; created: boolean }
  | { ok: false; problem: string };

/**
 * Define a field, or change one.
 *
 * The KEY is minted once and never changes, because values point at
 * it. Renaming the label is therefore free and renaming is what
 * people actually want — "Deal Jacket #" becoming "Jacket #" must not
 * orphan a year of answers.
 */
export async function saveField(draft: FieldDraft, by: string): Promise<FieldResult> {
  await ensure();
  const label = draft.label.trim().replace(/\s+/g, " ");
  if (label.length < 2) return { ok: false, problem: "A field needs a label." };
  if (label.length > 60) return { ok: false, problem: "That label is too long." };
  const input = isInput(draft.input) ? draft.input : "text";
  const options = [...new Set((draft.options ?? []).map((o) => String(o).trim()))]
    .filter(Boolean).slice(0, 40);
  if (input === "select" && options.length === 0) {
    return { ok: false, problem: "A list field needs at least one choice." };
  }
  const note = String(draft.note ?? "").trim().slice(0, 240);
  const days = Math.min(Math.max(Number(draft.newForDays) || 0, 0), 180);

  if (draft.key) {
    const current = (await listFields()).find((f) => f.key === draft.key);
    if (!current) return { ok: false, problem: "That field no longer exists." };
    if (current.page !== draft.page) {
      return { ok: false, problem: "A field cannot be moved to another page." };
    }
    const { rows } = await db().query<DbField>(
      `UPDATE dm_template_fields
          SET label = $2, input = $3, options = $4::jsonb, note = $5
            ${days > 0 ? `, new_until = now() + ($6 || ' days')::interval` : ""}
        WHERE key = $1 RETURNING ${F_COLS}`,
      days > 0
        ? [draft.key, label, input, JSON.stringify(options), note, String(days)]
        : [draft.key, label, input, JSON.stringify(options), note]);
    return rows[0]
      ? { ok: true, field: shape(rows[0]), created: false }
      : { ok: false, problem: "That field no longer exists." };
  }

  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18) || "field";
  const key = `${CUSTOM_PREFIX}${slug}_${Date.now().toString(36)}`;
  /*
   * A field somebody has just created IS new, so it is flagged
   * without being asked. Fourteen days is long enough for a monthly
   * user to meet it once and short enough that nobody has to
   * remember to take the badge down.
   */
  const { rows } = await db().query<DbField>(
    `INSERT INTO dm_template_fields
       (key, page, label, input, options, note, new_until, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now() + ($7 || ' days')::interval, $8)
     RETURNING ${F_COLS}`,
    [key, draft.page, label, input, JSON.stringify(options), note,
      String(days > 0 ? days : 14), by]);
  return { ok: true, field: shape(rows[0]!), created: true };
}

/**
 * Retire a field, or bring it back.
 *
 * Never a DELETE. Values written against it belong to the partners
 * who typed them, and a definition being wrong today is not a reason
 * to lose what was answered last year — un-retiring shows them all
 * again, exactly as they were.
 */
export async function archiveField(
  key: string, archived: boolean,
): Promise<{ ok: boolean; problem?: string }> {
  await ensure();
  const { rowCount } = await db().query(
    `UPDATE dm_template_fields SET archived_at = ${archived ? "now()" : "NULL"}
      WHERE key = $1`, [key]);
  return rowCount === 0 ? { ok: false, problem: "That field no longer exists." } : { ok: true };
}

/* ------------------------------------------------------------------ *
 * "New"
 * ------------------------------------------------------------------ */

export type NewMark = {
  page: string; itemKey: string; kind: string; newUntil: string; note: string;
};

/**
 * Flag something as new — including something that has been there
 * for years, which is the case the brief actually asks for. A
 * feature nobody notices was still shipped; the badge is how it gets
 * noticed, and it has to work on existing content or it only ever
 * announces the things that were already obvious.
 */
export async function markNew(opts: {
  page: string; itemKey: string; kind?: string; days?: number; note?: string; by: string;
}): Promise<NewMark> {
  await ensure();
  const days = Math.min(Math.max(Number(opts.days) || 14, 1), 180);
  const { rows } = await db().query<{ new_until: Date }>(
    `INSERT INTO dm_new_marks (page, item_key, kind, new_until, note, marked_by)
          VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5, $6)
     ON CONFLICT (page, item_key) DO UPDATE
          SET new_until = excluded.new_until, note = excluded.note,
              kind = excluded.kind, marked_at = now(), marked_by = excluded.marked_by
     RETURNING new_until`,
    [opts.page, opts.itemKey, opts.kind ?? "field", String(days),
      String(opts.note ?? "").slice(0, 160), opts.by]);
  return {
    page: opts.page, itemKey: opts.itemKey, kind: opts.kind ?? "field",
    newUntil: rows[0]!.new_until.toISOString(), note: String(opts.note ?? ""),
  };
}

/** Take the badge off before it expires. */
export async function clearNew(page: string, itemKey: string): Promise<void> {
  await ensure();
  await db().query("DELETE FROM dm_new_marks WHERE page = $1 AND item_key = $2",
    [page, itemKey]);
}

/** Every mark still in date, for one page. Expired ones answer nothing. */
export async function newMarks(page?: string): Promise<Map<string, NewMark>> {
  await ensure();
  const { rows } = page
    ? await db().query<{ page: string; item_key: string; kind: string;
      new_until: Date; note: string }>(
      `SELECT page, item_key, kind, new_until, note FROM dm_new_marks
        WHERE page = $1 AND new_until > now()`, [page])
    : await db().query<{ page: string; item_key: string; kind: string;
      new_until: Date; note: string }>(
      "SELECT page, item_key, kind, new_until, note FROM dm_new_marks WHERE new_until > now()");
  return new Map(rows.map((r) => [`${r.page}:${r.item_key}`, {
    page: r.page, itemKey: r.item_key, kind: r.kind,
    newUntil: r.new_until.toISOString(), note: r.note,
  }]));
}

/**
 * A custom field as the bucket editor sees it — the same shape as a
 * code-registered item, so nothing downstream has to know which kind
 * it is looking at. A custom field is never essential: essential
 * means a workflow depends on it, and no workflow can depend on
 * something defined after it was written.
 */
export const asItem = (f: CustomField): RegisteredItem => ({
  key: f.key,
  label: f.label,
  kind: "input",
  note: f.note || undefined,
  custom: true,
  input: f.input,
  options: f.options,
});

/* ------------------------------------------------------------------ *
 * The answers
 * ------------------------------------------------------------------ */

/**
 * One account's values for one subject.
 *
 * Account-scoped with no way to ask otherwise: the parameter is not
 * optional and it is the first column of the key.
 */
export async function valuesFor(
  accountId: string, page: BlockPage, subject = "",
): Promise<Record<string, string>> {
  await ensure();
  const { rows } = await db().query<{ field_key: string; value: string }>(
    `SELECT field_key, value FROM dm_custom_values
      WHERE account_id = $1 AND page = $2 AND subject = $3`,
    [accountId, page, subject]);
  return Object.fromEntries(rows.map((r) => [r.field_key, r.value]));
}

/** The same, for a list of subjects at once, so a table is one query. */
export async function valuesForMany(
  accountId: string, page: BlockPage, subjects: string[],
): Promise<Map<string, Record<string, string>>> {
  await ensure();
  const out = new Map<string, Record<string, string>>();
  if (subjects.length === 0) return out;
  const { rows } = await db().query<{ subject: string; field_key: string; value: string }>(
    `SELECT subject, field_key, value FROM dm_custom_values
      WHERE account_id = $1 AND page = $2 AND subject = ANY($3::text[])`,
    [accountId, page, subjects]);
  for (const r of rows) {
    const bag = out.get(r.subject) ?? {};
    bag[r.field_key] = r.value;
    out.set(r.subject, bag);
  }
  return out;
}

export type SaveValues =
  | { ok: true; values: Record<string, string> }
  | { ok: false; problem: string };

/**
 * Write answers for one subject in one account.
 *
 * A key that is not a live custom field on this page is refused
 * rather than stored, so a hand-made request cannot leave a value
 * nothing will ever render — the row that turns up in an export
 * three years later with no field to explain it.
 */
export async function saveValues(opts: {
  accountId: string; page: BlockPage; subject?: string;
  values: Record<string, unknown>; by: string;
}): Promise<SaveValues> {
  await ensure();
  const subject = String(opts.subject ?? "");
  const live = new Map((await listFields(opts.page))
    .filter((f) => f.archivedAt === null).map((f) => [f.key, f]));

  const writes: { key: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(opts.values)) {
    const field = live.get(key);
    if (!field) return { ok: false, problem: `${key} is not a field on this page.` };
    let value = raw === null || raw === undefined ? "" : String(raw);
    if (value.length > 2000) value = value.slice(0, 2000);
    if (field.input === "select" && value !== "" && !field.options.includes(value)) {
      return { ok: false, problem: `“${value}” is not one of ${field.label}'s choices.` };
    }
    if (field.input === "number" && value !== "" && !Number.isFinite(Number(value))) {
      return { ok: false, problem: `${field.label} takes a number.` };
    }
    writes.push({ key, value });
  }

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    for (const w of writes) {
      // An emptied field is removed rather than stored as "", so
      // "never answered" and "answered, then cleared" do not read
      // differently to anything downstream.
      if (w.value === "") {
        await client.query(
          `DELETE FROM dm_custom_values
            WHERE account_id = $1 AND page = $2 AND subject = $3 AND field_key = $4`,
          [opts.accountId, opts.page, subject, w.key]);
        continue;
      }
      await client.query(
        `INSERT INTO dm_custom_values
           (account_id, page, subject, field_key, value, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id, page, subject, field_key) DO UPDATE
           SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
        [opts.accountId, opts.page, subject, w.key, w.value, opts.by]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, values: await valuesFor(opts.accountId, opts.page, subject) };
}

/** How many answers a field holds, across every account. Before retiring one. */
export async function fieldUsage(key: string): Promise<number> {
  await ensure();
  const { rows } = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM dm_custom_values WHERE field_key = $1", [key]);
  return Number(rows[0]?.n ?? 0);
}

/** Drop a removed account's answers. */
export async function forgetValues(accountId: string): Promise<void> {
  await ensure();
  await db().query("DELETE FROM dm_custom_values WHERE account_id = $1", [accountId]);
}
