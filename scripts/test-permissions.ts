/**
 * What a role can DO, and whether the reviewer can do it.
 *
 *   pnpm exec tsx scripts/test-permissions.ts
 *
 * Two silent failures:
 *
 *   Action permissions are DERIVED, so the printout in the role editor
 *   and the server's own refusals must come from one function. If they
 *   drift, the editor cheerfully shows a permission nobody has.
 *
 *   The CSC Reviewer can stop being able to approve long after being
 *   set, because somebody else changed their role. Nobody finds out
 *   until a dealer rings up: the notification still goes out, with a
 *   link to a record the recipient will be refused.
 */
import { ACTIONS, actionsFor } from "../server/dutch-miller/actions.js";
import { DM_PAGE_KEYS } from "../server/dutch-miller/pages.js";
import { ADMIN_ROLE, CSC_ROLE, DEFAULT_ROLE, listRoles, saveRole } from "../server/dutch-miller/roles.js";
import { checkReviewer, saveDmUser, setDmUserEnabled } from "../server/dutch-miller/users.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

process.env.DM_SUPER_ADMINS = "owner@example.invalid";
const OWNER = "owner@example.invalid";
const BOSS = "boss@example.invalid";
const CSC_PERSON = "csc@example.invalid";
const MINE = [BOSS, CSC_PERSON];

try {
  console.log("1. Page access and action permissions are different questions");
  const nobody = actionsFor({ pages: [], administers: false, approves: false });
  check("a role with no pages can do nothing",
    Object.values(nobody).every((v) => v === false));
  const writer = actionsFor({
    pages: ["member-signups"], administers: false, approves: false,
  });
  // Member Signups is TWO grants now: reviewing and adding. Review
  // alone reads and exports; it does not enrol.
  check("Review Existing brings reviewing", writer["member.review"]);
  check("…and exporting", writer["member.export"]);
  check("…but not submitting — that is the other half",
    writer["member.submit"] === false);
  const desk = actionsFor({
    pages: ["member-signups-add"], administers: false, approves: false,
  });
  check("Add New brings submitting", desk["member.submit"]);
  check("…and importing", desk["member.import"]);
  check("…but not reviewing", desk["member.review"] === false);
  // The one that a page list cannot answer, and the reason this module
  // exists: a role editor full of page tick-boxes shows nothing at all
  // about who may approve.
  check("…and neither half brings approving",
    writer["member.approve"] === false && desk["member.approve"] === false);
  check("…nor managing users", writer["users.manage"] === false);

  console.log("\n2. Approving is not a consequence of anything else");
  const admin = actionsFor({
    pages: [...DM_PAGE_KEYS], administers: true, approves: false,
  });
  check("an administrator holds every page", admin["member.review"]);
  check("…and manages users", admin["users.manage"]);
  check("…and reads the security workspace", admin["security.view"]);
  check("…and still may NOT approve", admin["member.approve"] === false);
  check("…nor manage roles", admin["roles.manage"] === false);
  // Still true now that deleting is GRANTABLE: it must never arrive
  // by administering, or every administrator silently gains it.
  check("…nor delete a member record", admin["member.delete"] === false);
  const csc = actionsFor({ pages: ["member-signups"], administers: false, approves: true });
  check("CSC approves", csc["member.approve"]);
  check("…without administering anything", csc["users.manage"] === false);
  const sup = actionsFor({
    pages: [], administers: true, approves: true, pinnedSuper: true,
  });
  check("the super admin holds everything", Object.values(sup).every(Boolean));
  check("…including pages it was not given, because administering means all",
    sup["member.review"]);

  console.log("\n3. The printout matches the stored roles");
  const roles = await listRoles();
  for (const r of roles) {
    const a = actionsFor(r);
    check(`${r.name}: approving matches the role's own flag`,
      a["member.approve"] === r.approves);
  }
  check("exactly one built-in role approves",
    roles.filter((r) => r.approves).length === 1);
  check("every action has a stated source",
    ACTIONS.every((a) => a.source.length > 5));
  check("…and approving's source names CSC",
    (ACTIONS.find((a) => a.key === "member.approve")?.source ?? "").includes("CSC"));

  console.log("\n4. The reviewer is checked against what they can DO");
  const none = await checkReviewer("");
  check("no reviewer is reported", none.ok === false);
  check("…saying nobody is notified",
    none.problems.join(" ").includes("notify nobody"));

  const stranger = await checkReviewer("nobody@example.invalid");
  check("an address with no account is refused", stranger.ok === false);
  check("…saying there is no account",
    stranger.problems.join(" ").includes("no Dutch Miller account"));

  // The case that actually bites: an active account, with a role, that
  // simply is not the one that approves.
  await saveDmUser({ email: BOSS, roleKey: ADMIN_ROLE, by: OWNER, byRole: "super" });
  const asAdmin = await checkReviewer(BOSS);
  check("an ADMINISTRATOR is refused as reviewer", asAdmin.ok === false);
  check("…saying their role cannot approve",
    asAdmin.problems.join(" ").includes("cannot approve"),
    asAdmin.problems.join(" | "));

  await saveDmUser({ email: CSC_PERSON, roleKey: CSC_ROLE, by: OWNER, byRole: "super" });
  const good = await checkReviewer(CSC_PERSON);
  check("a CSC is accepted", good.ok === true, good.problems.join(" | "));
  check("…saying why", good.because.includes("approve"));

  // Set, then broken by somebody else. This is why it is checked on
  // every page load rather than only when saved.
  await setDmUserEnabled(CSC_PERSON, false, OWNER, "super");
  const disabled = await checkReviewer(CSC_PERSON);
  check("disabling them breaks the reviewer", disabled.ok === false);
  check("…and says so", disabled.problems.join(" ").includes("disabled"));
  await setDmUserEnabled(CSC_PERSON, true, OWNER, "super");
  await saveDmUser({ email: CSC_PERSON, roleKey: DEFAULT_ROLE, by: OWNER, byRole: "super" });
  const demoted = await checkReviewer(CSC_PERSON);
  check("so does moving them off CSC", demoted.ok === false);

  console.log("\n5. The super admin's exception is explained, not hidden");
  // The puzzle in the brief: nobody holds CSC, and approvals work.
  const owner = await checkReviewer(OWNER);
  check("the pinned owner is a valid reviewer", owner.ok === true);
  check("…and the reason names configuration, not a role",
    owner.because.includes("configuration"), owner.because);
  check("…and explains the apparently empty CSC role",
    owner.because.toLowerCase().includes("nobody holding csc"), owner.because);
} finally {
  await db().query("DELETE FROM dm_users WHERE email = ANY($1::text[])", [MINE]).catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
