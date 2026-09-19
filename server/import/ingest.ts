import type pg from "pg";
import * as mupdf from "mupdf";
import { db } from "../db.js";
import { parseExpensesPdf, type ParsedExpense, type ParsedReceipt } from "./parse-pdf.js";
import { dedupeKey, sha256 } from "./key.js";

/**
 * Ingest one daily Emburse export.
 *
 * The file is a snapshot of the Emburse INBOX, re-exported each day. Most of
 * it is therefore a repeat of yesterday, which drives three rules:
 *
 *   1. An expense already known by its dedupe key is UPDATED, never inserted
 *      again — that is what keeps duplicates out.
 *   2. An expense previously in the inbox but absent from today's file has
 *      been processed upstream. It is marked `in_inbox = false`, never
 *      deleted; the record and its receipts are kept.
 *   3. Receipt images are stored once by content hash. The same receipt
 *      arrives every day and may belong to several rows (a purchase split
 *      across sites), so bytes are written only the first time they are seen.
 *
 * The whole import runs in one transaction: either the file lands completely
 * or the database is untouched.
 */

export type ImportResult = {
  importId: number | null;
  filename: string;
  pageCount: number;
  parsedRows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  leftInbox: number;
  receiptsAdded: number;
  receiptsSkipped: number;
  totalCents: number;
  statedTotalCents: number | null;
  reconciled: boolean;
  /** True when this exact file had already been imported; nothing was written. */
  duplicateFile: boolean;
  warnings: string[];
};

export async function ingestExport(
  file: Buffer,
  filename: string,
  importedBy: string,
  opts: {
    force?: boolean;
    /** Reuse an existing parse instead of re-reading the file. */
    parsed?: ReturnType<typeof parseExpensesPdf>;
    /** Override the file identity, when the same bytes stand in for a later export. */
    fileHash?: string;
  } = {},
): Promise<ImportResult> {
  const fileHash = opts.fileHash ?? sha256(file);
  const parsed = opts.parsed ?? parseExpensesPdf(file);
  const warnings: string[] = [];

  const totalCents = parsed.expenses.reduce((a, e) => a + e.amountCents, 0);
  const reconciled = parsed.statedTotalCents !== null && totalCents === parsed.statedTotalCents;
  if (parsed.statedTotalCents === null) {
    warnings.push("No TOTAL line was found on page 1, so the parse could not be reconciled against the file's own figure.");
  } else if (!reconciled) {
    warnings.push(
      `Parsed total ${money(totalCents)} does not match the ${money(parsed.statedTotalCents)} printed on the export — ` +
        `rows may be missing. Imported anyway; check before relying on the figures.`,
    );
  }

  const base: ImportResult = {
    importId: null, filename, pageCount: parsed.pageCount, parsedRows: parsed.expenses.length,
    inserted: 0, updated: 0, unchanged: 0, leftInbox: 0, receiptsAdded: 0, receiptsSkipped: 0,
    totalCents, statedTotalCents: parsed.statedTotalCents, reconciled, duplicateFile: false, warnings,
  };

  if (parsed.expenses.length === 0) {
    throw new Error("No expense rows were found. Is this the Emburse Spend 'Expenses' export?");
  }

  const client = await db().connect();
  try {
    await client.query("BEGIN");

    // Re-uploading the identical file is a no-op rather than a second import.
    if (!opts.force) {
      const seen = await client.query<{ id: string }>(
        "SELECT id FROM expense_imports WHERE file_sha256 = $1 LIMIT 1", [fileHash]);
      if (seen.rowCount) {
        await client.query("ROLLBACK");
        return { ...base, importId: Number(seen.rows[0]!.id), duplicateFile: true,
          warnings: [...warnings, "This exact file has already been imported; nothing was changed."] };
      }
    }

    const imp = await client.query<{ id: string }>(
      `INSERT INTO expense_imports (filename, file_sha256, imported_by, page_count, parsed_rows,
                                    total_cents, stated_total_cents, reconciled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [filename, fileHash, importedBy, parsed.pageCount, parsed.expenses.length,
       totalCents, parsed.statedTotalCents, reconciled]);
    const importId = Number(imp.rows[0]!.id);

    const keys = new Map<string, ParsedExpense>();
    for (const e of parsed.expenses) keys.set(dedupeKey(e), e);
    if (keys.size !== parsed.expenses.length) {
      warnings.push(
        `${parsed.expenses.length - keys.size} rows share a dedupe key and were collapsed. ` +
          `Two expenses are identical in employee, date, merchant, amount, category, location and department.`,
      );
    }

    // Classify before writing. Postgres cannot expose the pre-update row in
    // RETURNING (EXCLUDED is only valid inside SET), so read the existing
    // rows once and diff in code — clearer than contorting the statement.
    const existing = new Map<string, Record<string, unknown>>();
    const prior = await client.query<{ dedupe_key: string } & Record<string, unknown>>(
      `SELECT dedupe_key, note, method, receipt_label, source_page, in_inbox
         FROM expenses WHERE dedupe_key = ANY($1::text[])`,
      [[...keys.keys()]]);
    for (const row of prior.rows) existing.set(row.dedupe_key, row);

    let inserted = 0, updated = 0, unchanged = 0;
    for (const [key, e] of keys) {
      const was = existing.get(key);
      if (!was) inserted++;
      else if (
        was.note !== e.note || was.method !== e.method ||
        was.receipt_label !== e.receiptLabel || was.source_page !== e.sourcePage ||
        was.in_inbox === false
      ) updated++;
      else unchanged++;

      await client.query(
        `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                               category, department, location, note, method, receipt_label,
                               in_inbox, first_import_id, last_import_id, source_page)
         VALUES ($1,$2,NULLIF($3,'')::date,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$12,$13)
         ON CONFLICT (dedupe_key) DO UPDATE SET
           note           = EXCLUDED.note,
           method         = EXCLUDED.method,
           receipt_label  = EXCLUDED.receipt_label,
           source_page    = EXCLUDED.source_page,
           in_inbox       = true,
           left_inbox_at  = NULL,
           last_seen_at   = now(),
           last_import_id = EXCLUDED.last_import_id`,
        [key, e.employee, e.date, e.merchant, e.amountCents, e.category, e.department,
         e.location, e.note, e.method, e.receiptLabel, importId, e.sourcePage]);
    }

    // Anything that was in the inbox and is not in this file has moved on.
    const gone = await client.query(
      `UPDATE expenses SET in_inbox = false, left_inbox_at = now()
       WHERE in_inbox = true AND dedupe_key <> ALL($1::text[])`,
      [[...keys.keys()]]);
    const leftInbox = gone.rowCount ?? 0;

    const receipts = await storeReceipts(client, file, parsed.receipts, keys, warnings);

    await client.query(
      `UPDATE expense_imports SET inserted_count=$2, updated_count=$3, unchanged_count=$4,
              left_inbox_count=$5, receipts_added=$6 WHERE id=$1`,
      [importId, inserted, updated, unchanged, leftInbox, receipts.added]);

    await client.query("COMMIT");
    return { ...base, importId, inserted, updated, unchanged, leftInbox,
      receiptsAdded: receipts.added, receiptsSkipped: receipts.skipped, warnings };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Render each receipt page and attach it to the expenses its caption names.
 *
 * A caption gives employee + amount + date, which is not always unique — the
 * split-across-sites case matches several rows — so the receipt is linked to
 * every expense it matches. The bytes are still written only once.
 */
async function storeReceipts(
  client: pg.PoolClient,
  file: Buffer,
  receipts: ParsedReceipt[],
  keys: Map<string, ParsedExpense>,
  warnings: string[],
): Promise<{ added: number; skipped: number }> {
  if (receipts.length === 0) return { added: 0, skipped: 0 };

  const byCaption = new Map<string, string[]>();
  for (const [key, e] of keys) {
    const k = caption(e.employee, e.amountCents, e.date);
    (byCaption.get(k) ?? byCaption.set(k, []).get(k)!).push(key);
  }

  const doc = mupdf.Document.openDocument(file, "application/pdf");
  let added = 0, skipped = 0, unmatched = 0;

  for (const r of receipts) {
    const matches = byCaption.get(caption(r.employee, r.amountCents, r.date));
    if (!matches?.length) {
      unmatched++;
      continue;
    }

    const png = renderPage(doc, r.page - 1);
    const hash = sha256(png);

    const ins = await client.query(
      `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
       VALUES ($1,'image/jpeg',$2,$3) ON CONFLICT (sha256) DO NOTHING`,
      [hash, png.length, png]);
    if (ins.rowCount === 0) skipped++;

    for (const key of matches) {
      const link = await client.query(
        `INSERT INTO expense_receipts (dedupe_key, sha256, source_page)
         VALUES ($1,$2,$3) ON CONFLICT (dedupe_key, sha256) DO NOTHING`,
        [key, hash, r.page]);
      if (link.rowCount) added++;
    }
  }

  if (unmatched > 0) {
    warnings.push(`${unmatched} receipt pages could not be matched to an expense row and were skipped.`);
  }
  return { added, skipped };
}

/**
 * Render a receipt page to JPEG.
 *
 * Encoding matters more than it looks: the same pages as PNG at 2x came to
 * 375 KB each — 80 MB for one import, against 8.7 MB of original JPEGs in the
 * PDF. JPEG at 1.5x lands at ~58 KB, close to source size, while 918x1188 px
 * stays sharp enough to read a receipt total (which the amount check needs).
 */
const RECEIPT_SCALE = 1.5;
const RECEIPT_QUALITY = 80;

function renderPage(doc: mupdf.Document, index: number): Buffer {
  const pixmap = doc
    .loadPage(index)
    .toPixmap(mupdf.Matrix.scale(RECEIPT_SCALE, RECEIPT_SCALE), mupdf.ColorSpace.DeviceRGB, false, true);
  const jpeg = Buffer.from(pixmap.asJPEG(RECEIPT_QUALITY, false));
  pixmap.destroy();
  return jpeg;
}

const caption = (employee: string, cents: number, date: string) =>
  `${employee.trim().toLowerCase()}|${cents}|${date}`;

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
