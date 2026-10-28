import crypto from "node:crypto";
import { db, ensureSchema } from "../db.js";
import { GRAPH, graphToken } from "../mail.js";
import { textOf } from "./receipt-mail.js";

/**
 * Pulling a matched receipt INTO the app, and linking it.
 *
 * The step everything else hangs off, and the one easiest to skip:
 * it is tempting to take a matched receipt straight from the
 * mailbox to Emburse, because that is the visible outcome. Doing
 * that attaches a picture and learns nothing from it.
 *
 * Linked here instead, through the tables the app already has —
 * `receipt_blobs` for the bytes, `expense_receipts` for the link
 * — an emailed receipt becomes indistinguishable from one that
 * arrived in the export. Which means, for free and without a line
 * of new code:
 *
 *   THE READER READS IT. `unreadReceipts` picks up any blob with
 *   no current reading, so the merchant, date, totals and line
 *   items come off it on the next pass. That reading is what the
 *   field fill is made of — without it there is nothing to fill
 *   from but the email's subject line.
 *
 *   THE QUEUE SHOWS IT. The drawer, the receipt-versus-claim
 *   check and the shared-receipt arithmetic all read these
 *   tables.
 *
 *   THE UPLOAD STOPS DEPENDING ON THE MAILBOX. Once the bytes
 *   are here, sending them to Emburse does not need the message
 *   to still exist — and a message that was filed or deleted
 *   between matching and sending is the ordinary case, not the
 *   rare one.
 *
 * Content-addressed, like every other receipt: the same image
 * arriving twice is stored once, and linking it to a second
 * expense is a row rather than a copy. That is also what makes
 * this safe to retry.
 */

const sha256 = (b: Buffer): string =>
  crypto.createHash("sha256").update(b).digest("hex");

export type Linked = {
  sha256: string;
  bytes: number;
  contentType: string;
  /** False when this exact image was already linked to this expense. */
  added: boolean;
};

/**
 * The receipt's bytes, from the message.
 *
 * An attachment comes straight off it. A receipt that is only in
 * the BODY — which is most of them — is rendered to a PDF from
 * the merchant's own HTML, so what gets linked and later attached
 * is the receipt rather than a screenshot of a list.
 *
 * Read only, like every Graph call in this feature.
 */
export async function bytesFromMessage(opts: {
  mailbox: string; messageId: string; attachmentId: string; subject: string;
}): Promise<{ name: string; contentType: string; bytes: Buffer }> {
  const head = { authorization: `Bearer ${await graphToken()}` };

  if (opts.attachmentId) {
    const res = await fetch(
      `${GRAPH}/users/${encodeURIComponent(opts.mailbox)}/messages/`
      + `${opts.messageId}/attachments/${opts.attachmentId}`,
      { headers: head });
    if (!res.ok) {
      throw new Error(`Graph would not hand over the attachment (${res.status}). `
        + "The message may have been moved or deleted since it was matched.");
    }
    const a = (await res.json()) as {
      name?: string; contentType?: string; contentBytes?: string;
    };
    if (!a.contentBytes) {
      throw new Error("That attachment has no bytes — it may be a link rather than a file.");
    }
    return {
      name: a.name ?? "receipt",
      contentType: a.contentType || "application/octet-stream",
      bytes: Buffer.from(a.contentBytes, "base64"),
    };
  }

  const res = await fetch(
    `${GRAPH}/users/${encodeURIComponent(opts.mailbox)}/messages/${opts.messageId}`
    + `?${new URLSearchParams({ "$select": "subject,body" }).toString()}`,
    { headers: head });
  if (!res.ok) {
    throw new Error(`Graph would not hand over the message (${res.status}). `
      + "It may have been moved or deleted since it was matched.");
  }
  const m = (await res.json()) as { body?: { contentType?: string; content?: string } };
  const html = m.body?.contentType?.toLowerCase() === "html"
    ? (m.body.content ?? "")
    : `<pre>${escapeHtml(textOf(m.body?.content ?? ""))}</pre>`;

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    /*
     * No network at all while rendering.
     *
     * A receipt email is full of tracking pixels and remote
     * images. Fetching them would tell the sender that the
     * message had been opened — by a machine, at 2am, which is
     * both untrue of a person and nobody's business.
     */
    await page.route("**/*", (route) => (
      route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const bytes = await page.pdf({ format: "Letter", printBackground: true });
    return {
      name: `${(opts.subject || "receipt").replace(/[^\w .-]+/g, " ").trim().slice(0, 60)}.pdf`,
      contentType: "application/pdf",
      bytes: Buffer.from(bytes),
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Store the bytes and link them to the expense.
 *
 * Both halves idempotent: the blob by content hash, the link by
 * its primary key. Linking the same receipt twice is a no-op
 * rather than a duplicate, which is what makes the whole flow
 * safe to re-run — and re-running it is the ordinary case, since
 * a scan finds the same message again every time.
 */
export async function linkReceipt(opts: {
  dedupeKey: string; bytes: Buffer; contentType: string;
}): Promise<Linked> {
  await ensureSchema();
  const hash = sha256(opts.bytes);
  await db().query(
    `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
          VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING`,
    [hash, opts.contentType, opts.bytes.length, opts.bytes]);
  const link = await db().query(
    `INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2)
     ON CONFLICT (dedupe_key, sha256) DO NOTHING`,
    [opts.dedupeKey, hash]);
  return {
    sha256: hash,
    bytes: opts.bytes.length,
    contentType: opts.contentType,
    added: (link.rowCount ?? 0) > 0,
  };
}

/** The bytes of a receipt already in the app, for sending on to Emburse. */
export async function linkedBytes(
  hash: string,
): Promise<{ name: string; contentType: string; bytes: Buffer } | null> {
  await ensureSchema();
  const { rows } = await db().query<{ content_type: string; bytes: Buffer }>(
    "SELECT content_type, bytes FROM receipt_blobs WHERE sha256 = $1", [hash]);
  const r = rows[0];
  if (!r) return null;
  const ext = /pdf/i.test(r.content_type) ? "pdf"
    : /png/i.test(r.content_type) ? "png"
      : /jpe?g/i.test(r.content_type) ? "jpg" : "bin";
  return {
    name: `receipt-${hash.slice(0, 12)}.${ext}`,
    contentType: r.content_type,
    bytes: r.bytes,
  };
}

/**
 * Take the link off again.
 *
 * The blob stays: it is content-addressed and may be linked to
 * another expense, and the purge that reclaims orphaned blobs
 * already exists. Unlinking is a correction to a match, not a
 * deletion of evidence.
 */
export async function unlinkReceipt(dedupeKey: string, hash: string): Promise<void> {
  await ensureSchema();
  await db().query(
    "DELETE FROM expense_receipts WHERE dedupe_key = $1 AND sha256 = $2",
    [dedupeKey, hash]);
}

/** What the reader has made of a linked receipt, when it has got to it yet. */
export async function readingOf(hash: string): Promise<{
  read: boolean;
  legible: boolean;
  merchant: string | null;
  purchasedAt: string | null;
  totalCents: number | null;
  items: string[];
  error: string | null;
} | null> {
  await ensureSchema();
  const { rows } = await db().query<{
    legible: boolean; merchant: string | null; purchased_at: Date | null;
    total_cents: string | null; error: string | null;
  }>(
    `SELECT legible, merchant, purchased_at, total_cents, error
       FROM receipt_readings WHERE sha256 = $1`, [hash]).catch(() => ({ rows: [] }));
  const r = rows[0];
  if (!r) return { read: false, legible: false, merchant: null, purchasedAt: null,
    totalCents: null, items: [], error: null };
  const { rows: items } = await db().query<{ description: string }>(
    "SELECT description FROM receipt_items WHERE sha256 = $1 ORDER BY line_no LIMIT 40",
    [hash]).catch(() => ({ rows: [] }));
  return {
    read: true,
    legible: r.legible,
    merchant: r.merchant,
    purchasedAt: r.purchased_at ? r.purchased_at.toISOString().slice(0, 10) : null,
    totalCents: r.total_cents === null ? null : Number(r.total_cents),
    items: items.map((i) => i.description),
    error: r.error,
  };
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
