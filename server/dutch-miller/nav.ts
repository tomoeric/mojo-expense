import { db, ensureSchema } from "../db.js";
import { DM_PAGES, type DmPageKey } from "./pages.js";

/**
 * The left rail: a shared catalogue, arranged per account.
 *
 * Same split as the buckets, for the same reason. A PAGE is code —
 * there is one implementation of it and it lives in the template, so
 * improving it improves it everywhere. Which pages an account shows,
 * and whether each sits at the top of the rail or under something
 * else, is the account's.
 *
 * THE CATALOGUE IS CODE, DELIBERATELY. A page is a route, a guard and
 * a component; "create a page" from an account editor could only ever
 * mean a blank one, and a blank page in a dealership's rail is worse
 * than no page. So an account adds a page that already exists, and a
 * page that does not exist is added by shipping it.
 *
 * ONE INSTANCE PER ACCOUNT, enforced by the primary key rather than by
 * the picker. The picker only offers what is unused, but a second tab,
 * a stale page and a retried request all get past a picker — and two
 * copies of Member Signups in one rail, one of them under RFID
 * Instructions, is the kind of thing nobody can explain afterwards.
 */

/** A routable destination. The hash route is what every link already uses. */
export type NavPage = {
  key: string;
  label: string;
  blurb: string;
  /** The access grant it needs. Unchanged by anything here. */
  grant: DmPageKey;
  /** The hash route, exactly as it has always been. */
  route: string;
  /** May other pages be placed under it? A heading always may. */
  parentable: boolean;
};

/**
 * Every page an account's rail can hold.
 *
 * The route strings are the ones that have always been in people's
 * bookmarks and in sent emails. Nothing here changes where a page
 * lives — only whether, and where, a button for it appears.
 */
export const NAV_PAGES: NavPage[] = [
  {
    key: "member-signups-review",
    label: "Review Existing",
    blurb: "Read member records, open them, and approve them.",
    grant: "member-signups",
    route: "member-signups/review",
    parentable: false,
  },
  {
    key: "member-signups-add",
    label: "Add New",
    blurb: "Enrol a member, assign a tag, and import a file of them.",
    grant: "member-signups-add",
    route: "member-signups/add",
    parentable: false,
  },
  {
    key: "account-registration",
    label: "Account Registration",
    blurb: "Manage your business information and verification.",
    grant: "account-registration",
    route: "account-registration",
    parentable: true,
  },
  {
    key: "rfid-instructions",
    label: "RFID Instructions",
    blurb: "Where the sticker goes on the vehicle, and how to apply it.",
    grant: "rfid-instructions",
    route: "rfid-instructions",
    parentable: true,
  },
  {
    key: "rfid-review",
    label: "RFID Inventory",
    blurb: "Every tag: available, assigned, held back and removed.",
    grant: "rfid-review",
    route: "rfid-review",
    parentable: true,
  },
  /*
   * Vendors, out of the normal rail and still in the catalogue.
   *
   * It is not the account-registration feature and does not belong in
   * a dealership's everyday navigation, so it is not in the base. Its
   * records, its review workflow, its routes and its audit history are
   * untouched — and a partner that genuinely approves vendors can add
   * the button back, which is a better answer than a page nobody can
   * reach holding live data.
   */
  {
    key: "vendors",
    label: "Vendors",
    blurb: "Approved vendors, and the review that approves them.",
    grant: "vendors",
    route: "vendors",
    parentable: true,
  },
];

/** A heading with pages under it. Not a destination of its own. */
export type NavGroup = { key: string; label: string; blurb: string };

export const NAV_GROUPS: NavGroup[] = DM_PAGES
  .filter((p) => p.children.length > 0)
  .map((p) => ({ key: p.key, label: p.label, blurb: p.blurb }));

export const pageByKey = (key: string): NavPage | undefined =>
  NAV_PAGES.find((p) => p.key === key);
export const groupByKey = (key: string): NavGroup | undefined =>
  NAV_GROUPS.find((g) => g.key === key);

/**
 * The rail every account starts on.
 *
 * Seeded into `dm_template_nav` so it can be changed centrally later
 * without a deploy, and resolved at read time so an account that has
 * added nothing follows a change to it.
 *
 * Account Registration is in the base, which is what puts it on
 * Dutch Miller's rail and on every account provisioned afterwards
 * without a migration per account.
 */
const BASE: { key: string; parent: string | null; position: number }[] = [
  { key: "member-signups", parent: null, position: 10 },
  { key: "member-signups-review", parent: "member-signups", position: 11 },
  { key: "member-signups-add", parent: "member-signups", position: 12 },
  { key: "account-registration", parent: null, position: 20 },
  { key: "rfid-instructions", parent: null, position: 30 },
  { key: "rfid-review", parent: null, position: 40 },
];

const SCHEMA = `
/**
 * The rail an account starts on, shared.
 *
 * A row is a page key or a heading key, with where it sits. Seeded
 * once and then editable centrally; an account with no additions
 * renders exactly this, resolved on read rather than copied, so a
 * change here reaches every account that has not overridden it.
 */
CREATE TABLE IF NOT EXISTS dm_template_nav (
  page_key   text    PRIMARY KEY,
  parent_key text,
  position   integer NOT NULL DEFAULT 0
);

/**
 * What one account has added to its own rail.
 *
 * The primary key is the duplicate check, and it is the only one that
 * can be trusted: a picker that offers only unused pages is still
 * defeated by two tabs, a stale page or a retried request, and the
 * result would be the same page twice in one rail under two different
 * parents.
 */
CREATE TABLE IF NOT EXISTS dm_account_nav (
  account_id text        NOT NULL,
  page_key   text        NOT NULL,
  parent_key text,
  position   integer     NOT NULL DEFAULT 0,
  /* An account-appropriate name. The KEY still decides duplicates. */
  label      text        NOT NULL DEFAULT '',
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   text        NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, page_key)
);
CREATE INDEX IF NOT EXISTS dm_account_nav_account
  ON dm_account_nav (account_id, position);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
    for (const row of BASE) {
      await db().query(
        `INSERT INTO dm_template_nav (page_key, parent_key, position)
              VALUES ($1, $2, $3)
         ON CONFLICT (page_key) DO NOTHING`,
        [row.key, row.parent, row.position]);
    }
  }));

/** For a test that needs the schema re-asserted against a fresh database. */
export const resetNavCache = (): void => { ready = null; };

export type RailChild = {
  key: string; label: string; blurb: string; grant: DmPageKey; route: string;
  /** Added by this account rather than coming from the shared base. */
  added: boolean;
};
export type RailItem = RailChild & {
  children: RailChild[];
  /** A heading has no route of its own. */
  group: boolean;
};

type DbNav = { page_key: string; parent_key: string | null; position: number; label?: string };

/**
 * The rail for one account.
 *
 * Base plus this account's additions, resolved here rather than
 * copied, so a page added to the base tomorrow appears for every
 * account that has not already got it — and an account's own
 * additions survive that.
 */
export async function navFor(accountId: string): Promise<RailItem[]> {
  await ensure();
  const base = await db().query<DbNav>(
    "SELECT page_key, parent_key, position FROM dm_template_nav");
  const mine = await db().query<DbNav>(
    `SELECT page_key, parent_key, position, label FROM dm_account_nav
      WHERE account_id = $1`, [accountId]);

  type Entry = { key: string; parent: string | null; position: number; label: string;
    added: boolean; };
  const entries = new Map<string, Entry>();
  for (const r of base.rows) {
    entries.set(r.page_key, {
      key: r.page_key, parent: r.parent_key, position: r.position, label: "", added: false,
    });
  }
  for (const r of mine.rows) {
    // An account cannot move a base entry, only add its own. A row for
    // a key the base already has is ignored rather than honoured: the
    // base is the shared rail, and letting one account rearrange it
    // from here would be a fork dressed as a preference.
    if (entries.has(r.page_key)) continue;
    entries.set(r.page_key, {
      key: r.page_key, parent: r.parent_key, position: r.position,
      label: r.label ?? "", added: true,
    });
  }

  const shape = (e: Entry): RailChild | null => {
    const page = pageByKey(e.key);
    if (!page) return null;
    return {
      key: page.key,
      label: e.label || page.label,
      blurb: page.blurb,
      grant: page.grant,
      route: page.route,
      added: e.added,
    };
  };

  const all = [...entries.values()].sort((a, b) => a.position - b.position);
  const out: RailItem[] = [];
  const index = new Map<string, RailItem>();

  for (const e of all) {
    if (e.parent !== null) continue;
    const group = groupByKey(e.key);
    if (group) {
      const item: RailItem = {
        key: group.key, label: e.label || group.label, blurb: group.blurb,
        grant: "member-signups" as DmPageKey, route: "", added: e.added,
        children: [], group: true,
      };
      out.push(item);
      index.set(group.key, item);
      continue;
    }
    const page = shape(e);
    if (!page) continue;
    const item: RailItem = { ...page, children: [], group: false };
    out.push(item);
    index.set(page.key, item);
  }

  for (const e of all) {
    if (e.parent === null) continue;
    const child = shape(e);
    if (!child) continue;
    const parent = index.get(e.parent);
    // A child whose parent is gone becomes a top-level button rather
    // than disappearing. A page somebody placed must not vanish
    // because a heading moved.
    if (parent) parent.children.push(child);
    else out.push({ ...child, children: [], group: false });
  }

  return out;
}

/** Which pages this account's rail already holds, at any depth. */
export async function navKeys(accountId: string): Promise<string[]> {
  const rail = await navFor(accountId);
  const keys: string[] = [];
  for (const item of rail) {
    if (!item.group) keys.push(item.key);
    for (const c of item.children) keys.push(c.key);
  }
  return keys;
}

/** Everything that could still be added, and where it could go. */
export async function navOptions(accountId: string): Promise<{
  pages: NavPage[];
  parents: { key: string; label: string }[];
}> {
  const used = new Set(await navKeys(accountId));
  const rail = await navFor(accountId);
  return {
    pages: NAV_PAGES.filter((p) => !used.has(p.key)),
    // Only a heading, or a page that says it may hold others. Nesting
    // under something that is itself a sub-button is not offered: the
    // rail is two deep and a third level would render nowhere.
    parents: rail
      .filter((i) => i.group || pageByKey(i.key)?.parentable === true)
      .map((i) => ({ key: i.key, label: i.label })),
  };
}

export type AddResult =
  | { ok: true; rail: RailItem[] }
  | { ok: false; problem: string };

/**
 * Put a page on one account's rail.
 *
 * Every refusal here is also a refusal the picker makes, and that is
 * the point: the picker is a convenience and this is the rule. A
 * stale tab offering a page that was added a minute ago by somebody
 * else gets the same answer as a hand-made request.
 */
export async function addNav(opts: {
  accountId: string;
  pageKey: string;
  /** Null for a top-level button, or the key of an existing main entry. */
  parentKey?: string | null;
  label?: string;
  by: string;
}): Promise<AddResult> {
  await ensure();
  const page = pageByKey(opts.pageKey);
  if (!page) {
    return {
      ok: false,
      problem: "That page is not in the shared template. A page has to be shipped before "
        + "an account can add it.",
    };
  }
  const used = new Set(await navKeys(opts.accountId));
  if (used.has(page.key)) {
    return {
      ok: false,
      problem: `${page.label} is already on this account's navigation. A page can appear `
        + "once, whatever it is called and whichever button it sits under.",
    };
  }

  const parentKey = opts.parentKey?.trim() || null;
  if (parentKey !== null) {
    const { parents } = await navOptions(opts.accountId);
    if (!parents.some((p) => p.key === parentKey)) {
      return {
        ok: false,
        problem: "Choose a main button that exists on this account's rail to put it under.",
      };
    }
  }

  const label = (opts.label ?? "").trim().slice(0, 40);
  const next = await db().query<{ n: number }>(
    "SELECT coalesce(max(position), 0) + 10 AS n FROM dm_account_nav WHERE account_id = $1",
    [opts.accountId]);
  const position = Math.max(Number(next.rows[0]?.n ?? 100), 100);

  const { rowCount } = await db().query(
    `INSERT INTO dm_account_nav (account_id, page_key, parent_key, position, label, added_by)
          VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id, page_key) DO NOTHING`,
    [opts.accountId, page.key, parentKey, position, label, opts.by]);
  if (rowCount === 0) {
    // Two requests at once. The primary key decided; say so plainly
    // rather than reporting a success that added nothing.
    return {
      ok: false,
      problem: `${page.label} was just added by somebody else. It is on the rail already.`,
    };
  }
  return { ok: true, rail: await navFor(opts.accountId) };
}

/**
 * Take an added page back off.
 *
 * Only a page this account added. The base rail is the shared one and
 * is not an account's to empty — a dealership without Member Signups
 * is not a layout choice, it is an outage nobody can undo from inside
 * the app.
 */
export async function removeNav(
  accountId: string, pageKey: string,
): Promise<AddResult> {
  await ensure();
  const { rowCount } = await db().query(
    "DELETE FROM dm_account_nav WHERE account_id = $1 AND page_key = $2",
    [accountId, pageKey]);
  if (rowCount === 0) {
    return {
      ok: false,
      problem: "That button is part of the shared rail and cannot be removed here.",
    };
  }
  return { ok: true, rail: await navFor(accountId) };
}

/** Drop a removed account's navigation. */
export async function forgetNav(accountId: string): Promise<void> {
  await ensure();
  await db().query("DELETE FROM dm_account_nav WHERE account_id = $1", [accountId]);
}
