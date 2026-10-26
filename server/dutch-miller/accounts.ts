import { db, ensureSchema } from "../db.js";
import { ensureUsersSchema } from "./users.js";

/**
 * Partner accounts — one application, many partners.
 *
 * Dutch Miller was built as the only tenant there would ever be, so its
 * name is in the header, its settings are singletons and its records are
 * every record there is. This module is the spine that turns that into a
 * platform: an account is a row, Dutch Miller is the first one, and
 * everything that used to be "the" member list becomes "this account's".
 *
 * THREE RULES, and the rest follows from them.
 *
 *   The ID is immutable and is the only ownership key. A slug is routing
 *   and a name is a label; both can be changed by somebody who does not
 *   realise what hangs off them, which is exactly why neither may ever
 *   decide who can read what. Renaming an account must not move a single
 *   record.
 *
 *   Dutch Miller's ID is a CONSTANT, not a generated value. Every
 *   pre-existing row in this database belongs to it, and the migration
 *   that says so is a column default — `ADD COLUMN account_id text NOT
 *   NULL DEFAULT 'acct_dutchmiller'` backfills the lot in one statement
 *   with no script to run, no ordering to get right and nothing to do
 *   twice. A generated ID would have needed all three.
 *
 *   Provisioning never copies. A new account gets the shared code, the
 *   current defaults and empty data. Copying Dutch Miller's reviewers,
 *   tags or members into it is how one partner's details end up on
 *   another partner's screen.
 *
 * What is SHARED and what is the ACCOUNT'S, stated once so nobody has to
 * infer it: users, roles, the event trail, security, email settings and
 * reminders are platform-wide, managed centrally and the same everywhere.
 * Member signups, RFID stock, vendors, sticker placement and the account's
 * own identity are the account's, and are never visible across one.
 */

/**
 * The template the running code implements.
 *
 * Recorded on an account when it is provisioned or migrated, so a release
 * can be traced and rolled back. It is a RECORD, never a selector: every
 * account is always rendered by the code that is deployed, so this number
 * cannot pin anybody to an old template. The moment it chooses behaviour
 * it has become a fork, which is the one thing this whole module exists
 * to prevent.
 */
export const TEMPLATE_VERSION = 1;

/** The first account. A constant, because every existing row is its. */
export const DUTCH_MILLER = "acct_dutchmiller";
export const DUTCH_MILLER_SLUG = "dutchmiller";

export type AccountStatus = "active" | "inactive";

export type Account = {
  /** Immutable. The ownership key, and the only one. */
  id: string;
  /** The path this account lives at. Routing, never authorisation. */
  slug: string;
  name: string;
  /** The wash it runs under. Blank is normal and must render as nothing. */
  affiliation: string;
  status: AccountStatus;
  templateVersion: number;
  createdAt: string;
  createdBy: string;
  deactivatedAt: string | null;
  deactivatedBy: string | null;
  deactivateReason: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_accounts (
  id                text        PRIMARY KEY,
  slug              text        NOT NULL,
  name              text        NOT NULL,
  affiliation       text        NOT NULL DEFAULT '',
  status            text        NOT NULL DEFAULT 'active',
  template_version  integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text        NOT NULL DEFAULT '',
  deactivated_at    timestamptz,
  deactivated_by    text,
  deactivate_reason text        NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS dm_accounts_slug ON dm_accounts (slug);

/**
 * Who may open which account.
 *
 * A row here is one person in one account. Holding every account is NOT
 * a pile of rows — it is the all_accounts mark on the person, so that
 * adding an account does not mean remembering to go back and add the
 * platform's own people to it.
 */
CREATE TABLE IF NOT EXISTS dm_account_access (
  email      text        NOT NULL,
  account_id text        NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   text        NOT NULL DEFAULT '',
  PRIMARY KEY (email, account_id)
);
CREATE INDEX IF NOT EXISTS dm_account_access_account
  ON dm_account_access (account_id, email);

/**
 * One-time migrations that must not run twice.
 *
 * Its own table rather than a flag on something else, because the thing
 * being marked is usually a backfill across several tables and there is
 * no single row it belongs to. A mark is written once and never read for
 * anything but "has this already happened".
 */
CREATE TABLE IF NOT EXISTS dm_platform_marks (
  key text        PRIMARY KEY,
  at  timestamptz NOT NULL DEFAULT now()
);

/**
 * Dutch Miller, seeded.
 *
 * ON CONFLICT DO NOTHING, so a redeploy cannot reset a name or a slug an
 * administrator has since changed. The affiliation is the one observed on
 * the live header.
 */
INSERT INTO dm_accounts (id, slug, name, affiliation, status, template_version, created_by)
     VALUES ('${DUTCH_MILLER}', '${DUTCH_MILLER_SLUG}', 'Dutch Miller',
             'SUDS Car Wash', 'active', ${TEMPLATE_VERSION}, 'migration')
ON CONFLICT (id) DO NOTHING;
`;

/**
 * Everybody who already had Dutch Miller, given Dutch Miller.
 *
 * Run once, behind a mark. Every `dm_users` row predates accounts and so
 * belongs to the only account there was; without this the migration would
 * take the app away from every person in it. Behind a mark rather than
 * keyed on an empty table, because an administrator who removes the last
 * assignment must not find the whole list back after a restart.
 */
const BACKFILL = `
WITH first_run AS (
  INSERT INTO dm_platform_marks (key) VALUES ('accounts_backfill_dutchmiller')
  ON CONFLICT (key) DO NOTHING
  RETURNING key
)
INSERT INTO dm_account_access (email, account_id, added_by)
SELECT u.email, '${DUTCH_MILLER}', 'migration'
  FROM dm_users u
 WHERE EXISTS (SELECT 1 FROM first_run)
ON CONFLICT (email, account_id) DO NOTHING;
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
    /*
     * The people table has to exist before anybody can be carried
     * over to Dutch Miller. On an empty database it does not yet,
     * which is why its own schema is awaited rather than assumed.
     *
     * Still guarded: a failure here must not stop accounts working,
     * and the mark is only written when the insert runs, so the next
     * boot tries again.
     */
    await ensureUsersSchema().catch(() => undefined);
    await db().query(BACKFILL).catch(() => undefined);
  }));

/** For a test that needs the schema re-asserted against a fresh database. */
export const resetAccountsCache = (): void => { ready = null; };

type Db = {
  id: string; slug: string; name: string; affiliation: string;
  status: AccountStatus; template_version: number;
  created_at: Date; created_by: string;
  deactivated_at: Date | null; deactivated_by: string | null;
  deactivate_reason: string;
};

const COLUMNS = ["id", "slug", "name", "affiliation", "status", "template_version",
  "created_at", "created_by", "deactivated_at", "deactivated_by",
  "deactivate_reason"] as const;

const COLS = COLUMNS.join(", ");
/** The same list, for a query that joins and so must qualify them. */
const A_COLS = COLUMNS.map((c) => `a.${c}`).join(", ");

const shape = (r: Db): Account => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  affiliation: r.affiliation,
  status: r.status,
  templateVersion: r.template_version,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
  deactivatedAt: r.deactivated_at?.toISOString() ?? null,
  deactivatedBy: r.deactivated_by,
  deactivateReason: r.deactivate_reason,
});

/* ------------------------------------------------------------------ *
 * Slugs
 * ------------------------------------------------------------------ */

/**
 * Paths a partner may not take.
 *
 * An account lives at `/<slug>`, so a slug that collides with one of the
 * application's own paths does not merely look odd — it shadows the thing
 * it collides with. `api` would take the whole back end down for everyone.
 *
 * Kept deliberately wider than the paths in use today, because the cost of
 * reserving a word nobody wanted is nothing and the cost of releasing one
 * that is already somebody's URL is a broken link in an email that has
 * already been sent.
 */
export const RESERVED_SLUGS = [
  "api", "auth", "assets", "static", "public", "health", "healthz", "status",
  "login", "logout", "signin", "signout", "redeem", "continue", "callback",
  "oauth", "sso", "admin", "administration", "app", "apps", "account",
  "accounts", "partner", "partners", "platform", "template", "templates",
  "dm-auth", "dutch-miller", "emburse", "me", "events", "settings", "users",
  "roles", "security", "audit", "vendors", "rfid", "new", "edit", "index",
  "favicon.ico", "robots.txt", "index.html", "sitemap.xml", "manifest.json",
];

export type SlugProblem = string | null;

/**
 * Is this usable as a path?
 *
 * Lowercase letters, digits and single hyphens between them. Not a
 * stylistic preference: a slug appears in a URL that gets typed over the
 * phone and pasted into a message, and uppercase, underscores and dots
 * all survive that journey badly.
 */
export function slugProblem(raw: string): SlugProblem {
  const slug = raw.trim().toLowerCase();
  if (!slug) return "A path is required.";
  if (slug.length < 2) return "A path needs at least two characters.";
  if (slug.length > 40) return "A path can be at most 40 characters.";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return "Use lowercase letters, numbers and single hyphens — for example dutchmiller.";
  }
  if (RESERVED_SLUGS.includes(slug)) {
    return `“${slug}” is reserved by the application and cannot be a partner path.`;
  }
  return null;
}

/** The slug a name suggests. A starting point in the form, never imposed. */
export function slugFrom(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export async function listAccounts(): Promise<Account[]> {
  await ensure();
  const { rows } = await db().query<Db>(
    `SELECT ${COLS} FROM dm_accounts ORDER BY name ASC`);
  return rows.map(shape);
}

export async function getAccount(id: string): Promise<Account | null> {
  await ensure();
  const { rows } = await db().query<Db>(
    `SELECT ${COLS} FROM dm_accounts WHERE id = $1`, [id.trim()]);
  return rows[0] ? shape(rows[0]) : null;
}

export async function getAccountBySlug(slug: string): Promise<Account | null> {
  await ensure();
  const { rows } = await db().query<Db>(
    `SELECT ${COLS} FROM dm_accounts WHERE slug = $1`, [slug.trim().toLowerCase()]);
  return rows[0] ? shape(rows[0]) : null;
}

/* ------------------------------------------------------------------ *
 * Who may open what
 * ------------------------------------------------------------------ */

/**
 * The accounts this person may open.
 *
 * Three sources, in order of authority. A pinned account administrator
 * holds every account including ones created after they were pinned —
 * they are the person who creates them. Somebody marked All Accounts
 * holds every account for the same reason: the mark means "platform
 * staff", and a platform person who had to be added to each new partner
 * by hand would be missing from the one that mattered. Everybody else
 * holds exactly the rows written for them.
 *
 * This answers MEMBERSHIP and nothing else. A deactivated account is
 * still listed, because somebody attached to it is still attached to
 * it — whether they may work in it is a different question, asked
 * once in the middleware against the account's status. Filtering it
 * out here instead would collapse the two, and the dealer whose
 * partner went dark would be told the account is "not available to
 * you" rather than that it was deactivated and why.
 */
export async function accountsFor(opts: {
  email: string; isAccountAdmin: boolean; allAccounts: boolean;
}): Promise<Account[]> {
  await ensure();
  if (opts.isAccountAdmin || opts.allAccounts) return listAccounts();
  const { rows } = await db().query<Db>(
    `SELECT ${A_COLS}
       FROM dm_accounts a
       JOIN dm_account_access x ON x.account_id = a.id
      WHERE x.email = $1
      ORDER BY a.name ASC`,
    [opts.email.trim().toLowerCase()]);
  return rows.map(shape);
}

/** Which accounts this person is explicitly assigned, marks aside. */
export async function assignedAccounts(email: string): Promise<string[]> {
  await ensure();
  const { rows } = await db().query<{ account_id: string }>(
    "SELECT account_id FROM dm_account_access WHERE email = $1 ORDER BY account_id",
    [email.trim().toLowerCase()]);
  return rows.map((r) => r.account_id);
}

/**
 * Replace somebody's account assignments.
 *
 * Whole-list rather than add/remove, because the caller is a form showing
 * every account with a tick beside some of them, and reconciling that into
 * two streams of calls is how a half-applied change happens.
 *
 * Unknown IDs are dropped rather than refused: an account deleted between
 * the page loading and the form saving should not fail the save of the
 * other six.
 */
export async function setAssignedAccounts(
  email: string, ids: string[], by: string,
): Promise<string[]> {
  await ensure();
  const who = email.trim().toLowerCase();
  const all = new Set((await listAccounts()).map((a) => a.id));
  const keep = [...new Set(ids.map((i) => i.trim()))].filter((i) => all.has(i));
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM dm_account_access WHERE email = $1", [who]);
    for (const id of keep) {
      await client.query(
        `INSERT INTO dm_account_access (email, account_id, added_by) VALUES ($1, $2, $3)
         ON CONFLICT (email, account_id) DO NOTHING`,
        [who, id, by]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return keep;
}

/**
 * Everybody explicitly assigned to one account.
 *
 * Explicit rows only — somebody marked All Accounts is not listed
 * here, because they hold it through the mark and showing them as an
 * assignment would make removing the assignment look like it would
 * take the account away.
 */
export async function holdersOf(accountId: string): Promise<string[]> {
  await ensure();
  const { rows } = await db().query<{ email: string }>(
    "SELECT email FROM dm_account_access WHERE account_id = $1 ORDER BY email",
    [accountId]);
  return rows.map((r) => r.email);
}

/** Drop every assignment, for somebody being removed from the platform. */
export async function forgetAccountAccess(email: string): Promise<void> {
  await ensure();
  await db().query("DELETE FROM dm_account_access WHERE email = $1",
    [email.trim().toLowerCase()]);
}

/* ------------------------------------------------------------------ *
 * Creating and deactivating
 * ------------------------------------------------------------------ */

export type NewAccount = { name: string; slug?: string; affiliation?: string };

export type Provisioned =
  | { ok: true; account: Account; created: boolean }
  | { ok: false; problem: string };

/**
 * Provision an account.
 *
 * A NAME is the whole requirement. Everything else has a safe default, so
 * the shell that comes out is real — routes, forms, roles and empty data —
 * rather than a half-filled record waiting on six settings nobody has.
 * Reviewers, stock and integrations are deliberately NOT invented here:
 * an account that claims a reviewer it does not have is worse than one
 * that says it has none.
 *
 * Idempotent on the slug, which is what makes a double-click and a retried
 * request safe. A second call with the same slug returns the account that
 * is already there, flagged `created: false`, rather than failing the
 * person or minting a twin. One statement, so a failure part-way cannot
 * leave an account half-made.
 */
export async function createAccount(
  input: NewAccount, by: string,
): Promise<Provisioned> {
  await ensure();
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2) return { ok: false, problem: "A partner name is required." };
  if (name.length > 80) return { ok: false, problem: "That name is too long." };

  const slug = (input.slug?.trim().toLowerCase() || slugFrom(name));
  const bad = slugProblem(slug);
  if (bad) return { ok: false, problem: bad };

  const affiliation = (input.affiliation ?? "").trim().slice(0, 80);
  const id = `acct_${slug.replace(/-/g, "")}_${Date.now().toString(36)}`;

  const { rows } = await db().query<Db>(
    `INSERT INTO dm_accounts (id, slug, name, affiliation, status, template_version, created_by)
          VALUES ($1, $2, $3, $4, 'active', $5, $6)
     ON CONFLICT (slug) DO NOTHING
       RETURNING ${COLS}`,
    [id, slug, name, affiliation, TEMPLATE_VERSION, by]);

  if (rows[0]) return { ok: true, account: shape(rows[0]), created: true };

  // The slug was taken. If it is taken by an identical request that has
  // just landed, hand that one back; if it is somebody else's partner,
  // say so plainly rather than inventing a suffix.
  const existing = await getAccountBySlug(slug);
  if (existing && existing.name === name) {
    return { ok: true, account: existing, created: false };
  }
  return {
    ok: false,
    problem: `The path “${slug}” is already used by ${existing?.name ?? "another partner"}.`,
  };
}

/** Rename, or correct the affiliation. The ID and the slug do not move. */
export async function renameAccount(
  id: string, patch: { name?: string; affiliation?: string }, by: string,
): Promise<Account | { problem: string }> {
  await ensure();
  const current = await getAccount(id);
  if (!current) return { problem: "That account no longer exists." };
  const name = (patch.name ?? current.name).trim().replace(/\s+/g, " ");
  if (name.length < 2) return { problem: "A partner name is required." };
  const affiliation = (patch.affiliation ?? current.affiliation).trim().slice(0, 80);
  const { rows } = await db().query<Db>(
    `UPDATE dm_accounts SET name = $2, affiliation = $3 WHERE id = $1 RETURNING ${COLS}`,
    [id, name, affiliation]);
  void by;
  return rows[0] ? shape(rows[0]) : { problem: "That account no longer exists." };
}

/**
 * Switch an account off, or back on.
 *
 * Deactivation KEEPS everything. Records, tags, invitations, roles and
 * history are untouched; what stops is operational access to the account,
 * enforced on the server so a deep link or a stale tab cannot walk past
 * it. Account administrators keep a management view, because reviewing a
 * dormant partner is the reason it was kept rather than deleted.
 *
 * A reason is required to switch off and is kept on the record, because
 * "why is this partner dark?" is asked months later by somebody who was
 * not in the room.
 *
 * This is NOT the per-account partner-access switch. That one closes the
 * emailed-link door and leaves MOJO staff working inside the account;
 * this one closes the account itself. Keeping both is deliberate: pausing
 * a dealer's logins while MOJO finishes a backlog is an ordinary week,
 * and shutting the partner down is not.
 */
export async function setAccountStatus(
  id: string, status: AccountStatus, by: string, reason: string,
): Promise<Account | { problem: string }> {
  await ensure();
  const note = reason.trim();
  if (status === "inactive" && note.length < 5) {
    return { problem: "Say why this account is being deactivated." };
  }
  const { rows } = await db().query<Db>(
    `UPDATE dm_accounts
        SET status = $2,
            deactivated_at = CASE WHEN $2 = 'inactive' THEN now() ELSE NULL END,
            deactivated_by = CASE WHEN $2 = 'inactive' THEN $3 ELSE NULL END,
            deactivate_reason = CASE WHEN $2 = 'inactive' THEN $4 ELSE '' END
      WHERE id = $1
  RETURNING ${COLS}`,
    [id, status, by, note]);
  return rows[0] ? shape(rows[0]) : { problem: "That account no longer exists." };
}

/**
 * How an account is shown in a header.
 *
 * "Dutch Miller — SUDS Car Wash", or just "Dutch Miller" when no
 * affiliation is configured. Never a dangling separator and never an
 * invented wash: an account whose affiliation nobody has filled in is
 * the normal state of a new partner, not an error to paper over.
 */
export const accountLine = (a: Pick<Account, "name" | "affiliation">): string =>
  a.affiliation ? `${a.name} — ${a.affiliation}` : a.name;

/** The platform's own name, in one place. */
export const PLATFORM_NAME = "MOJO Partners";
