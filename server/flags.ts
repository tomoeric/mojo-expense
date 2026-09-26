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
    `INSERT INTO app_flags (key, enabled, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, enabled, by],
  );
}
