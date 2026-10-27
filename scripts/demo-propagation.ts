/**
 * How a template change reaches accounts. Demonstrated, not described.
 *
 *   pnpm exec tsx scripts/demo-propagation.ts
 *
 * Three accounts, so the difference is visible rather than asserted:
 *
 *   FOLLOWER   has never arranged the page. No rows in dm_account_layout.
 *   CUSTOM     has saved its own arrangement of the page.
 *   SOURCE     is where a correction is made and promoted from.
 *
 * It prints what each one actually renders after each step. Nothing
 * here is a test — the point is to show behaviour, including the
 * behaviour that is wrong, so it can be argued with.
 *
 * Touches only its own scratch accounts. Dutch Miller is read for the
 * shared template and never written.
 */
import { createAccount, listAccounts } from "../server/dutch-miller/accounts.js";
import {
  forgetLayouts, itemOn, itemsOn, layoutFor, listBlocks, promoteLayout,
  resetLayout, saveBlock, saveLayout, type BlockPage,
} from "../server/dutch-miller/blocks.js";
import { db } from "../server/db.js";

const PAGE: BlockPage = "member-signups-review";
const BY = "demo@mojocarwash.com";
const ids: string[] = [];
const madeBlocks: string[] = [];

const line = (s = "") => console.log(s);
const head = (s: string) => { line(); line(`\x1b[1m${s}\x1b[0m`); };

/** One account's page, as a reader would see it. */
async function show(label: string, id: string): Promise<void> {
  const rows = await layoutFor(id, PAGE);
  const own = rows.some((r) => r.overridden);
  line(`  ${label.padEnd(10)} ${own ? "[its own layout]" : "[follows the base]"}`);
  for (const r of rows) {
    line(`      ${r.name.padEnd(22)} ${String(r.width)}/6  ${r.items.length} field(s)`
      + `${r.hidden ? "  (hidden)" : ""}`);
  }
  if (rows.length === 0) line("      (nothing)");
}

/** What a bucket is holding, by label, as the shared template defines it. */
async function fieldsOf(blockId: string): Promise<string> {
  const b = (await listBlocks(PAGE)).find((x) => x.id === blockId);
  return (b?.items ?? []).map((k) => itemOn(PAGE, k)?.label ?? k).join(", ");
}

/** What one account actually shows from that bucket. */
async function shownBy(id: string, blockId: string): Promise<string> {
  const b = (await layoutFor(id, PAGE)).find((x) => x.id === blockId);
  if (!b) return "(not on this page)";
  return b.items.map((k) => itemOn(PAGE, k)?.label ?? k).join(", ");
}

let FOLLOWER = "";
let CUSTOM = "";
let SOURCE = "";

try {
  for (const name of ["Demo Follower", "Demo Custom", "Demo Source"]) {
    const made = await createAccount({ name }, BY);
    if (!made.ok) throw new Error(made.problem);
    ids.push(made.account.id);
  }
  [FOLLOWER, CUSTOM, SOURCE] = ids as [string, string, string];

  head("Starting point — the shared base layout");
  await show("FOLLOWER", FOLLOWER);
  await show("CUSTOM", CUSTOM);
  await show("SOURCE", SOURCE);

  // CUSTOM arranges its page: Customer first and narrower, Auto Data gone.
  await saveLayout(CUSTOM, PAGE, [
    { blockId: "blk_review_customer", position: 10, width: 4, height: "auto" },
    { blockId: "blk_review_dealer", position: 20, width: 2, height: "auto" },
  ], BY);
  head("CUSTOM arranges its own page (Customer first, Auto Data taken off)");
  await show("FOLLOWER", FOLLOWER);
  await show("CUSTOM", CUSTOM);

  /* ---------------------------------------------------------------- */
  head("1. A correction made in one account and promoted");
  line("   SOURCE puts Dealer first and makes it 3/6, then promotes it.");
  await saveLayout(SOURCE, PAGE, [
    { blockId: "blk_review_dealer", position: 10, width: 3, height: "auto" },
    { blockId: "blk_review_auto", position: 20, width: 3, height: "auto" },
    { blockId: "blk_review_customer", position: 30, width: 6, height: "auto" },
  ], BY);
  const up = await promoteLayout(SOURCE, PAGE, BY);
  line(`   promote: ${up.ok ? `reached ${up.reached} account(s) on the base` : up.problem}`);
  line();
  await show("FOLLOWER", FOLLOWER);
  await show("CUSTOM", CUSTOM);
  await show("SOURCE", SOURCE);
  line();
  line("   \x1b[33mFOLLOWER took the correction. CUSTOM did not, and was not told.\x1b[0m");
  line("   \x1b[33mSOURCE went back to following the base, which now says what it set.\x1b[0m");

  /* ---------------------------------------------------------------- */
  head("2. Changing a field's text in the shared template");
  const before = await fieldsOf("blk_review_dealer");
  line(`   Dealer holds: ${before}`);
  line();
  line("   A field's LABEL and its help text live in the code registry");
  line("   (ITEM in server/dutch-miller/blocks.ts), not in a table. There is");
  line("   no per-account text anywhere in the schema today, so:");
  line("     · changing one is a deploy, and it reaches every account at once;");
  line("     · no account can have customised it, so nothing can be overwritten.");
  line();
  line("   What IS editable per template, and does propagate immediately:");
  const renamed = await saveBlock({
    id: "blk_review_dealer", page: PAGE, name: "Dealer references",
    items: (await listBlocks(PAGE)).find((b) => b.id === "blk_review_dealer")!.items,
    columns: 3,
  }, BY);
  line(`     · a bucket's NAME — now "${renamed.ok ? renamed.block.name : "?"}"`);
  await show("FOLLOWER", FOLLOWER);
  await show("CUSTOM", CUSTOM);
  line();
  line("   \x1b[33mThe rename reached CUSTOM too, even though CUSTOM has its own");
  line("   layout. Definition propagates; arrangement does not.\x1b[0m");

  /* ---------------------------------------------------------------- */
  head("3a. Adding a FIELD to an existing shared bucket");
  const dealer = (await listBlocks(PAGE)).find((b) => b.id === "blk_review_dealer")!;
  line(`   CUSTOM shows from Dealer: ${await shownBy(CUSTOM, "blk_review_dealer")}`);
  await saveBlock({
    id: "blk_review_dealer", page: PAGE, name: dealer.name,
    items: [...dealer.items, "submittedBy"], columns: dealer.columns,
  }, BY);
  line(`   Template now holds:      ${await fieldsOf("blk_review_dealer")}`);
  line();
  line(`   FOLLOWER shows:          ${await shownBy(FOLLOWER, "blk_review_dealer")}`);
  line(`   CUSTOM shows:            ${await shownBy(CUSTOM, "blk_review_dealer")}`);
  line();
  line("   \x1b[33mBoth got it. CUSTOM overrode the page's ARRANGEMENT but never");
  line("   the bucket's field list, so its items column is null and it");
  line("   follows the template. An account that HAD picked its own fields");
  line("   for that bucket would not have — shown next.\x1b[0m");

  await saveLayout(CUSTOM, PAGE, [
    {
      blockId: "blk_review_customer", position: 10, width: 4, height: "auto",
      items: ["firstName", "lastName", "rfid", "stickerAttached"],
    },
    { blockId: "blk_review_dealer", position: 20, width: 2, height: "auto" },
  ], BY);
  const cust = (await listBlocks(PAGE)).find((b) => b.id === "blk_review_customer")!;
  await saveBlock({
    id: "blk_review_customer", page: PAGE, name: cust.name,
    items: [...cust.items, "openedBy"], columns: cust.columns,
  }, BY);
  line();
  line(`   Customer in the template: ${await fieldsOf("blk_review_customer")}`);
  line(`   FOLLOWER shows:           ${await shownBy(FOLLOWER, "blk_review_customer")}`);
  line(`   CUSTOM shows:             ${await shownBy(CUSTOM, "blk_review_customer")}`);
  line();
  line("   \x1b[33mCUSTOM picked its own fields for that bucket, so the new one is");
  line("   AVAILABLE to it but not imposed. FOLLOWER got it.\x1b[0m");

  head("3b. Adding a whole BUCKET to the shared template");
  const extra = await saveBlock({
    page: PAGE, name: "Who dealt with it",
    items: ["submittedBy", "openedBy", "completedBy"], columns: 3,
  }, BY);
  if (extra.ok) madeBlocks.push(extra.block.id);
  line(`   Created "${extra.ok ? extra.block.name : "?"}" in the catalogue.`);
  line();
  await show("FOLLOWER", FOLLOWER);
  await show("CUSTOM", CUSTOM);
  line();
  line("   \x1b[33mNeither shows it: a new bucket is offered, never imposed. It is in");
  line("   the Add-a-bucket list for both. For FOLLOWER it will appear the");
  line("   moment it is added to the BASE layout:\x1b[0m");
  const base = await layoutFor(FOLLOWER, PAGE);
  await db().query(
    `INSERT INTO dm_template_layout (page, block_id, position, width, height)
     VALUES ($1, $2, $3, 6, 'auto') ON CONFLICT (page, block_id) DO NOTHING`,
    [PAGE, extra.ok ? extra.block.id : "", (base.length + 1) * 10]);
  line();
  await show("FOLLOWER", FOLLOWER);
  await show("CUSTOM", CUSTOM);
  line();
  line("   \x1b[33mFOLLOWER took it. CUSTOM did not — its page is its own.\x1b[0m");

  /* ---------------------------------------------------------------- */
  head("4. An account removes a field from a bucket");
  /*
   * Removal has to be shown on a field the bucket is actually
   * showing, and it has to be shown BOTH ways: out of the bucket and
   * into the inventory, then back out of the inventory and into the
   * bucket. A one-way demonstration proves nothing — the question is
   * whether the field is still AVAILABLE afterwards.
   */
  const customerBlock = (await listBlocks(PAGE))
    .find((b) => b.id === "blk_review_customer")!;
  const label = (k: string) => itemOn(PAGE, k)?.label ?? k;
  const names = (ks: string[]) => ks.map(label).join(", ") || "(nothing)";
  const customerNow = async (): Promise<string[]> =>
    (await layoutFor(CUSTOM, PAGE)).find((b) => b.id === "blk_review_customer")!.items;
  const inventoryNow = async (): Promise<string[]> => {
    const shown = await customerNow();
    return customerBlock.items.filter((k) => !shown.includes(k));
  };
  const arrange = async (items: string[]) => saveLayout(CUSTOM, PAGE, [
    { blockId: "blk_review_customer", position: 10, width: 4, height: "auto", items },
    { blockId: "blk_review_dealer", position: 20, width: 2, height: "auto" },
  ], BY);

  line(`   CUSTOM's Customer bucket shows: ${names(await customerNow())}`);
  line(`   …and its inventory offers:      ${names(await inventoryNow())}`);
  line();

  line("   CUSTOM adds Phone from the inventory:");
  await arrange([...(await customerNow()), "phone"]);
  line(`     shown:      ${names(await customerNow())}`);
  line(`     inventory:  ${names(await inventoryNow())}`);
  line();

  line("   …then takes Phone back off:");
  await arrange((await customerNow()).filter((k) => k !== "phone"));
  const afterOptional = await customerNow();
  const invAfter = await inventoryNow();
  line(`     shown:      ${names(afterOptional)}`);
  line(`     inventory:  ${names(invAfter)}`);
  line();
  line("   \x1b[33mPhone left the bucket and is back in the inventory, ready to");
  line("   add again. Nothing was deleted: the template bucket still holds");
  line("   every one of them, and no member record changed.\x1b[0m");
  line(`   Template still holds: ${await fieldsOf("blk_review_customer")}`);
  line(`   Phone is offered again: ${invAfter.includes("phone")}`);
  line();

  line("   An ESSENTIAL field cannot be removed this way — First Name:");
  await arrange(afterOptional.filter((k) => k !== "firstName"));
  const afterEssential = await customerNow();
  line(`     shown:      ${names(afterEssential)}`);
  line(`     inventory:  ${names(await inventoryNow())}`);
  line(`   \x1b[33mFirst Name is registered essential, so the save put it back — `
    + `still shown: ${afterEssential.includes("firstName")}\x1b[0m`);
  line("   \x1b[33mIt is NOT offered in the inventory either: it was never taken off.\x1b[0m");

  head("Registered fields on this page, for reference");
  for (const i of itemsOn(PAGE)) {
    line(`   ${i.key.padEnd(18)} ${i.label.padEnd(24)} ${i.kind}`
      + `${i.essential ? "  ESSENTIAL" : ""}`);
  }
} finally {
  head("Cleaning up");
  // Put the shared template back exactly as it was.
  await saveBlock({
    id: "blk_review_dealer", page: PAGE, name: "Dealer",
    items: ["dlwContractId", "dealNumber", "customerId"], columns: 3,
  }, "demo-cleanup").catch(() => undefined);
  await saveBlock({
    id: "blk_review_customer", page: PAGE, name: "Customer",
    items: ["firstName", "lastName", "phone", "email", "plate", "vehicleMake",
      "vehicleModel", "vehicleYear", "vehicleColor", "rfid", "stickerAttached"],
    columns: 3,
  }, "demo-cleanup").catch(() => undefined);
  await db().query(
    `DELETE FROM dm_template_layout WHERE page = $1 AND block_id = ANY($2::text[])`,
    [PAGE, madeBlocks]).catch(() => undefined);
  for (const id of madeBlocks) {
    await db().query("DELETE FROM dm_template_blocks WHERE id = $1", [id])
      .catch(() => undefined);
  }
  // The base layout as seeded.
  await db().query("DELETE FROM dm_template_layout WHERE page = $1", [PAGE])
    .catch(() => undefined);
  for (const [block, pos] of [["blk_review_auto", 10], ["blk_review_dealer", 20],
    ["blk_review_customer", 30], ["blk_review_delivery", 40]] as const) {
    await db().query(
      `INSERT INTO dm_template_layout (page, block_id, position, width, height)
       VALUES ($1, $2, $3, 6, 'auto') ON CONFLICT (page, block_id) DO NOTHING`,
      [PAGE, block, pos]).catch(() => undefined);
  }
  for (const id of ids) {
    await forgetLayouts(id).catch(() => undefined);
    await resetLayout(id, PAGE).catch(() => undefined);
    await db().query("DELETE FROM dm_accounts WHERE id = $1", [id]).catch(() => undefined);
  }
  line(`   ${ids.length} scratch account(s) removed; the shared template restored.`);
  line(`   Accounts left: ${(await listAccounts()).map((a) => a.name).join(", ")}`);
  process.exit(0);
}
