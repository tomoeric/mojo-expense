import type { NextFunction, Request, Response } from "express";
import { db, ensureSchema } from "../db.js";
import { isAdmin, isAuthConfigured } from "../auth/index.js";

/**
 * Who is allowed to write rules.
 *
 * Separate from `isAdmin` on purpose. Admin is about shared settings; this is
 * about a narrower and sharper power — a rule can approve and deny real
 * expenses in Emburse, and the person who should be able to write one is not
 * automatically everyone who can change a cron schedule.
 *
 * The list is stored rather than an env var so somebody can be added without a
 * redeploy, which is the whole point: "Eric for now, Brian when he's ready" is
 * a toggle, not a release.
 *
 * ONE IMPORTANT LIMIT, and it is not a bug in this file. Managing the list is
 * admin-only, and with `AUTH_ADMINS` unset every signed-in person is an admin —
 * so anyone could add themselves back. Until `AUTH_ADMINS` is set this is a
 * guard rail, not a lock, and the UI says exactly that rather than implying a
 * security property it does not have.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rule_editors (
  email    text PRIMARY KEY,
  added_by text,
  added_at timestamptz NOT NULL DEFAULT now()
);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema()
    .then(async () => {
      await db().query(SCHEMA);
    })
    .catch((err) => {
      ready = null;
      throw err;
    }));

const norm = (email: string): string => email.trim().toLowerCase();

export type Editor = { email: string; addedBy: string | null; addedAt: string };

export async function listEditors(): Promise<Editor[]> {
  await ensure();
  const { rows } = await db().query<{ email: string; added_by: string | null; added_at: Date }>(
    "SELECT email, added_by, added_at FROM rule_editors ORDER BY email");
  return rows.map((r) => ({ email: r.email, addedBy: r.added_by, addedAt: r.added_at.toISOString() }));
}

export async function setEditor(email: string, allowed: boolean, by: string): Promise<void> {
  await ensure();
  const who = norm(email);
  if (!who.includes("@")) throw new Error(`“${email}” is not an email address.`);
  if (allowed) {
    await db().query(
      `INSERT INTO rule_editors (email, added_by) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING`, [who, by]);
  } else {
    await db().query("DELETE FROM rule_editors WHERE email = $1", [who]);
  }
}

/**
 * Whether the list is being enforced at all.
 *
 * An empty list means nobody has restricted anything yet, so every admin may
 * write — the behaviour before this existed. Restricting is an act, not a
 * default, because a default-empty allow-list would lock out the very person
 * who has to populate it.
 */
export async function isRestricted(): Promise<boolean> {
  await ensure();
  const { rows } = await db().query<{ n: string }>("SELECT count(*) AS n FROM rule_editors");
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function canWriteRules(email: string | undefined): Promise<boolean> {
  // No sign-in configured means no identity to check, and the app is already
  // refusing to serve real data — the same reasoning as requireAdmin.
  if (!isAuthConfigured()) return true;
  if (!email || !isAdmin(email)) return false;
  if (!(await isRestricted())) return true;
  const { rows } = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM rule_editors WHERE email = $1", [norm(email)]);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** 403 unless the caller may create, edit, enable or run rules. */
export async function requireRuleEditor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (await canWriteRules(req.user?.email)) {
      next();
      return;
    }
    res.status(403).json({
      error: (await isRestricted())
        ? "You are not on the list of people who may write rules. An administrator can add you on the Rules page."
        : "Only an administrator can write rules.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not check permissions." });
  }
}
