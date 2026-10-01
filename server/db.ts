import pg from "pg";
import { env } from "./env.js";

/**
 * Neon/Postgres access.
 *
 * Schema is owned by `ensureSchema()` — idempotent CREATE … IF NOT EXISTS run
 * on boot, the same pattern ninja-live-status uses. There are no migration
 * files to drift out of step with the database.
 */

let pool: pg.Pool | null = null;

export function isDbConfigured(): boolean {
  return Boolean(env.databaseUrl);
}

export function db(): pg.Pool {
  if (!pool) {
    if (!env.databaseUrl) throw new Error("DATABASE_URL is not set.");
    pool = new pg.Pool({
      connectionString: env.databaseUrl,
      // Neon terminates idle connections; keep the pool small and patient.
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (err) => console.error("pg pool error:", err.message));
  }
  return pool;
}

const SCHEMA = `
-- One row per uploaded file, so an import can be traced and audited.
CREATE TABLE IF NOT EXISTS expense_imports (
  id                 bigserial PRIMARY KEY,
  filename           text        NOT NULL,
  file_sha256        text        NOT NULL,
  imported_at        timestamptz NOT NULL DEFAULT now(),
  imported_by        text,
  page_count         integer,
  parsed_rows        integer,
  inserted_count     integer,
  updated_count      integer,
  unchanged_count    integer,
  left_inbox_count   integer,
  receipts_added     integer,
  total_cents        bigint,
  stated_total_cents bigint,
  reconciled         boolean
);
-- Warnings are persisted, not just returned to whoever triggered the import.
-- The usual path is an unattended scheduled export, so a warning nobody
-- stored is a warning nobody ever sees.
ALTER TABLE expense_imports ADD COLUMN IF NOT EXISTS warnings text[] NOT NULL DEFAULT '{}';
ALTER TABLE expense_imports ADD COLUMN IF NOT EXISTS export_sections text[];

-- Whose Needs Review this file was, and which Emburse list it came from.
--
-- An import is scoped by that pair exactly as the expenses it carries are.
-- Both of the checks that refuse an import ask "have we seen this before",
-- and without these columns they answered for everybody: Brian's very first
-- pull was refused for being older than Eric's, because the newest expense
-- in the whole table is not the newest expense in Brian's queue.
ALTER TABLE expense_imports ADD COLUMN IF NOT EXISTS reviewer text NOT NULL DEFAULT '';
ALTER TABLE expense_imports ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS expense_imports_at_idx ON expense_imports (imported_at DESC);
CREATE INDEX IF NOT EXISTS expense_imports_who_idx
  ON expense_imports (reviewer, source, imported_at DESC);

CREATE TABLE IF NOT EXISTS expenses (
  dedupe_key      text PRIMARY KEY,
  employee        text   NOT NULL,
  expense_date    date,
  merchant        text   NOT NULL,
  amount_cents    bigint NOT NULL,
  category        text,
  department      text,
  location        text,
  note            text,
  method          text,
  receipt_label   text,
  -- The export is the Emburse INBOX. A row that stops appearing has been
  -- processed, not deleted, so it is flagged rather than removed.
  in_inbox        boolean     NOT NULL DEFAULT true,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  left_inbox_at   timestamptz,
  first_import_id bigint,
  last_import_id  bigint,
  source_page     integer
);
-- WHOSE Needs Review brought this row in.
--
-- Emburse's Needs Review is per account: the expenses waiting on Eric are
-- not the expenses waiting on Brian. One import signing in as one account
-- therefore cannot serve two reviewers — it shows each of them the other's
-- work. This column is what makes a second importer possible at all, and
-- the purge below is why it had to exist before one ran: "delete everything
-- this export no longer carries" is correct for one reviewer and catastrophic
-- for two, because each would delete the other's queue every hour.
--
-- Blank on rows imported before this existed, and on a hand-uploaded file
-- where nobody can say whose queue it was.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reviewer text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS expenses_reviewer_idx ON expenses (reviewer) WHERE in_inbox;
-- WHICH Emburse list this came from.
--
-- Transactions and Reimbursements are two queues on two pages, and the same
-- argument as the reviewer column applies with the same force: an import of one must
-- not purge the other, or each run would delete everything the other
-- brought. Blank means Transactions, so every row that already exists is
-- correct without touching it.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS expenses_source_idx ON expenses (source) WHERE in_inbox;
CREATE INDEX IF NOT EXISTS expenses_date_idx     ON expenses (expense_date DESC);
CREATE INDEX IF NOT EXISTS expenses_inbox_idx    ON expenses (in_inbox);
CREATE INDEX IF NOT EXISTS expenses_employee_idx ON expenses (employee);
CREATE INDEX IF NOT EXISTS expenses_dept_idx     ON expenses (department);
CREATE INDEX IF NOT EXISTS expenses_category_idx ON expenses (category);
CREATE INDEX IF NOT EXISTS expenses_location_idx ON expenses (location);

-- Receipt bytes are stored ONCE, keyed by content hash. The same receipt
-- arrives in every daily export and can also be shared by several expense
-- rows (one purchase split across sites), so blobs are separated from the
-- links to them.
CREATE TABLE IF NOT EXISTS receipt_blobs (
  sha256       text PRIMARY KEY,
  content_type text    NOT NULL,
  byte_size    integer NOT NULL,
  bytes        bytea   NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Which renderer produced the image, so a re-import can upgrade older ones.
ALTER TABLE receipt_blobs ADD COLUMN IF NOT EXISTS render_version integer NOT NULL DEFAULT 1;

-- Which Emburse section a row came from.
--
-- The export PDF has no per-row status column, so this can only be known when
-- an import covers exactly one section — then every row in it is that section.
-- With the default all-in-one export it stays null, and the UI simply does not
-- offer the split rather than showing empty buckets.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS section text;
-- When the rules last judged THIS expense, as opposed to when a rule last
-- ran at all.
--
-- The difference is a window the queue was lying in. Reading a receipt takes
-- the expense out of "Receipt being read"; the rules are re-run for the whole
-- batch afterwards, a good half-minute later for a batch of twenty-five. In
-- between, an expense had a read receipt and no verdict yet — and showed as
-- Unflagged, which is supposed to mean judged and clean.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS rules_run_at timestamptz;
CREATE INDEX IF NOT EXISTS expenses_section_idx ON expenses (section) WHERE section IS NOT NULL;

-- What each import changed, field by field.
--
-- The diff already exists in ingest.ts in order to count updates; persisting it
-- is what lets a reviewer see *what* moved rather than only that something did.
-- Emburse edits notes and categories after the fact, and a silently-changed
-- business purpose is exactly the thing a reviewer would want to look at again.
CREATE TABLE IF NOT EXISTS expense_changes (
  id           bigserial PRIMARY KEY,
  dedupe_key   text        NOT NULL REFERENCES expenses (dedupe_key) ON DELETE CASCADE,
  import_id    bigint      NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  field        text        NOT NULL,
  before_value text,
  after_value  text
);
CREATE INDEX IF NOT EXISTS expense_changes_key_idx ON expense_changes (dedupe_key, id DESC);
CREATE INDEX IF NOT EXISTS expense_changes_import_idx ON expense_changes (import_id);

CREATE TABLE IF NOT EXISTS expense_receipts (
  dedupe_key  text NOT NULL REFERENCES expenses (dedupe_key) ON DELETE CASCADE,
  sha256      text NOT NULL REFERENCES receipt_blobs (sha256),
  source_page integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dedupe_key, sha256)
);
CREATE INDEX IF NOT EXISTS expense_receipts_key_idx ON expense_receipts (dedupe_key);
`;

let ready: Promise<void> | null = null;

/** Runs once per process; safe to call from every entry point. */
export function ensureSchema(): Promise<void> {
  ready ??= db()
    .query(SCHEMA)
    .then(() => {
      console.log("schema ready");
    })
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}
