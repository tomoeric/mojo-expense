import { db, ensureSchema } from "../db.js";
import { isMicrosoft, type SessionUser } from "../auth/session.js";

/**
 * Who may do what inside Dutch Miller.
 *
 * Three levels:
 *
 *   super — everything, and the ONLY one who can make somebody an admin
 *   admin — invite people, set their page access, revoke a login
 *   user  — only the pages they have been given
 *
 * Super is not a row. It is pinned by configuration (`DM_SUPER_ADMINS`), so
 * it cannot be granted, edited or deleted through the app: an admin cannot
 * promote themselves, and nobody can lock the owner out by deleting a row.
 * The table only ever holds `admin` and `user`.
 *
 * Two doors lead here. MOJO staff come through Microsoft SSO. Outside
 * people — dealer staff — are INVITED BY AN ADMIN and sign in with an
 * emailed one-time link. There is no self-signup: an address nobody
 * invited cannot get in by asking.
 */

/**
 * Who is a super admin, before and regardless of any row.
 *
 * A default rather than an empty list, so the owner is never locked out of
 * the deploy that introduces this. A secret REPLACES it rather than adding
 * to it — a default nobody can remove is a backdoor.
 */
const SUPER_DEFAULT = ["eric.s@mojocarwash.com"];

const clean = (email: string) => email.trim().toLowerCase();

const superList = (): string[] => {
  const raw = (process.env.DM_SUPER_ADMINS ?? "")
    .split(/[,;\s]+/).map(clean).filter(Boolean);
  return raw.length > 0 ? raw : SUPER_DEFAULT;
};

/**
 * MOJO's own people.
 *
 * Signed in through Microsoft SSO against our tenant AND on one of our
 * domains. The provider half is the important one: once outside people can
 * be invited by email, a test on the address alone would let somebody
 * invited as anything@mojocarwash.com inherit staff powers. The domain half
 * matters too, because a guest account in the tenant is also "Microsoft"
 * without being one of us.
 */
const STAFF_DOMAINS_DEFAULT = ["mojocarwash.com", "mammothholdings.com"];

const staffDomains = (): string[] => {
  const raw = (process.env.STAFF_DOMAINS ?? "")
    .split(/[,;\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  return raw.length > 0 ? raw : STAFF_DOMAINS_DEFAULT;
};

export function isStaff(user: SessionUser | undefined | null): boolean {
  if (!user || !isMicrosoft(user)) return false;
  const domain = clean(user.email).split("@")[1] ?? "";
  return staffDomains().includes(domain);
}

export const isSuperEmail = (email: string): boolean => superList().includes(clean(email));

/** For the boot log: how many, never who. */
export const superListSize = (): number => superList().length;
export const staffDomainList = (): string[] => staffDomains();

/**
 * The pages a user can be given, one entry per page.
 *
 * A registry rather than a free-text column, so a typo cannot grant access
 * to nothing and look like access to something, and so the Users page can
 * list what exists without anybody keeping a second copy in sync.
 */
export const DM_PAGES = [
  {
    key: "member-signups",
    label: "Member Signups",
    blurb: "Enrol a member and assign them an RFID tag.",
    // Sub-pages of one page, not pages of their own: access is granted at
    // the parent, so a tick-box per tab would only be a way to hand somebody
    // Add New without Review Existing.
    children: [
      { key: "review", label: "Review Existing" },
      { key: "add", label: "Add New" },
    ],
  },
  {
    key: "rfid-review",
    label: "RFID Review",
    blurb: "Upload RFID numbers and review active and used ones.",
    children: [],
  },
] as const;

export type DmPageKey = (typeof DM_PAGES)[number]["key"];
export const DM_PAGE_KEYS: DmPageKey[] = DM_PAGES.map((p) => p.key);
export const isDmPage = (v: unknown): v is DmPageKey =>
  typeof v === "string" && (DM_PAGE_KEYS as string[]).includes(v);

/** What the table can hold. `super` is computed, never stored. */
export type StoredRole = "admin" | "user";
export type DmRole = StoredRole | "super";
export type DmStatus = "invited" | "active" | "disabled";
export type AuthMethod = "microsoft" | "link";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_users (
  email      text PRIMARY KEY,
  role       text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  /** Page keys a general user may open. Ignored for an admin, who has all. */
  pages      jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);
/** Which door this person comes through. */
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'microsoft';
/** Invited but not yet set up, set up, or switched off. */
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS business text;
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS invited_at timestamptz;
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS invited_by text;
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
/**
 * Revocation counter. A session carries the value it was minted with, so
 * raising this invalidates every session already issued to this person —
 * the one thing a stateless signed cookie cannot otherwise do.
 */
ALTER TABLE dm_users ADD COLUMN IF NOT EXISTS session_epoch integer NOT NULL DEFAULT 0;
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

export type DmUser = {
  email: string;
  role: DmRole;
  pages: DmPageKey[];
  authMethod: AuthMethod;
  status: DmStatus;
  firstName: string | null;
  lastName: string | null;
  business: string | null;
  phone: string | null;
  emailVerifiedAt: string | null;
  invitedAt: string | null;
  invitedBy: string | null;
  activatedAt: string | null;
  lastSeenAt: string | null;
  sessionEpoch: number;
  updatedAt: string;
  updatedBy: string;
};

type Db = {
  email: string; role: StoredRole; pages: unknown;
  auth_method: AuthMethod; status: DmStatus;
  first_name: string | null; last_name: string | null;
  business: string | null; phone: string | null;
  email_verified_at: Date | null;
  invited_at: Date | null; invited_by: string | null;
  activated_at: Date | null; last_seen_at: Date | null;
  session_epoch: number;
  updated_at: Date; updated_by: string;
};

const COLS = `email, role, pages, auth_method, status, first_name, last_name,
  business, phone, email_verified_at, invited_at, invited_by, activated_at,
  last_seen_at, session_epoch, updated_at, updated_by`;

const shape = (r: Db): DmUser => ({
  email: r.email,
  // The pinned list wins over whatever the row says.
  role: isSuperEmail(r.email) ? "super" : r.role,
  pages: Array.isArray(r.pages) ? (r.pages as unknown[]).filter(isDmPage) : [],
  authMethod: r.auth_method,
  status: r.status,
  firstName: r.first_name,
  lastName: r.last_name,
  business: r.business,
  phone: r.phone,
  emailVerifiedAt: r.email_verified_at?.toISOString() ?? null,
  invitedAt: r.invited_at?.toISOString() ?? null,
  invitedBy: r.invited_by,
  activatedAt: r.activated_at?.toISOString() ?? null,
  lastSeenAt: r.last_seen_at?.toISOString() ?? null,
  sessionEpoch: r.session_epoch,
  updatedAt: r.updated_at.toISOString(),
  updatedBy: r.updated_by,
});

export async function listDmUsers(): Promise<DmUser[]> {
  await ensure();
  const { rows } = await db().query<Db>(
    `SELECT ${COLS} FROM dm_users ORDER BY status, email`);
  return rows.map(shape);
}

export async function getDmUser(email: string): Promise<DmUser | null> {
  await ensure();
  const { rows } = await db().query<Db>(
    `SELECT ${COLS} FROM dm_users WHERE email = $1`, [clean(email)]);
  return rows[0] ? shape(rows[0]) : null;
}

export type Access = {
  role: DmRole;
  pages: DmPageKey[];
  status: DmStatus;
  /** A super admin with no row — they still have everything. */
  pinned: boolean;
};

/**
 * What this person may do.
 *
 * A super admin needs no row. Everybody else needs an ACTIVE one: an
 * invited-but-not-yet-set-up account and a disabled one both come back with
 * nothing, so neither can reach a page while it waits or after it is
 * switched off.
 *
 * There is no "empty table means everybody is an admin" fallback any more.
 * It existed so the first person was not locked out of the page that fills
 * the table in; a pinned super admin does that job without ever leaving the
 * door open to everybody else.
 */
export async function dmAccessFor(email: string): Promise<Access> {
  await ensure();
  if (isSuperEmail(email)) {
    return { role: "super", pages: [...DM_PAGE_KEYS], status: "active", pinned: true };
  }
  const row = await getDmUser(email);
  if (!row || row.status !== "active") {
    return { role: "user", pages: [], status: row?.status ?? "invited", pinned: false };
  }
  if (row.role === "admin") {
    return { role: "admin", pages: [...DM_PAGE_KEYS], status: "active", pinned: false };
  }
  return { role: "user", pages: row.pages, status: "active", pinned: false };
}

export const canAdminister = (a: Access): boolean => a.role === "admin" || a.role === "super";

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function assertEmail(email: string): string {
  const who = clean(email);
  if (!EMAIL_RE.test(who)) throw new Error("That is not an email address.");
  return who;
}

/**
 * Create or update somebody.
 *
 * `byRole` is the role of the person DOING it, because one rule cannot be
 * expressed any other way: only a super admin may make somebody an admin.
 * An admin who could promote could promote themselves, and the difference
 * between the two levels would be a label.
 */
export async function saveDmUser(opts: {
  email: string;
  role: StoredRole;
  pages: DmPageKey[];
  by: string;
  byRole: DmRole;
  authMethod?: AuthMethod;
  status?: DmStatus;
}): Promise<DmUser> {
  await ensure();
  const who = assertEmail(opts.email);
  if (isSuperEmail(who)) {
    throw new Error(
      "That account is a super administrator, set in configuration rather than here.");
  }
  if (opts.role === "admin" && opts.byRole !== "super") {
    throw new Error("Only a super administrator can make somebody an administrator.");
  }
  const existing = await getDmUser(who);
  if (existing && existing.role === "admin" && opts.byRole !== "super") {
    throw new Error("Only a super administrator can change an administrator.");
  }

  const keep = [...new Set(opts.pages.filter(isDmPage))];
  const method = opts.authMethod ?? existing?.authMethod ?? "microsoft";
  const status = opts.status ?? existing?.status ?? (method === "link" ? "invited" : "active");

  await db().query(
    `INSERT INTO dm_users (email, role, pages, auth_method, status, updated_at, updated_by)
          VALUES ($1, $2, $3::jsonb, $4, $5, now(), $6)
     ON CONFLICT (email) DO UPDATE
        SET role = EXCLUDED.role, pages = EXCLUDED.pages,
            auth_method = EXCLUDED.auth_method, status = EXCLUDED.status,
            updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [who, opts.role, JSON.stringify(keep), method, status, opts.by]);
  return (await getDmUser(who))!;
}

/** Note that an invite went out, keeping who sent it and when. */
export async function markInvited(email: string, by: string): Promise<void> {
  await ensure();
  await db().query(
    `UPDATE dm_users SET invited_at = now(), invited_by = $2
      WHERE email = $1 AND status = 'invited'`, [clean(email), by]);
}

/**
 * The end of onboarding: their own details, and the account goes live.
 *
 * Name, business and number are the only things anybody sets about
 * themselves. Role and page access are deliberately not among them — an
 * onboarding form that could set its own permissions would make the invite
 * email the entire security boundary.
 */
export async function activateDmUser(opts: {
  email: string;
  firstName: string;
  lastName: string;
  business: string;
  phone: string;
}): Promise<DmUser | null> {
  await ensure();
  const { rows } = await db().query<Db>(
    `UPDATE dm_users
        SET first_name = $2, last_name = $3, business = NULLIF($4, ''), phone = NULLIF($5, ''),
            status = 'active', activated_at = now(), email_verified_at = now(),
            updated_at = now(), updated_by = $1
      WHERE email = $1 AND status = 'invited'
    RETURNING ${COLS}`,
    [clean(opts.email), opts.firstName, opts.lastName, opts.business, opts.phone]);
  return rows[0] ? shape(rows[0]) : null;
}

/**
 * Switch an account off, or back on.
 *
 * Disabling also raises the revocation counter, so somebody already signed
 * in is out on their next request rather than at the end of their eight
 * hours. That is the difference between "revoked" and "revoked eventually",
 * and it is the whole reason the counter exists.
 */
export async function setDmUserEnabled(
  email: string, enabled: boolean, by: string, byRole: DmRole,
): Promise<{ ok: boolean; reason?: string; user?: DmUser }> {
  await ensure();
  const who = clean(email);
  if (isSuperEmail(who)) {
    return { ok: false, reason: "A super administrator cannot be switched off from here." };
  }
  const row = await getDmUser(who);
  if (!row) return { ok: false, reason: "No such person." };
  if (row.role === "admin" && byRole !== "super") {
    return { ok: false, reason: "Only a super administrator can switch off an administrator." };
  }
  const next = enabled ? (row.activatedAt ? "active" : "invited") : "disabled";
  const { rows } = await db().query<Db>(
    `UPDATE dm_users
        SET status = $2,
            session_epoch = session_epoch + CASE WHEN $2 = 'disabled' THEN 1 ELSE 0 END,
            updated_at = now(), updated_by = $3
      WHERE email = $1
    RETURNING ${COLS}`,
    [who, next, by]);
  return { ok: true, user: rows[0] ? shape(rows[0]) : undefined };
}

/** Sign every one of this person's sessions out, without disabling them. */
export async function revokeDmSessions(email: string): Promise<number> {
  await ensure();
  const { rows } = await db().query<{ session_epoch: number }>(
    `UPDATE dm_users SET session_epoch = session_epoch + 1 WHERE email = $1
     RETURNING session_epoch`, [clean(email)]);
  return rows[0]?.session_epoch ?? 0;
}

export async function removeDmUser(
  email: string, byRole: DmRole,
): Promise<{ ok: boolean; reason?: string }> {
  await ensure();
  const who = clean(email);
  if (isSuperEmail(who)) {
    return {
      ok: false,
      reason: "A super administrator is set in configuration and cannot be removed here.",
    };
  }
  const row = await getDmUser(who);
  if (!row) return { ok: true };
  if (row.role === "admin" && byRole !== "super") {
    return { ok: false, reason: "Only a super administrator can remove an administrator." };
  }
  await db().query("DELETE FROM dm_users WHERE email = $1", [who]);
  return { ok: true };
}

/** Last seen, for the Users page. Cheap, best-effort, never blocking. */
export async function noteDmSeen(email: string): Promise<void> {
  await ensure();
  await db().query("UPDATE dm_users SET last_seen_at = now() WHERE email = $1", [clean(email)])
    .catch(() => {});
}
