/**
 * Member signups: one member, one tag, exactly once.
 *
 *   pnpm exec tsx scripts/test-signups.ts
 *
 * The failure that matters here cannot be undone by hand: two members
 * holding the same RFID tag, or a tag marked used with no member behind
 * it. So the cases below are the ones where that could happen — the same
 * entry submitted twice, two entries racing for one tag, and a tag that
 * stopped being available while the form was open — rather than the happy
 * path, which has nothing to get wrong.
 *
 * Also checked: the generated date, time and GUID really are the server's.
 * "Read-only" in a form is a styling choice until the server refuses to
 * take a client's word for them.
 */
import {
  createSignup, getSignup, isMojoStaff, listSignups, newHandle, setComplete,
  validateSignup,
} from "../server/dutch-miller/signups.js";
import { addRfids } from "../server/dutch-miller/rfid.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

/** Tags of our own, cleaned up at the end. */
const TAG = (i: number) => `90${String(i).padStart(3, "0")}+9${String(i).padStart(5, "0")}`;
const TAGS = [1, 2, 3, 4, 5].map(TAG);
const GUIDS: string[] = [];

const entry = (over: Record<string, string> = {}) => {
  const h = newHandle();
  GUIDS.push(h.guid);
  return {
    ...h,
    dlwContractId: "0041", dealNumber: "00712", customerId: "C-9",
    firstName: "Dana", lastName: "Reyes",
    plateDlw: "", vehicleMake: "Ford", vehicleModel: "Bronco",
    vehicleYear: "2024", vehicleColor: "Blue",
    rfid: TAGS[0]!,
    ...over,
  };
};

const ME = "tester@example.invalid";

try {
  await addRfids(TAGS, [], TAGS.length, ME);

  console.log("1. Validation, field by field");
  const empty = validateSignup({});
  check("the six required fields are named", Object.keys(empty.errors).length === 6,
    Object.keys(empty.errors).join(","));
  check("a three-digit year is refused",
    Boolean(validateSignup({ vehicleYear: "202" }).errors.vehicleYear));
  check("…and a blank one is not", !validateSignup({ vehicleYear: "" }).errors.vehicleYear);
  check("an RFID that is not one is refused",
    Boolean(validateSignup({ rfid: "nope" }).errors.rfid));
  const trimmed = validateSignup({ dlwContractId: "  0041  ", customerId: " C-9 " });
  check("surrounding space goes", trimmed.clean.dlwContractId === "0041",
    JSON.stringify(trimmed.clean.dlwContractId));
  check("…and the leading zero stays", trimmed.clean.dlwContractId.startsWith("0"));

  console.log("\n2. The generated values are the server's");
  const forged = await createSignup(
    { ...entry(), guid: "11111111-1111-4111-8111-111111111111", token: "made-up" }, ME);
  check("a GUID the server never minted is refused",
    forged.ok === false && forged.kind === "bad-handle",
    forged.ok ? "accepted" : forged.kind);
  const moved = entry();
  const tampered = await createSignup(
    { ...moved, createdAt: new Date(0).toISOString() }, ME);
  check("a creation time changed in flight is refused",
    tampered.ok === false && tampered.kind === "bad-handle");

  console.log("\n3. One signup, one tag");
  const one = entry({ rfid: TAGS[0]! });
  const made = await createSignup(one, ME);
  check("it saves", made.ok === true, made.ok ? "" : JSON.stringify(made));
  if (!made.ok) throw new Error("cannot continue");
  check("the tag is now used", (await db().query<{ status: string }>(
    "SELECT status FROM dm_rfid WHERE number = $1", [TAGS[0]])).rows[0]?.status === "used");
  check("the leading zero survived storage", made.row.dealer.dealNumber === "00712",
    made.row.dealer.dealNumber);
  check("a blank optional field is stored as null", made.row.customer.plateDlw === null);
  check("it is marked submitted to MOJO", Boolean(made.row.submittedAt));
  check("…and NOT marked complete", made.row.completedAt === null);

  console.log("\n4. The same entry submitted twice");
  const again = await createSignup(one, ME);
  check("the second attempt succeeds", again.ok === true);
  check("…reporting that it was already there",
    again.ok === true && again.alreadyExisted === true);
  const howMany = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_member_signups WHERE guid = $1", [one.guid]);
  check("…and there is still exactly one member", howMany.rows[0]?.n === "1",
    howMany.rows[0]?.n);
  const stillOne = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_rfid WHERE status = 'used' AND number = ANY($1::text[])",
    [TAGS]);
  check("…and exactly one tag used", stillOne.rows[0]?.n === "1", stillOne.rows[0]?.n);

  console.log("\n5. A tag that is gone");
  const taken = await createSignup(entry({ rfid: TAGS[0]! }), ME);
  check("a used tag cannot be assigned again",
    taken.ok === false && taken.kind === "rfid-taken",
    taken.ok ? "accepted" : taken.kind);
  check("…and says so in words the form can show",
    !taken.ok && taken.kind === "rfid-taken"
      && /no longer available|already assigned/i.test(taken.reason));
  const none = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_member_signups WHERE rfid = $1", [TAGS[0]]);
  check("…leaving no second member behind", none.rows[0]?.n === "1");

  console.log("\n6. Two entries racing for one tag");
  const racers = [entry({ rfid: TAGS[1]! }), entry({ rfid: TAGS[1]! })];
  const raced = await Promise.all(racers.map((r) => createSignup(r, ME)));
  check("exactly one wins", raced.filter((r) => r.ok).length === 1,
    JSON.stringify(raced.map((r) => (r.ok ? "ok" : r.kind))));
  check("…and the loser is told why",
    raced.some((r) => !r.ok && r.kind === "rfid-taken"));
  const once = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_member_signups WHERE rfid = $1", [TAGS[1]]);
  check("…and the tag belongs to one member", once.rows[0]?.n === "1", once.rows[0]?.n);

  console.log("\n7. A tag held back is not available either");
  await db().query("UPDATE dm_rfid SET status = 'inactive' WHERE number = $1", [TAGS[2]]);
  const held = await createSignup(entry({ rfid: TAGS[2]! }), ME);
  check("a held-back tag is refused", held.ok === false && held.kind === "rfid-taken");
  check("…and stays held back, not used", (await db().query<{ status: string }>(
    "SELECT status FROM dm_rfid WHERE number = $1", [TAGS[2]])).rows[0]?.status === "inactive");

  console.log("\n8. The MOJO-side mark");
  check("a MOJO address is staff", isMojoStaff("eric.s@mojocarwash.com"));
  check("…and a dealer address is not", !isMojoStaff("paul@dutchmiller.example"));
  check("…and a lookalike domain is not",
    !isMojoStaff("someone@notmojocarwash.com.example"));
  const done = await setComplete(one.guid, true, "eric.s@mojocarwash.com");
  check("marking complete records who", done?.completedBy === "eric.s@mojocarwash.com");
  check("…and when", Boolean(done?.completedAt));
  const reopened = await setComplete(one.guid, false, "eric.s@mojocarwash.com");
  check("reopening clears both", reopened?.completedAt === null && reopened?.completedBy === null);

  console.log("\n9. Reading back");
  const got = await getSignup(one.guid);
  check("the three buckets come back grouped",
    got?.dealer.dealNumber === "00712" && got?.customer.vehicleMake === "Ford");
  const listed = await listSignups({ search: "reyes" });
  check("search finds it by name", listed.rows.some((r) => r.guid === one.guid));
  const byTag = await listSignups({ search: TAGS[0]! });
  check("…and by tag", byTag.rows.some((r) => r.guid === one.guid));
  const onlyNew = await listSignups({ status: "new" });
  check("filtering by state returns only those",
    onlyNew.rows.every((r) => r.completedAt === null));
} finally {
  await db().query("DELETE FROM dm_member_signups WHERE guid = ANY($1::uuid[])", [GUIDS])
    .catch(() => {});
  await db().query("DELETE FROM dm_rfid WHERE number = ANY($1::text[])", [TAGS])
    .catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
