/**
 * Pulling a matched receipt into the app, and what that buys.
 *
 *   pnpm exec tsx scripts/test-receipt-link.ts
 *
 * The step that was missing, and the reason it matters: a receipt
 * sent straight from the mailbox to Emburse attaches a picture
 * and teaches the app nothing. Linked through the tables the app
 * already has, it becomes indistinguishable from one that arrived
 * in the export — so the reader reads it, the queue shows it, and
 * the field fill has something to be made of.
 *
 * What these check:
 *
 *   IT LANDS IN THE ORDINARY TABLES, not a parallel set.
 *
 *   THE READER WILL PICK IT UP. `unreadReceipts` is what the
 *   reader polls; a linked receipt has to appear in it or
 *   nothing downstream ever runs.
 *
 *   LINKING TWICE IS A NO-OP. A scan finds the same message
 *   every time, so re-linking is the ordinary case.
 *
 *   ONE IMAGE, TWO EXPENSES, ONE COPY. Content-addressed, so a
 *   split purchase costs a row rather than a second blob.
 *
 *   AND THE UPLOAD READS FROM HERE, so it does not depend on the
 *   message still being in the mailbox.
 */
import { db, ensureSchema } from "../server/db.js";
import { linkReceipt, linkedBytes, readingOf, unlinkReceipt } from "../server/emburse/receipt-link.js";
import { ensureReceiptItems, unreadReceipts } from "../server/emburse/receipt-items.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const TAG = `zz-link-${Date.now()}`;
const A = `${TAG}-a`;
const B = `${TAG}-b`;
const ERIC = "eric.s@mojocarwash.com";
// Distinctive, so the hash cannot collide with a real receipt.
const BYTES = Buffer.from(`%PDF-1.4 receipt for ${TAG}`);

const add = (key: string) => db().query(
  `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                         category, department, location, note, method, in_inbox,
                         reviewer, source, lane)
   VALUES ($1,'Eric S','2026-09-24','STARBUCKS #4417',1299,'Meals','Ops','Site','','Card',
           true,$2,'','personal-mojo')
   ON CONFLICT (dedupe_key) DO NOTHING`, [key, ERIC]);

await ensureSchema();
await ensureReceiptItems();

let hash = "";
try {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await add(A);
  await add(B);

  console.log("1. It lands in the ordinary tables");
  const linked = await linkReceipt({
    dedupeKey: A, bytes: BYTES, contentType: "application/pdf",
  });
  hash = linked.sha256;
  check("it reports the link as new", linked.added === true);
  check("…with the content hash as its identity", /^[0-9a-f]{64}$/.test(hash), hash);
  const { rows: blob } = await db().query<{ byte_size: number; content_type: string }>(
    "SELECT byte_size, content_type FROM receipt_blobs WHERE sha256 = $1", [hash]);
  check("the bytes are in receipt_blobs", blob.length === 1
    && blob[0]!.byte_size === BYTES.length, JSON.stringify(blob[0] ?? {}));
  const { rows: link } = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM expense_receipts WHERE dedupe_key = $1 AND sha256 = $2",
    [A, hash]);
  check("…and the link is in expense_receipts", link[0]?.n === "1");

  console.log("\n2. THE READER WILL PICK IT UP");
  /*
   * The whole reason for linking rather than uploading. If a
   * linked receipt does not appear here, nothing downstream ever
   * runs: no merchant, no total, no line items, nothing to fill
   * a field from.
   */
  const pending = await unreadReceipts(500);
  check("it is in the reader's queue", pending.includes(hash),
    `${pending.length} waiting`);
  const before = await readingOf(hash);
  check("…and has no reading yet", before?.read === false);

  console.log("\n3. Linking twice is a no-op");
  const again = await linkReceipt({
    dedupeKey: A, bytes: BYTES, contentType: "application/pdf",
  });
  check("the second link adds nothing", again.added === false);
  check("…and the hash is the same", again.sha256 === hash);
  const { rows: still } = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM expense_receipts WHERE dedupe_key = $1", [A]);
  check("…so there is still one link", still[0]?.n === "1");
  const { rows: blobs } = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM receipt_blobs WHERE sha256 = $1", [hash]);
  check("…and one blob", blobs[0]?.n === "1");

  console.log("\n4. One image, two expenses, one copy");
  const shared = await linkReceipt({
    dedupeKey: B, bytes: BYTES, contentType: "application/pdf",
  });
  check("the second expense gets a link", shared.added === true);
  check("…to the SAME blob", shared.sha256 === hash);
  const { rows: two } = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM expense_receipts WHERE sha256 = $1", [hash]);
  check("…so two links and still one image", two[0]?.n === "2");

  console.log("\n5. The upload reads from here, not the mailbox");
  const out = await linkedBytes(hash);
  check("the bytes come back", out !== null && out.bytes.length === BYTES.length);
  check("…byte for byte", out !== null && out.bytes.equals(BYTES));
  check("…with a usable filename", /\.pdf$/.test(out?.name ?? ""), out?.name);
  check("a hash nobody stored returns nothing",
    (await linkedBytes("0".repeat(64))) === null);

  console.log("\n6. Unlinking is a correction, not a deletion");
  await unlinkReceipt(B, hash);
  const { rows: left } = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM expense_receipts WHERE sha256 = $1", [hash]);
  check("the link goes", left[0]?.n === "1");
  check("…and the image stays, because another expense still has it",
    (await linkedBytes(hash)) !== null);

  /*
   * AND THE NEXT IMPORT DOES NOT THROW IT AWAY.
   *
   * This is the round trip the whole pipeline does: the image goes back to
   * Emburse, the expense sits there until it is submitted, and the next
   * export therefore carries that receipt as a page of its own.
   * `storeReceipts` renders it, links the rendered copy, and then deletes
   * every link for that expense whose blob came from an OLDER renderer —
   * and a blob with no origin counted as an export render at version 1. So
   * the emailed original was unlinked and deleted as an orphan by the next
   * purge, leaving a JPEG of a PDF page in place of the file the merchant
   * sent, its AI reading orphaned with it, and the match's record of which
   * email it came from pointing at nothing.
   */
  console.log("\n7. The export's render sweep does not take an emailed receipt");
  const { rows: origin } = await db().query<{ origin: string }>(
    "SELECT origin FROM receipt_blobs WHERE sha256 = $1", [hash]);
  check("an emailed receipt is marked as one", origin[0]?.origin === "email",
    origin[0]?.origin ?? "(none)");
  // The sweep, exactly as storeReceipts runs it once the receipt comes back
  // in the export at the current render version.
  const { RENDER_VERSION } = await import("../server/import/ingest.js");
  await db().query(
    `DELETE FROM expense_receipts er USING receipt_blobs b
      WHERE er.sha256 = b.sha256 AND er.dedupe_key = $1
        AND b.origin = 'export' AND b.render_version < $2`,
    [A, RENDER_VERSION]);
  // The LINK, not the blob: `linkedBytes` reads the bytes by hash and
  // answers whether the image exists, which it does either way. What the
  // sweep takes is the row in expense_receipts.
  const isLinked = async (key: string, h: string): Promise<boolean> =>
    (await db().query("SELECT 1 FROM expense_receipts WHERE dedupe_key = $1 AND sha256 = $2",
      [key, h])).rowCount === 1;
  check("THE EMAILED RECEIPT IS STILL LINKED", await isLinked(A, hash));
  const { rows: survived } = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM expense_receipts WHERE dedupe_key = $1 AND sha256 = $2",
    [A, hash]);
  check("…to the expense it was matched to", survived[0]?.n === "1");
  // And an export-rendered one from an older renderer still IS swept, which
  // is what that statement is for.
  const OLD = Buffer.from(`old render for ${TAG}`);
  const { sha256: oldHash } = await import("../server/import/key.js")
    .then((m) => ({ sha256: m.sha256(OLD) }));
  await db().query(
    `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes, render_version, origin)
     VALUES ($1,'image/jpeg',$2,$3,1,'export') ON CONFLICT (sha256) DO NOTHING`,
    [oldHash, OLD.length, OLD]);
  await db().query(
    `INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2)
     ON CONFLICT (dedupe_key, sha256) DO NOTHING`, [A, oldHash]);
  await db().query(
    `DELETE FROM expense_receipts er USING receipt_blobs b
      WHERE er.sha256 = b.sha256 AND er.dedupe_key = $1
        AND b.origin = 'export' AND b.render_version < $2`,
    [A, RENDER_VERSION]);
  check("…while a stale EXPORT render is still swept, as before",
    !(await isLinked(A, oldHash)));
  await db().query("DELETE FROM receipt_blobs WHERE sha256 = $1", [oldHash])
    .catch(() => undefined);

} finally {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`])
    .catch(() => undefined);
  if (hash) {
    await db().query("DELETE FROM receipt_blobs WHERE sha256 = $1", [hash])
      .catch(() => undefined);
  }
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
