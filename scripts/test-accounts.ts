/**
 * Partner accounts: one application, and no leaks between them.
 *
 *   pnpm exec tsx scripts/test-accounts.ts
 *
 * The failure that matters here is not a crash. It is a partner
 * administrator opening a page and reading another partner's members,
 * or an RFID number issued twice because two accounts each thought it
 * was theirs. Neither looks like a bug from inside the application —
 * both look like data — so the cases below are all about what one
 * account can see of another.
 *
 * Checked here:
 *
 *   Dutch Miller is seeded, keeps its id, and keeps everything that
 *   was already in the database. The migration is a column default,
 *   so getting it wrong would silently empty the live account.
 *
 *   Every read is scoped. A list, a lookup by id, a count and a
 *   search all refuse to cross an account, and a lookup by a real id
 *   from the wrong account answers exactly as it does for an id that
 *   never existed.
 *
 *   A physical tag belongs to ONE account. The pool never hands out
 *   another partner's number and an upload of one adds nothing.
 *
 *   Provisioning is idempotent, reserves the application's own paths,
 *   and invents nothing.
 */
import {
  DUTCH_MILLER, DUTCH_MILLER_SLUG, RESERVED_SLUGS, accountLine, accountsFor,
  assignedAccounts, createAccount, forgetAccountAccess, getAccount,
  getAccountBySlug, holdersOf, listAccounts, renameAccount, setAccountStatus,
  setAssignedAccounts, slugFrom, slugProblem,
} from "../server/dutch-miller/accounts.js";
import { addRfids, listRfids, rfidCounts } from "../server/dutch-miller/rfid.js";
import {
  createSignup, getSignup, listSignups, newHandle,
} from "../server/dutch-miller/signups.js";
import { getPlacement, setPlacement } from "../server/dutch-miller/settings.js";
import { listVendors, proposeVendor } from "../server/dutch-miller/vendors.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const BY = "eric.s@mojocarwash.com";
/** Tags of our own, in a range the other suites do not touch. */
const TAG = (i: number) => `81${String(i).padStart(3, "0")}+8${String(i).padStart(5, "0")}`;
const TAGS = [1, 2, 3, 4].map(TAG);
const GUIDS: string[] = [];
let second = "";

const entry = (over: Record<string, string> = {}) => {
  const h = newHandle();
  GUIDS.push(h.guid);
  return {
    ...h,
    dlwContractId: "0041",
    firstName: "Robin",
    lastName: "Hale",
    plateDlw: "ZZZ 0001",
    plateState: "WV",
    stickerAttached: true,
    ...over,
  };
};

try {
  console.log("1. Dutch Miller is the first account, not a new one");
  const dm = await getAccount(DUTCH_MILLER);
  check("it is seeded", dm !== null);
  check("…at the id every existing row was migrated to", dm?.id === DUTCH_MILLER);
  check("…reachable by its path", (await getAccountBySlug(DUTCH_MILLER_SLUG))?.id === DUTCH_MILLER);
  check("…and active", dm?.status === "active");
  check("the header line reads as the live one does",
    accountLine({ name: "Dutch Miller", affiliation: "SUDS Car Wash" })
      === "Dutch Miller — SUDS Car Wash");
  // A partner whose wash nobody has filled in is the normal state of
  // a new account, and must render as the name alone rather than as
  // a dangling dash or an invented affiliation.
  check("…and omits an affiliation nobody set",
    accountLine({ name: "Smith Ford", affiliation: "" }) === "Smith Ford");

  console.log("\n2. Paths the application needs for itself");
  check("api is refused", slugProblem("api") !== null);
  check("…and so is auth", slugProblem("auth") !== null);
  check("every reserved word is refused",
    RESERVED_SLUGS.every((w) => slugProblem(w) !== null));
  // Lowered rather than refused: somebody typing their own
  // dealership's name with capitals has not made a mistake, and
  // `createAccount` stores what the check accepted.
  check("uppercase is accepted and lowered", slugProblem("DutchMiller") === null);
  check("a space is refused", slugProblem("smith ford") !== null);
  check("a leading hyphen is refused", slugProblem("-smith") !== null);
  check("one letter is refused", slugProblem("x") !== null);
  check("an ordinary one is fine", slugProblem("smith-ford") === null);
  check("a name suggests a path", slugFrom("Smith Ford Lincoln") === "smith-ford-lincoln");
  check("…with the punctuation dropped", slugFrom("O'Brien & Sons, Inc.") === "o-brien-sons-inc");

  console.log("\n3. Provisioning");
  const made = await createAccount({ name: "Smith Ford", affiliation: "SUDS Car Wash" }, BY);
  check("a name is enough", made.ok === true);
  if (!made.ok) throw new Error(made.problem);
  second = made.account.id;
  check("…it was created", made.created === true);
  check("…with a path derived from the name", made.account.slug === "smith-ford");
  check("…its own id, not the first account's", made.account.id !== DUTCH_MILLER);
  check("…and the template version recorded", made.account.templateVersion >= 1);

  // A double-click, or a retried request. Neither may mint a twin.
  const again = await createAccount({ name: "Smith Ford", affiliation: "SUDS Car Wash" }, BY);
  check("submitting it twice returns the same account",
    again.ok === true && again.account.id === second);
  check("…and says it did not create one", again.ok === true && again.created === false);

  const clash = await createAccount({ name: "Someone Else", slug: "smith-ford" }, BY);
  check("a different partner cannot take the path", clash.ok === false);
  check("…and is told who has it",
    clash.ok === false && clash.problem.includes("Smith Ford"), clash.ok ? "" : clash.problem);
  const reserved = await createAccount({ name: "Api", slug: "api" }, BY);
  check("a reserved path is refused", reserved.ok === false);
  const noName = await createAccount({ name: " " }, BY);
  check("a blank name is refused", noName.ok === false);

  console.log("\n4. A new account starts EMPTY");
  check("no members", (await listSignups({ account: second })).counts.total === 0);
  check("no tags", (await rfidCounts(second)).total === 0);
  check("no vendors", (await listVendors({ account: second, status: "all" })).counts.total === 0);
  // Not copied from Dutch Miller, and not left blank either: the
  // default is the safe one, because a setting appearing must not
  // rewrite what anybody is told to do at a vehicle.
  check("placement is the default, not the first account's",
    (await getPlacement(second)).placement === "inside");

  console.log("\n5. Tags belong to one account, and one only");
  await addRfids([TAGS[0]!, TAGS[1]!], [], 2, BY, DUTCH_MILLER);
  await addRfids([TAGS[2]!], [], 1, BY, second);
  check("each pool holds its own",
    (await listRfids({ account: second, status: "all" })).total === 1);
  check("…and not the other's",
    (await listRfids({ account: second, search: TAGS[0]!, status: "all" })).total === 0);

  // The whole reason the number stays a global primary key. A sticker
  // is a physical thing with one number on it, and the gate readers
  // have never heard of accounts.
  const stolen = await addRfids([TAGS[0]!], [], 1, BY, second);
  check("a number another partner holds is not added", stolen.added === 0);
  check("…it is reported as already held", stolen.alreadyHeld.length === 1);
  check("…and marked as somebody else's",
    stolen.alreadyHeld[0]?.otherAccount === true);
  check("…without the other partner being named",
    JSON.stringify(stolen.alreadyHeld).toLowerCase().includes("dutch") === false);
  check("…and it is still not in this pool",
    (await listRfids({ account: second, search: TAGS[0]!, status: "all" })).total === 0);

  console.log("\n6. The pool never crosses an account");
  // A bulk import names no tag: the server takes the next free one.
  // Taking it from the wrong pool would put one partner's sticker on
  // another partner's windscreen.
  const bulk = await createSignup(
    { ...entry(), rfid: "" }, BY, { account: second, assignAnyRfid: true });
  check("an import takes a tag from its OWN pool", bulk.ok === true);
  check("…which is the one this account uploaded",
    bulk.ok && bulk.row.customer.rfid === TAGS[2]!, bulk.ok ? bulk.row.customer.rfid : "");

  // Naming one by hand is the same rule, stated the other way round.
  const reach = await createSignup(
    entry({ rfid: TAGS[1]! }), BY, { account: second });
  check("naming another partner's tag is refused", reach.ok === false);
  check("…as not being in this pool",
    !reach.ok && reach.kind === "rfid-taken", reach.ok ? "" : reach.kind);
  check("…and the tag is untouched",
    (await listRfids({ account: DUTCH_MILLER, search: TAGS[1]!, status: "active" })).total === 1);

  console.log("\n7. Members and vendors do not cross either");
  const mine = await createSignup(entry({ rfid: TAGS[0]! }), BY, { account: DUTCH_MILLER });
  check("a member lands in the account that made them", mine.ok === true);
  if (!mine.ok) throw new Error("could not make a member");
  check("…and is found there", (await getSignup(mine.row.guid, DUTCH_MILLER)) !== null);
  /*
   * The important one. A GUID is unguessable but it is also pasted
   * into chats and left in old bookmarks, so the question is what the
   * WRONG account gets back — and the answer has to be the same one
   * an invented id gets, with no name, no plate and no hint that the
   * record is real.
   */
  check("…and NOT from another account", (await getSignup(mine.row.guid, second)) === null);
  check("…which reads exactly like an id that never existed",
    (await getSignup("00000000-0000-4000-8000-000000000000", second)) === null);
  check("a search cannot reach across", (await listSignups({
    account: second, search: "Hale", status: "all",
  })).rows.every((r) => r.customer.rfid !== TAGS[0]!));

  const vend = await proposeVendor({
    account: second, by: BY,
    raw: {
      companyName: "Mill Road Supply", contactName: "Jo Park",
      phone: "3045550144", email: "jo@millroad.example",
      address1: "2 Mill Road", city: "Huntington", state: "WV", postalCode: "25701",
    },
  });
  check("a vendor lands in its own account", vend.ok === true);
  check("…and is not in the other's register",
    (await listVendors({ account: DUTCH_MILLER, status: "all" }))
      .vendors.every((v) => v.companyName !== "Mill Road Supply"));

  console.log("\n8. Settings that belong to one partner");
  await setPlacement("outside", BY, second);
  check("the second account can be set", (await getPlacement(second)).placement === "outside");
  check("…without moving the first", (await getPlacement(DUTCH_MILLER)).placement !== "outside");

  console.log("\n9. Who may open what");
  const SCOPED = "desk@smithford.example";
  await setAssignedAccounts(SCOPED, [second], BY);
  const theirs = await accountsFor({
    email: SCOPED, isAccountAdmin: false, allAccounts: false,
  });
  check("a scoped person holds what they were given", theirs.length === 1);
  check("…and that is their account", theirs[0]?.id === second);
  check("…the assignment reads back", (await assignedAccounts(SCOPED)).includes(second));
  check("…and they are listed as a holder", (await holdersOf(second)).includes(SCOPED));

  // The mark, as against a pile of rows. The difference shows the day
  // a new partner is created: a list of assignments is silently
  // missing from it, and the mark is not.
  const everywhere = await accountsFor({
    email: "platform@mojocarwash.com", isAccountAdmin: false, allAccounts: true,
  });
  check("an all-accounts person holds every active one",
    everywhere.length === (await listAccounts()).filter((a) => a.status === "active").length);
  const admin = await accountsFor({
    email: BY, isAccountAdmin: true, allAccounts: false,
  });
  check("an account administrator holds all of them",
    admin.length === (await listAccounts()).length);

  // An unknown id in the list is dropped rather than failing the save
  // of the others — an account deleted between the page loading and
  // the form saving must not take the whole change with it.
  const kept = await setAssignedAccounts(SCOPED, [second, "acct_nope"], BY);
  check("an unknown account is dropped, not refused", kept.length === 1);

  console.log("\n10. Deactivation keeps everything");
  const why = "Partner agreement ended 2026-10-26.";
  const noReason = await setAccountStatus(second, "inactive", BY, "");
  check("switching off with no reason is refused", "problem" in noReason);
  const off = await setAccountStatus(second, "inactive", BY, why);
  check("it switches off", !("problem" in off) && off.status === "inactive");
  check("…carrying the reason", !("problem" in off) && off.deactivateReason === why);
  check("…and who did it", !("problem" in off) && off.deactivatedBy === BY);
  // Not deleted. Everything that was in it is still in it, which is
  // the whole difference between deactivating and removing.
  check("its members are still there",
    (await listSignups({ account: second, status: "all" })).counts.total > 0);
  check("its tags are still there", (await rfidCounts(second)).total > 0);
  /*
   * Still listed, and that is deliberate. Membership and permission
   * to work are separate questions: the first is answered here, the
   * second by the account's status, checked once in the middleware.
   * Dropping it from the list instead would tell the dealer whose
   * partner went dark that it is "not available to you", when what
   * they need to read is that it was deactivated and why.
   */
  const stillTheirs = await accountsFor({
    email: SCOPED, isAccountAdmin: false, allAccounts: false,
  });
  check("a scoped person is still attached to it", stillTheirs.length === 1);
  check("…and it reads as deactivated", stillTheirs[0]?.status === "inactive");
  check("…carrying the reason they will be shown",
    stillTheirs[0]?.deactivateReason === why);
  check("…and an account administrator sees it too, to bring it back",
    (await accountsFor({ email: BY, isAccountAdmin: true, allAccounts: false }))
      .some((a) => a.id === second));
  const back = await setAccountStatus(second, "active", BY, "");
  check("it comes back", !("problem" in back) && back.status === "active");
  check("…and the reason is cleared", !("problem" in back) && back.deactivateReason === "");

  console.log("\n11. Renaming moves nothing");
  const before = (await listSignups({ account: second, status: "all" })).counts.total;
  const renamed = await renameAccount(second, { name: "Smith Ford Lincoln" }, BY);
  check("the name changes", !("problem" in renamed) && renamed.name === "Smith Ford Lincoln");
  // The id is the ownership key and the slug is routing. If either
  // moved on a rename, every record, link and permission would have
  // to move with it — which is the thing names are not allowed to do.
  check("…the id does not", !("problem" in renamed) && renamed.id === second);
  check("…nor does the path", !("problem" in renamed) && renamed.slug === "smith-ford");
  check("…and its records are exactly where they were",
    (await listSignups({ account: second, status: "all" })).counts.total === before);

} finally {
  // Everything this suite made, and nothing anybody else's suite did.
  if (GUIDS.length > 0) {
    await db().query("DELETE FROM dm_member_signups WHERE guid = ANY($1::uuid[])", [GUIDS])
      .catch(() => {});
  }
  await db().query("DELETE FROM dm_rfid WHERE number = ANY($1::text[])", [TAGS])
    .catch(() => {});
  if (second) {
    await db().query("DELETE FROM dm_vendor_revisions WHERE vendor_id IN "
      + "(SELECT id FROM dm_vendors WHERE account_id = $1)", [second]).catch(() => {});
    await db().query("DELETE FROM dm_vendors WHERE account_id = $1", [second]).catch(() => {});
    await db().query("DELETE FROM dm_settings WHERE account_id = $1", [second]).catch(() => {});
    await db().query("DELETE FROM dm_accounts WHERE id = $1", [second]).catch(() => {});
  }
  await forgetAccountAccess("desk@smithford.example").catch(() => {});
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
