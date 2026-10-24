/**
 * Who may open what inside Dutch Miller.
 *
 *   pnpm exec tsx scripts/test-dm-users.ts
 *
 * Two rules here can lock a person out of the only page that could let
 * them back in, so both are tested from the outside rather than read:
 *
 *   - an EMPTY table makes everyone an administrator, and the first row
 *     closes that. Get the second half wrong and the permission list is
 *     decoration — everybody stays an admin forever.
 *   - the LAST administrator cannot be removed. Get that wrong and the
 *     table is non-empty with nobody able to edit it, which no amount of
 *     signing in again will fix.
 *
 * The table is shared, so this refuses to run against one that already
 * holds rows rather than deleting somebody's configuration.
 */
import {
  DM_PAGE_KEYS, dmAccessFor, listDmUsers, removeDmUser, saveDmUser,
} from "../server/dutch-miller/users.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const BOSS = "boss@example.invalid";
const HAND = "hand@example.invalid";
const PAGE = DM_PAGE_KEYS[0]!;

try {
  // `dmAccessFor` answers from whether the table is empty, so a leftover
  // row would make the first section test the opposite of what it says.
  const existing = await listDmUsers();
  if (existing.length > 0) {
    console.log(`SKIP — dm_users already holds ${existing.length} row(s); not touching them.`);
    process.exit(0);
  }

  console.log("1. Nobody set up yet");
  const open = await dmAccessFor("anyone@example.invalid");
  check("everyone is an administrator", open.role === "admin");
  check("…with every page", open.pages.length === DM_PAGE_KEYS.length);
  check("…and it says so, rather than looking configured", open.unconfigured === true);

  console.log("\n2. The first row closes it");
  await saveDmUser(BOSS, "admin", [], "setup@example.invalid");
  const after = await dmAccessFor("anyone@example.invalid");
  check("a stranger is no longer an administrator", after.role === "user", after.role);
  check("…and has no pages", after.pages.length === 0);
  check("…and the table is no longer unconfigured", after.unconfigured === false);
  const boss = await dmAccessFor(BOSS);
  check("the administrator still has every page", boss.pages.length === DM_PAGE_KEYS.length);

  console.log("\n3. A general user gets what they were given");
  await saveDmUser(HAND, "user", [PAGE], BOSS);
  const hand = await dmAccessFor(HAND);
  check("the page they were given", hand.pages.includes(PAGE), hand.pages.join(","));
  check("…and not the administrator role", hand.role === "user");
  check("case in the address does not matter",
    (await dmAccessFor(HAND.toUpperCase())).pages.includes(PAGE));

  console.log("\n4. A page key that does not exist is dropped, not stored");
  await saveDmUser(HAND, "user", ["not-a-page", PAGE] as never, BOSS);
  const cleaned = await dmAccessFor(HAND);
  check("only the real page survives", cleaned.pages.join(",") === PAGE, cleaned.pages.join(","));

  console.log("\n5. Taking a page away actually takes it away");
  await saveDmUser(HAND, "user", [], BOSS);
  check("no pages left", (await dmAccessFor(HAND)).pages.length === 0);

  console.log("\n6. The last administrator stays");
  const lone = await removeDmUser(BOSS);
  check("removing the only administrator is refused", lone.ok === false);
  check("…with a reason that says why", /only administrator/i.test(lone.reason ?? ""),
    lone.reason ?? "");
  check("…and they are still there",
    (await listDmUsers()).some((u) => u.email === BOSS && u.role === "admin"));

  console.log("\n7. …once there are two, either can go");
  await saveDmUser(HAND, "admin", [], BOSS);
  check("the second administrator can be removed", (await removeDmUser(HAND)).ok === true);
  check("…and is gone", (await listDmUsers()).every((u) => u.email !== HAND));
  check("removing somebody who is not there is not an error",
    (await removeDmUser("ghost@example.invalid")).ok === true);

  console.log("\n8. An address that is not one");
  let refused = false;
  try { await saveDmUser("not an email", "user", [], BOSS); } catch { refused = true; }
  check("is refused", refused);
} finally {
  await db().query("DELETE FROM dm_users WHERE email = ANY($1::text[])",
    [[BOSS, HAND]]).catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
