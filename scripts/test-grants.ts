/**
 * Member Signups as two grants, deleting as a role's to give, and
 * tags kept back for testing.
 *
 *   pnpm exec tsx scripts/test-grants.ts
 *
 * Each of the three has one way to go wrong that nobody would notice
 * until it mattered:
 *
 *   The split must not take Add New away from anybody who had it. A
 *   permission that disappears on deploy is a dealership that cannot
 *   enrol on Monday morning.
 *
 *   Deleting is now grantable. It must still never arrive by
 *   administering, or every administrator silently gains it.
 *
 *   A test tag must never reach a paying member. The pool must not
 *   hand one out at all, and naming one must be the owner's alone.
 */
import {
  ADMIN_ROLE, CSC_ROLE, DEFAULT_ROLE, getRole, listRoles, saveRole,
} from "../server/dutch-miller/roles.js";
import { DM_GRANTS, DM_PAGE_KEYS } from "../server/dutch-miller/pages.js";
import { actionsFor } from "../server/dutch-miller/actions.js";
import { dmAccessFor, saveDmUser } from "../server/dutch-miller/users.js";
import { addRfids, listRfids, rfidCounts, setRfidTestOnly } from "../server/dutch-miller/rfid.js";
import { createSignup, newHandle } from "../server/dutch-miller/signups.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

process.env.DM_SUPER_ADMINS = "owner@example.invalid";
const OWNER = "owner@example.invalid";
const DESK = "desk@example.invalid";
const MADE: string[] = [];
const TAG = (i: number) => `70${String(i).padStart(3, "0")}+7${String(i).padStart(5, "0")}`;
const TAGS = [1, 2, 3].map(TAG);
const GUIDS: string[] = [];

const entry = (over: Record<string, unknown> = {}) => {
  const h = newHandle();
  GUIDS.push(h.guid);
  return {
    ...h, dlwContractId: "0041", firstName: "Dana", lastName: "Reyes",
    stickerAttached: true, rfid: TAGS[0]!, ...over,
  };
};

try {
  console.log("1. Member Signups is two grants");
  check("both are grantable", DM_PAGE_KEYS.includes("member-signups")
    && DM_PAGE_KEYS.includes("member-signups-add"));
  check("…and each is named for a person to read",
    DM_GRANTS.every((g) => g.label.length > 3 && g.blurb.length > 10));

  // A front desk that enrols and never reviews.
  const desk = await saveRole({
    name: "Test Front Desk", pages: ["member-signups-add"], administers: false, by: OWNER,
  });
  MADE.push(desk.key);
  const deskActions = actionsFor(desk);
  check("Add New alone can submit", deskActions["member.submit"]);
  check("…and import", deskActions["member.import"]);
  check("…but NOT review", deskActions["member.review"] === false);
  check("…nor export member records", deskActions["member.export"] === false);

  // And somebody at MOJO who reads the queue and never types one in.
  const reader = await saveRole({
    name: "Test Reader", pages: ["member-signups"], administers: false, by: OWNER,
  });
  MADE.push(reader.key);
  const readerActions = actionsFor(reader);
  check("Review alone can review", readerActions["member.review"]);
  check("…and export", readerActions["member.export"]);
  check("…but NOT submit", readerActions["member.submit"] === false);

  console.log("\n2. The split did not take Add New from anybody");
  // The backfill runs once, at boot, for roles that held the old
  // single grant. The built-in admin holds everything regardless.
  const admin = (await listRoles()).find((r) => r.key === ADMIN_ROLE);
  check("the administrator role still holds both",
    Boolean(admin?.pages.includes("member-signups"))
      && Boolean(admin?.pages.includes("member-signups-add")),
    (admin?.pages ?? []).join(","));
  const csc = (await listRoles()).find((r) => r.key === CSC_ROLE);
  check("…and so does CSC", Boolean(csc?.pages.includes("member-signups-add")),
    (csc?.pages ?? []).join(","));

  console.log("\n3. Deleting is grantable, and never arrives by accident");
  check("a new role cannot delete members", deskActions["member.delete"] === false);
  check("…nor RFIDs", deskActions["rfid.delete"] === false);
  // The thing that must stay true: administering is not deleting.
  const admins = actionsFor({
    pages: [...DM_PAGE_KEYS], administers: true, approves: false,
  });
  check("an ADMINISTRATOR still cannot delete members",
    admins["member.delete"] === false);
  check("…nor RFIDs", admins["rfid.delete"] === false);

  const remover = await saveRole({
    name: "Test Remover", pages: ["member-signups", "rfid-review"],
    administers: false, deletesSignups: true, deletesRfid: false, by: OWNER,
  });
  MADE.push(remover.key);
  check("granting member deletion works", actionsFor(remover)["member.delete"]);
  check("…and does NOT hand over RFID deletion",
    actionsFor(remover)["rfid.delete"] === false);
  check("…which the stored role agrees with",
    (await getRole(remover.key))?.deletesSignups === true);

  // And it has to reach the person, not just the role.
  await saveDmUser({ email: DESK, roleKey: remover.key, by: OWNER, byRole: "super" });
  const theirs = await dmAccessFor(DESK);
  check("the holder can delete members", theirs.deletesSignups);
  check("…and cannot delete RFIDs", theirs.deletesRfid === false);
  // The owner keeps both, by configuration rather than by a role.
  const owner = await dmAccessFor(OWNER);
  check("the owner holds both", owner.deletesSignups && owner.deletesRfid);

  console.log("\n4. A tag kept back for testing never reaches a member");
  await db().query(
    `UPDATE dm_rfid SET status = 'active', used_at = NULL, used_by = NULL,
            used_for = NULL, test_only = false
      WHERE number = ANY($1::text[])`, [TAGS]).catch(() => {});
  await db().query("DELETE FROM dm_member_signups WHERE rfid = ANY($1::text[])", [TAGS])
    .catch(() => {});
  await addRfids(TAGS, [], TAGS.length, OWNER);
  await setRfidTestOnly([TAGS[0]!], true);

  const marked = (await listRfids({ status: "test", search: TAGS[0]! })).rows;
  check("it shows in the test view", marked.some((r) => r.number === TAGS[0]!));
  check("…and is counted apart", (await rfidCounts()).testOnly >= 1);
  // Still in the pool as 'active' — that is the difference from
  // holding one back, and the reason the rules below are needed.
  check("…while still being an active tag",
    marked[0]?.status === "active", marked[0]?.status);

  // THE RULE: the pool must never hand one out.
  const auto = await createSignup(
    entry({ rfid: "", firstName: "Auto" }), OWNER, { assignAnyRfid: true });
  check("an import never spends a test tag",
    auto.ok === true && auto.row.customer.rfid !== TAGS[0]!,
    auto.ok ? auto.row.customer.rfid : JSON.stringify(auto));

  // Naming one is the owner's alone.
  const notOwner = await createSignup(entry({ rfid: TAGS[0]! }), DESK);
  check("somebody else naming it is refused", notOwner.ok === false);
  check("…saying why", !notOwner.ok && notOwner.kind === "rfid-taken",
    notOwner.ok ? "accepted" : notOwner.kind);
  const asOwner = await createSignup(
    entry({ rfid: TAGS[0]!, firstName: "Tester" }), OWNER, { mayUseTestTags: true });
  check("the owner CAN use it", asOwner.ok === true,
    asOwner.ok ? "" : JSON.stringify(asOwner));

  console.log("\n5. Un-marking puts it back in ordinary use");
  await setRfidTestOnly([TAGS[2]!], true);
  check("marked", (await listRfids({ status: "test", search: TAGS[2]! })).rows.length === 1);
  await setRfidTestOnly([TAGS[2]!], false);
  check("…and released",
    (await listRfids({ status: "test", search: TAGS[2]! })).rows.length === 0);
  check("…back among the available ones",
    (await listRfids({ status: "active", search: TAGS[2]! })).rows.length === 1);
  console.log("\n6. RFID Inventory, to look at and not to touch");
  /*
   * Most people who need this page need it to answer a question —
   * which tag went on that car, how many are left — and opening it
   * used to come with the ability to spend tags.
   */
  const looker = await saveRole({
    name: "Test Looker", pages: ["rfid-review"], administers: false,
    rfidReadOnly: true, by: OWNER,
  });
  MADE.push(looker.key);
  const look = actionsFor(looker);
  check("they can open RFID Inventory", looker.pages.includes("rfid-review"));
  check("…but cannot upload", look["rfid.upload"] === false);
  check("…nor hold tags back", look["rfid.manage"] === false);
  check("…nor remove any", look["rfid.delete"] === false);

  // View-only beats a delete grant: ticking both is a contradiction
  // and the narrower answer is the safe one.
  const both = await saveRole({
    name: "Test Looker Two", pages: ["rfid-review"], administers: false,
    rfidReadOnly: true, deletesRfid: true, by: OWNER,
  });
  MADE.push(both.key);
  check("view-only wins over a delete grant",
    actionsFor(both)["rfid.delete"] === false);

  // And administering is every PAGE, not a licence to change one.
  const bossLooker = await saveRole({
    name: "Test Looker Boss", pages: [], administers: true,
    rfidReadOnly: true, by: OWNER,
  });
  MADE.push(bossLooker.key);
  check("…and over administering", actionsFor(bossLooker)["rfid.manage"] === false);
  check("…while they still hold the page",
    actionsFor(bossLooker)["member.review"]);

  // It reaches the person, and the owner is never read-only.
  await saveDmUser({ email: DESK, roleKey: looker.key, by: OWNER, byRole: "super" });
  check("the holder is read-only", (await dmAccessFor(DESK)).rfidReadOnly);
  check("the owner never is", (await dmAccessFor(OWNER)).rfidReadOnly === false);

} finally {
  await db().query("DELETE FROM dm_member_signups WHERE guid = ANY($1::uuid[])", [GUIDS])
    .catch(() => {});
  await db().query("DELETE FROM dm_rfid WHERE number = ANY($1::text[])", [TAGS])
    .catch(() => {});
  await db().query("DELETE FROM dm_users WHERE email = $1", [DESK]).catch(() => {});
  await db().query("DELETE FROM dm_roles WHERE key = ANY($1::text[])", [MADE])
    .catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
