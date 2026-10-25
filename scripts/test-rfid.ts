/**
 * The RFID pool: no duplicates, and each number issued exactly once.
 *
 *   pnpm exec tsx scripts/test-rfid.ts
 *
 * A number here is a physical tag. Two of the rules come from that rather
 * than from the schema — there is one of each, and once it has been issued
 * it cannot be issued again — and both have a failure mode that cannot be
 * undone by hand afterwards: two vehicles carrying the same tag.
 *
 * So the interesting cases are not the happy path. They are the second
 * upload of an overlapping file, the repeat inside one file, and two
 * requests for the same tag arriving together.
 */
import { zipSync, strToU8 } from "fflate";
import { parseRfidFile, readCell } from "../server/dutch-miller/rfid-parse.js";
import {
  addRfids, deleteRfids, listRfids, rfidCounts, setRfidActive, useRfid,
} from "../server/dutch-miller/rfid.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

/** A minimal .xlsx: shared strings plus one sheet referencing them. */
function xlsxOf(values: string[]): Buffer {
  const si = values.map((v) => `<si><t>${v}</t></si>`).join("");
  const rows = values
    .map((_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>${i}</v></c></row>`)
    .join("");
  return Buffer.from(zipSync({
    "xl/sharedStrings.xml": strToU8(
      `<?xml version="1.0"?><sst count="${values.length}">${si}</sst>`),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`),
  }));
}

const N = (i: number) => `1${String(10000 + i).slice(-4)}+${String(100000 + i).slice(-6)}`;
const MINE: string[] = [];
const mine = (i: number) => { const n = N(i); MINE.push(n); return n; };

try {
  console.log("1. Reading a cell");
  check("the canonical form", readCell("12345+678901").number === "12345+678901");
  check("bare 11 digits gain the separator", readCell("12345678901").number === "12345+678901");
  check("quotes and spaces are not part of the number",
    readCell(' "12345+678901" ').number === "12345+678901");
  check("a dash used as the separator", readCell("12345-678901").number === "12345+678901");
  check("a blank cell is not a reject", readCell("   ").problem === null);
  // Furniture, not a reject: a header, a notes column and a sheet title
  // all reach here, and reporting them buries the rows that need fixing.
  check("a header row is furniture, not a problem", readCell("RFID").problem === null);
  check("…and so is text carrying a digit", readCell("Vehicle 42").problem === null);
  check("but digits of the wrong length ARE a problem",
    readCell("12345+6789").problem !== null);
  // The one that must NOT be guessed at. Ten digits is Excel dropping a
  // leading zero, and padding it back invents a tag that may be somebody
  // else's.
  const short = readCell("1234567890");
  check("10 digits is refused, never padded", short.number === null);
  check("…and says it is Excel dropping a leading zero",
    /leading zero/i.test(short.problem ?? ""), short.problem ?? "");

  console.log("\n2. Reading a file");
  const csv = parseRfidFile(Buffer.from(
    `RFID,Notes\n"${N(1)}",first\n${N(2)},second\n\n${N(1)},repeat\n`));
  check("the numbers come out", csv.numbers.length === 3, csv.numbers.join(" "));
  check("…including the repeat, for counting later",
    csv.numbers.filter((n) => n === N(1)).length === 2);
  // Words are furniture, not rejects: every cell is read so nobody has to
  // name a column, and a Notes column would otherwise bury the real ones.
  check("a header row and a notes column are not reported as problems",
    csv.rejected.length === 0, JSON.stringify(csv.rejected));
  const typo = parseRfidFile(Buffer.from("12345+6789\nVehicle 42\n"));
  check("…but a mistyped number IS", typo.rejected.length === 1,
    JSON.stringify(typo.rejected));
  const xl = parseRfidFile(xlsxOf([N(3), "not a tag", N(4)]));
  check("an .xlsx reads the same way", xl.numbers.join(",") === `${N(3)},${N(4)}`,
    xl.numbers.join(","));

  console.log("\n3. Duplicates in the file are identified and removed");
  const first = await addRfids(
    [mine(1), mine(2), N(1), mine(3)], [], 4, "test@example.invalid");
  check("each number is stored once", first.added === 3, String(first.added));
  check("the repeat is reported", first.duplicatesInFile.length === 1);
  check("…with how many copies there were",
    first.duplicatesInFile[0]?.copies === 2, JSON.stringify(first.duplicatesInFile));

  console.log("\n4. A second file that overlaps the pool");
  // Normal, not a mistake — but it must not re-add, and above all must not
  // reset anything.
  const second = await addRfids([N(1), mine(4)], [], 2, "test@example.invalid");
  check("only the new one is added", second.added === 1, String(second.added));
  check("the one already held is reported", second.alreadyHeld.length === 1);
  check("…with the state it is in",
    second.alreadyHeld[0]?.status === "active", JSON.stringify(second.alreadyHeld));

  console.log("\n5. Issued once, and only once");
  const got = await useRfid(N(1), "eric@example.invalid", "Vehicle 42");
  check("the first claim succeeds", got.ok === true);
  check("…and records who and what for",
    got.ok && got.row.usedBy === "eric@example.invalid" && got.row.usedFor === "Vehicle 42");
  const again = await useRfid(N(1), "paul@example.invalid", "Vehicle 43");
  check("the second claim is refused", again.ok === false);
  check("…saying who already has it",
    !again.ok && /already used/i.test(again.reason) && /eric@/.test(again.reason),
    again.ok ? "" : again.reason);

  console.log("\n6. Two claims arriving together");
  // The guard is inside the UPDATE, so the database picks a winner. A read
  // followed by a write would let both through.
  const race = await Promise.all([
    useRfid(N(2), "a@example.invalid", "A"),
    useRfid(N(2), "b@example.invalid", "B"),
  ]);
  check("exactly one wins", race.filter((r) => r.ok).length === 1,
    JSON.stringify(race.map((r) => r.ok)));

  console.log("\n7. Holding a number back, and putting it in play");
  check("an unused number can be made inactive",
    (await setRfidActive([N(3)], false)).changed === 1);
  check("…and active again", (await setRfidActive([N(3)], true)).changed === 1);
  // The rule the whole feature rests on. Reactivating a used tag would put
  // a number already on a vehicle back into the pool.
  const reactivate = await setRfidActive([N(1)], true);
  check("a USED number cannot be made active", reactivate.changed === 0);
  check("…and the refusal is counted, not silent", reactivate.refusedUsed === 1);
  const stillUsed = await listRfids({ search: N(1), limit: 1 });
  check("…so it is still used", stillUsed.rows[0]?.status === "used");

  console.log("\n8. Counts and filtering");
  const counts = await rfidCounts();
  check("used is counted apart from active", counts.used >= 2, JSON.stringify(counts));
  const onlyUsed = await listRfids({ status: "used", limit: 500 });
  check("filtering by status returns only those",
    onlyUsed.rows.every((r) => r.status === "used"));
  check("a number not in the pool cannot be issued",
    !(await useRfid("99999+999999", "x@example.invalid", "")).ok);
  console.log("\n9. A file is all or nothing");
  // The route refuses the whole file when any cell is an unreadable
  // attempt at a number, so this checks the parser gives it the two
  // facts that decision needs: what could be read, and what could not.
  const mixedFile = parseRfidFile(Buffer.from(
    `RFID\n${N(7)}\n1234567890\n${N(8)}\n`, "utf8"));
  check("the readable ones are still reported",
    mixedFile.numbers.length === 2, String(mixedFile.numbers.length));
  check("…and so is the one that is not", mixedFile.rejected.length === 1);
  check("…with a reason somebody can act on",
    /leading zero/i.test(mixedFile.rejected[0]?.problem ?? ""),
    mixedFile.rejected[0]?.problem ?? "");
  // Headers and notes are furniture, not errors — refusing a file for
  // having a title row would make the rule unusable.
  const tidy = parseRfidFile(Buffer.from(`Tag numbers\nRFID\n${N(9)}\nVehicle 42\n`, "utf8"));
  check("a header and a note are not failures", tidy.rejected.length === 0,
    JSON.stringify(tidy.rejected));
  check("…and the real number is still found", tidy.numbers.length === 1);

  /*
   * 10. Removing a number from the pool.
   *
   * The dangerous mistake here is the opposite of the one for member
   * records: a deleted tag must NOT come back. A number that quietly
   * returned to the pool — on a re-upload of the same file, say —
   * could be issued to a second vehicle while the first one still
   * carries the sticker, and that cannot be undone by hand.
   */
  console.log("\n10. Removing a number keeps the row");
  const doomed = mine(40);
  await addRfids([doomed], [], 1, "boss@example.invalid");
  const noNote = await deleteRfids({ numbers: [doomed], note: "x", by: "boss@example.invalid" });
  check("a note is required", "error" in noNote);
  const went = await deleteRfids({
    numbers: [doomed], note: "Damaged in the October batch.", by: "boss@example.invalid",
  });
  check("it removes one", !("error" in went) && went.deleted === 1);
  const marked = (await listRfids({ status: "deleted", search: doomed })).rows
    .find((r) => r.number === doomed);
  check("…and the row is STILL THERE", Boolean(marked));
  check("…with who and why",
    marked?.deletedBy === "boss@example.invalid"
    && (marked?.deleteNote ?? "").startsWith("Damaged"));
  check("removing it twice changes nothing",
    !("error" in (await deleteRfids({
      numbers: [doomed], note: "again, for the record", by: "boss@example.invalid",
    })) ) );

  console.log("\n11. A removed number is out of the pool, and stays out");
  check("it is not in the active list",
    !(await listRfids({ status: "active", search: doomed })).rows
      .some((r) => r.number === doomed));
  check("…nor in All", !(await listRfids({ status: "all", search: doomed })).rows
    .some((r) => r.number === doomed));
  check("…and cannot be issued",
    !(await useRfid(doomed, "x@example.invalid", "")).ok);
  check("…saying it was removed",
    /removed from the pool/i.test(
      ((await useRfid(doomed, "x@example.invalid", "")) as { reason?: string }).reason ?? ""));
  // The one that would be easy to get wrong: uploading the same file
  // again must not resurrect it.
  const reupload = await addRfids([doomed], [], 1, "boss@example.invalid");
  check("re-uploading the file does not bring it back", reupload.added === 0);
  check("…and says so", reupload.alreadyHeld.some((h) => h.number === doomed && h.deleted));
  check("…it is still deleted",
    !(await listRfids({ status: "active", search: doomed })).rows
      .some((r) => r.number === doomed));
  check("holding it back does not revive it either",
    (await setRfidActive([doomed], true)).changed === 0);
  const tally = await rfidCounts();
  check("deleted numbers are counted apart from the pool", tally.deleted >= 1,
    JSON.stringify(tally));

} finally {
  await db().query("DELETE FROM dm_rfid WHERE number = ANY($1::text[])",
    [[...MINE, N(1), N(2), N(3), N(4)]]).catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
