/**
 * Storing what a receipt says was bought.
 *
 *   pnpm exec tsx scripts/test-receipt-items.ts            the storage rules
 *   pnpm exec tsx scripts/test-receipt-items.ts --stored   read a real one
 *   pnpm exec tsx scripts/test-receipt-items.ts --stored 7f3a   that one
 *   pnpm exec tsx scripts/test-receipt-items.ts --live photo.jpg
 *
 * All three need DATABASE_URL; the last two also need an Anthropic key.
 *
 * Plain, it spends no tokens: it exercises the storage, which is where the
 * properties that matter live. One receipt is read once however many expenses
 * share it, a re-read replaces rather than merges, and — the point of the
 * whole feature — the items outlive the image, because an approved expense's
 * receipt is deleted and can never be fetched again.
 *
 * `--stored` reads a receipt this app already holds and prints what came back,
 * which is the only way to judge whether the reading is any good. Newest
 * first, or the one whose id starts with what you pass. `--live` does the same
 * for a loose image file, which is rarely what you have.
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

// ------------------------------------------------- read one we already hold
/** Print a reading the way a person wants to check one: as the receipt reads. */
function show(reading: {
  merchant: string | null; purchasedAt: string | null; notes: string;
  items: { description: string; quantity: number | null; amount: number | null }[];
  subtotal: number | null; tax: number | null; tip: number | null; total: number | null;
}) {
  const amount = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
  console.log(`\nmerchant: ${reading.merchant ?? "—"}   date: ${reading.purchasedAt ?? "—"}\n`);
  for (const i of reading.items) {
    const qty = i.quantity !== null && i.quantity !== 1 ? ` x${i.quantity}` : "";
    console.log(`  ${(i.description + qty).slice(0, 52).padEnd(54)}${amount(i.amount).padStart(10)}`);
  }
  if (reading.items.length === 0) console.log("  (no itemised lines on this receipt)");
  console.log(`  ${"".padEnd(54)}${"".padStart(10, "-")}`);
  for (const [label, value] of [["subtotal", reading.subtotal], ["tax", reading.tax],
                                ["tip", reading.tip], ["TOTAL", reading.total]] as const) {
    if (value !== null) console.log(`  ${label.padEnd(54)}${amount(value).padStart(10)}`);
  }
  if (reading.notes) console.log(`\nnote: ${reading.notes}`);
}

const stored = process.argv.indexOf("--stored");
if (stored !== -1) {
  const prefix = (process.argv[stored + 1] ?? "").replace(/[^0-9a-f]/gi, "");
  const { rows } = await db().query<{ sha256: string; byte_size: number }>(
    `SELECT sha256, byte_size FROM receipt_blobs
      WHERE ($1 = '' OR sha256 LIKE $1 || '%')
      ORDER BY created_at DESC LIMIT 1`, [prefix]);
  const blob = rows[0];
  if (!blob) {
    console.error(prefix ? `No stored receipt starts with ${prefix}.` : "No receipts are stored yet.");
    process.exit(2);
  }

  const { extractReceipt, canReadReceipts } = await import("../server/emburse/receipt-items.js");
  if (!canReadReceipts()) {
    // Said here rather than letting the SDK's "could not resolve
    // authentication method" stand in for it.
    console.error(
      "Reading receipts needs an Anthropic key: AI_INTEGRATIONS_ANTHROPIC_API_KEY (Replit's\n" +
      "Anthropic integration) or ANTHROPIC_API_KEY. Without one the background reader stays off too.");
    process.exit(2);
  }
  console.log(`reading ${blob.sha256.slice(0, 12)} (${(blob.byte_size / 1024).toFixed(0)} KB)…`);
  const detail = await extractReceipt(blob.sha256, { force: true });
  if (!detail) {
    console.error("That receipt image is no longer stored.");
    process.exit(1);
  }
  if (detail.error) {
    console.error(`\nCould not read it: ${detail.error}`);
    process.exit(1);
  }
  show(detail);
  console.log(`\nStored against ${detail.sha256.slice(0, 12)} — kept even after the image is released.`);
  process.exit(0);
}

// --------------------------------------------------------------- live read
const live = process.argv.indexOf("--live");
if (live !== -1) {
  const path = process.argv[live + 1];
  if (!path || !fs.existsSync(path)) {
    console.error("Usage: --live path/to/image.jpg");
    process.exit(2);
  }
  const { readReceipt } = await import("../server/emburse/receipt-items.js");
  show(await readReceipt(fs.readFileSync(path)));
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
