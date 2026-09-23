import type pg from "pg";
import * as mupdf from "mupdf";
import { db } from "../db.js";
import { parseExpensesPdf, type ParsedExpense, type ParsedReceipt } from "./parse-pdf.js";
import { dedupeKey, sha256 } from "./key.js";
import { checkAgainstSettings, readSettings } from "./settings.js";
import { nudgeReceiptReader } from "../emburse/receipt-reader.js";
import { ensureTaxonomy, recordTaxonomy, type NewNames } from "./taxonomy.js";

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
  /** Category / location / department names this import put on the list for the first time. */
  newNames: NewNames;
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
    /**
     * The run that produced this file read the section chips and confirmed
     * they matched the configuration.
     *
     * Emburse prints the *grid* search on page 1 — "Section: Inbox, Receipt:
     * Receipts: True" — and never names the chips from the export dialog. So
     * for a file this app produced, the header saying "Inbox" is simply what
     * that line always says, and warning about it fires on every successful
     * run. A warning that is always wrong is worse than no warning: it teaches
     * people to skip the one that matters.
     *
     * The chips are still checked, just earlier and better — by the runner,
     * which reads each one, refuses when it cannot, and verifies the result.
     * This flag says that happened. Files arriving any other way (dropped into
     * uploaded by hand) have had no such check, so they keep the old one.
     */
    sectionsVerified?: boolean;
  } = {},
): Promise<ImportResult> {
  const fileHash = opts.fileHash ?? sha256(file);
  const parsed = opts.parsed ?? parseExpensesPdf(file);
  const warnings: string[] = [];

  // What arrived vs what was asked for. A section chip left in the wrong state
  // yields a well-formed PDF of the wrong rows that passes every other check,
  // so the search line printed on page 1 is the only thing that can catch it.
  warnings.push(
    ...checkAgainstSettings(parsed.header, await readSettings(), {
      sectionsVerified: opts.sectionsVerified ?? false,
    }),
  );

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
    newNames: { category: [], location: [], department: [] },
    totalCents, statedTotalCents: parsed.statedTotalCents, reconciled, duplicateFile: false, warnings,
  };

  if (parsed.expenses.length === 0) {
    throw new Error("No expense rows were found. Is this the Emburse Spend 'Expenses' export?");
  }

  // Outside the transaction: creating the taxonomy table is DDL, and an import
  // that rolls back must not take the table with it.
  await ensureTaxonomy();

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

    // An export older than one already imported would do real damage, quietly.
    // Every row in the file is marked back into the inbox (`in_inbox = true,
    // left_inbox_at = NULL`) and everything absent from it is marked as having
    // left — so yesterday's file resurrects expenses that have since been
    // approved and evicts the ones actually waiting now. Worse once approvals
    // start releasing receipts: a resurrected expense comes back with no
    // receipt to review, and the image cannot be fetched again.
    //
    // Refused rather than warned about, because by the time a warning is read
    // the queue has already been rewritten.
    if (!opts.force) {
      const stale = await olderThanWhatWeHave(client, parsed);
      if (stale) {
        await client.query("ROLLBACK");
        return { ...base, warnings: [...warnings, stale] };
      }
    }

    const imp = await client.query<{ id: string }>(
      `INSERT INTO expense_imports (filename, file_sha256, imported_by, page_count, parsed_rows,
                                    total_cents, stated_total_cents, reconciled, export_sections)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [filename, fileHash, importedBy, parsed.pageCount, parsed.expenses.length,
       totalCents, parsed.statedTotalCents, reconciled, parsed.header?.sections ?? null]);
    const importId = Number(imp.rows[0]!.id);

    // Only unambiguous when the export covered exactly one *named* section.
    // Emburse writes "Inbox" for the unfiltered default view, which is not a
    // section at all — tagging rows with it would add a queue bucket that just
    // duplicates "All waiting".
    const only = parsed.header?.sections.length === 1 ? parsed.header.sections[0]!.trim() : null;
    const section = only && only.toLowerCase() !== "inbox" ? only : null;

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
    const changes: { key: string; field: string; before: string | null; after: string | null }[] = [];

    for (const [key, e] of keys) {
      const was = existing.get(key);
      if (!was) inserted++;
      else {
        // Compare the fields an Emburse edit can actually move. The dedupe key
        // covers employee, date, merchant, amount, category, location and
        // department, so a change to any of those makes a different row rather
        // than an edit to this one — there is nothing to diff there.
        const moved = FIELDS.filter(({ was: read, now: take }) => read(was) !== take(e));
        // Source page shifts whenever the export's row order changes, which is
        // most days and means nothing to a reviewer; it is worth detecting as
        // an update but not worth reporting as one.
        const worth = moved.filter((f) => f.report);

        const returned = was.in_inbox === false;
        if (moved.length > 0 || returned) updated++;
        else unchanged++;

        for (const f of worth) {
          changes.push({ key, field: f.label, before: str(f.was(was)), after: str(f.now(e)) });
        }
        if (returned) {
          changes.push({ key, field: "Inbox", before: "left the inbox", after: "back in the inbox" });
        }
      }

      await client.query(
        `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                               category, department, location, note, method, receipt_label,
                               in_inbox, first_import_id, last_import_id, source_page, section)
         VALUES ($1,$2,NULLIF($3,'')::date,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$12,$13,$14)
         ON CONFLICT (dedupe_key) DO UPDATE SET
           note           = EXCLUDED.note,
           method         = EXCLUDED.method,
           receipt_label  = EXCLUDED.receipt_label,
           source_page    = EXCLUDED.source_page,
           in_inbox       = true,
           left_inbox_at  = NULL,
           last_seen_at   = now(),
           last_import_id = EXCLUDED.last_import_id,
           -- Keep a known section rather than letting an all-sections export
           -- blank out what a per-section one established.
           section        = COALESCE(EXCLUDED.section, expenses.section)`,
        [key, e.employee, e.date, e.merchant, e.amountCents, e.category, e.department,
         e.location, e.note, e.method, e.receiptLabel, importId, e.sourcePage, section]);
    }

    if (changes.length > 0) {
      // One statement rather than one per change: an export where a category
      // rename touched every row would otherwise be hundreds of round trips.
      await client.query(
        `INSERT INTO expense_changes (dedupe_key, import_id, field, before_value, after_value)
         SELECT * FROM unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[])`,
        [changes.map((c) => c.key), changes.map(() => importId), changes.map((c) => c.field),
         changes.map((c) => c.before), changes.map((c) => c.after)],
      );
    }

    // Anything that was in the inbox and is not in this file has moved on.
    const gone = await client.query(
      `UPDATE expenses SET in_inbox = false, left_inbox_at = now()
       WHERE in_inbox = true AND dedupe_key <> ALL($1::text[])`,
      [[...keys.keys()]]);
    const leftInbox = gone.rowCount ?? 0;

    // Every name this file carried goes on the permanent lists. Inside the
    // transaction, so names never outlive the rows they came from.
    const newNames = await recordTaxonomy(client, parsed.expenses);

    const receipts = await storeReceipts(client, file, parsed.receipts, keys, warnings);

    // Now that this export has confirmed which expenses left the inbox, the
    // receipts for the ones this app approved are safe to let go of.
    const freed = await dropApprovedReceipts(client);

    // Last, because storeReceipts appends to `warnings` too.
    await client.query("UPDATE expense_imports SET warnings = $2 WHERE id = $1", [importId, warnings]);

    await client.query(
      `UPDATE expense_imports SET inserted_count=$2, updated_count=$3, unchanged_count=$4,
              left_inbox_count=$5, receipts_added=$6 WHERE id=$1`,
      [importId, inserted, updated, unchanged, leftInbox, receipts.added]);
    if (freed.images > 0) {
      console.log(`import: released ${freed.images} receipt image(s) for ${freed.expenses} approved expense(s)`);
    }

    await client.query("COMMIT");

    // New pictures to read. Prompt rather than wait: reading them is minutes
    // of vision calls, and an import that held its transaction open for that
    // would fail as a unit on one bad receipt.
    if (receipts.added > 0) nudgeReceiptReader();

    return { ...base, importId, inserted, updated, unchanged, leftInbox,
      receiptsAdded: receipts.added, receiptsSkipped: receipts.skipped, newNames, warnings };
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

    // JPEG, both from the cropped path and the whole-page fallback — the name
    // matters because the column next to it declares the content type.
    const image = renderReceiptPage(doc, r.page - 1);
    const hash = sha256(image);

    // Keyed by the hash of the image, so the same receipt arriving in every
    // daily export is stored once and costs an index lookup thereafter.
    const ins = await client.query(
      `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes, render_version)
       VALUES ($1,'image/jpeg',$2,$3,$4) ON CONFLICT (sha256) DO NOTHING`,
      [hash, image.length, image, RENDER_VERSION]);
    if (ins.rowCount === 0) skipped++;

    for (const key of matches) {
      const link = await client.query(
        `INSERT INTO expense_receipts (dedupe_key, sha256, source_page)
         VALUES ($1,$2,$3) ON CONFLICT (dedupe_key, sha256) DO NOTHING`,
        [key, hash, r.page]);
      if (link.rowCount) added++;
      // Replace, don't accumulate: an expense that already had an image from
      // an older renderer would otherwise end up showing two receipts.
      await client.query(
        `DELETE FROM expense_receipts er USING receipt_blobs b
          WHERE er.sha256 = b.sha256 AND er.dedupe_key = $1 AND b.render_version < $2`,
        [key, RENDER_VERSION],
      );
    }
  }

  if (unmatched > 0) {
    warnings.push(`${unmatched} receipt pages could not be matched to an expense row and were skipped.`);
  }
  return { added, skipped };
}

/**
 * The fields an import can change on an existing row.
 *
 * `report: false` means the change counts as an update but is not shown to a
 * reviewer, because it carries no meaning for them.
 */
const FIELDS: {
  label: string;
  report: boolean;
  was: (r: Record<string, unknown>) => unknown;
  now: (e: ParsedExpense) => unknown;
}[] = [
  { label: "Note", report: true, was: (r) => r.note, now: (e) => e.note },
  { label: "Payment method", report: true, was: (r) => r.method, now: (e) => e.method },
  { label: "Receipt", report: true, was: (r) => r.receipt_label, now: (e) => e.receiptLabel },
  { label: "Page", report: false, was: (r) => r.source_page, now: (e) => e.sourcePage },
];

const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

/**
 * Render the receipt from one page.
 *
 * Rendering the whole page wastes most of the pixels on white margin and the
 * caption, and worse, it UNDER-samples: the embedded receipts are natively
 * around 733x1200 while a full page at 1.5x left the receipt itself at roughly
 * 528x866 — a third of the detail thrown away before anyone tried to read it.
 *
 * So the image block's own bounding box is rendered instead, at a scale that
 * meets or exceeds native resolution. That is sharper AND crops the margin;
 * ~82 KB against ~58 KB for a markedly better picture. Pages with no image
 * block (a typed note rather than a photo) fall back to the whole page.
 */
/**
 * Scale for rendering a receipt page when there is no photo to extract.
 *
 * Only used for the fallback — a receipt that is vector text rather than a
 * picture of paper. Those have no native resolution to preserve, so the
 * number is simply how legible we want them.
 */
const RECEIPT_SCALE = 3;

/**
 * Longest edge we keep, in pixels.
 *
 * Set above what a phone actually produces — 4032 is the long edge of a
 * 12MP sensor — so in practice nothing is resampled at all and the stored
 * image is the photo. The cap exists only to bound the absurd case, a flatbed
 * scan at 600dpi, which would otherwise dominate the storage that the
 * approved-receipt cleanup is there to contain.
 */
const RECEIPT_MAX_EDGE = 4200;

/**
 * JPEG quality. Higher than it was, and deliberately.
 *
 * These images are read by people squinting at faded thermal paper, and now
 * also by a model pulling line items off them. Compression artefacts land
 * hardest on exactly the thing both are trying to read: small, low-contrast
 * digits.
 */
const RECEIPT_QUALITY = 92;

/** Bumped whenever rendering changes, so a re-import replaces older images. */
export const RENDER_VERSION = 3;

/** One receipt page as a JPEG: cropped to the image on it, or the whole page. */
export function renderReceiptPage(doc: mupdf.Document, index: number): Buffer {
  const page = doc.loadPage(index);

  // The photo itself, at the resolution the camera took it.
  //
  // What this replaced: rendering the whole *page* at a fixed scale and
  // cropping to where the image sat. That throws away everything the photo
  // had beyond the page's own geometry — measured on a 2400x3200 receipt
  // placed on a 576x768pt page, the old path produced 1268x1690 and lost more
  // than half the linear detail. On faded thermal paper that is the
  // difference between a total you can read and one you cannot, and it is
  // also what a model has to work with when pulling line items off it.
  const photo = largestImage(page);
  if (photo) {
    try {
      return encode(photo.toPixmap());
    } catch {
      // An exotic colour space or a mask — fall through and rasterise, which
      // always works even when it is not the best available.
    }
  }

  // No embedded photo: a receipt that is vector text, with no native
  // resolution to preserve. Rasterising is the only option.
  return encode(
    page.toPixmap(
      mupdf.Matrix.scale(RECEIPT_SCALE, RECEIPT_SCALE),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    ),
  );
}

/**
 * The biggest image on the page, as an image rather than as a rectangle.
 *
 * `walk` hands over the image object itself, which is what makes native
 * resolution reachable — reading the structured text as JSON gives only the
 * bounding box, and a box can be rendered but not extracted.
 */
function largestImage(page: mupdf.Page): mupdf.Image | null {
  let best: { image: mupdf.Image; area: number } | null = null;
  try {
    page.toStructuredText("preserve-images").walk({
      onImageBlock(bbox, _ctm, image) {
        // Small decorations — logos, icons in a header — are not the receipt.
        const [x0, y0, x1, y1] = bbox as unknown as [number, number, number, number];
        const area = Math.abs((x1 - x0) * (y1 - y0));
        if (Math.abs(x1 - x0) < 40 || Math.abs(y1 - y0) < 40) return;
        if (!best || area > best.area) best = { image, area };
      },
    });
  } catch {
    return null;
  }
  return best ? (best as { image: mupdf.Image }).image : null;
}

/** A pixmap as JPEG, in RGB, no larger than the cap. */
function encode(pixmap: mupdf.Pixmap): Buffer {
  let pm = pixmap;
  try {
    // Greyscale and CMYK both happen; JPEG wants neither surprise.
    if (pm.getNumberOfComponents() !== 3) {
      pm = pm.convertToColorSpace(mupdf.ColorSpace.DeviceRGB);
    }
    const w = pm.getWidth();
    const h = pm.getHeight();
    if (Math.max(w, h) > RECEIPT_MAX_EDGE) {
      const f = RECEIPT_MAX_EDGE / Math.max(w, h);
      pm = pm.warp(
        // The four corners, unmoved: a straight resample rather than a
        // perspective correction. `warp` is the only resize mupdf exposes.
        [[0, 0], [w, 0], [w, h], [0, h]] as never,
        Math.round(w * f), Math.round(h * f),
      );
    }
    return Buffer.from(pm.asJPEG(RECEIPT_QUALITY, false));
  } finally {
    try { pm.destroy(); } catch { /* already gone */ }
    if (pm !== pixmap) { try { pixmap.destroy(); } catch { /* already gone */ } }
  }
}

/**
 * Is this export older than one already imported? Say so in words, or null.
 *
 * Judged on the newest expense in the file against the newest we hold. An
 * export is a snapshot of the inbox, so a later snapshot cannot have an older
 * newest row — and on a quiet day the two simply match, which is not treated
 * as stale.
 */
async function olderThanWhatWeHave(
  client: pg.PoolClient,
  parsed: { expenses: { date: string }[] },
): Promise<string | null> {
  const { rows } = await client.query<{ newest: string | null }>(
    "SELECT max(expense_date)::text AS newest FROM expenses",
  );
  return staleExportReason(
    parsed.expenses.map((e) => e.date).filter(Boolean).sort().at(-1) ?? null,
    rows[0]?.newest ?? null,
  );
}

/**
 * The rule itself, with no database in the way.
 *
 * Separated so it can be checked against every boundary without a live table
 * — the first import, a quiet day where the dates match, a file with no dates
 * at all. Each of those must be allowed through, and a rule that blocks a real
 * import is worse than the hazard it guards against.
 */
export function staleExportReason(
  newestInFile: string | null,
  newestStored: string | null,
): string | null {
  if (!newestInFile) return null;
  if (!newestStored) return null;
  if (newestInFile >= newestStored) return null;

  return (
    `This export is older than one already imported — its newest expense is ${newestInFile}, ` +
    `and expenses up to ${newestStored} are already stored. Loading it would put already-decided ` +
    `expenses back in the review queue and take today's out of it, so it was not imported. ` +
    `Re-run today's export instead, or force it if you are certain.`
  );
}

/**
 * Let go of the receipts for expenses this app approved and Emburse confirmed.
 *
 * "Confirmed" is the important word. An approval is only known to have taken
 * once the expense stops appearing in the export, and by then the image cannot
 * be fetched again — an expense out of the inbox is out of every future export
 * too. Deleting on the click instead would mean a failed approval loses the
 * receipt for an expense still sitting in the queue. This costs at most one
 * day of storage and cannot lose anything.
 *
 * Two deletions, in order, and the order is the point. Images are shared by
 * content hash — one purchase split across sites points several expenses at
 * the same picture — so the link goes first and the image only when nothing
 * references it any more. Dropping the image because one of its owners was
 * approved would blank the receipt on the others.
 */
async function dropApprovedReceipts(client: pg.PoolClient): Promise<{ expenses: number; images: number }> {
  const links = await client.query(
    `DELETE FROM expense_receipts er
      USING expense_decisions d, expenses e
      WHERE er.dedupe_key = d.dedupe_key
        AND e.dedupe_key  = d.dedupe_key
        AND d.decision = 'approve' AND d.state = 'applied'
        AND e.in_inbox = false`,
  );

  const blobs = await client.query(
    `DELETE FROM receipt_blobs b
      WHERE NOT EXISTS (SELECT 1 FROM expense_receipts er WHERE er.sha256 = b.sha256)`,
  );

  return { expenses: links.rowCount ?? 0, images: blobs.rowCount ?? 0 };
}

/** The largest image on the page, as [x, y, w, h] in points. */
function imageBox(page: mupdf.Page): [number, number, number, number] | null {
  try {
    const st = JSON.parse(page.toStructuredText("preserve-images").asJSON()) as {
      blocks: { type: string; bbox: { x: number; y: number; w: number; h: number } }[];
    };
    const images = st.blocks.filter((b) => b.type === "image" && b.bbox.w > 40 && b.bbox.h > 40);
    if (images.length === 0) return null;
    const biggest = images.reduce((a, b) => (a.bbox.w * a.bbox.h >= b.bbox.w * b.bbox.h ? a : b));
    return [biggest.bbox.x, biggest.bbox.y, biggest.bbox.w, biggest.bbox.h];
  } catch {
    return null;
  }
}

const caption = (employee: string, cents: number, date: string) =>
  `${employee.trim().toLowerCase()}|${cents}|${date}`;

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
