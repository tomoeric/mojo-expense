import { db, ensureSchema } from "../db.js";
import { DM_PAGES, DM_PAGE_KEYS, isDmPage, type DmPageKey } from "./pages.js";

/**
 * Named roles, each carrying a set of Dutch Miller pages.
 *
 * Access used to be a per-person list of tick-boxes. That works for three
 * people and stops working at thirty: nobody can answer "what can a
 * service writer see?" without opening thirty rows, and granting a new
 * page to a job means finding everybody who holds it. A role is that
 * answer written down once.
 *
 * Two roles are BUILT IN and cannot be deleted or renamed:
 *
 *   administrator — every page, plus Users and Settings
 *   general user  — no pages at all until somebody grants them
 *
 * The second one exists so that assigning a role is never a way to
 * accidentally grant everything: the default a new person lands on gives
 * nothing away.
 *
 * Super admin is NOT a role. It stays pinned in configuration (see
 * `users.ts`), because a role that could be edited is a role that could
 * be edited to lock the owner out.
 */

export type DmRoleDef = {
  key: string;
  name: string;
  pages: DmPageKey[];
  /** May open Users, Settings and the audit trail. */
  administers: boolean;
  /** May mark a member signup approved. Only the built-in CSC role. */
  approves: boolean;
  /** Built in: editable pages for the admin role, but never renamed or removed. */
  builtin: boolean;
  /** How many people hold it. Filled in by `listRoles`. */
  holders?: number;
  createdAt: string | null;
  createdBy: string | null;
};

export const ADMIN_ROLE = "administrator";
export const DEFAULT_ROLE = "general-user";
/**
 * The one role that can approve a membership.
 *
 * Approving is not an administrative act — it is somebody at the
 * customer service centre checking a signup and putting their name on
 * it. Separating it from `administers` is the whole point: an
 * administrator manages who can use the app, which is a different job
 * from deciding that a member may wash.
 */
export const CSC_ROLE = "csc";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_roles (
  key         text        PRIMARY KEY,
  name        text        NOT NULL,
  pages       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  administers boolean     NOT NULL DEFAULT false,
  builtin     boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL DEFAULT ''
);
/* Approving is its own permission, not a consequence of administering. */
ALTER TABLE dm_roles ADD COLUMN IF NOT EXISTS approves boolean NOT NULL DEFAULT false;
`;

/**
 * The two that must always exist.
 *
 * Inserted with ON CONFLICT DO NOTHING, so an administrator who narrows
 * the admin role's pages keeps that change across restarts — only the
 * row's existence is guaranteed here, not its contents.
 */
const SEED = `
INSERT INTO dm_roles (key, name, pages, administers, approves, builtin, created_by)
     VALUES ('${ADMIN_ROLE}', 'Administrator', $1::jsonb, true, false, true, 'system'),
            ('${CSC_ROLE}', 'CSC', $1::jsonb, false, true, true, 'system'),
            ('${DEFAULT_ROLE}', 'General user', '[]'::jsonb, false, false, true, 'system')
ON CONFLICT (key) DO NOTHING;
`;

/*
 * Approving belongs to CSC and to nothing else.
 *
 * Asserted on every boot rather than only at seeding, so a row edited
 * by hand cannot quietly hand the permission to another role. Its own
 * statement because a parameterised query may carry only one.
 */
const ONLY_CSC_APPROVES = `
UPDATE dm_roles SET approves = (key = '${CSC_ROLE}') WHERE approves <> (key = '${CSC_ROLE}');
`;

/*
 * The administrator role is "every page" by definition, so a page
 * added later has to reach it. Only that one: a general user's pages
 * are somebody's deliberate choice and are never widened from here.
 */
const WIDEN_ADMIN = `
UPDATE dm_roles SET pages = $1::jsonb WHERE key = '${ADMIN_ROLE}' AND administers;
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
    await db().query(SEED, [JSON.stringify(DM_PAGE_KEYS)]);
    await db().query(ONLY_CSC_APPROVES);
    await db().query(WIDEN_ADMIN, [JSON.stringify(DM_PAGE_KEYS)]);
  }));

type Db = {
  key: string; name: string; pages: unknown; administers: boolean;
  approves: boolean; builtin: boolean; created_at: Date; created_by: string;
  holders?: string;
};

const shape = (r: Db): DmRoleDef => ({
  key: r.key,
  name: r.name,
  pages: Array.isArray(r.pages) ? (r.pages as unknown[]).filter(isDmPage) : [],
  administers: r.administers,
  approves: r.approves,
  builtin: r.builtin,
  holders: r.holders === undefined ? undefined : Number(r.holders),
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
});

export async function listRoles(): Promise<DmRoleDef[]> {
  await ensure();
  const { rows } = await db().query<Db>(
    `SELECT r.key, r.name, r.pages, r.administers, r.approves, r.builtin,
            r.created_at, r.created_by,
            (SELECT count(*) FROM dm_users u WHERE u.role_key = r.key) AS holders
       FROM dm_roles r
      ORDER BY r.administers DESC, r.builtin DESC, lower(r.name)`);
  return rows.map(shape);
}

export async function getRole(key: string): Promise<DmRoleDef | null> {
  await ensure();
  const { rows } = await db().query<Db>(
    `SELECT key, name, pages, administers, approves, builtin, created_at, created_by
       FROM dm_roles WHERE key = $1`, [key.trim().toLowerCase()]);
  return rows[0] ? shape(rows[0]) : null;
}

/** `Service Writer` → `service-writer`. Stable, so renaming keeps the holders. */
export function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function saveRole(opts: {
  /** Omitted creates one; given edits that role in place, holders intact. */
  key?: string;
  name: string;
  pages: DmPageKey[];
  administers: boolean;
  by: string;
}): Promise<DmRoleDef> {
  await ensure();
  const name = opts.name.trim();
  if (name === "") throw new Error("A role needs a name.");
  if (name.length > 60) throw new Error("That name is too long.");

  const pages = [...new Set(opts.pages.filter(isDmPage))];
  const existing = opts.key ? await getRole(opts.key) : null;

  if (opts.key && !existing) throw new Error("No such role.");
  if (existing?.builtin) {
    // Its pages are the point of being able to edit it at all; its name
    // and its administering are what other things are written against.
    if (name !== existing.name) throw new Error("A built-in role cannot be renamed.");
    if (opts.administers !== existing.administers) {
      throw new Error("A built-in role's administrator rights cannot be changed.");
    }
  }

  const key = existing?.key ?? slug(name);
  if (key === "") throw new Error("That name has no letters or numbers in it.");
  if (!existing) {
    const clash = await getRole(key);
    if (clash) throw new Error(`There is already a role called ${clash.name}.`);
  }

  // `approves` is deliberately absent: it belongs to the built-in CSC
  // role and is not something a role editor can hand out.
  await db().query(
    `INSERT INTO dm_roles (key, name, pages, administers, builtin, created_by)
          VALUES ($1, $2, $3::jsonb, $4, false, $5)
     ON CONFLICT (key) DO UPDATE
        SET name = EXCLUDED.name, pages = EXCLUDED.pages,
            administers = CASE WHEN dm_roles.builtin THEN dm_roles.administers
                               ELSE EXCLUDED.administers END`,
    [key, name, JSON.stringify(pages), opts.administers, opts.by]);
  return (await getRole(key))!;
}

/**
 * Delete a role.
 *
 * Refused while anybody holds it. Moving them somewhere automatically
 * would be a silent change to what several people can see, decided by
 * whoever happened to press delete.
 */
export async function removeRole(key: string): Promise<{ ok: boolean; reason?: string }> {
  await ensure();
  const role = await getRole(key);
  if (!role) return { ok: true };
  if (role.builtin) return { ok: false, reason: "A built-in role cannot be removed." };
  const { rows } = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_users WHERE role_key = $1", [role.key]);
  const held = Number(rows[0]?.n ?? 0);
  if (held > 0) {
    return {
      ok: false,
      reason: `${held} ${held === 1 ? "person holds" : "people hold"} this role. `
        + "Move them to another one first.",
    };
  }
  await db().query("DELETE FROM dm_roles WHERE key = $1", [role.key]);
  return { ok: true };
}

export { DM_PAGES, DM_PAGE_KEYS, isDmPage, type DmPageKey };
