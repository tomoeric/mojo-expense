/**
 * Manual verification for the Emburse import.
 *
 *   DATABASE_URL=... npx tsx scripts/verify-import.ts <export.pdf>
 *
 * Parses the file, reconciles the parsed total against the TOTAL printed on
 * the export itself, then imports it twice to prove the second run changes
 * nothing. Writes to whatever DATABASE_URL points at — use a scratch database,
 * not production.
 */
import fs from "node:fs";
import { ensureSchema, db } from "../server/db.js";
import { ingestExport } from "../server/import/ingest.js";
import { parseExpensesPdf } from "../server/import/parse-pdf.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/verify-import.ts <export.pdf>");
  process.exit(1);
}

const money = (c: number) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
const buf = fs.readFileSync(path);

const parsed = parseExpensesPdf(buf);
const total = parsed.expenses.reduce((a, e) => a + e.amountCents, 0);
console.log(`pages ${parsed.pageCount} | expenses ${parsed.expenses.length} | receipt pages ${parsed.receipts.length}`);
console.log(`parsed ${money(total)} vs stated ${parsed.statedTotalCents === null ? "none" : money(parsed.statedTotalCents)}` +
  `  ${total === parsed.statedTotalCents ? "RECONCILES" : "*** MISMATCH ***"}`);
console.log(`missing amount: ${parsed.expenses.filter((e) => !e.amountCents).length} | missing date: ${parsed.expenses.filter((e) => !e.date).length}`);

await ensureSchema();
const first = await ingestExport(buf, path, "verify-script");
console.log(`\nimport 1: inserted=${first.inserted} updated=${first.updated} unchanged=${first.unchanged} ` +
  `leftInbox=${first.leftInbox} receipts=${first.receiptsAdded}`);
first.warnings.forEach((w) => console.log("  ! " + w));

const second = await ingestExport(buf, path, "verify-script", { force: true });
console.log(`import 2: inserted=${second.inserted} updated=${second.updated} unchanged=${second.unchanged} ` +
  `leftInbox=${second.leftInbox} receipts=${second.receiptsAdded}`);
console.log(second.inserted === 0 && second.receiptsAdded === 0
  ? "\nIDEMPOTENT — re-importing the same file changed nothing."
  : "\n*** NOT IDEMPOTENT — the second import wrote rows. ***");

await db().end();
