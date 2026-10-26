/**
 * Vendors, and the review that approves them.
 *
 *   pnpm exec tsx scripts/test-vendors.ts
 *
 * One requirement shapes all of this: a CHANGE needs approval too.
 * So the record people read and the record somebody is proposing
 * cannot be the same row, and the failures worth preventing all
 * follow from that:
 *
 *   A proposed edit must never appear as the vendor before somebody
 *   signs it off, and a REJECTED edit must leave an established
 *   vendor exactly as it was.
 *
 *   Two pending changes at once would silently apply one over the
 *   other with nobody told.
 */
import {
  BLANK_VENDOR, approvalBlockers, changedFields, decideVendor, deleteVendor,
  getVendor, listVendors, proposeVendor, validateVendor,
} from "../server/dutch-miller/vendors.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const DEALER = "desk@dutchmiller.example";
const BOSS = "boss@mojocarwash.com";
const MADE: string[] = [];

const GOOD = {
  companyName: "Tri-State Chemical", contactName: "Dana Reyes",
  phone: "3045550133", email: "Dana@TriState.example",
  address1: "14 Mill Road", city: "Huntington", state: "wv", postalCode: "25701",
  services: "Wash chemicals", taxId: "55-1234567",
  w9OnFile: true, insuranceOnFile: true, insuranceExpires: "2099-01-01",
};

try {
  console.log("1. What a submission must have");
  const empty = validateVendor({});
  check("the contact block is required",
    ["companyName", "contactName", "phone", "email", "address1", "city",
      "state", "postalCode"].every((k) => Boolean(empty.errors[k])));
  // Checked at APPROVAL instead, so a dealership can start the
  // process without holding the W-9 in their hand.
  check("…but the paperwork is not", !empty.errors.w9OnFile && !empty.errors.taxId);
  check("a bad address is refused",
    Boolean(validateVendor({ ...GOOD, email: "nope" }).errors.email));
  check("a bad ZIP is refused",
    Boolean(validateVendor({ ...GOOD, postalCode: "257" }).errors.postalCode));
  const tidy = validateVendor(GOOD);
  check("the phone is formatted", tidy.clean.phone === "(304) 555-0133", tidy.clean.phone);
  check("…the email lower-cased", tidy.clean.email === "dana@tristate.example");
  check("…and the state lifted", tidy.clean.state === "WV");

  console.log("\n2. A new vendor is a request, not a vendor");
  const made = await proposeVendor({ raw: GOOD, by: DEALER, note: "New supplier." });
  check("it is accepted", made.ok === true);
  if (!made.ok) throw new Error("cannot continue");
  const id = made.vendor.id;
  MADE.push(id);
  check("…as pending", made.vendor.status === "pending");
  check("…with nothing approved yet", made.vendor.neverApproved);
  // THE RULE. Until somebody signs it off, the vendor's own fields
  // are empty — the proposed name lives on the revision.
  check("…and the approved record is still blank",
    made.vendor.companyName === "", `"${made.vendor.companyName}"`);
  check("…while the proposal holds the detail",
    made.vendor.pending?.fields.companyName === "Tri-State Chemical");

  console.log("\n3. Approving is the only thing that writes a vendor");
  const live = await decideVendor({
    id, revisionId: made.vendor.pending!.id, approve: true, by: BOSS,
  });
  check("it approves", live.ok === true);
  check("…and the record is now real",
    live.ok && live.vendor.companyName === "Tri-State Chemical");
  check("…marked approved", live.ok && live.vendor.status === "approved");
  check("…by whom", live.ok && live.vendor.approvedBy === BOSS);
  check("…with nothing left waiting", live.ok && live.vendor.pending === null);

  console.log("\n4. A change waits, and the approved record does not move");
  const edit = await proposeVendor({
    id, raw: { ...GOOD, phone: "3045559999", paymentTerms: "Net 45" },
    by: DEALER, note: "New number.",
  });
  check("the change is accepted", edit.ok === true);
  // The whole reason for two tables.
  const during = await getVendor(id);
  check("THE APPROVED RECORD IS UNCHANGED",
    during?.phone === "(304) 555-0133", during?.phone);
  check("…and still reads as approved", during?.status === "approved");
  check("…with the change shown separately",
    during?.pending?.fields.phone === "(304) 555-9999");
  check("…naming what it would change",
    (during?.pending?.changed ?? []).includes("Phone"),
    (during?.pending?.changed ?? []).join(", "));

  console.log("\n5. Sending one back leaves the vendor alone");
  const back = await decideVendor({
    id, revisionId: during!.pending!.id, approve: false, by: BOSS,
    note: "Confirm the number with the supplier first.",
  });
  check("it is sent back", back.ok === true);
  const after = await getVendor(id);
  check("the approved phone is the OLD one", after?.phone === "(304) 555-0133");
  check("…and the vendor is still approved", after?.status === "approved");
  check("…with nothing waiting", after?.pending === null);
  // A rejection with no reason produces a second identical submission.
  const bare = await decideVendor({
    id, revisionId: "1", approve: false, by: BOSS,
  });
  check("rejecting with no reason is refused", bare.ok === false);

  console.log("\n6. Only one change can be waiting");
  await proposeVendor({ id, raw: { ...GOOD, city: "Barboursville" }, by: DEALER });
  const second = await proposeVendor({
    id, raw: { ...GOOD, city: "Milton" }, by: DEALER,
  });
  check("a second proposal supersedes the first",
    second.ok === true && second.superseded);
  const one = await getVendor(id);
  check("…leaving exactly one waiting",
    (one?.history ?? []).filter((r) => r.status === "pending").length === 1);
  check("…and the superseded one says so",
    (one?.history ?? []).some((r) => r.status === "superseded"));
  check("…with the newest content", one?.pending?.fields.city === "Milton");

  console.log("\n7. What stops a reviewer, as against a submitter");
  check("missing paperwork is reported", approvalBlockers({
    ...BLANK_VENDOR, w9OnFile: false, insuranceOnFile: false,
  }).length >= 2);
  check("…including lapsed insurance",
    approvalBlockers({
      ...BLANK_VENDOR, w9OnFile: true, insuranceOnFile: true,
      insuranceExpires: "2001-01-01", taxId: "x", services: "y",
    }).some((b) => /expired/.test(b)));
  check("…and a complete one has nothing to report",
    approvalBlockers({
      ...BLANK_VENDOR, w9OnFile: true, insuranceOnFile: true,
      insuranceExpires: "2099-01-01", taxId: "55-1", services: "Chemicals",
    }).length === 0);
  // Reported, never enforced: approving anyway is a decision.
  const anyway = await decideVendor({
    id, revisionId: one!.pending!.id, approve: true, by: BOSS,
  });
  check("a reviewer can approve despite them", anyway.ok === true);

  console.log("\n8. Removing one keeps it");
  check("a note is required",
    (await deleteVendor({ id, note: "x", by: BOSS })).ok === false);
  await proposeVendor({ id, raw: { ...GOOD, notes: "pending when removed" }, by: DEALER });
  check("it removes", (await deleteVendor({
    id, note: "Contract ended 31 December.", by: BOSS,
  })).ok === true);
  const gone = await getVendor(id);
  check("…and the record is still there", Boolean(gone));
  check("…marked, with the reason", (gone?.deleteNote ?? "").startsWith("Contract"));
  // Nothing may be left waiting on a record nobody will look at.
  check("…and nothing is left waiting on it", gone?.pending === null);
  check("…while its whole history survives", (gone?.history.length ?? 0) >= 5,
    String(gone?.history.length));
  check("it is out of the live list",
    !(await listVendors({ status: "all" })).vendors.some((v) => v.id === id));

  console.log("\n9. Changed fields are named in words");
  check("a changed field is named",
    changedFields(BLANK_VENDOR, { ...BLANK_VENDOR, taxId: "1" })
      .join(",") === "Tax ID (EIN)");
  check("…and an unchanged record names none",
    changedFields(BLANK_VENDOR, BLANK_VENDOR).length === 0);
} finally {
  await db().query("DELETE FROM dm_vendors WHERE id = ANY($1::uuid[])", [MADE])
    .catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
