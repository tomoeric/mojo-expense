/**
 * Storing what a receipt says was bought.
 *
 *   pnpm exec tsx scripts/test-receipt-items.ts          (needs DATABASE_URL)
 *   pnpm exec tsx scripts/test-receipt-items.ts --live <image.jpg>
 *
 * Without --live this spends no tokens: it exercises the storage, which is
 * where the properties that matter live. One receipt is read once however many
 * expenses share it, a re-read replaces rather than merges, and — the point of
 * the whole feature — the items outlive the image, because an approved
 * expense's receipt is deleted and can never be fetched again.
 *
 * With --live it calls the model on a real image and prints what came back,
 * which is the only way to judge whether the reading is any good.
 */

import fs from "node:fs";
import { db, ensureSchema } from "../server/db.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
const { receiptDetail, detailsForExpenses, unreadReceipts } =
  await import("../server/emburse/receipt-items.js");

// --------------------------------------------------------------- live read
const live = process.argv.indexOf("--live");
if (live !== -1) {
  const path = process.argv[live + 1];
  if (!path || !fs.existsSync(path)) {
    console.error("Usage: --live <image.jpg>");
    process.exit(2);
  }
  const { readReceipt } = await import("../server/emburse/receipt-items.js");
  const reading = await readReceipt(fs.readFileSync(path));
  console.log(`\nmerchant: ${reading.merchant ?? "—"}   date: ${reading.purchasedAt ?? "—"}`);
  for (const i of reading.items) {
    console.log(`  ${i.description.padEnd(44)} ${i.amount === null ? "—" : `$${i.amount.toFixed(2)}`}`);
  }
  console.log(`  ${"subtotal".padEnd(44)} ${reading.subtotal ?? "—"}`);
  console.log(`  ${"tax".padEnd(44)} ${reading.tax ?? "—"}`);
  console.log(`  ${"TOTAL".padEnd(44)} ${reading.total ?? "—"}`);
  if (reading.notes) console.log(`\nnote: ${reading.notes}`);
  process.exit(0);
}

// ------------------------------------------------------------- the storage
const SHA = "ri" + "0".repeat(62);
const A = "ri-expense-a";
const B = "ri-expense-b";

const clean = async () => {
  await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE 'ri%'");
  await db().query("DELETE FROM expense_receipts WHERE dedupe_key LIKE 'ri-%'");
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'ri-%'");
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE 'ri%'");
};
await unreadReceipts(1); // create the tables before tidying up after them
await clean();

/** Store a reading the way extractReceipt does, without calling the model. */
async function store(sha: string, items: [string, number | null][], total: number | null) {
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, legible, merchant, total_cents, notes)
     VALUES ($1,'test',true,'LOWES',$2,'')
     ON CONFLICT (sha256) DO UPDATE SET total_cents = EXCLUDED.total_cents`,
    [sha, total === null ? null : Math.round(total * 100)]);
  await db().query("DELETE FROM receipt_items WHERE sha256 = $1", [sha]);
  let n = 0;
  for (const [description, amount] of items) {
    await db().query(
      `INSERT INTO receipt_items (sha256, line_no, description, amount_cents) VALUES ($1,$2,$3,$4)`,
      [sha, ++n, description, amount === null ? null : Math.round(amount * 100)]);
  }
}

console.log("\n1. Items are stored against the image, not the expense");
await db().query(
  `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents)
   VALUES ($1,'Rajen Spiker','2026-09-18','LOWES',4357), ($2,'Kevin McBride','2026-09-18','LOWES',4357)`,
  [A, B]);
await db().query(
  `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes) VALUES ($1,'image/jpeg',3,'\\x001122')`,
  [SHA]);
await db().query(`INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2), ($3,$2)`, [A, SHA, B]);
await store(SHA, [["8H 6-FT 13-6A HD U-POST", 39.88], ["CONCRETE MIX 50LB", null]], 43.57);

const detail = await receiptDetail(SHA);
check("the reading is found", detail !== null);
check("with one entry per item", detail?.items.length === 2, `${detail?.items.length ?? 0}`);
check("in the order they were printed",
  detail?.items[0]?.description.startsWith("8H 6-FT") === true, detail?.items[0]?.description ?? "");
check("an unreadable amount stays null rather than becoming a guess",
  detail?.items[1]?.amount === null, String(detail?.items[1]?.amount));
check("money comes back in dollars", detail?.total === 43.57, String(detail?.total));

console.log("\n2. One image shared by two expenses is read once");
const both = await detailsForExpenses([A, B]);
check("both expenses see the items", both.get(A)?.[0]?.items.length === 2 && both.get(B)?.[0]?.items.length === 2);
const readings = Number((await db().query(
  "SELECT count(*) c FROM receipt_readings WHERE sha256 = $1", [SHA])).rows[0].c);
check("…from a single stored reading", readings === 1, `${readings}`);

console.log("\n3. Re-reading replaces, never merges");
await store(SHA, [["8H 6-FT 13-6A HD U-POST", 39.88]], 43.57);
const after = await receiptDetail(SHA);
check("the old lines are gone", after?.items.length === 1, `${after?.items.length ?? 0}`);

console.log("\n4. The items outlive the image — the reason to store them");
// Exactly what the approved-receipt cleanup does.
await db().query("DELETE FROM expense_receipts WHERE sha256 = $1", [SHA]);
await db().query("DELETE FROM receipt_blobs WHERE sha256 = $1", [SHA]);
const survived = await receiptDetail(SHA);
check("the reading survives the picture being released", survived !== null);
check("…with its items", survived?.items.length === 1, `${survived?.items.length ?? 0}`);
check("…and its total", survived?.total === 43.57, String(survived?.total));

console.log("\n5. Only unread receipts are queued");
await db().query(
  `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
   VALUES ($1,'image/jpeg',3,'\\x001122'), ($2,'image/jpeg',3,'\\x001122')`,
  [SHA, "ri" + "1".repeat(62)]);
const queued = await unreadReceipts(50);
check("a receipt already read is not queued again", !queued.includes(SHA), SHA.slice(0, 8));
check("…but an unread one is", queued.includes("ri" + "1".repeat(62)));

await clean();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
