/**
 * The sticker: three states, and what each one may not do.
 *
 *   pnpm exec tsx scripts/test-sticker.ts
 *
 * The defect this exists to prevent is specific. A bulk import used to
 * write `sticker_attached = true` because the FILE said YES — a
 * confirmation about a tag that did not exist when it was given, since
 * the number is allocated by the server afterwards. Approval then
 * shipped on a promise nobody was in a position to make.
 *
 * And a boolean could not tell "nobody confirmed it" from "somebody
 * checked and found none", so every record written before the column
 * existed read as the second, which is a claim nobody made.
 */
import {
  confirmSticker, createSignup, getSignup, markOpened, newHandle, setComplete,
} from "../server/dutch-miller/signups.js";
import { addRfids } from "../server/dutch-miller/rfid.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const TAG = (i: number) => `80${String(i).padStart(3, "0")}+8${String(i).padStart(5, "0")}`;
const TAGS = [1, 2, 3].map(TAG);
const GUIDS: string[] = [];
const ME = "tester@example.invalid";
const CSC = "csc@mojocarwash.com";

const entry = (over: Record<string, unknown> = {}) => {
  const h = newHandle();
  GUIDS.push(h.guid);
  return {
    ...h,
    dlwContractId: "0041", firstName: "Dana", lastName: "Reyes",
    vehicleMake: "Ford", vehicleModel: "Bronco", stickerAttached: true,
    rfid: TAGS[0]!,
    ...over,
  };
};

try {
  await db().query(
    `UPDATE dm_rfid SET status = 'active', used_at = NULL, used_by = NULL, used_for = NULL
      WHERE number = ANY($1::text[])`, [TAGS]).catch(() => {});
  await db().query("DELETE FROM dm_member_signups WHERE rfid = ANY($1::text[])", [TAGS])
    .catch(() => {});
  await addRfids(TAGS, [], TAGS.length, ME);

  console.log("1. A typed signup confirms at submission");
  const typed = entry({ rfid: TAGS[0]! });
  const made = await createSignup(typed, ME);
  check("it saves", made.ok === true);
  const row = await getSignup(typed.guid);
  check("the state is confirmed", row?.customer.stickerState === "confirmed");
  check("…with who said so", row?.customer.stickerConfirmedBy === ME);
  check("…and when", Boolean(row?.customer.stickerConfirmedAt));

  console.log("\n2. An IMPORT may not say the sticker is on");
  /*
   * The whole point. The tag is chosen here, inside this call, so at
   * the moment the spreadsheet was written nobody could know which
   * number would land on which car.
   */
  const imported = entry({ rfid: "", firstName: "Sam" });
  const bulk = await createSignup(imported, ME, { assignAnyRfid: true });
  check("it saves", bulk.ok === true, bulk.ok ? "" : JSON.stringify(bulk));
  const bulkRow = await getSignup(imported.guid);
  check("…with a tag allocated", (bulkRow?.customer.rfid ?? "").length > 0);
  check("…and the sticker PENDING, not confirmed",
    bulkRow?.customer.stickerState === "pending",
    bulkRow?.customer.stickerState);
  check("…even though the row claimed stickerAttached",
    bulkRow?.customer.stickerAttached === false);
  check("…and nobody is recorded as having confirmed it",
    bulkRow?.customer.stickerConfirmedAt === null);

  console.log("\n3. Approval waits for a real confirmation");
  await markOpened(imported.guid, CSC);
  const early = await setComplete(imported.guid, CSC);
  check("completing is refused", early.ok === false);
  check("…saying why", !early.ok && early.reason === "sticker-unconfirmed",
    early.ok ? "approved" : early.reason);
  const done = await confirmSticker(imported.guid, "dealer@dutchmiller.example");
  check("confirming works", done.ok === true);
  const confirmed = await getSignup(imported.guid);
  check("…and records who", confirmed?.customer.stickerConfirmedBy === "dealer@dutchmiller.example");
  check("…and when", Boolean(confirmed?.customer.stickerConfirmedAt));
  check("confirming twice is refused",
    (await confirmSticker(imported.guid, ME)).ok === false);
  const now = await setComplete(imported.guid, CSC);
  check("NOW it can be approved", now.ok === true);

  console.log("\n4. A legacy record is not a missing sticker");
  // Exactly the row the brief found: completed, reading "Not confirmed",
  // written before the column existed.
  const legacy = entry({ rfid: TAGS[2]!, firstName: "Old" });
  await createSignup(legacy, ME);
  await db().query(
    `UPDATE dm_member_signups
        SET sticker_attached = false, sticker_state = 'legacy',
            sticker_confirmed_at = NULL, sticker_confirmed_by = NULL
      WHERE guid = $1`, [legacy.guid]);
  const old = await getSignup(legacy.guid);
  check("it reads as legacy, not as unconfirmed", old?.customer.stickerState === "legacy");
  // Not rewritten to true. A confirmation nobody gave is not ours to invent.
  check("…and was NOT backfilled to confirmed",
    old?.customer.stickerAttached === false);
  await markOpened(legacy.guid, CSC);
  const blocked = await setComplete(legacy.guid, CSC);
  check("approving it still needs somebody to look",
    !blocked.ok && blocked.reason === "sticker-unconfirmed",
    blocked.ok ? "approved" : blocked.reason);
  await confirmSticker(legacy.guid, CSC);
  check("…and once they have, it approves",
    (await setComplete(legacy.guid, CSC)).ok === true);
} finally {
  await db().query("DELETE FROM dm_member_signups WHERE guid = ANY($1::uuid[])", [GUIDS])
    .catch(() => {});
  await db().query("DELETE FROM dm_rfid WHERE number = ANY($1::text[])", [TAGS])
    .catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
