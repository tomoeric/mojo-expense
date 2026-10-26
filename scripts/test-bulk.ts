/**
 * Bulk member signups from a spreadsheet.
 *
 *   pnpm exec tsx scripts/test-bulk.ts
 *
 * The rule the whole feature rests on is ALL OR NOTHING. Every accepted
 * row spends an RFID tag permanently, so a file that half-imports
 * leaves tags issued against members who are not there and no way to
 * tell which half landed except by reading both. The parser therefore
 * writes nothing and claims nothing; it either says the file is good or
 * says exactly what is wrong with it.
 *
 * Also checked: a quoted field containing a comma, which is what Excel
 * writes the moment somebody types a colour like "Blue, Metallic" — get
 * that wrong and every later column shifts by one and the import is
 * confidently incorrect.
 */
import { BULK_COLUMNS, parseBulk, splitCsvLine, templateCsv } from "../server/dutch-miller/bulk.js";
import { createSignup, getSignup, newHandle } from "../server/dutch-miller/signups.js";
import { addRfids } from "../server/dutch-miller/rfid.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const HEAD = BULK_COLUMNS.map((c) => c.header).join(",");
/** Every example row needs the attestation, as a real file would. */
const TAG = (i: number) => `70${String(i).padStart(3, "0")}+7${String(i).padStart(5, "0")}`;
const TAGS = [1, 2, 3].map(TAG);
const GUIDS: string[] = [];

try {
  console.log("1. Splitting a line");
  check("plain fields", splitCsvLine("a,b,c").join("|") === "a|b|c");
  check("a quoted field holding a comma",
    splitCsvLine('a,"Blue, Metallic",c').join("|") === "a|Blue, Metallic|c",
    splitCsvLine('a,"Blue, Metallic",c').join("|"));
  check("a doubled quote inside one",
    splitCsvLine('a,"say ""hi""",c')[1] === 'say "hi"');
  check("an empty field is kept, not dropped",
    splitCsvLine("a,,c").length === 3);

  console.log("\n2. The template is importable as-is");
  const t = parseBulk(templateCsv());
  check("it parses", t.ok === true, JSON.stringify(t.fileErrors.concat(
    t.rows.flatMap((r) => Object.values(r.errors)))));
  check("…with one example row", t.rows.length === 1);
  check("…and no RFID column, because the pool assigns those",
    !HEAD.toLowerCase().includes("rfid"));

  console.log("\n3. A file that is not usable at all");
  check("empty", parseBulk("").fileErrors.length === 1);
  check("headers but no rows", parseBulk(HEAD).fileErrors.some((f) => /no rows/.test(f)));
  const missing = parseBulk("First Name,Last Name\nDana,Reyes");
  check("a missing required column is named",
    missing.fileErrors.some((f) => f.includes("DLW Contract ID")),
    missing.fileErrors.join(" "));
  check("…and nothing is offered for import", missing.rows.length === 0);

  console.log("\n4. One bad row refuses the whole file");
  const mixed = parseBulk(
    `${HEAD}\n0041,,,Dana,Reyes,,,,,,,,\n0042,,,,Jones,,,,,,,,\n`);
  check("the file is refused", mixed.ok === false);
  check("…and BOTH rows still come back, so the good one is not hidden",
    mixed.rows.length === 2);
  check("the bad row is named by line", mixed.rows[1]!.line === 3, String(mixed.rows[1]!.line));
  check("…and by column", Boolean(mixed.rows[1]!.errors["First Name"]),
    Object.keys(mixed.rows[1]!.errors).join(","));
  check("the good row carries no errors",
    Object.keys(mixed.rows[0]!.errors).length === 0);

  console.log("\n5. Field rules match the form's");
  const bad = parseBulk(`${HEAD}\n0041,,,Dana,Reyes,,,ABC123,ZZ,99,Ford,Bronco,Blue\n`);
  check("a state that is not one", Boolean(bad.rows[0]!.errors.State));
  check("a two-digit year", Boolean(bad.rows[0]!.errors["Vehicle Year"]));
  const ok = parseBulk(`${HEAD}\n0041,,,Dana,Reyes,,,ABC123,wv,2024,Ford,Bronco,Blue\n`);
  check("a lower-case state is accepted and lifted",
    ok.ok && ok.rows[0]!.values.plateState === "WV", ok.rows[0]!.values.plateState);
  check("leading zeros survive", ok.rows[0]!.values.dlwContractId === "0041");

  console.log("\n6. The same plate twice");
  // Nearly always one car entered twice. Catching it costs nothing
  // here and costs a tag afterwards.
  const dupe = parseBulk(
    `${HEAD}\n0041,,,Dana,Reyes,,,ABC123,WV,,,,\n0042,,,Sam,Lee,,,abc123,WV,,,,\n`);
  check("is refused", dupe.ok === false);
  check("…pointing at the first one", /row 2/.test(dupe.rows[1]!.errors.Plate ?? ""),
    dupe.rows[1]!.errors.Plate ?? "");
  check("the same plate in a different state is fine",
    parseBulk(`${HEAD}\n0041,,,Dana,Reyes,,,ABC123,WV,,,,\n0042,,,Sam,Lee,,,ABC123,OH,,,,\n`).ok);

  console.log("\n6b. An import cannot attest to a sticker");
  /*
   * The column is GONE, and that is the fix rather than a regression.
   *
   * It used to be required to say YES — a confirmation about a tag that
   * did not exist when it was given, because the number is allocated
   * by the server after the file is written. Nobody filling in a
   * spreadsheet can know which sticker goes on which windshield.
   */
  check("there is no Sticker Attached column",
    !BULK_COLUMNS.some((c) => (c.header as string) === "Sticker Attached"),
    BULK_COLUMNS.map((c) => c.header).join(","));
  check("…nor in the template", !templateCsv().includes("Sticker"));
  const plain = parseBulk(`${HEAD}\n0041,,,Dana,Reyes,,,,,,,,\n`);
  check("a row without one is accepted", plain.ok === true,
    JSON.stringify(plain.rows[0]?.errors));
  // Somebody will still put the old column in a file they kept.
  const stale = parseBulk(
    `${HEAD},Sticker Attached\n0041,,,Dana,Reyes,,,,,,,,\n`);
  check("an old file with the column still imports", stale.ok === true,
    JSON.stringify(stale.rows[0]?.errors));
  check("…and the column is simply ignored",
    !JSON.stringify(stale.rows[0]!.values).includes("YES"));

  console.log("\n7. Column order and extra columns");
  const shuffled = parseBulk(
    "Last Name,Nickname,First Name,DLW Contract ID\nReyes,Dan,Dana,0041\n");
  check("headers in any order", shuffled.ok === true,
    JSON.stringify(shuffled.rows[0]?.errors));
  check("…read from the right columns",
    shuffled.rows[0]!.values.firstName === "Dana"
      && shuffled.rows[0]!.values.dlwContractId === "0041");
  check("an unknown column is ignored, not an error", shuffled.fileErrors.length === 0);

  console.log("\n8. Committing takes the next free tag");
  // Same reason as test-signups: a run that died before its cleanup
  // must not fail the next one on its own leftovers.
  await db().query(
    `UPDATE dm_rfid SET status = 'active', used_at = NULL, used_by = NULL, used_for = NULL
      WHERE number = ANY($1::text[])`, [TAGS]).catch(() => {});
  await db().query(
    "DELETE FROM dm_member_signups WHERE rfid = ANY($1::text[])", [TAGS]).catch(() => {});
  await addRfids(TAGS, [], TAGS.length, "bulk-test@example.invalid");
  const row = {
    dlwContractId: "0041", firstName: "Dana", lastName: "Reyes", stickerAttached: true,
  };
  const h1 = newHandle();
  GUIDS.push(h1.guid);
  const first = await createSignup({ ...row, ...h1, rfid: "" }, "bulk@example.invalid",
    { assignAnyRfid: true });
  check("it saves without naming a tag", first.ok === true,
    first.ok ? "" : JSON.stringify(first));
  check("…and a tag was assigned", first.ok && TAGS.includes(first.row.customer.rfid),
    first.ok ? first.row.customer.rfid : "");
  check("…and that tag is now used", (await db().query<{ status: string }>(
    "SELECT status FROM dm_rfid WHERE number = $1",
    [first.ok ? first.row.customer.rfid : ""])).rows[0]?.status === "used");

  const h2 = newHandle();
  GUIDS.push(h2.guid);
  const second = await createSignup({ ...row, ...h2, rfid: "" }, "bulk@example.invalid",
    { assignAnyRfid: true });
  check("the next row takes a DIFFERENT tag",
    second.ok && first.ok && second.row.customer.rfid !== first.row.customer.rfid,
    second.ok && first.ok ? `${first.row.customer.rfid} vs ${second.row.customer.rfid}` : "");

  console.log("\n9. Two rows landing together");
  // The whole reason the claim is FOR UPDATE SKIP LOCKED rather than a
  // read followed by a write.
  const pair = await Promise.all([newHandle(), newHandle()].map((h) => {
    GUIDS.push(h.guid);
    return createSignup({ ...row, ...h, rfid: "" }, "bulk@example.invalid",
      { assignAnyRfid: true });
  }));
  const got = pair.filter((r) => r.ok);
  check("one succeeds on the last tag", got.length >= 1, JSON.stringify(
    pair.map((r) => (r.ok ? r.row.customer.rfid : r.kind))));
  const used = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_rfid WHERE status = 'used' AND number = ANY($1::text[])",
    [TAGS]);
  check("…and no tag goes to two members", Number(used.rows[0]?.n ?? 0) <= TAGS.length,
    used.rows[0]?.n);
  const distinct = await db().query<{ n: string }>(
    `SELECT count(DISTINCT rfid) AS n FROM dm_member_signups WHERE guid = ANY($1::uuid[])`,
    [GUIDS]);
  const saved = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM dm_member_signups WHERE guid = ANY($1::uuid[])`, [GUIDS]);
  check("every saved member has a tag of their own",
    distinct.rows[0]?.n === saved.rows[0]?.n,
    `${distinct.rows[0]?.n} tags for ${saved.rows[0]?.n} members`);

  console.log("\n10. An empty pool");
  const h5 = newHandle();
  GUIDS.push(h5.guid);
  await db().query("UPDATE dm_rfid SET status = 'inactive' WHERE status = 'active'");
  const none = await createSignup({ ...row, ...h5, rfid: "" }, "bulk@example.invalid",
    { assignAnyRfid: true });
  check("is refused rather than silently skipped", !none.ok);
  check("…saying what to do about it",
    !none.ok && none.kind === "rfid-taken" && /no active RFID/i.test(none.reason),
    none.ok ? "" : none.kind);
  check("…and no member was created", (await getSignup(h5.guid)) === null);
} finally {
  await db().query("DELETE FROM dm_member_signups WHERE guid = ANY($1::uuid[])", [GUIDS])
    .catch(() => {});
  await db().query("DELETE FROM dm_rfid WHERE number = ANY($1::text[])", [TAGS]).catch(() => {});
  await db().query("UPDATE dm_rfid SET status = 'active' WHERE status = 'inactive'")
    .catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
