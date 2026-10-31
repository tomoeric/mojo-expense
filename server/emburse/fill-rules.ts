import { db, ensureSchema } from "../db.js";

/**
 * VENDOR RULES: what an expense from this merchant should say.
 *
 * The owner's ask, 2026-10-31: *"Want rules for match receipts
 * that fill out data. Example AI receipt would. Would like an
 * interface where vendors can be marked as categories and then
 * the rules applied."*
 *
 * The fields are the ones on Emburse's own **Edit Expense
 * Details** form, which the owner sent a picture of, and nothing
 * else:
 *
 *   Category            Technology/Software, Licenses, and Subscriptions
 *   Business Purpose    AI Development and Use
 *   Location / Site     Corporate-Pure Magic
 *   Department          IT & Compliance
 *
 * Merchant and Date are NOT settable here. They come off the
 * receipt and the charge, and a rule that could rewrite the
 * merchant is a rule that can make an expense look like a
 * different purchase.
 *
 * A rule PROPOSES. It never sends: the fields it fills arrive in
 * the same "what will change" list as the receipt and wait for
 * the same press. That is the standing instruction — always ask —
 * and a rule is not a way around it.
 */

export type FillRule = {
  id: number;
  owner: string;
  /** "" means every personal tab this person has; else one lane. */
  lane: string;
  /** Matched against the expense's merchant, case and punctuation blind. */
  vendor: string;
  category: string;
  purpose: string;
  location: string;
  department: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
};

/** The four fields a rule can set, in the order the form shows them. */
export const FILL_FIELDS = ["category", "purpose", "location", "department"] as const;
export type FillField = (typeof FILL_FIELDS)[number];

/** What each one is called on Emburse's form, for anything user-facing. */
export const FIELD_LABEL: Record<FillField, string> = {
  category: "Category",
  purpose: "Business Purpose",
  location: "Location / Site",
  department: "Department",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS expense_fill_rules (
  id          bigserial   PRIMARY KEY,
  owner       text        NOT NULL,
  lane        text        NOT NULL DEFAULT '',
  vendor      text        NOT NULL,
  category    text        NOT NULL DEFAULT '',
  purpose     text        NOT NULL DEFAULT '',
  location    text        NOT NULL DEFAULT '',
  department  text        NOT NULL DEFAULT '',
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text        NOT NULL DEFAULT ''
);
-- One rule per vendor per tab. Two rules for REPLIT on the same
-- tab is not a configuration, it is a question nobody can answer.
CREATE UNIQUE INDEX IF NOT EXISTS expense_fill_rules_one
  ON expense_fill_rules (owner, lane, lower(vendor));
`;

let ready: Promise<void> | null = null;
const ensure = async (): Promise<void> => {
  if (!ready) ready = (async () => { await ensureSchema(); await db().query(SCHEMA); })();
  await ready;
};

/** The table, for a caller that wants it before it reads it. */
export const ensureFillRules = ensure;

const normalise = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Does this rule's vendor name describe this expense's merchant?
 *
 * Contains, either way round and punctuation-blind, because the
 * same vendor is "REPLIT", "Replit", "REPLIT.COM" and
 * "REPLIT #4417" across one statement. Deliberately NOT the
 * word-overlap test the receipt matcher uses: there, a loose
 * match costs a person one look at a card they reject; here it
 * silently writes a category onto somebody's expense.
 */
export function vendorMatches(vendor: string, merchant: string): boolean {
  const v = normalise(vendor);
  const m = normalise(merchant);
  if (!v || !m) return false;
  return m === v || m.includes(v) || v.includes(m);
}

/** Only the fields this rule actually sets. */
export function setsOf(rule: FillRule): Partial<Record<FillField, string>> {
  const out: Partial<Record<FillField, string>> = {};
  for (const f of FILL_FIELDS) {
    const v = rule[f].trim();
    if (v) out[f] = v;
  }
  return out;
}

/**
 * The rule that applies, when one does.
 *
 * MOST SPECIFIC WINS, and specificity is defined rather than
 * guessed: a rule naming this tab beats one that covers every
 * tab, and between two on equal footing the LONGER vendor string
 * wins — "REPLIT PRO" is a narrower statement than "REPLIT" and
 * whoever wrote it meant it to be.
 */
export function pick(rules: FillRule[], merchant: string, lane: string): FillRule | null {
  const fits = rules.filter((r) =>
    r.enabled && (r.lane === "" || r.lane === lane) && vendorMatches(r.vendor, merchant));
  if (fits.length === 0) return null;
  return fits.sort((a, b) =>
    (b.lane === "" ? 0 : 1) - (a.lane === "" ? 0 : 1)
    || b.vendor.length - a.vendor.length
    || a.id - b.id)[0]!;
}

const row = (r: {
  id: string | number; owner: string; lane: string; vendor: string; category: string;
  purpose: string; location: string; department: string; enabled: boolean;
  updated_at: Date; updated_by: string;
}): FillRule => ({
  id: Number(r.id),
  owner: r.owner,
  lane: r.lane,
  vendor: r.vendor,
  category: r.category,
  purpose: r.purpose,
  location: r.location,
  department: r.department,
  enabled: r.enabled,
  updatedAt: r.updated_at.toISOString(),
  updatedBy: r.updated_by,
});

export async function rulesFor(owner: string): Promise<FillRule[]> {
  await ensure();
  const { rows } = await db().query(
    `SELECT id, owner, lane, vendor, category, purpose, location, department, enabled,
            updated_at, updated_by
       FROM expense_fill_rules
      WHERE lower(owner) = lower($1)
      ORDER BY lower(vendor)`,
    [owner]);
  return rows.map(row);
}

export async function saveRule(input: {
  id?: number; owner: string; lane?: string; vendor: string;
  category?: string; purpose?: string; location?: string; department?: string;
  enabled?: boolean; by: string;
}): Promise<FillRule> {
  await ensure();
  const vendor = input.vendor.trim();
  if (!vendor) throw new Error("A rule needs a vendor name to match on.");
  const values = [
    input.owner, (input.lane ?? "").trim(), vendor,
    (input.category ?? "").trim(), (input.purpose ?? "").trim(),
    (input.location ?? "").trim(), (input.department ?? "").trim(),
    input.enabled ?? true, input.by,
  ];
  if (input.id) {
    const { rows } = await db().query(
      `UPDATE expense_fill_rules
          SET lane = $2, vendor = $3, category = $4, purpose = $5, location = $6,
              department = $7, enabled = $8, updated_by = $9, updated_at = now()
        WHERE id = $10 AND lower(owner) = lower($1)
        RETURNING id, owner, lane, vendor, category, purpose, location, department,
                  enabled, updated_at, updated_by`,
      [...values, input.id]);
    const found = rows[0];
    if (!found) throw new Error("That rule is not yours, or no longer exists.");
    return row(found);
  }
  // Saving the same vendor twice is an EDIT, not an error: the
  // page offers a suggested rule per vendor and pressing it
  // twice must not be a dead end.
  const { rows } = await db().query(
    `INSERT INTO expense_fill_rules
       (owner, lane, vendor, category, purpose, location, department, enabled, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (owner, lane, lower(vendor)) DO UPDATE
       SET category = excluded.category, purpose = excluded.purpose,
           location = excluded.location, department = excluded.department,
           enabled = excluded.enabled, updated_by = excluded.updated_by,
           updated_at = now()
     RETURNING id, owner, lane, vendor, category, purpose, location, department,
               enabled, updated_at, updated_by`,
    values);
  return row(rows[0]);
}

export async function deleteRule(owner: string, id: number): Promise<boolean> {
  await ensure();
  const { rowCount } = await db().query(
    "DELETE FROM expense_fill_rules WHERE id = $1 AND lower(owner) = lower($2)",
    [id, owner]);
  return (rowCount ?? 0) > 0;
}

/* ------------------------------------------------------------------ *
 * Rules the expenses already imply
 * ------------------------------------------------------------------ */

export type Suggestion = {
  vendor: string;
  /** How many of this vendor's expenses there are in all. */
  seen: number;
  /** The commonest non-empty value, and how many said it. */
  category: { value: string; of: number };
  location: { value: string; of: number };
  department: { value: string; of: number };
};

/**
 * What this person's own expenses say each vendor should be.
 *
 * Nobody should type a rule for a vendor they have already
 * categorised nine times by hand. This reads the history back:
 * for each merchant with no rule yet, the value that appears
 * most often in each field, with the count, so the page can say
 * "7 of 9" and the person can tell a habit from a one-off.
 *
 * Business Purpose is NOT suggested. It is not in the export, so
 * there is no history to read — "AI Development and Use" is a
 * sentence about intent that only the person can write.
 */
export async function suggestions(owner: string, lane: string | null): Promise<Suggestion[]> {
  await ensure();
  const { rows } = await db().query<{
    merchant: string; seen: string;
    category: string | null; category_of: string | null;
    location: string | null; location_of: string | null;
    department: string | null; department_of: string | null;
  }>(
    `WITH mine AS (
       SELECT merchant,
              nullif(trim(coalesce(category, '')), '')   AS category,
              nullif(trim(coalesce(location, '')), '')   AS location,
              nullif(trim(coalesce(department, '')), '') AS department
         FROM expenses
        WHERE lower(reviewer) = lower($1)
          AND lane <> ''
          AND ($2::text IS NULL OR lane = $2)
          AND trim(coalesce(merchant, '')) <> ''
     ),
     totals AS (SELECT merchant, count(*) AS seen FROM mine GROUP BY merchant),
     top AS (
       SELECT merchant, field, value, n,
              row_number() OVER (PARTITION BY merchant, field ORDER BY n DESC, value) AS rank
         FROM (
           SELECT merchant, 'category' AS field, category AS value, count(*) AS n
             FROM mine WHERE category IS NOT NULL GROUP BY merchant, category
           UNION ALL
           SELECT merchant, 'location', location, count(*)
             FROM mine WHERE location IS NOT NULL GROUP BY merchant, location
           UNION ALL
           SELECT merchant, 'department', department, count(*)
             FROM mine WHERE department IS NOT NULL GROUP BY merchant, department
         ) counted
     )
     SELECT t.merchant, t.seen::text AS seen,
            max(CASE WHEN p.field = 'category' THEN p.value END)        AS category,
            max(CASE WHEN p.field = 'category' THEN p.n END)::text      AS category_of,
            max(CASE WHEN p.field = 'location' THEN p.value END)        AS location,
            max(CASE WHEN p.field = 'location' THEN p.n END)::text      AS location_of,
            max(CASE WHEN p.field = 'department' THEN p.value END)      AS department,
            max(CASE WHEN p.field = 'department' THEN p.n END)::text    AS department_of
       FROM totals t
       LEFT JOIN top p ON p.merchant = t.merchant AND p.rank = 1
      GROUP BY t.merchant, t.seen
      ORDER BY t.seen DESC, t.merchant
      LIMIT 60`,
    [owner, lane]);

  const already = await rulesFor(owner);
  return rows
    .map((r) => ({
      vendor: r.merchant,
      seen: Number(r.seen),
      category: { value: r.category ?? "", of: Number(r.category_of ?? 0) },
      location: { value: r.location ?? "", of: Number(r.location_of ?? 0) },
      department: { value: r.department ?? "", of: Number(r.department_of ?? 0) },
    }))
    // A vendor with nothing filled in anywhere teaches nothing,
    // and a vendor that already has a rule is not a suggestion.
    .filter((s) => s.category.value || s.location.value || s.department.value)
    .filter((s) => !already.some((r) => vendorMatches(r.vendor, s.vendor)));
}
