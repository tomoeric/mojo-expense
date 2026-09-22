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
-- The usual path is an unattended SharePoint sync, so a warning nobody stored
-- is a warning nobody ever sees.
ALTER TABLE expense_imports ADD COLUMN IF NOT EXISTS warnings text[] NOT NULL DEFAULT '{}';
ALTER TABLE expense_imports ADD COLUMN IF NOT EXISTS export_sections text[];

CREATE INDEX IF NOT EXISTS expense_imports_at_idx ON expense_imports (imported_at DESC);

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
CREATE INDEX IF NOT EXISTS expenses_date_idx     ON expenses (expense_date DESC);
CREATE INDEX IF NOT EXISTS expenses_inbox_idx    ON expenses (in_inbox);
CREATE INDEX IF NOT EXISTS expenses_employee_idx ON expenses (employee);
CREATE INDEX IF NOT EXISTS expenses_dept_idx     ON expenses (department);

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
