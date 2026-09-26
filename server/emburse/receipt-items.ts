import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { db, ensureSchema, isDbConfigured } from "../db.js";
import { env, isAuditConfigured } from "../env.js";
import { callAnthropic, describeAiConfig, supportsEffort } from "../ai.js";

/**
 * What was actually bought, read off the receipt itself.
 *
 * The expense row says "LOWES OF W KNOXVILLE — $43.57, Store Support
 * Marketing". The receipt says "8H 6-FT 13-6A HD U-POST, 39.88" and that four
 * items were purchased. Only the second tells a reviewer whether the category
 * is right, whether anything personal is mixed in, or why a number is what it
 * is — and reading it means opening an image and squinting.
 *
 * Two things make this worth storing rather than reading on demand:
 *
 *   - Receipts are **deleted once an approval is confirmed**. Extracting the
 *     items first means the detail outlives the picture, permanently, for a
 *     few hundred bytes instead of a megabyte.
 *   - A receipt image is shared by content hash, so the items are too. The
 *     same purchase split across sites is read once.
 */

const Item = z.object({
  description: z.string().describe("The line as printed, tidied of obvious OCR noise but not reworded."),
  alcohol: z.boolean().describe(
    "True when this line is an alcoholic drink. Judge the product, not the words: MODELO ESP 12PK, " +
    "CAB SAUV GLS, TITOS, LAGUNITAS IPA and BUD LT are all alcohol even though none of them says so. " +
    "Non-alcoholic drinks that sound alcoholic are not: ginger beer, root beer, O'Doul's, a mocktail, " +
    "non-alcoholic wine. When a line is too faded to tell what the product is, say false and mention " +
    "it in notes rather than guessing.",
  ),
  quantity: z.number().nullable().describe("Units, when the line states one. Null otherwise."),
  unitPrice: z.number().nullable().describe("Price per unit when printed separately. Null otherwise."),
  amount: z.number().nullable().describe("What this line cost in total. Null if unreadable."),
});

const Reading = z.object({
  legible: z.boolean().describe("False when the image is too poor to read items from at all."),
  itemised: z.boolean().describe(
    "True when the receipt lists what was bought. False for an order summary or a bar tab that shows " +
    "only a total — which is not the same as an unreadable image, and matters because nothing can be " +
    "judged from the lines of a receipt that has none.",
  ),
  merchant: z.string().nullable().describe("Merchant name as printed, or null."),
  purchasedAt: z.string().nullable().describe("Transaction date as YYYY-MM-DD, or null."),
  currency: z.string().nullable().describe("ISO code such as USD, or null."),
  items: z.array(Item).describe(
    "One entry per purchased line. Exclude subtotal, tax, tip, total, change and payment lines — those are separate fields.",
  ),
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  tip: z.number().nullable(),
  total: z.number().nullable().describe("The final amount charged."),
  notes: z.string().describe(
    "One short sentence only when something would change how a reviewer reads this — items too faded to be sure of, a count that disagrees with the lines, several people's meals on one bill. Empty string when unremarkable.",
  ),
});

export type ReceiptReading = z.infer<typeof Reading>;

export type ReceiptItem = {
  lineNo: number;
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
};

export type ReceiptDetail = {
  sha256: string;
  extractedAt: string;
  model: string;
  legible: boolean;
  merchant: string | null;
  purchasedAt: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
  notes: string;
  error: string | null;
  items: ReceiptItem[];
};

const SCHEMA = `
-- Keyed on the image's content hash, exactly as the image is, so one receipt
-- read once serves every expense pointing at it. Deliberately no foreign key
-- to receipt_blobs: an approved expense's image is deleted, and the items are
-- the part worth keeping.
CREATE TABLE IF NOT EXISTS receipt_readings (
  sha256       text PRIMARY KEY,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  model        text        NOT NULL,
  legible      boolean     NOT NULL DEFAULT false,
  merchant     text,
  purchased_at date,
  currency     text,
  subtotal_cents bigint,
  tax_cents      bigint,
  tip_cents      bigint,
  total_cents    bigint,
  notes        text NOT NULL DEFAULT '',
  -- Set when the read itself failed, so a retry is distinguishable from a
  -- receipt that genuinely has no items on it.
  error        text
);

CREATE TABLE IF NOT EXISTS receipt_items (
  sha256       text    NOT NULL REFERENCES receipt_readings (sha256) ON DELETE CASCADE,
  line_no      integer NOT NULL,
  description  text    NOT NULL,
  quantity     numeric,
  unit_cents   bigint,
  amount_cents bigint,
  PRIMARY KEY (sha256, line_no)
);
-- Whether this line is an alcoholic drink, as the reader judged it. On the
-- LINE rather than the receipt so a reviewer can be shown which lines, and so
-- "a $9 beer on a $200 team dinner" and "a $200 bar tab" are distinguishable.
ALTER TABLE receipt_items    ADD COLUMN IF NOT EXISTS alcohol  boolean NOT NULL DEFAULT false;
-- Whether the receipt lists what was bought at all. Not the same as legible:
-- an order summary reading "1 Item $141.24" is perfectly readable and says
-- nothing, and a rule over line items can conclude nothing from it either way.
ALTER TABLE receipt_readings ADD COLUMN IF NOT EXISTS itemised boolean;
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
  }));

/**
 * Create the tables without reading anything.
 *
 * Rules can be written against receipt line items, so the rule runner joins
 * `receipt_items` — on a database where no receipt has ever been read, that
 * table does not exist and the join is a hard error. Which is not a corner
 * case: it is exactly the state of an app with no working Anthropic key, where
 * the reader never runs and nothing else would ever have created it.
 */
export const ensureReceiptItems = ensure;

const cents = (n: number | null | undefined): number | null =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100);
const dollars = (c: string | number | null): number | null =>
  c === null ? null : Number(c) / 100;


const SYSTEM = `You read retail and restaurant receipts and list what was bought.

Transcribe the purchased lines only — not subtotal, tax, tip, total, change,
card or loyalty lines, which are separate fields. Keep each description close to
what is printed; abbreviations like "HD U-POST" are what the reviewer will
match against, so do not expand or interpret them.

Thermal receipts fade. When a line is partly unreadable, give what you can read
and leave the amount null rather than guessing a number — a wrong figure is
worse than a missing one, because it will be believed.`;

/** Read one receipt image. Throws only for a failure worth retrying. */
export async function readReceipt(image: Buffer, contentType = "image/jpeg"): Promise<ReceiptReading> {
  const response = await callAnthropic((c) => c.messages.parse({
    model: env.audit.model,
    max_tokens: 8000,
    system: SYSTEM,
    // Medium rather than low: this is a long transcription off a poor
    // photograph, not a single number, and an item list that quietly drops
    // half the lines looks exactly like a short receipt.
    // Effort is spread in only where the model accepts it — Haiku rejects it
    // outright with a 400. Spread rather than a helper returning the whole
    // object, because `parse` infers the parsed shape from `format` and a
    // helper's return type erases that.
    output_config: {
      ...(supportsEffort(env.audit.model) ? { effort: env.audit.itemsEffort } : {}),
      format: zodOutputFormat(Reading),
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: image.toString("base64"),
            },
          },
          { type: "text", text: "List everything purchased on this receipt." },
        ],
      },
    ],
  }));

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("The receipt reading came back in an unexpected shape.");
  return parsed;
}

/**
 * Read a stored receipt and keep what it says.
 *
 * Reads the image out of our own store rather than Emburse: it is the copy we
 * have, it is now kept at the camera's resolution, and it needs no Emburse
 * session — which matters because this runs unattended after an import.
 */
export async function extractReceipt(
  sha256: string,
  opts: { force?: boolean } = {},
): Promise<ReceiptDetail | null> {
  await ensure();

  if (!opts.force) {
    const existing = await receiptDetail(sha256);
    if (existing && !existing.error) return existing;
  }

  const { rows } = await db().query<{ bytes: Buffer; content_type: string }>(
    "SELECT bytes, content_type FROM receipt_blobs WHERE sha256 = $1", [sha256]);
  const blob = rows[0];
  if (!blob) return null;

  let reading: ReceiptReading | null = null;
  let error: string | null = null;
  try {
    reading = await readReceipt(blob.bytes, blob.content_type);
  } catch (err) {
    // A configuration failure gets its own sentence. Stored on the row, so a
    // reviewer looking at an unread receipt is told what to fix rather than
    // being shown a status code from a gateway they have never heard of.
    error = describeAiConfig(err)
      ?? (err instanceof Error ? err.message.slice(0, 500) : "The receipt could not be read.");
  }

  const client2 = await db().connect();
  try {
    await client2.query("BEGIN");
    await client2.query(
      `INSERT INTO receipt_readings
         (sha256, extracted_at, model, legible, merchant, purchased_at, currency,
          subtotal_cents, tax_cents, tip_cents, total_cents, notes, error, itemised)
       VALUES ($1, now(), $2, $3, $4, NULLIF($5,'')::date, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (sha256) DO UPDATE SET
         extracted_at = now(), model = EXCLUDED.model, legible = EXCLUDED.legible,
         merchant = EXCLUDED.merchant, purchased_at = EXCLUDED.purchased_at,
         currency = EXCLUDED.currency, subtotal_cents = EXCLUDED.subtotal_cents,
         tax_cents = EXCLUDED.tax_cents, tip_cents = EXCLUDED.tip_cents,
         total_cents = EXCLUDED.total_cents, notes = EXCLUDED.notes, error = EXCLUDED.error,
         itemised = EXCLUDED.itemised`,
      [sha256, env.audit.model, reading?.legible ?? false, reading?.merchant ?? null,
       reading?.purchasedAt ?? "", reading?.currency ?? null,
       cents(reading?.subtotal), cents(reading?.tax), cents(reading?.tip), cents(reading?.total),
       reading?.notes ?? "", error, reading ? reading.itemised === true : null],
    );

    // Replaced wholesale rather than merged: a re-read is a new opinion about
    // the same picture, and half of one reading beside half of another would
    // be a list nobody could trust.
    await client2.query("DELETE FROM receipt_items WHERE sha256 = $1", [sha256]);
    let n = 0;
    for (const item of reading?.items ?? []) {
      if (!item.description.trim()) continue;
      await client2.query(
        `INSERT INTO receipt_items (sha256, line_no, description, quantity, unit_cents, amount_cents, alcohol)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sha256, ++n, item.description.trim().slice(0, 300), item.quantity,
         cents(item.unitPrice), cents(item.amount), item.alcohol === true],
      );
    }
    await client2.query("COMMIT");
  } catch (err) {
    await client2.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client2.release();
  }

  return receiptDetail(sha256);
}

/** What we know about one receipt, items and all. */
export async function receiptDetail(sha256: string): Promise<ReceiptDetail | null> {
  await ensure();
  const { rows } = await db().query<Record<string, never>>(
    `SELECT sha256, extracted_at, model, legible, merchant, purchased_at::text AS purchased_at,
            currency, subtotal_cents, tax_cents, tip_cents, total_cents, notes, error
       FROM receipt_readings WHERE sha256 = $1`, [sha256]);
  const r = rows[0] as Record<string, string | number | boolean | Date | null> | undefined;
  if (!r) return null;

  const { rows: items } = await db().query<Record<string, never>>(
    `SELECT line_no, description, quantity, unit_cents, amount_cents
       FROM receipt_items WHERE sha256 = $1 ORDER BY line_no`, [sha256]);

  return {
    sha256,
    extractedAt: (r.extracted_at as Date).toISOString(),
    model: r.model as string,
    legible: r.legible as boolean,
    merchant: (r.merchant as string | null) ?? null,
    purchasedAt: (r.purchased_at as string | null) ?? null,
    currency: (r.currency as string | null) ?? null,
    subtotal: dollars(r.subtotal_cents as string | null),
    tax: dollars(r.tax_cents as string | null),
    tip: dollars(r.tip_cents as string | null),
    total: dollars(r.total_cents as string | null),
    notes: (r.notes as string) ?? "",
    error: (r.error as string | null) ?? null,
    items: (items as unknown as Record<string, string | number | null>[]).map((i) => ({
      lineNo: Number(i.line_no),
      description: String(i.description),
      quantity: i.quantity === null ? null : Number(i.quantity),
      unitPrice: dollars(i.unit_cents as string | null),
      amount: dollars(i.amount_cents as string | null),
    })),
  };
}

/** Everything we have read, for the expenses on screen. */
export async function detailsForExpenses(keys: string[]): Promise<Map<string, ReceiptDetail[]>> {
  await ensure();
  if (keys.length === 0) return new Map();
  const { rows } = await db().query<{ dedupe_key: string; sha256: string }>(
    "SELECT dedupe_key, sha256 FROM expense_receipts WHERE dedupe_key = ANY($1)", [keys]);

  const out = new Map<string, ReceiptDetail[]>();
  for (const row of rows) {
    const detail = await receiptDetail(row.sha256);
    if (!detail) continue;
    (out.get(row.dedupe_key) ?? out.set(row.dedupe_key, []).get(row.dedupe_key)!).push(detail);
  }
  return out;
}

/** Receipts we hold an image for but have never read. */
export async function unreadReceipts(limit: number): Promise<string[]> {
  await ensure();
  const { rows } = await db().query<{ sha256: string }>(
    `SELECT b.sha256 FROM receipt_blobs b
      WHERE NOT EXISTS (SELECT 1 FROM receipt_readings r WHERE r.sha256 = b.sha256 AND r.error IS NULL)
      ORDER BY b.created_at DESC LIMIT $1`, [limit]);
  return rows.map((r) => r.sha256);
}

export const canReadReceipts = (): boolean => isAuditConfigured() && isDbConfigured();
