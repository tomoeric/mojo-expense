/**
 * Small on/off switches an admin can flip without a deploy.
 *
 * A key-value table, which this app otherwise avoids — the note in CLAUDE.md
 * is to prefer a real table for anything that grows per-day or per-user or
 * gets queried. A handful of booleans is none of those: it never grows with
 * the data, it is read once per request at most, and giving each one its own
 * column on a settings table named after something else would be worse.
 *
 * Anything that accumulates rows belongs in its own table instead.
 */

import { db } from "./db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_flags (
  key        text        PRIMARY KEY,
  enabled    boolean     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
-- Auto-approval needs a NUMBER as well as an on/off, and one number does
-- not earn a table of its own.
ALTER TABLE app_flags ADD COLUMN IF NOT EXISTS amount integer;
-- Who turned it on. An automatic approval still reaches Emburse under a
-- real person's login and carries their name, so there has to be one.
ALTER TABLE app_flags ADD COLUMN IF NOT EXISTS owner text;
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> => (ready ??= db().query(SCHEMA).then(() => undefined));

/** Every flag, with the default used when nobody has set it. */
export const FLAGS = {
  /**
   * Keep the full step-by-step trace of each approve and deny.
   *
   * Off by default. The steps are small, but they quote what was on the page
   * at each stage, and a reviewer's queue does not need a browser transcript
   * attached to every decision. Turned on when something is failing and the
   * question is *where* — which, before this existed, could only be answered
   * by approving a real expense and reading a one-line error.
   */
  traceDecisions: false,

  /**
   * Queue approvals for expenses no rule flagged, without anybody clicking.
   *
   * Off, and not the kind of thing that should ever default otherwise.
   * This is the only path in the app that approves somebody's spending
   * with no human in the loop at all, so it carries a per-run ceiling, it
   * only ever touches expenses with ZERO flags from enabled rules, and it
   * runs as the person who switched it on — their name goes on every
   * approval it makes.
   */
  autoApprove: false,

  /**
   * Hold everything back from Emburse, without losing anything.
   *
   * There was no way to say "not now". The only control was the automatic
   * approvals switch, which stops new ones being QUEUED and does nothing
   * about the hundred already waiting — and they share one browser with the
   * export, so a long run of decisions is also the thing standing between
   * the morning import and the queue it refreshes.
   *
   * Paused means: queue nothing automatically, and start no new batch.
   * Already-queued decisions stay exactly as they are and go when it is
   * lifted; a batch already at the browser finishes, because abandoning a
   * half-clicked approval is worse than letting it land.
   */
  holdDecisions: false,
} as const;

export type FlagKey = keyof typeof FLAGS;

export async function getFlag(key: FlagKey): Promise<boolean> {
  await ensure();
  const { rows } = await db().query<{ enabled: boolean }>(
    "SELECT enabled FROM app_flags WHERE key = $1", [key]);
  return rows[0]?.enabled ?? FLAGS[key];
}

export async function allFlags(): Promise<Record<FlagKey, boolean>> {
  await ensure();
  const { rows } = await db().query<{ key: string; enabled: boolean }>(
    "SELECT key, enabled FROM app_flags");
  const set = new Map(rows.map((r) => [r.key, r.enabled]));
  const out = {} as Record<FlagKey, boolean>;
  for (const key of Object.keys(FLAGS) as FlagKey[]) out[key] = set.get(key) ?? FLAGS[key];
  return out;
}

export async function setFlag(key: FlagKey, enabled: boolean, by: string): Promise<void> {
  await ensure();
  await db().query(
    `INSERT INTO app_flags (key, enabled, updated_by, owner) VALUES ($1,$2,$3,$3)
     ON CONFLICT (key) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by,
           -- Switching it on claims ownership; switching it off leaves the
           -- last owner on the row, which is who the history belongs to.
           owner = CASE WHEN EXCLUDED.enabled THEN EXCLUDED.owner ELSE app_flags.owner END`,
    [key, enabled, by],
  );
}

/** How many, for the flags that carry a number. Null when never set. */
export async function getLimit(key: FlagKey): Promise<number | null> {
  await ensure();
  const { rows } = await db().query<{ amount: number | null }>(
    "SELECT amount FROM app_flags WHERE key = $1", [key]);
  return rows[0]?.amount ?? null;
}

export async function setLimit(key: FlagKey, amount: number, by: string): Promise<void> {
  await ensure();
  await db().query(
    `INSERT INTO app_flags (key, enabled, amount, updated_by) VALUES ($1, false, $2, $3)
     ON CONFLICT (key) DO UPDATE
       SET amount = EXCLUDED.amount, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, amount, by],
  );
}

/** Whose Emburse login an automatic decision is made under. */
export async function flagOwner(key: FlagKey): Promise<string | null> {
  await ensure();
  const { rows } = await db().query<{ owner: string | null }>(
    "SELECT owner FROM app_flags WHERE key = $1", [key]);
  return rows[0]?.owner ?? null;
}
