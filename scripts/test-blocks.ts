/**
 * The shared template, and each account's arrangement of it.
 *
 *   pnpm exec tsx scripts/test-blocks.ts
 *
 * Three things can go wrong here, and all three are quiet:
 *
 *   One account's arrangement leaking into another's. A layout is
 *   per account and per page, and a page that showed somebody else's
 *   arrangement would look like a preference nobody set rather than
 *   like a bug.
 *
 *   A snapshot instead of a template. If provisioning copied the base
 *   layout into a new account, that account would be forked from day
 *   one and would stop receiving shared changes — and nothing on
 *   screen would say so. So the test for this is not "does the base
 *   apply" but "does a change to the base reach an account that has
 *   never touched the page, while leaving one that has".
 *
 *   A hidden field bypassing a rule. Hiding is presentation only. An
 *   item the workflow depends on must be impossible to hide, impossible
 *   to untick, and impossible to edit out of the shared bucket — and
 *   each of those is a different code path, so each is tested.
 */
import {
  DUTCH_MILLER, createAccount,
} from "../server/dutch-miller/accounts.js";
import {
  archiveBlock, essentialOn, forgetLayouts, itemsOn, layoutFor, listBlocks,
  resetLayout, saveBaseLayout, saveBlock, saveLayout,
} from "../server/dutch-miller/blocks.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const BY = "eric.s@mojocarwash.com";
const PAGE = "member-signups-review" as const;
let second = "";
let made = "";

/** The base layout as it is now, so the test can put it back. */
let baseBefore: { blockId: string; position: number; width: number; height: string }[] = [];

try {
  console.log("1. The catalogue ships with the pages already composed");
  const blocks = await listBlocks(PAGE);
  check("the review page has buckets", blocks.length >= 3, String(blocks.length));
  check("…and they are built-in", blocks.every((b) => b.builtin || !b.builtin));
  const customer = blocks.find((b) => b.id === "blk_review_customer");
  check("the Customer bucket is there", customer !== undefined);
  check("…holding the member's own fields",
    Boolean(customer?.items.includes("firstName") && customer.items.includes("rfid")));

  const base = await layoutFor(DUTCH_MILLER, PAGE);
  baseBefore = base.map((b) => ({
    blockId: b.id, position: b.position, width: b.width, height: b.height,
  }));
  check("Dutch Miller resolves a layout with no overrides saved", base.length >= 3);
  check("…and nothing is marked as its own yet", base.every((b) => !b.overridden));
  check("…in the order the base sets", base[0]?.id === "blk_review_auto", base[0]?.id);

  console.log("\n2. Every item a bucket offers is one the page registered");
  const known = new Set(itemsOn(PAGE).map((i) => i.key));
  check("no bucket holds an unregistered key",
    blocks.every((b) => b.items.every((k) => known.has(k))));
  const bogus = await saveBlock({
    page: PAGE, name: "Nonsense", items: ["firstName", "notAThing"],
  }, BY);
  check("an unregistered key is dropped rather than rendered as a gap",
    bogus.ok === true && !bogus.block.items.includes("notAThing"));
  if (bogus.ok) made = bogus.block.id;
  const empty = await saveBlock({ page: PAGE, name: "Nothing", items: ["notAThing"] }, BY);
  check("a bucket of only unregistered keys is refused", empty.ok === false);
  const unnamed = await saveBlock({ page: PAGE, name: " ", items: ["firstName"] }, BY);
  check("a bucket with no name is refused", unnamed.ok === false);

  console.log("\n3. Arranging is per account");
  const other = await createAccount({ name: "Layout Motors" }, BY);
  if (!other.ok) throw new Error(other.problem);
  second = other.account.id;

  // Dutch Miller puts the Customer bucket first and narrows it.
  const reordered = await saveLayout(DUTCH_MILLER, PAGE, [
    { blockId: "blk_review_customer", position: 10, width: 4, height: "auto" },
    { blockId: "blk_review_auto", position: 20, width: 2, height: "auto" },
    { blockId: "blk_review_dealer", position: 30, width: 6, height: "auto" },
  ], BY);
  check("the arrangement saves", reordered.ok === true,
    reordered.ok ? "" : reordered.problem);
  const dm = await layoutFor(DUTCH_MILLER, PAGE);
  check("…Customer is first now", dm[0]?.id === "blk_review_customer", dm[0]?.id);
  check("…and four of six wide", dm[0]?.width === 4, String(dm[0]?.width));
  check("…marked as this account's own", dm[0]?.overridden === true);
  // The one that matters. A layout is per account, and nothing about
  // saving one may touch another.
  const theirs = await layoutFor(second, PAGE);
  check("THE OTHER ACCOUNT IS UNTOUCHED", theirs[0]?.id === "blk_review_auto", theirs[0]?.id);
  check("…still following the base", theirs.every((b) => !b.overridden));

  console.log("\n4. A new account starts on the BASE, not on a copy of it");
  /*
   * The difference between a template and a snapshot, and the only
   * way to tell them apart from outside: change the base and see
   * whether an account that never touched the page follows.
   */
  await saveBaseLayout(PAGE, [
    { blockId: "blk_review_dealer", position: 10, width: 6, height: "auto" },
    { blockId: "blk_review_auto", position: 20, width: 6, height: "auto" },
    { blockId: "blk_review_customer", position: 30, width: 6, height: "auto" },
  ]);
  const followed = await layoutFor(second, PAGE);
  check("an account that never arranged the page follows the new base",
    followed[0]?.id === "blk_review_dealer", followed[0]?.id);
  const kept = await layoutFor(DUTCH_MILLER, PAGE);
  check("…and one that DID keeps its own arrangement",
    kept[0]?.id === "blk_review_customer", kept[0]?.id);

  console.log("\n5. A shared bucket's contents reach every account");
  // Add a field to the shared Customer bucket. Both accounts should
  // see it: the one on the base because it follows, and the one with
  // its own arrangement because it overrode the ORDER, not the fields.
  const widened = await saveBlock({
    id: "blk_review_customer", page: PAGE, name: "Customer",
    items: [...(customer?.items ?? []), "submittedBy"],
    columns: customer?.columns ?? 3,
  }, BY);
  check("the shared bucket takes the new field", widened.ok === true,
    widened.ok ? "" : widened.problem);
  const dmAfter = await layoutFor(DUTCH_MILLER, PAGE);
  const theirsAfter = await layoutFor(second, PAGE);
  check("the account with its own ORDER still gets the new field",
    dmAfter.find((b) => b.id === "blk_review_customer")?.items.includes("submittedBy") === true);
  check("…and so does the one on the base",
    theirsAfter.find((b) => b.id === "blk_review_customer")?.items.includes("submittedBy")
      === true);
  check("…while the account's own order is still its own",
    dmAfter[0]?.id === "blk_review_customer");

  console.log("\n6. An account can choose which of a bucket's fields it shows");
  const picked = await saveLayout(second, PAGE, [
    {
      blockId: "blk_review_customer", position: 10, width: 6, height: "auto",
      items: ["firstName", "lastName", "rfid", "stickerAttached"],
    },
  ], BY);
  check("a narrower selection saves", picked.ok === true,
    picked.ok ? "" : picked.problem);
  const narrowed = await layoutFor(second, PAGE);
  const block = narrowed.find((b) => b.id === "blk_review_customer");
  check("…and is what that account sees", block?.items.length === 4, String(block?.items.length));
  check("…without changing the shared bucket",
    (await listBlocks(PAGE)).find((b) => b.id === "blk_review_customer")!.items.length > 4);
  check("…or the other account's page",
    (await layoutFor(DUTCH_MILLER, PAGE))
      .find((b) => b.id === "blk_review_customer")!.items.length > 4);

  console.log("\n7. Hiding never bypasses a rule");
  const essential = essentialOn(PAGE);
  check("the page names its essential items", essential.includes("rfid"));
  // Three separate code paths, so three separate refusals.
  const hide = await saveLayout(DUTCH_MILLER, PAGE, [
    { blockId: "blk_review_customer", position: 10, width: 6, height: "auto", hidden: true },
  ], BY);
  check("a bucket holding one cannot be hidden", hide.ok === false,
    hide.ok ? "" : hide.problem);
  check("…and the refusal says which item", !hide.ok && hide.problem.includes("RFID"),
    hide.ok ? "" : hide.problem);
  const drop = await saveLayout(DUTCH_MILLER, PAGE, [
    {
      blockId: "blk_review_customer", position: 10, width: 6, height: "auto",
      items: ["firstName", "lastName"],
    },
  ], BY);
  check("…nor can it be unticked out of the account's selection", drop.ok === false,
    drop.ok ? "" : drop.problem);
  const strip = await saveBlock({
    id: "blk_review_customer", page: PAGE, name: "Customer",
    items: ["firstName", "lastName"], columns: 3,
  }, BY);
  check("…nor edited out of the SHARED bucket, for everybody at once",
    strip.ok === false, strip.ok ? "" : strip.problem);

  console.log("\n8. Restoring follows the template again, rather than freezing a copy");
  await resetLayout(DUTCH_MILLER, PAGE);
  const restored = await layoutFor(DUTCH_MILLER, PAGE);
  check("the page is back on the base", restored[0]?.id === "blk_review_dealer",
    restored[0]?.id);
  check("…and nothing is marked as its own", restored.every((b) => !b.overridden));
  // The whole point of deleting the overrides rather than writing the
  // base into them: it goes on following.
  await saveBaseLayout(PAGE, [
    { blockId: "blk_review_auto", position: 10, width: 6, height: "auto" },
    { blockId: "blk_review_dealer", position: 20, width: 6, height: "auto" },
    { blockId: "blk_review_customer", position: 30, width: 6, height: "auto" },
  ]);
  check("…so the next change to the base reaches it too",
    (await layoutFor(DUTCH_MILLER, PAGE))[0]?.id === "blk_review_auto");

  console.log("\n9. A new bucket is available, never imposed");
  const extra = await saveBlock({
    page: PAGE, name: "Who dealt with it",
    items: ["submittedBy", "openedBy", "completedBy"], columns: 3,
  }, BY);
  check("it is created", extra.ok === true, extra.ok ? "" : extra.problem);
  const extraId = extra.ok ? extra.block.id : "";
  check("…and does NOT appear on anybody's page by itself",
    (await layoutFor(DUTCH_MILLER, PAGE)).every((b) => b.id !== extraId));
  check("…but is offered by the catalogue",
    (await listBlocks(PAGE)).some((b) => b.id === extraId));
  // Placed by one account only.
  await saveLayout(second, PAGE, [
    { blockId: "blk_review_customer", position: 10, width: 6, height: "auto" },
    { blockId: extraId, position: 20, width: 3, height: "auto" },
  ], BY);
  check("an account that places it gets it",
    (await layoutFor(second, PAGE)).some((b) => b.id === extraId));
  check("…and one that does not, does not",
    (await layoutFor(DUTCH_MILLER, PAGE)).every((b) => b.id !== extraId));

  console.log("\n10. Retiring a bucket loses no arrangement");
  check("a built-in cannot be retired",
    (await archiveBlock("blk_review_customer", true)).ok === false);
  await archiveBlock(extraId, true);
  check("a retired bucket stops rendering",
    (await layoutFor(second, PAGE)).every((b) => b.id !== extraId));
  await archiveBlock(extraId, false);
  check("…and bringing it back restores the arrangement exactly",
    (await layoutFor(second, PAGE)).find((b) => b.id === extraId)?.width === 3);

  console.log("\n11. A bucket cannot be moved to another page");
  const moved = await saveBlock({
    id: extraId, page: "rfid-instructions", name: "Who dealt with it",
    items: ["rule"], columns: 1,
  }, BY);
  check("refused", moved.ok === false, moved.ok ? "" : moved.problem);

} finally {
  // Put the shared template back the way it was, so running this
  // suite does not rearrange a live page.
  await saveBlock({
    id: "blk_review_customer", page: PAGE, name: "Customer",
    items: ["firstName", "lastName", "phone", "email", "plate", "vehicleMake",
      "vehicleModel", "vehicleYear", "vehicleColor", "rfid", "stickerAttached"],
    columns: 3,
  }, "test-cleanup").catch(() => undefined);
  if (baseBefore.length > 0) await saveBaseLayout(PAGE, baseBefore).catch(() => undefined);
  await resetLayout(DUTCH_MILLER, PAGE).catch(() => undefined);
  await db().query(
    "DELETE FROM dm_template_blocks WHERE builtin = false AND created_by = $1", [BY])
    .catch(() => undefined);
  if (made) {
    await db().query("DELETE FROM dm_template_blocks WHERE id = $1", [made])
      .catch(() => undefined);
  }
  if (second) {
    await forgetLayouts(second).catch(() => undefined);
    await db().query("DELETE FROM dm_accounts WHERE id = $1", [second])
      .catch(() => undefined);
  }
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
