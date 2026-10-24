/**
 * Who may open what inside Dutch Miller, and who may change it.
 *
 *   pnpm exec tsx scripts/test-dm-users.ts
 *
 * Three rules here are the difference between a permission system and a
 * label, and each has a way of failing quietly:
 *
 *   Only a SUPER admin can make somebody an admin. If an admin can, an
 *   admin can promote themselves and the two levels are the same level.
 *   Super is pinned by configuration, so it cannot be granted, edited or
 *   deleted through the app and nobody can lock the owner out.
 *
 *   An account that is invited-but-not-set-up, or disabled, has NOTHING.
 *   Getting that wrong means an invite is itself access, before anybody
 *   has proved they can read the address it went to.
 *
 *   Disabling raises the revocation counter. Without it "revoked" means
 *   "revoked within eight hours", which is not what anybody thinks the
 *   button does.
 *
 * The table is shared, so this refuses to run against one holding rows it
 * did not create rather than deleting somebody's configuration.
 */
import {
  DM_PAGE_KEYS, dmAccessFor, getDmUser, isStaff, isSuperEmail, listDmUsers,
  removeDmUser, revokeDmSessions, saveDmUser, setDmUserEnabled, activateDmUser,
} from "../server/dutch-miller/users.js";
import { ADMIN_ROLE, DEFAULT_ROLE, saveRole } from "../server/dutch-miller/roles.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const BOSS = "boss@example.invalid";
const HAND = "hand@example.invalid";
const DEALER = "dealer@dutchmiller.example";
const PAGE = DM_PAGE_KEYS[0]!;
const MINE = [BOSS, HAND, DEALER];

/** The pinned super admin, for this run. */
process.env.DM_SUPER_ADMINS = "owner@example.invalid";
const OWNER = "owner@example.invalid";

const refused = async (what: string, fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return ""; } catch (e) { return (e as Error).message; }
};

try {
  const existing = await listDmUsers();
  const strangers = existing.filter((u) => !MINE.includes(u.email));
  if (strangers.length > 0) {
    console.log(`SKIP — dm_users holds ${strangers.length} row(s) this test did not make.`);
    process.exit(0);
  }

  console.log("1. Super is pinned, not stored");
  check("the pinned address is super", isSuperEmail(OWNER));
  const owner = await dmAccessFor(OWNER);
  check("…with every page and no row at all", owner.role === "super" && owner.pinned);
  check("…and all pages", owner.pages.length === DM_PAGE_KEYS.length);
  check("a stranger is nobody", (await dmAccessFor("nobody@example.invalid")).pages.length === 0);
  check("…which is the point: there is no empty-table free-for-all",
    (await dmAccessFor("nobody@example.invalid")).role === "user");
  check("the pinned account cannot be written over",
    (await refused("save super", () => saveDmUser({ email: OWNER, roleKey: ADMIN_ROLE, by: OWNER, byRole: "super" }))).includes("super administrator"));
  check("…nor removed", (await removeDmUser(OWNER, "super")).ok === false);

  console.log("\n1b. An ordinary admin cannot touch the super admin");
  // Not merely hidden in the UI: an admin session that asked directly
  // has to be refused, and the pinned account has to survive it.
  check("an admin cannot edit the super admin",
    (await refused("edit super", () => saveDmUser({
      email: OWNER, roleKey: DEFAULT_ROLE, by: BOSS, byRole: "admin",
    }))).includes("super administrator"));
  check("an admin cannot remove the super admin",
    (await removeDmUser(OWNER, "admin")).ok === false);
  check("an admin cannot switch the super admin off",
    (await setDmUserEnabled(OWNER, false, BOSS, "admin")).ok === false);
  check("…and a SUPER admin cannot either — it is configuration, not a row",
    (await setDmUserEnabled(OWNER, false, OWNER, "super")).ok === false);
  check("…so they still hold everything",
    (await dmAccessFor(OWNER)).pages.length === DM_PAGE_KEYS.length);

  console.log("\n2. Only super can make an admin");
  const asAdmin = await refused("promote", () => saveDmUser({ email: BOSS, roleKey: ADMIN_ROLE, by: HAND, byRole: "admin" }));
  check("an admin cannot promote anybody", asAdmin.includes("super administrator"), asAdmin);
  await saveDmUser({ email: BOSS, roleKey: ADMIN_ROLE, by: OWNER, byRole: "super" });
  check("a super admin can", (await dmAccessFor(BOSS)).role === "admin");
  const demote = await refused("demote", () => saveDmUser({
    email: BOSS, roleKey: DEFAULT_ROLE, by: HAND, byRole: "admin",
  }));
  check("…and an admin cannot change an existing admin either",
    demote.includes("super administrator"), demote);

  console.log("\n3. Pages come from the ROLE, never from the person");
  const writer = await saveRole({
    name: "Test Writer", pages: [PAGE], administers: false, by: OWNER,
  });
  await saveDmUser({ email: HAND, roleKey: writer.key, by: BOSS, byRole: "admin" });
  const hand = await dmAccessFor(HAND);
  check("they get the role's page", hand.pages.includes(PAGE), hand.pages.join(","));
  check("…and the role is named back", hand.roleName === "Test Writer", hand.roleName);
  check("case in the address does not matter",
    (await dmAccessFor(HAND.toUpperCase())).pages.includes(PAGE));
  // The point of roles: one edit, and everybody holding it changes.
  await saveRole({ key: writer.key, name: "Test Writer", pages: [], administers: false, by: OWNER });
  check("narrowing the ROLE narrows the person", (await dmAccessFor(HAND)).pages.length === 0);
  await saveRole({
    key: writer.key, name: "Test Writer",
    pages: ["not-a-page", PAGE] as never, administers: false, by: OWNER,
  });
  check("a page key that does not exist is dropped",
    (await dmAccessFor(HAND)).pages.join(",") === PAGE);

  console.log("\n4. An invited account has nothing yet");
  await saveDmUser({
    email: DEALER, roleKey: writer.key, by: BOSS, byRole: "admin",
    authMethod: "link", status: "invited",
  });
  const waiting = await dmAccessFor(DEALER);
  check("invited is not access", waiting.pages.length === 0, waiting.pages.join(","));
  check("…and it says why", waiting.status === "invited");

  console.log("\n5. Setting up the account is what turns it on");
  const live = await activateDmUser({
    email: DEALER, firstName: "Dana", lastName: "Reyes",
    business: "Dutch Miller Chevrolet", phone: "304 555 0133",
  });
  check("the details are kept", live?.business === "Dutch Miller Chevrolet");
  check("…the address counts as verified", Boolean(live?.emailVerifiedAt));
  check("…and the pages they were given arrive now",
    (await dmAccessFor(DEALER)).pages.includes(PAGE));
  check("activating twice does nothing the second time",
    (await activateDmUser({
      email: DEALER, firstName: "X", lastName: "Y", business: "Z", phone: "1234567890",
    })) === null);
  check("…and the first set of details stands",
    (await getDmUser(DEALER))?.firstName === "Dana");

  console.log("\n6. Disabling takes effect now, not in eight hours");
  const before = (await getDmUser(DEALER))!.sessionEpoch;
  const off = await setDmUserEnabled(DEALER, false, BOSS, "admin");
  check("it switches off", off.ok === true);
  check("…access goes with it", (await dmAccessFor(DEALER)).pages.length === 0);
  check("…and the revocation counter moves",
    (await getDmUser(DEALER))!.sessionEpoch === before + 1,
    `${before} → ${(await getDmUser(DEALER))!.sessionEpoch}`);
  const back = await setDmUserEnabled(DEALER, true, BOSS, "admin");
  check("switching back on restores it", back.ok === true
    && (await dmAccessFor(DEALER)).pages.includes(PAGE));
  const bumped = await revokeDmSessions(DEALER);
  check("revoking alone also moves the counter", bumped > before + 1);
  check("…while leaving them active", (await dmAccessFor(DEALER)).pages.includes(PAGE));

  console.log("\n7. An admin is not an admin's to touch");
  check("an admin cannot switch off an admin",
    (await setDmUserEnabled(BOSS, false, HAND, "admin")).ok === false);
  check("…nor remove one", (await removeDmUser(BOSS, "admin")).ok === false);
  check("a super admin can remove one", (await removeDmUser(BOSS, "super")).ok === true);
  check("removing somebody who is not there is not an error",
    (await removeDmUser("ghost@example.invalid", "super")).ok === true);

  console.log("\n8. Addresses");
  check("a non-address is refused", (await refused("bad email", () => saveDmUser({
    email: "not an email", roleKey: DEFAULT_ROLE, by: OWNER, byRole: "super",
  }))).includes("email address"));
  check("a role that does not exist is refused", (await refused("bad role", () => saveDmUser({
    email: HAND, roleKey: "no-such-role", by: OWNER, byRole: "super",
  }))).includes("No such role"));
  check("nobody is staff without a session", !isStaff(null));
} finally {
  await db().query("DELETE FROM dm_users WHERE email = ANY($1::text[])", [MINE]).catch(() => {});
  await db().query("DELETE FROM dm_roles WHERE key = 'test-writer'").catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
