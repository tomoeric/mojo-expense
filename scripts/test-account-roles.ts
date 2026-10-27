/**
 * Roles an account adds for itself, and the people it invites.
 *
 *   pnpm exec tsx scripts/test-account-roles.ts
 *
 * A dealership knows what its own jobs are called and should not have
 * to ask MOJO to add "Service Writer". What it must NOT be able to do
 * is use that freedom to reach further than it was given — so the
 * cases below are the ways a role could become a way in:
 *
 *   An account's own administrator minting a role that administers,
 *   or deletes, or approves vendors, and then holding it. The rule
 *   this codebase has had since roles existed is that somebody who
 *   can hand out a grant can hand it to themselves; it does not stop
 *   being true inside a partner.
 *
 *   An account-local role carried into ANOTHER account by somebody
 *   assigned to both. The role is one partner's; its pages must not
 *   travel.
 *
 *   Two partners both calling a role "Service Writer" and the second
 *   silently editing the first's, because keys are global.
 */
import {
  DUTCH_MILLER, assignedAccounts, createAccount, forgetAccountAccess,
  setAssignedAccounts,
} from "../server/dutch-miller/accounts.js";
import { listRoles, removeRole, saveRole } from "../server/dutch-miller/roles.js";
import { dmAccessFor, removeDmUser, saveDmUser } from "../server/dutch-miller/users.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};
const refused = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return ""; } catch (e) { return (e as Error).message; }
};

const BY = "eric.s@mojocarwash.com";
const THEIRS = "desk@dutchmiller.example";
let second = "";
const MADE: string[] = [];

try {
  console.log("1. A shared template role is every partner's");
  const shared = await saveRole({
    name: "Shared Reader", pages: ["member-signups"], administers: false, by: BY,
  });
  MADE.push(shared.key);
  check("it is created", shared.name === "Shared Reader");
  check("…with no account on it", shared.accountId === "");
  check("…and its key is unprefixed", shared.key === "shared-reader", shared.key);

  const made = await createAccount({ name: "Role Motors" }, BY);
  if (!made.ok) throw new Error(made.problem);
  second = made.account.id;

  check("it is offered in Dutch Miller",
    (await listRoles(DUTCH_MILLER)).some((r) => r.key === shared.key));
  check("…and in the other account too",
    (await listRoles(second)).some((r) => r.key === shared.key));

  console.log("\n2. An account adds a role of its own");
  const theirs = await saveRole({
    name: "Service Writer", pages: ["member-signups-add"], administers: false,
    scope: { kind: "account", accountId: DUTCH_MILLER }, by: THEIRS,
  });
  MADE.push(theirs.key);
  check("it is created", theirs.name === "Service Writer");
  check("…belonging to that account", theirs.accountId === DUTCH_MILLER);
  // Keys are global — dm_users.role_key points straight at one — so
  // two partners naming a role the same thing would collide and the
  // second would silently edit the first's.
  check("…with a key prefixed by the account",
    theirs.key.startsWith(`${DUTCH_MILLER}__`), theirs.key);

  check("it is offered in its own account",
    (await listRoles(DUTCH_MILLER)).some((r) => r.key === theirs.key));
  check("AND NOT IN ANOTHER ACCOUNT",
    !(await listRoles(second)).some((r) => r.key === theirs.key));

  // The collision that the prefix prevents.
  const alsoTheirs = await saveRole({
    name: "Service Writer", pages: ["member-signups"], administers: false,
    scope: { kind: "account", accountId: second }, by: BY,
  });
  MADE.push(alsoTheirs.key);
  check("another partner can use the same name", alsoTheirs.name === "Service Writer");
  check("…without touching the first", alsoTheirs.key !== theirs.key,
    `${theirs.key} / ${alsoTheirs.key}`);
  check("…and the first still says what it said",
    (await listRoles(DUTCH_MILLER)).find((r) => r.key === theirs.key)?.pages
      .includes("member-signups-add") === true);

  console.log("\n3. An account cannot widen its own reach");
  const admin = await refused(() => saveRole({
    name: "Sneaky Admin", pages: [], administers: true,
    scope: { kind: "account", accountId: DUTCH_MILLER }, by: THEIRS,
  }));
  check("a role that administers is refused", admin.includes("cannot administer"), admin);
  const deleter = await refused(() => saveRole({
    name: "Sneaky Deleter", pages: ["member-signups"], administers: false,
    deletesSignups: true,
    scope: { kind: "account", accountId: DUTCH_MILLER }, by: THEIRS,
  }));
  check("…one that deletes members, refused", deleter.includes("account administrator"),
    deleter);
  const rfid = await refused(() => saveRole({
    name: "Sneaky Tags", pages: ["rfid-review"], administers: false, deletesRfid: true,
    scope: { kind: "account", accountId: DUTCH_MILLER }, by: THEIRS,
  }));
  check("…one that deletes tags, refused", rfid.length > 0);
  const vend = await refused(() => saveRole({
    name: "Sneaky Vendors", pages: ["vendors"], administers: false, approvesVendors: true,
    scope: { kind: "account", accountId: DUTCH_MILLER }, by: THEIRS,
  }));
  check("…one that approves vendors, refused", vend.length > 0);
  // The restriction IS allowed: it takes away rather than grants.
  const readOnly = await saveRole({
    name: "Tag Reader", pages: ["rfid-review"], administers: false, rfidReadOnly: true,
    scope: { kind: "account", accountId: DUTCH_MILLER }, by: THEIRS,
  });
  MADE.push(readOnly.key);
  check("view-only IS allowed — it restricts rather than grants",
    readOnly.rfidReadOnly === true);

  console.log("\n4. An account cannot touch the shared template, or another partner");
  const editShared = await refused(() => saveRole({
    key: shared.key, name: "Shared Reader", pages: [], administers: false,
    scope: { kind: "account", accountId: DUTCH_MILLER }, by: THEIRS,
  }));
  check("editing a shared role is refused",
    editShared.includes("shared template"), editShared);
  const editOther = await refused(() => saveRole({
    key: alsoTheirs.key, name: "Taken Over", pages: [], administers: false,
    scope: { kind: "account", accountId: DUTCH_MILLER }, by: THEIRS,
  }));
  check("…and editing another partner's role, refused",
    editOther.includes("another partner"), editOther);
  const delShared = await removeRole(shared.key,
    { kind: "account", accountId: DUTCH_MILLER });
  check("deleting a shared role is refused", delShared.ok === false, delShared.reason);
  const delOther = await removeRole(alsoTheirs.key,
    { kind: "account", accountId: DUTCH_MILLER });
  check("…and another partner's, refused", delOther.ok === false, delOther.reason);

  console.log("\n5. An account's role grants nothing in another account");
  /*
   * The one that matters. Somebody assigned to two partners holds a
   * role one of them defined; its pages must not travel with them.
   */
  await saveDmUser({ email: THEIRS, roleKey: theirs.key, by: BY, byRole: "super" });
  await setAssignedAccounts(THEIRS, [DUTCH_MILLER, second], BY);
  check("they hold both accounts", (await assignedAccounts(THEIRS)).length === 2);

  const inOwn = await dmAccessFor(THEIRS, DUTCH_MILLER);
  check("in its own account the role works",
    inOwn.pages.includes("member-signups-add"), inOwn.pages.join(","));
  const inOther = await dmAccessFor(THEIRS, second);
  check("IN THE OTHER ACCOUNT IT GRANTS NOTHING", inOther.pages.length === 0,
    inOther.pages.join(","));
  check("…and does not administer there", inOther.role !== "admin");
  // A SHARED role, by contrast, works in both.
  await saveDmUser({ email: THEIRS, roleKey: shared.key, by: BY, byRole: "super" });
  check("a shared role works in its own account",
    (await dmAccessFor(THEIRS, DUTCH_MILLER)).pages.includes("member-signups"));
  check("…and in the other one too",
    (await dmAccessFor(THEIRS, second)).pages.includes("member-signups"));

} finally {
  await removeDmUser(THEIRS, "super").catch(() => undefined);
  await forgetAccountAccess(THEIRS).catch(() => undefined);
  for (const key of MADE) {
    await db().query("DELETE FROM dm_roles WHERE key = $1", [key]).catch(() => undefined);
  }
  if (second) {
    await db().query("DELETE FROM dm_roles WHERE account_id = $1", [second])
      .catch(() => undefined);
    await db().query("DELETE FROM dm_accounts WHERE id = $1", [second])
      .catch(() => undefined);
  }
  await db().query("DELETE FROM dm_roles WHERE account_id = $1", [DUTCH_MILLER])
    .catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
