import type pg from "pg";
import { db, ensureSchema } from "../db.js";

/**
 * The permanent lists of Categories, Locations/Sites and Departments.
 *
 * Emburse owns these lists; the export only ever shows the ones that happen to
 * be attached to an expense in that file. So the app keeps its own copy: every
 * value that has ever arrived stays on the list, whether or not anything is
 * using it today. That is the point of the table — a name that stops appearing
 * has not been deleted, it just has no open expenses this week, and a reviewer
 * comparing against Emburse needs to see it either way.
 *
 * Nothing here is authored by hand. The list grows only from what imports
 * bring in, which means it cannot drift out of step with the data: if a name is
 * on this list, some expense in this database carries it.
 *
 * Counts deliberately are NOT stored. A stored tally would be one more thing to
 * keep right across re-imports, deletions and the inbox flag; counting the
 * expenses table at read time is cheap at this size and cannot be stale.
 */

export const KINDS = ["category", "location", "department"] as const;
export type Kind = (typeof KINDS)[number];

/** Which expenses column each list is drawn from. Never interpolated from input. */
const COLUMN: Record<Kind, string> = {
  category: "category",
  location: "location",
  department: "department",
};

export const KIND_LABEL: Record<Kind, { one: string; many: string }> = {
  category: { one: "Category", many: "Categories" },
  location: { one: "Location / Site", many: "Locations & Sites" },
  department: { one: "Department", many: "Departments" },
};

export const isKind = (s: string): s is Kind => (KINDS as readonly string[]).includes(s);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS expense_taxonomy (
  kind        text NOT NULL,
  name        text NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, name)
);
CREATE INDEX IF NOT EXISTS expense_taxonomy_kind_idx ON expense_taxonomy (kind, name);
`;

let ready: Promise<void> | null = null;

/**
 * Create the table, then take in anything the expenses table already knows.
 *
 * The backfill runs on every boot rather than once. It is a single grouped
 * scan that inserts nothing when there is nothing new, and it means the list is
 * correct for a database that was filled before this table existed — including
 * the one in production, which has months of imports behind it.
 */
export const ensureTaxonomy = (): Promise<void> =>
  (ready ??= ensureSchema()
    .then(async () => {
      await db().query(SCHEMA);
      await seedFromExpenses(db());
    })
    .catch((err) => {
      ready = null;
      throw err;
    }));

type Queryable = Pick<pg.PoolClient, "query">;

/** Exported so the backfill can be tested; `ensureTaxonomy` is the way in. */
export async function seedFromExpenses(client: Queryable): Promise<void> {
  for (const kind of KINDS) {
    await client.query(
      `INSERT INTO expense_taxonomy (kind, name, first_seen, last_seen)
       SELECT $1::text, btrim(${COLUMN[kind]}), min(first_seen_at), max(last_seen_at)
         FROM expenses
        WHERE btrim(coalesce(${COLUMN[kind]}, '')) <> ''
        GROUP BY btrim(${COLUMN[kind]})
       ON CONFLICT (kind, name) DO UPDATE
         SET first_seen = least(expense_taxonomy.first_seen, EXCLUDED.first_seen),
             last_seen  = greatest(expense_taxonomy.last_seen, EXCLUDED.last_seen)`,
      [kind],
    );
  }
}

export type NewNames = Record<Kind, string[]>;

const emptyNewNames = (): NewNames => ({ category: [], location: [], department: [] });

/**
 * Record every name this import carried, and report the ones never seen before.
 *
 * Runs inside the import's own transaction: a rolled-back import must not leave
 * names behind for rows that were never stored. `xmax = 0` is how Postgres
 * lets an upsert say which rows it actually inserted.
 */
export async function recordTaxonomy(
  client: Queryable,
  rows: Iterable<{ category?: string; location?: string; department?: string }>,
): Promise<NewNames> {
  const seen: Record<Kind, Set<string>> = { category: new Set(), location: new Set(), department: new Set() };
  for (const row of rows) {
    for (const kind of KINDS) {
      const name = (row[kind] ?? "").trim();
      if (name) seen[kind].add(name);
    }
  }

  const added = emptyNewNames();
  for (const kind of KINDS) {
    const names = [...seen[kind]];
    if (names.length === 0) continue;
    const { rows: out } = await client.query<{ name: string; inserted: boolean }>(
      `INSERT INTO expense_taxonomy (kind, name)
       SELECT $1::text, n FROM unnest($2::text[]) AS n
       ON CONFLICT (kind, name) DO UPDATE SET last_seen = now()
       RETURNING name, (xmax = 0) AS inserted`,
      [kind, names],
    );
    added[kind] = out.filter((r) => r.inserted).map((r) => r.name).sort((a, b) => a.localeCompare(b));
  }
  return added;
}

export type TaxonomyEntry = {
  name: string;
  /** For "Parent › Leaf" category names; both null when the name is flat. */
  parent: string | null;
  leaf: string;
  firstSeen: string;
  lastSeen: string;
  /** Expenses carrying this name, over all time. */
  uses: number;
  /** Of those, how many are still waiting in the inbox. */
  waiting: number;
  totalCents: number;
  /** Most recent expense date, not import date — null when nothing uses it. */
  lastUsed: string | null;
};

export type TaxonomyList = {
  kind: Kind;
  label: { one: string; many: string };
  entries: TaxonomyEntry[];
  /**
   * Expenses whose value for this field is blank. Says plainly whether the
   * field is actually coming through on the export — an empty list of names
   * beside thousands of blank rows means the column is not being read, which is
   * a very different problem from "nobody fills it in".
   */
  blank: number;
  expenses: number;
};

/** Emburse writes nested categories as "Parent › Leaf". */
function split(name: string): { parent: string | null; leaf: string } {
  const parts = name.split(/\s*[›>]\s*/).filter((p) => p.length > 0);
  if (parts.length < 2) return { parent: null, leaf: name };
  return { parent: parts.slice(0, -1).join(" › "), leaf: parts[parts.length - 1]! };
}

export async function listTaxonomy(kind: Kind): Promise<TaxonomyList> {
  await ensureTaxonomy();
  const col = COLUMN[kind];

  const { rows } = await db().query<{
    name: string; first_seen: Date; last_seen: Date;
    uses: string; waiting: string; total_cents: string | null; last_used: string | null;
  }>(
    `SELECT t.name, t.first_seen, t.last_seen,
            count(e.dedupe_key)                                    AS uses,
            count(e.dedupe_key) FILTER (WHERE e.in_inbox)          AS waiting,
            coalesce(sum(e.amount_cents), 0)                       AS total_cents,
            to_char(max(e.expense_date), 'YYYY-MM-DD')             AS last_used
       FROM expense_taxonomy t
       LEFT JOIN expenses e ON btrim(coalesce(e.${col}, '')) = t.name
      WHERE t.kind = $1
      GROUP BY t.name, t.first_seen, t.last_seen
      ORDER BY t.name`,
    [kind],
  );

  const totals = await db().query<{ blank: string; expenses: string }>(
    `SELECT count(*) FILTER (WHERE btrim(coalesce(${col}, '')) = '') AS blank,
            count(*)                                                AS expenses
       FROM expenses`,
  );

  return {
    kind,
    label: KIND_LABEL[kind],
    entries: rows.map((r) => ({
      name: r.name,
      ...split(r.name),
      firstSeen: r.first_seen.toISOString(),
      lastSeen: r.last_seen.toISOString(),
      uses: Number(r.uses),
      waiting: Number(r.waiting),
      totalCents: Number(r.total_cents ?? 0),
      lastUsed: r.last_used,
    })),
    blank: Number(totals.rows[0]?.blank ?? 0),
    expenses: Number(totals.rows[0]?.expenses ?? 0),
  };
}

/** How many names each list holds, for the rail. */
export async function taxonomyCounts(): Promise<Record<Kind, number>> {
  await ensureTaxonomy();
  const { rows } = await db().query<{ kind: string; n: string }>(
    `SELECT kind, count(*) AS n FROM expense_taxonomy GROUP BY kind`);
  const out: Record<Kind, number> = { category: 0, location: 0, department: 0 };
  for (const r of rows) if (isKind(r.kind)) out[r.kind] = Number(r.n);
  return out;
}
