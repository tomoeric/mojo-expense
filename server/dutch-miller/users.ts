import { db, ensureSchema } from "../db.js";

/**
 * Who may do what inside Dutch Miller.
 *
 * Two levels, because that is what was asked for and because a third one
 * always turns out to be a page list in disguise:
 *
 *   admin — every page, plus this page
 *   user  — only the pages they have been given
 *
 * Being assigned to Dutch Miller at all is a separate question, answered
 * by `auth/apps.ts` from a Secret. This is the layer inside it: the Secret
 * says who comes through the door, this says what they find.
 */

/**
 * The pages a general user can be given, one entry per page.
 *
 * A registry rather than a free-text column so a typo cannot grant access
 * to nothing and look like access to something, and so the Users page can
 * list what is available without anybody keeping a second copy in sync.
 */
export const DM_PAGES = [
  { key: "rfid-review", label: "RFID Review", blurb: "Upload RFID numbers and review active and used ones." },
] as const;

export type DmPageKey = (typeof DM_PAGES)[number]["key"];
export const DM_PAGE_KEYS: DmPageKey[] = DM_PAGES.map((p) => p.key);
export const isDmPage = (v: unknown): v is DmPageKey =>
  typeof v === "string" && (DM_PAGE_KEYS as string[]).includes(v);

export type DmRole = "admin" | "user";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_users (
  email      text PRIMARY KEY,
  role       text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  /** Page keys a general user may open. Ignored for an admin, who has all. */
  pages      jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

export type DmUser = {
  email: string;
  role: DmRole;
  pages: DmPageKey[];
  updatedAt: string;
  updatedBy: string;
};

const clean = (email: string) => email.trim().toLowerCase();

export async function listDmUsers(): Promise<DmUser[]> {
  await ensure();
  const { rows } = await db().query<{
    email: string; role: DmRole; pages: unknown; updated_at: Date; updated_by: string;
  }>("SELECT email, role, pages, updated_at, updated_by FROM dm_users ORDER BY email");
  return rows.map((r) => ({
    email: r.email,
    role: r.role,
    pages: Array.isArray(r.pages) ? (r.pages as unknown[]).filter(isDmPage) : [],
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by,
  }));
}

/**
 * What this person may do, whether or not they have a row.
 *
 * AN EMPTY TABLE MAKES EVERYONE AN ADMIN, deliberately, and the same
 * reasoning as `AUTH_ADMINS` upstream: a permission list that starts out
 * empty locks the first person out of the page they need in order to fill
 * it in. The moment one row exists the table governs and the fallback is
 * gone, so it cannot quietly stay open — adding yourself closes it.
 */
export async function dmAccessFor(email: string): Promise<{
  role: DmRole;
  pages: DmPageKey[];
  /** True while nobody has been set up yet — the UI says so out loud. */
  unconfigured: boolean;
}> {
  await ensure();
  const any = await db().query<{ n: string }>("SELECT count(*) AS n FROM dm_users");
  const configured = Number(any.rows[0]?.n ?? 0) > 0;
  if (!configured) return { role: "admin", pages: [...DM_PAGE_KEYS], unconfigured: true };

  const { rows } = await db().query<{ role: DmRole; pages: unknown }>(
    "SELECT role, pages FROM dm_users WHERE email = $1", [clean(email)]);
  const row = rows[0];
  if (!row) return { role: "user", pages: [], unconfigured: false };
  if (row.role === "admin") return { role: "admin", pages: [...DM_PAGE_KEYS], unconfigured: false };
  return {
    role: "user",
    pages: Array.isArray(row.pages) ? (row.pages as unknown[]).filter(isDmPage) : [],
    unconfigured: false,
  };
}

export async function saveDmUser(
  email: string,
  role: DmRole,
  pages: DmPageKey[],
  by: string,
): Promise<DmUser> {
  await ensure();
  const who = clean(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(who)) throw new Error("That is not an email address.");
  const keep = [...new Set(pages.filter(isDmPage))];
  await db().query(
    `INSERT INTO dm_users (email, role, pages, updated_at, updated_by)
          VALUES ($1, $2, $3::jsonb, now(), $4)
     ON CONFLICT (email) DO UPDATE
        SET role = EXCLUDED.role, pages = EXCLUDED.pages,
            updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [who, role, JSON.stringify(keep), by]);
  return (await listDmUsers()).find((u) => u.email === who)!;
}

/**
 * Remove somebody.
 *
 * Refuses to remove the LAST admin. Not a courtesy: with the row gone and
 * the table still non-empty, the fallback above does not come back, and
 * there is no one left who can open the page that would fix it.
 */
export async function removeDmUser(email: string): Promise<{ ok: boolean; reason?: string }> {
  await ensure();
  const who = clean(email);
  const admins = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_users WHERE role = 'admin'");
  const mine = await db().query<{ role: DmRole }>(
    "SELECT role FROM dm_users WHERE email = $1", [who]);
  if (mine.rows.length === 0) return { ok: true };
  if (mine.rows[0]!.role === "admin" && Number(admins.rows[0]?.n ?? 0) <= 1) {
    return {
      ok: false,
      reason: "That is the only administrator. Make somebody else an administrator first — " +
        "removing this one would leave nobody who can open this page.",
    };
  }
  await db().query("DELETE FROM dm_users WHERE email = $1", [who]);
  return { ok: true };
}
