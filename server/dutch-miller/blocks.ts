import { db, ensureSchema } from "../db.js";
import { DUTCH_MILLER } from "./accounts.js";

/**
 * The shared template, and each account's arrangement of it.
 *
 * A PAGE is a fixed set of registered items — named fields and named
 * pieces of content that the application already renders. A BUCKET is
 * a titled group holding some of those items in an order. A LAYOUT is
 * which buckets a page shows, in what order, at what width.
 *
 * Buckets live in the TEMPLATE, once, shared by every account.
 * Layouts live per ACCOUNT and per PAGE. That split is the whole
 * design and everything below follows from it:
 *
 *   A bucket's implementation is shared, so improving one improves it
 *   everywhere on the next deploy, with nothing to re-copy and no
 *   account left on an old version.
 *
 *   An account's arrangement is its own, so changing Dutch Miller's
 *   page cannot change anybody else's.
 *
 *   An account with no arrangement saved falls through to the base
 *   layout AT READ TIME rather than being given a copy of it. A copy
 *   taken at provisioning is a snapshot, and a snapshot is a fork
 *   that nobody notices for six months.
 *
 * WHAT THIS IS NOT. It arranges registered items. It cannot invent a
 * field, reach a column nobody exposed, or run anything — the item
 * keys below are the complete vocabulary, and one that is not in the
 * list is refused rather than rendered empty. Hiding is presentation
 * only: it deletes nothing, relaxes no validation and skips no step
 * of a workflow, which is why an item the workflow depends on is
 * marked ESSENTIAL here and cannot be hidden at all.
 */

export const BLOCK_PAGES = [
  "member-signups-review",
  "member-signups-add",
  "rfid-instructions",
  "rfid-review",
] as const;
export type BlockPage = (typeof BLOCK_PAGES)[number];
export const isBlockPage = (v: unknown): v is BlockPage =>
  typeof v === "string" && (BLOCK_PAGES as readonly string[]).includes(v);

export const PAGE_LABEL: Record<BlockPage, string> = {
  "member-signups-review": "Member Signups — Review Existing",
  "member-signups-add": "Member Signups — Add New",
  "rfid-instructions": "RFID Instructions",
  "rfid-review": "RFID Inventory",
};

/**
 * What a registered item IS, which decides how it may be treated.
 *
 *   data     a value read off a record. Safe to hide; nothing depends
 *            on it being on screen.
 *   input    a form field somebody types into. Hiding one that is
 *            required would mean a form that cannot be submitted, so
 *            those are essential.
 *   content  instructional copy or a picture.
 *   control  a button, a filter, a toggle — something that DOES
 *            things. Hiding one takes an action away from the page
 *            without taking the permission away, which is why the
 *            ones that matter are essential.
 */
export type ItemKind = "data" | "input" | "content" | "control";

export type RegisteredItem = {
  key: string;
  label: string;
  kind: ItemKind;
  /**
   * May not be hidden, and may not be removed from the bucket holding it.
   *
   * Not a styling preference. These are the items a workflow, a
   * validation rule or a legal record depends on: the tag a member was
   * issued, the fields the server refuses a submission without, the
   * generated values it signs. A page that let somebody hide one would
   * be a page that quietly stops working, and the person who finds out
   * is standing at a vehicle.
   */
  essential?: boolean;
  /** One line in the editor's checklist, saying what it is. */
  note?: string;
};

const ITEM: Record<BlockPage, RegisteredItem[]> = {
  "member-signups-review": [
    { key: "createdDate", label: "Date Created", kind: "data" },
    { key: "createdTime", label: "Time Created", kind: "data" },
    {
      key: "guid", label: "Unique GUID", kind: "data", essential: true,
      note: "The record's identity. Quoted in emails and support calls.",
    },
    {
      key: "dlwContractId", label: "DLW Contract ID", kind: "data", essential: true,
      note: "How the dealership identifies the agreement.",
    },
    { key: "dealNumber", label: "Deal #", kind: "data" },
    { key: "customerId", label: "Customer ID #", kind: "data" },
    { key: "firstName", label: "First Name", kind: "data", essential: true },
    { key: "lastName", label: "Last Name", kind: "data", essential: true },
    { key: "phone", label: "Phone", kind: "data" },
    { key: "email", label: "Email", kind: "data" },
    { key: "plate", label: "Plate and state", kind: "data" },
    { key: "vehicleMake", label: "Vehicle Make", kind: "data" },
    { key: "vehicleModel", label: "Vehicle Model", kind: "data" },
    { key: "vehicleYear", label: "Vehicle Year", kind: "data" },
    { key: "vehicleColor", label: "Vehicle Color", kind: "data" },
    {
      key: "rfid", label: "RFID", kind: "data", essential: true,
      note: "Which tag is on the vehicle. The page cannot answer its own question without it.",
    },
    {
      key: "stickerAttached", label: "Sticker state", kind: "data", essential: true,
      note: "Approval is refused until it is confirmed, so hiding it hides the reason.",
    },
    { key: "submittedBy", label: "Submitted by", kind: "data" },
    { key: "openedBy", label: "Opened by MOJO", kind: "data" },
    { key: "completedBy", label: "Approved by", kind: "data" },
    {
      key: "deliveries", label: "Email delivery attempts", kind: "content",
      note: "What was attempted about this member, and how it went.",
    },
  ],
  "member-signups-add": [
    {
      key: "createdDate", label: "Date Created", kind: "data", essential: true,
      note: "Minted and signed by the server. The form carries it through untouched.",
    },
    { key: "createdTime", label: "Time Created", kind: "data", essential: true },
    { key: "guid", label: "Unique GUID", kind: "data", essential: true },
    {
      key: "dlwContractId", label: "DLW Contract ID", kind: "input", essential: true,
      note: "Required. A submission without it is refused by the server.",
    },
    { key: "dealNumber", label: "Deal #", kind: "input" },
    { key: "customerId", label: "Customer ID #", kind: "input" },
    { key: "firstName", label: "First Name", kind: "input", essential: true },
    { key: "lastName", label: "Last Name", kind: "input", essential: true },
    { key: "phone", label: "Phone", kind: "input" },
    { key: "email", label: "Email", kind: "input" },
    { key: "plate", label: "Plate (DLW)", kind: "input" },
    { key: "plateState", label: "Plate state", kind: "input" },
    { key: "vehicleYear", label: "Vehicle Year", kind: "input" },
    { key: "vehicleMake", label: "Vehicle Make", kind: "input" },
    { key: "vehicleModel", label: "Vehicle Model", kind: "input" },
    { key: "vehicleColor", label: "Vehicle Color", kind: "input" },
    {
      key: "rfid", label: "RFID", kind: "input", essential: true,
      note: "Required, and claimed in the same transaction that writes the member.",
    },
    {
      key: "stickerAttached", label: "Sticker confirmation", kind: "input", essential: true,
      note: "The attestation approval depends on. It cannot be taken off the form.",
    },
  ],
  "rfid-instructions": [
    {
      key: "rule", label: "The placement rule", kind: "content", essential: true,
      note: "Where the sticker goes. The page exists to say it.",
    },
    { key: "diagram", label: "Illustrated guide", kind: "content" },
    { key: "dos", label: "Do", kind: "content" },
    { key: "donts", label: "Do not", kind: "content" },
    {
      key: "numberMatch", label: "Check the number warning", kind: "content", essential: true,
      note: "A tag on the wrong windshield cannot be undone from here.",
    },
  ],
  "rfid-review": [
    {
      key: "upload", label: "Upload a file", kind: "control",
      note: "Only ever shown to a role that may change the pool, whatever the layout says.",
    },
    { key: "format", label: "Required file format", kind: "content" },
    {
      key: "counts", label: "Status filters and counts", kind: "control", essential: true,
      note: "Available, assigned, held back, test and removed. Without them the page is one list.",
    },
    {
      key: "search", label: "Search", kind: "control", essential: true,
      note: "The only way to find one number in a pool of thousands.",
    },
    { key: "note", label: "What each view means", kind: "content" },
    {
      key: "table", label: "The numbers", kind: "data", essential: true,
      note: "The page itself.",
    },
  ],
};

export const itemsOn = (page: BlockPage): RegisteredItem[] => ITEM[page];
export const itemOn = (page: BlockPage, key: string): RegisteredItem | undefined =>
  ITEM[page].find((i) => i.key === key);
export const essentialOn = (page: BlockPage): string[] =>
  ITEM[page].filter((i) => i.essential).map((i) => i.key);

/* ------------------------------------------------------------------ *
 * The template
 * ------------------------------------------------------------------ */

/** A bucket's width, in a six-column grid. The same control WashIQ uses. */
export const WIDTHS = [2, 3, 4, 6] as const;
export type Width = (typeof WIDTHS)[number];
export const isWidth = (v: unknown): v is Width =>
  (WIDTHS as readonly number[]).includes(Number(v));

/** How tall, in the same three steps, rather than a free pixel value. */
export const HEIGHTS = ["auto", "short", "tall"] as const;
export type Height = (typeof HEIGHTS)[number];
export const isHeight = (v: unknown): v is Height =>
  typeof v === "string" && (HEIGHTS as readonly string[]).includes(v);

export type TemplateBlock = {
  /** Stable, and never reused. Layouts point at it. */
  id: string;
  page: BlockPage;
  name: string;
  /** Ordered item keys. Every one is registered on that page. */
  items: string[];
  /** Columns INSIDE the bucket, 1 to 3. */
  columns: number;
  /** Shipped with the application; cannot be deleted or renamed away. */
  builtin: boolean;
  /** Retired. Kept so a layout pointing at it still resolves. */
  archivedAt: string | null;
  createdAt: string;
  createdBy: string;
};

export type Placed = TemplateBlock & {
  position: number;
  width: Width;
  height: Height;
  hidden: boolean;
  /** True when this account has its own arrangement of this bucket. */
  overridden: boolean;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_template_blocks (
  id          text        PRIMARY KEY,
  page        text        NOT NULL,
  name        text        NOT NULL,
  items       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  columns     integer     NOT NULL DEFAULT 3,
  builtin     boolean     NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS dm_template_blocks_page
  ON dm_template_blocks (page, archived_at);

/**
 * The base layout: what a page looks like before anybody arranges it.
 *
 * One row per bucket per page, shared. A new account starts here and
 * so does an account that has never touched the page — resolved at
 * read time, not copied, so a change to the base reaches both.
 */
CREATE TABLE IF NOT EXISTS dm_template_layout (
  page     text    NOT NULL,
  block_id text    NOT NULL,
  position integer NOT NULL DEFAULT 0,
  width    integer NOT NULL DEFAULT 6,
  height   text    NOT NULL DEFAULT 'auto',
  PRIMARY KEY (page, block_id)
);

/**
 * One account's arrangement of one page.
 *
 * A row here is an OVERRIDE. No row means the base layout, which is
 * why provisioning writes nothing and why a later change to the base
 * still reaches an account that has never arranged that page.
 *
 * The items column is null unless the account chose its own
 * selection within the bucket; null means "whatever the template's
 * bucket holds", so a field added to a shared bucket appears for
 * everybody who had not overridden it.
 */
CREATE TABLE IF NOT EXISTS dm_account_layout (
  account_id text    NOT NULL,
  page       text    NOT NULL,
  block_id   text    NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  width      integer NOT NULL DEFAULT 6,
  height     text    NOT NULL DEFAULT 'auto',
  hidden     boolean NOT NULL DEFAULT false,
  items      jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text    NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, page, block_id)
);
CREATE INDEX IF NOT EXISTS dm_account_layout_page
  ON dm_account_layout (account_id, page, position);
`;

/**
 * The buckets the application ships with.
 *
 * Seeded so the base layout IS what the pages render today — the
 * migration's job is to change nothing on screen. Built-in, so the
 * catalogue cannot be emptied to the point where a page has nothing
 * on it, and `ON CONFLICT DO NOTHING` so a redeploy cannot undo an
 * edit somebody has since made to one.
 */
type Seed = {
  id: string; page: BlockPage; name: string; items: string[];
  columns: number; width: Width; height: Height; position: number;
};

const SEEDS: Seed[] = [
  {
    id: "blk_review_auto", page: "member-signups-review", name: "Auto Data",
    items: ["createdDate", "createdTime", "guid"],
    columns: 3, width: 6, height: "auto", position: 10,
  },
  {
    id: "blk_review_dealer", page: "member-signups-review", name: "Dealer",
    items: ["dlwContractId", "dealNumber", "customerId"],
    columns: 3, width: 6, height: "auto", position: 20,
  },
  {
    id: "blk_review_customer", page: "member-signups-review", name: "Customer",
    items: ["firstName", "lastName", "phone", "email", "plate", "vehicleMake",
      "vehicleModel", "vehicleYear", "vehicleColor", "rfid", "stickerAttached"],
    columns: 3, width: 6, height: "auto", position: 30,
  },
  {
    id: "blk_review_delivery", page: "member-signups-review", name: "Email delivery",
    items: ["deliveries"],
    columns: 1, width: 6, height: "auto", position: 40,
  },
  {
    id: "blk_add_auto", page: "member-signups-add", name: "Auto Data",
    items: ["createdDate", "createdTime", "guid"],
    columns: 3, width: 6, height: "auto", position: 10,
  },
  {
    id: "blk_add_dealer", page: "member-signups-add", name: "Dealer",
    items: ["dlwContractId", "dealNumber", "customerId"],
    columns: 3, width: 6, height: "auto", position: 20,
  },
  {
    id: "blk_add_customer", page: "member-signups-add", name: "Customer",
    items: ["firstName", "lastName", "phone", "email", "plate", "plateState",
      "vehicleYear", "vehicleMake", "vehicleModel", "vehicleColor",
      "rfid", "stickerAttached"],
    columns: 3, width: 6, height: "auto", position: 30,
  },
  {
    id: "blk_rfid_rule", page: "rfid-instructions", name: "Where it goes",
    items: ["rule", "diagram"],
    columns: 1, width: 6, height: "auto", position: 10,
  },
  {
    id: "blk_rfid_dos", page: "rfid-instructions", name: "Do",
    items: ["dos"], columns: 1, width: 3, height: "auto", position: 20,
  },
  {
    id: "blk_rfid_donts", page: "rfid-instructions", name: "Do not",
    items: ["donts"], columns: 1, width: 3, height: "auto", position: 30,
  },
  {
    id: "blk_rfid_check", page: "rfid-instructions", name: "Before you apply it",
    items: ["numberMatch"], columns: 1, width: 6, height: "auto", position: 40,
  },
  {
    id: "blk_inv_upload", page: "rfid-review", name: "Adding numbers",
    items: ["upload", "format"], columns: 1, width: 6, height: "auto", position: 10,
  },
  {
    id: "blk_inv_find", page: "rfid-review", name: "Finding a number",
    items: ["counts", "search", "note"], columns: 1, width: 6, height: "auto", position: 20,
  },
  {
    id: "blk_inv_table", page: "rfid-review", name: "Numbers",
    items: ["table"], columns: 1, width: 6, height: "auto", position: 30,
  },
];

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
    for (const s of SEEDS) {
      await db().query(
        `INSERT INTO dm_template_blocks (id, page, name, items, columns, builtin, created_by)
              VALUES ($1, $2, $3, $4::jsonb, $5, true, 'template')
         ON CONFLICT (id) DO NOTHING`,
        [s.id, s.page, s.name, JSON.stringify(s.items), s.columns]);
      await db().query(
        `INSERT INTO dm_template_layout (page, block_id, position, width, height)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (page, block_id) DO NOTHING`,
        [s.page, s.id, s.position, s.width, s.height]);
    }
  }));

/** For a test that needs the schema re-asserted against a fresh database. */
export const resetBlocksCache = (): void => { ready = null; };

type DbBlock = {
  id: string; page: BlockPage; name: string; items: unknown; columns: number;
  builtin: boolean; archived_at: Date | null; created_at: Date; created_by: string;
};

const shape = (r: DbBlock): TemplateBlock => ({
  id: r.id,
  page: r.page,
  name: r.name,
  items: Array.isArray(r.items) ? (r.items as unknown[]).map(String) : [],
  columns: r.columns,
  builtin: r.builtin,
  archivedAt: r.archived_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
});

const B_COLS = `id, page, name, items, columns, builtin, archived_at,
                created_at, created_by`;

/** Every bucket in the catalogue, for one page or all of them. */
export async function listBlocks(page?: BlockPage): Promise<TemplateBlock[]> {
  await ensure();
  const { rows } = page
    ? await db().query<DbBlock>(
      `SELECT ${B_COLS} FROM dm_template_blocks WHERE page = $1
        ORDER BY builtin DESC, name ASC`, [page])
    : await db().query<DbBlock>(
      `SELECT ${B_COLS} FROM dm_template_blocks ORDER BY page, builtin DESC, name ASC`);
  return rows.map(shape);
}

export type BlockDraft = {
  id?: string;
  page: BlockPage;
  name: string;
  items: string[];
  columns?: number;
};

export type SaveResult =
  | { ok: true; block: TemplateBlock; created: boolean }
  | { ok: false; problem: string };

/**
 * Create a bucket, or change one.
 *
 * The items are checked against the page's registry, so a key nobody
 * registered is refused rather than rendered as a blank. An id is
 * minted from the name once and then never moves — layouts point at
 * it, and renaming a bucket must not orphan every account that placed
 * it.
 *
 * A built-in's item list and columns can be edited, which is the
 * point of a shared template; its page cannot, because a layout on
 * the old page would be pointing at a bucket that is no longer there.
 */
export async function saveBlock(draft: BlockDraft, by: string): Promise<SaveResult> {
  await ensure();
  if (!isBlockPage(draft.page)) return { ok: false, problem: "No such page." };
  const name = draft.name.trim().replace(/\s+/g, " ");
  if (name.length < 2) return { ok: false, problem: "A bucket needs a name." };
  if (name.length > 60) return { ok: false, problem: "That name is too long." };

  const known = new Set(itemsOn(draft.page).map((i) => i.key));
  const items = [...new Set(draft.items.map(String))].filter((k) => known.has(k));
  if (items.length === 0) {
    return { ok: false, problem: "Choose at least one field or piece of content." };
  }
  const columns = Math.min(Math.max(Number(draft.columns) || 3, 1), 3);

  if (draft.id) {
    const current = (await listBlocks()).find((b) => b.id === draft.id);
    if (!current) return { ok: false, problem: "That bucket no longer exists." };
    if (current.page !== draft.page) {
      return { ok: false, problem: "A bucket cannot be moved to another page." };
    }
    /*
     * An essential item cannot be edited out of the bucket that holds
     * it, because every account's page would lose it at once — and
     * the pages whose workflow depends on it would stop working
     * everywhere, with nobody having touched their own layout.
     */
    const lost = current.items.filter(
      (k) => itemOn(draft.page, k)?.essential && !items.includes(k));
    if (lost.length > 0) {
      return {
        ok: false,
        problem: `${lost.map((k) => itemOn(draft.page, k)?.label ?? k).join(", ")} cannot be `
          + "removed — the page's workflow depends on it.",
      };
    }
    const { rows } = await db().query<DbBlock>(
      `UPDATE dm_template_blocks SET name = $2, items = $3::jsonb, columns = $4
        WHERE id = $1 RETURNING ${B_COLS}`,
      [draft.id, name, JSON.stringify(items), columns]);
    return rows[0]
      ? { ok: true, block: shape(rows[0]), created: false }
      : { ok: false, problem: "That bucket no longer exists." };
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "bucket";
  const id = `blk_${slug}_${Date.now().toString(36)}`;
  const { rows } = await db().query<DbBlock>(
    `INSERT INTO dm_template_blocks (id, page, name, items, columns, builtin, created_by)
          VALUES ($1, $2, $3, $4::jsonb, $5, false, $6)
       RETURNING ${B_COLS}`,
    [id, draft.page, name, JSON.stringify(items), columns, by]);
  return { ok: true, block: shape(rows[0]!), created: true };
}

/**
 * Retire a bucket.
 *
 * Archived, never deleted. A layout row in some account still points
 * at it, and a dangling id would mean a page that fails to resolve
 * rather than a page with one fewer bucket. An archived bucket stops
 * being offered and stops rendering; bringing it back restores every
 * account's arrangement of it exactly as they left it.
 *
 * A built-in cannot be archived. The base layout is made of them, and
 * a page with no buckets left is a blank screen with no way back.
 */
export async function archiveBlock(
  id: string, archived: boolean,
): Promise<{ ok: boolean; problem?: string }> {
  await ensure();
  const block = (await listBlocks()).find((b) => b.id === id);
  if (!block) return { ok: false, problem: "That bucket no longer exists." };
  if (block.builtin && archived) {
    return { ok: false, problem: "A bucket the application ships with cannot be retired." };
  }
  await db().query(
    `UPDATE dm_template_blocks SET archived_at = ${archived ? "now()" : "NULL"}
      WHERE id = $1`, [id]);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Resolving a page
 * ------------------------------------------------------------------ */

type DbPlace = {
  block_id: string; position: number; width: number; height: string;
  hidden?: boolean; items?: unknown;
};

/**
 * What one account's page actually looks like.
 *
 * Base layout, then the account's overrides on top, resolved HERE
 * rather than copied at provisioning. Three consequences, and all
 * three are requirements:
 *
 *   An account that has never arranged this page follows the base,
 *   including a change made to the base tomorrow.
 *
 *   An account that HAS arranged it keeps its arrangement when the
 *   base changes.
 *
 *   A bucket added to the template later is available but not
 *   imposed: it appears for accounts on the base layout, and for
 *   accounts with their own layout only once they place it.
 */
export async function layoutFor(
  accountId: string, page: BlockPage,
): Promise<Placed[]> {
  await ensure();
  const blocks = (await listBlocks(page)).filter((b) => b.archivedAt === null);
  const byId = new Map(blocks.map((b) => [b.id, b]));

  const base = await db().query<DbPlace>(
    `SELECT block_id, position, width, height FROM dm_template_layout WHERE page = $1`,
    [page]);
  const mine = await db().query<DbPlace>(
    `SELECT block_id, position, width, height, hidden, items
       FROM dm_account_layout WHERE account_id = $1 AND page = $2`,
    [accountId, page]);

  const overrides = new Map(mine.rows.map((r) => [r.block_id, r]));
  const out: Placed[] = [];
  const seen = new Set<string>();

  const place = (block: TemplateBlock, from: DbPlace, overridden: boolean): void => {
    const own = overrides.get(block.id);
    // The account's own selection, when it made one. Filtered against
    // the registry and the bucket, so a field removed from the shared
    // bucket disappears for everybody rather than lingering in the
    // accounts that had picked it.
    const chosen = Array.isArray(own?.items)
      ? (own!.items as unknown[]).map(String).filter((k) => block.items.includes(k))
      : null;
    const essential = block.items.filter((k) => itemOn(page, k)?.essential);
    const items = chosen
      ? [...chosen, ...essential.filter((k) => !chosen.includes(k))]
      : block.items;
    out.push({
      ...block,
      items,
      position: from.position,
      width: isWidth(from.width) ? (Number(from.width) as Width) : 6,
      height: isHeight(from.height) ? from.height : "auto",
      // A bucket holding an essential item is never hidden, whatever
      // the row says. The rule is enforced on save too; this is the
      // belt to that brace, because a row can also arrive from a
      // restore, a copy, or a hand-edited database.
      hidden: own?.hidden === true && essential.length === 0,
      overridden,
    });
    seen.add(block.id);
  };

  for (const row of base.rows) {
    const block = byId.get(row.block_id);
    if (!block) continue;
    const own = overrides.get(row.block_id);
    place(block, own ?? row, Boolean(own));
  }
  // Buckets this account added that are not in the base layout.
  for (const row of mine.rows) {
    if (seen.has(row.block_id)) continue;
    const block = byId.get(row.block_id);
    if (block) place(block, row, true);
  }

  return out.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export type LayoutInput = {
  blockId: string;
  position?: number;
  width?: number;
  height?: string;
  hidden?: boolean;
  /** Null or absent means "whatever the template's bucket holds". */
  items?: string[] | null;
};

/**
 * Save one account's arrangement of one page.
 *
 * Whole-page rather than per-bucket, because that is what the editor
 * shows and reconciling a drag-and-drop into a stream of calls is how
 * a half-applied layout happens.
 *
 * Refused outright, never silently corrected:
 *   a bucket that is not on this page,
 *   hiding a bucket that holds an item the workflow depends on,
 *   an item selection that drops one of those items.
 * Silently fixing any of them would mean the editor says one thing
 * and the page does another.
 */
export async function saveLayout(
  accountId: string, page: BlockPage, rows: LayoutInput[], by: string,
): Promise<{ ok: true; layout: Placed[] } | { ok: false; problem: string }> {
  await ensure();
  const blocks = new Map(
    (await listBlocks(page)).filter((b) => b.archivedAt === null).map((b) => [b.id, b]));

  const prepared: {
    blockId: string; position: number; width: number; height: Height;
    hidden: boolean; items: string[] | null;
  }[] = [];

  let position = 0;
  for (const row of rows) {
    const block = blocks.get(String(row.blockId));
    if (!block) return { ok: false, problem: "That bucket is not on this page." };
    const essential = block.items.filter((k) => itemOn(page, k)?.essential);
    const hidden = row.hidden === true;
    if (hidden && essential.length > 0) {
      return {
        ok: false,
        problem: `“${block.name}” cannot be hidden — it holds `
          + `${essential.map((k) => itemOn(page, k)?.label ?? k).join(", ")}, which the `
          + "page's workflow depends on.",
      };
    }
    let items: string[] | null = null;
    if (Array.isArray(row.items)) {
      const chosen = [...new Set(row.items.map(String))].filter((k) => block.items.includes(k));
      const missing = essential.filter((k) => !chosen.includes(k));
      if (missing.length > 0) {
        return {
          ok: false,
          problem: `${missing.map((k) => itemOn(page, k)?.label ?? k).join(", ")} cannot be `
            + `taken off “${block.name}” — the page's workflow depends on it.`,
        };
      }
      // Null when it matches the bucket exactly, so an account that
      // merely reordered the page does not freeze its field list and
      // stop receiving fields added to the shared bucket later.
      const same = chosen.length === block.items.length
        && chosen.every((k, i) => k === block.items[i]);
      items = same ? null : chosen;
    }
    prepared.push({
      blockId: block.id,
      position: Number.isFinite(Number(row.position)) ? Number(row.position) : (position += 10),
      width: isWidth(row.width) ? Number(row.width) : 6,
      height: isHeight(row.height) ? row.height : "auto",
      hidden,
      items,
    });
  }
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM dm_account_layout WHERE account_id = $1 AND page = $2",
      [accountId, page]);
    for (const r of prepared) {
      await client.query(
        `INSERT INTO dm_account_layout
           (account_id, page, block_id, position, width, height, hidden, items, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [accountId, page, r.blockId, r.position, r.width, r.height, r.hidden,
          r.items === null ? null : JSON.stringify(r.items), by]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, layout: await layoutFor(accountId, page) };
}

/**
 * Put a page back to the base layout.
 *
 * Deleting the overrides rather than writing the base into them, so
 * the account goes back to FOLLOWING the base rather than to a copy
 * of what the base happens to say today.
 */
export async function resetLayout(
  accountId: string, page: BlockPage,
): Promise<Placed[]> {
  await ensure();
  await db().query(
    "DELETE FROM dm_account_layout WHERE account_id = $1 AND page = $2",
    [accountId, page]);
  return layoutFor(accountId, page);
}

/** Set the base layout itself. The account administrator's. */
export async function saveBaseLayout(
  page: BlockPage, rows: LayoutInput[],
): Promise<{ ok: true } | { ok: false; problem: string }> {
  await ensure();
  const blocks = new Map(
    (await listBlocks(page)).filter((b) => b.archivedAt === null).map((b) => [b.id, b]));
  const prepared: { blockId: string; position: number; width: number; height: Height }[] = [];
  let position = 0;
  for (const row of rows) {
    const block = blocks.get(String(row.blockId));
    if (!block) return { ok: false, problem: "That bucket is not on this page." };
    prepared.push({
      blockId: block.id,
      position: Number.isFinite(Number(row.position)) ? Number(row.position) : (position += 10),
      width: isWidth(row.width) ? Number(row.width) : 6,
      height: isHeight(row.height) ? row.height : "auto",
    });
  }
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM dm_template_layout WHERE page = $1", [page]);
    for (const r of prepared) {
      await client.query(
        `INSERT INTO dm_template_layout (page, block_id, position, width, height)
              VALUES ($1, $2, $3, $4, $5)`,
        [page, r.blockId, r.position, r.width, r.height]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { ok: true };
}

/** Which accounts have arranged a page for themselves. For the template editor. */
export async function accountsArranging(page: BlockPage): Promise<string[]> {
  await ensure();
  const { rows } = await db().query<{ account_id: string }>(
    "SELECT DISTINCT account_id FROM dm_account_layout WHERE page = $1", [page]);
  return rows.map((r) => r.account_id);
}

/** Drop a removed account's arrangements. */
export async function forgetLayouts(accountId: string): Promise<void> {
  await ensure();
  await db().query("DELETE FROM dm_account_layout WHERE account_id = $1", [accountId]);
}

/** The first account, for a caller that has no request to read one from. */
export const DEFAULT_LAYOUT_ACCOUNT = DUTCH_MILLER;
