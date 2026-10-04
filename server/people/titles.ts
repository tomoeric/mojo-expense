/**
 * What each person's job title is, so a rule can act on it.
 *
 * The reason this exists: a corporate purchase and a site purchase are
 * judged differently, and the only thing on an Emburse export that hints
 * at which is the department and the location — both of which describe
 * the EXPENSE, not the person. The title describes the person, and it is
 * the thing a rule like "deny a corporate card used for …" is really
 * about.
 *
 * NAME ONLY, deliberately. The export carries no email — an expense says
 * "Jonathan Roath" and nothing more — so the name is the only join there
 * is, and storing an address this app has no use for would be collecting
 * somebody's data to leave it sitting there. Name and title, nothing else.
 *
 * THE DANGEROUS CASE, and why it is safe: a title we do not know comes
 * back as an empty string, and an empty text field makes a condition
 * "cannot say" rather than false — so a rule reading "title is not
 * Store Manager → deny" does NOT deny the people it failed to match. It
 * skips them. For an unattended DENIAL that is the only acceptable
 * direction to fail in, and it is the engine's existing behaviour rather
 * than anything added here.
 */

import { db, ensureSchema } from "../db.js";

const SCHEMA = `
-- Keyed on the NORMALISED name, because that is what the join is.
-- Emburse prints "scott pashley" where the directory says "Scott
-- Pashley", so the raw string is not a key.
CREATE TABLE IF NOT EXISTS employee_titles (
  name_key   text PRIMARY KEY,
  name       text NOT NULL,
  title      text NOT NULL,
  source     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

/** Exported because `subjects` LEFT JOINs this table on every rule run. */
export const ensureTitles = ensure;

/**
 * A person's name reduced to what two systems can agree on.
 *
 * Case and punctuation go, because "scott pashley", "Scott Pashley" and
 * "Pashley, Scott" are one person typed three ways. Word ORDER goes too —
 * the words are sorted — which is what lets a directory's "Last, First"
 * meet an export's "First Last" without a special case for each.
 *
 * Middle initials are dropped: a single letter is never what
 * distinguishes two employees, and keeping it means "Craig W Demoranville"
 * misses "Craig Demoranville" for no gain.
 */
export function nameKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return [...new Set(words)].sort().join(" ");
}

export type Title = { name: string; title: string; source: string };

/** Replace the directory wholesale, for one source. */
export async function setTitles(
  people: { name: string; title: string }[], source: string,
): Promise<number> {
  await ensure();
  let n = 0;
  for (const p of people) {
    const key = nameKey(p.name);
    const title = p.title.trim();
    // A person with no title in the directory is not a person with a
    // blank title here: storing "" would turn "we do not know" into "they
    // have none", and the two behave differently in a rule.
    if (!key || !title) continue;
    await db().query(
      `INSERT INTO employee_titles (name_key, name, title, source)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name_key) DO UPDATE
         SET name = EXCLUDED.name, title = EXCLUDED.title,
             source = EXCLUDED.source, updated_at = now()`,
      [key, p.name.trim(), title, source]);
    n++;
  }
  return n;
}

/**
 * Titles pasted by hand, for a tenant that cannot read its directory.
 *
 * The directory is the right source and this is not a rival to it — but
 * granting an application permission is a wait on somebody else, and 88
 * people with no title is a deny rule that cannot be written at all in
 * the meantime. Two columns, name and title, comma or tab separated,
 * one per line; a header row is ignored if it looks like one.
 *
 * Stored under source "pasted", so a later directory read simply
 * overwrites each name it also knows about and the two never argue.
 */
export function parsePasted(text: string): { name: string; title: string }[] {
  const out: { name: string; title: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Tab first: a name like "Pashley, Scott" has a comma in it, and
    // splitting on that would make the surname the title.
    const parts = line.includes("\t") ? line.split("\t") : line.split(",");
    if (parts.length < 2) continue;
    const name = parts[0]!.trim();
    const title = parts.slice(1).join(",").trim();
    if (!name || !title) continue;
    if (/^(name|employee|person)$/i.test(name) && /^(title|job ?title|role)$/i.test(title)) {
      continue; // a header row
    }
    out.push({ name, title });
  }
  return out;
}

export async function allTitles(): Promise<(Title & { updatedAt: string })[]> {
  await ensure();
  const { rows } = await db().query<{
    name: string; title: string; source: string; updated_at: Date;
  }>("SELECT name, title, source, updated_at FROM employee_titles ORDER BY name");
  return rows.map((r) => ({
    name: r.name, title: r.title, source: r.source,
    updatedAt: r.updated_at.toISOString(),
  }));
}

/**
 * Who in the queue has a title and who does not.
 *
 * The match rate is the whole question before a rule depends on this. A
 * deny rule that silently covers two thirds of the company is worse than
 * one that covers none, because the gap is invisible from its results.
 */
export async function titleCoverage(): Promise<{
  matched: { employee: string; title: string }[];
  unmatched: string[];
  stored: number;
  updatedAt: string | null;
}> {
  await ensure();
  const { rows } = await db().query<{
    employee: string; title: string | null;
  }>(
    `SELECT DISTINCT e.employee, t.title
       FROM expenses e
       LEFT JOIN employee_titles t ON t.name_key = ${KEY_SQL("e.employee")}
      WHERE e.in_inbox
      ORDER BY e.employee`);
  const { rows: meta } = await db().query<{ n: string; at: Date | null }>(
    "SELECT count(*) AS n, max(updated_at) AS at FROM employee_titles");
  return {
    matched: rows.filter((r) => r.title).map((r) => ({ employee: r.employee, title: r.title! })),
    unmatched: rows.filter((r) => !r.title).map((r) => r.employee),
    stored: Number(meta[0]?.n ?? 0),
    updatedAt: meta[0]?.at ? meta[0].at.toISOString() : null,
  };
}

/**
 * `nameKey` as SQL, so the join happens in the database.
 *
 * It has to agree with the TypeScript exactly — the same lowering, the
 * same stripping, the same dropping of single letters, the same sort —
 * or a name would be stored under one key and looked up under another.
 * A test pins the two to each other.
 */
export function KEY_SQL(col: string): string {
  return `(
    SELECT coalesce(string_agg(w, ' ' ORDER BY w), '')
      FROM (
        SELECT DISTINCT w
          FROM unnest(regexp_split_to_array(
                 regexp_replace(lower(${col}), '[^a-z[:space:]]', ' ', 'g'),
                 '\\s+')) AS w
         WHERE length(w) > 1
      ) AS words
  )`;
}
