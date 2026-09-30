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
  subtotal: z.number().nullable().describe(
    "The figure before tax, when the receipt prints one. Menards labels it “TOTAL” and prints the " +
    "real charge on “TOTAL SALE” below it — put the pre-tax figure here even when the receipt " +
    "calls it the total, because the arithmetic is what catches a misread.",
  ),
  tax: z.number().nullable(),
  tip: z.number().nullable(),
  /**
   * The single most reliable figure on the page, and the one both misreads
   * would have been saved by: receipts print what the card was charged
   * against the card itself.
   */
  /**
   * The summary block, transcribed rather than interpreted.
   *
   * Asking which figure is "the total" is a judgement, and it has now been
   * got wrong twice in opposite directions. Asking for the lines as
   * printed is transcription, which is the thing this model is reliable
   * at — and then the choosing happens in code, where it can be read,
   * argued with and tested.
   */
  totals: z.array(z.object({
    label: z.string().describe("The label exactly as printed: “TOTAL”, “TOTAL SALE”, “Amount Paid”, “AMERICAN EXPRESS 1002”."),
    amount: z.number().describe("The figure on that line."),
  })).describe(
    "Every money line at the foot of the receipt, in the order printed, including the payment or " +
    "card line. Do not judge which is the real total, do not skip one because it repeats another, " +
    "and do not reorder them.",
  ),
  paid: z.number().nullable().describe(
    "The amount printed against the payment line — “AMERICAN EXPRESS 1002  13.54”, “Amount Paid”, " +
    "“TOTAL SALE”, “Total Paid”, “Charged”. This is what the card was actually charged, so give it " +
    "whenever the receipt shows one, even if it repeats a figure above. Null only when there is no " +
    "such line at all.",
  ),
  total: z.number().nullable().describe(
    "The amount actually CHARGED — the last money figure on the receipt, after any tip. " +
    "A restaurant slip prints “Total” BEFORE the tip line and then “Amount Paid”, “Total Paid” " +
    "or “Charged” below it: the later, larger figure is the answer, never the one labelled Total " +
    "above the tip. Where the customer has written a tip in by hand, add it. Where there is no tip " +
    "line at all, the printed total is the answer.",
  ),
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
  /**
   * When the app re-read this image by itself because the total it had did
   * not match the charge. Null means it never has.
   *
   * Shown to the reviewer, and that is most of the point: a mismatch that
   * survived a second reading is evidence, where a first reading is only a
   * guess that might be wrong. It also enforces "once" — a receipt whose
   * re-read still disagrees is not read a third time.
   */
  autoRereadAt: string | null;
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
  paid_cents     bigint,
  notes        text NOT NULL DEFAULT '',
  -- Set when the read itself failed, so a retry is distinguishable from a
  -- receipt that genuinely has no items on it.
  error        text
);

-- The amount printed against the payment card. Added after two receipts
-- were read off the wrong line: it is the figure the card was charged,
-- stated by the receipt itself, and it settles what arithmetic can only
-- infer.
ALTER TABLE receipt_readings ADD COLUMN IF NOT EXISTS paid_cents bigint;
-- Which generation of the reader produced this. Bumping READER_VERSION is
-- how a fixed prompt reaches receipts that were already read: the cache is
-- by image hash and nothing is ever read twice without it.
ALTER TABLE receipt_readings ADD COLUMN IF NOT EXISTS reader_version integer NOT NULL DEFAULT 1;

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
-- How many times reading this image has been tried. A failed read leaves a
-- row with an error set, which used to still count as unread, so it was
-- retried every pass, for ever. When a bad request made every read fail, the
-- reader spent hundreds of model calls re-failing on the same receipts with
-- nothing being imported at all.
ALTER TABLE receipt_readings ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
-- When the app re-read this image of its own accord, because the total it
-- had did not match what was charged. Set BEFORE the re-read, so a crash
-- mid-read cannot turn "try once" into a loop, and never cleared: once is
-- once. A null here is what makes a receipt a candidate.
ALTER TABLE receipt_readings ADD COLUMN IF NOT EXISTS auto_reread_at timestamptz;
CREATE INDEX IF NOT EXISTS receipt_readings_auto_reread_idx
  ON receipt_readings (auto_reread_at) WHERE auto_reread_at IS NULL;
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

/**
 * Which generation of the reader produced a stored reading.
 *
 * Readings are cached by image hash and never read twice, which is right —
 * a vision call per receipt is the expensive part of this app. But it also
 * means a FIXED reader never reaches anything already read: two receipts
 * were read off the wrong line, the prompt now says which line to take, and
 * without this the stored totals would stay wrong until those images
 * happened to turn over.
 *
 * Bumping this re-reads everything, once. That is a real cost — one call
 * per stored receipt — so it is bumped deliberately, when what changed
 * makes the old readings wrong rather than merely better.
 *
 *   2 — the total is the amount CHARGED, not the line labelled "Total".
 *   3 — the summary block is transcribed, so the choosing happens in code.
 *   4 — handwritten tips and totals are read, and the lower part of the
 *       receipt is sent again enlarged so the pen is legible.
 */
export const READER_VERSION = 4;

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
worse than a missing one, because it will be believed.

THE TOTAL IS WHAT THE CARD WAS CHARGED, and on many receipts the word
"TOTAL" is printed against a smaller figure. Two real ones, both read
wrongly:

    Sub Total    35.37
    Tax           2.87
    Total        38.24     <- before the tip, NOT the answer
    Tip           7.65
    Amount Paid  45.89     <- charged

    TOTAL                     12.49    <- before tax, NOT the answer
    TAX WASHINGTON-MN 8.375%   1.05
    TOTAL SALE                13.54    <- charged
    AMERICAN EXPRESS 1002     13.54

Take the last money figure, the one on the payment line: 45.89 and 13.54.
Reading 38.24 or 12.49 turns an ordinary purchase into an overclaim of
exactly the tip, or exactly the tax.

Give "paid" whenever a payment line prints an amount, and put the pre-tax
figure in "subtotal" even where the receipt labels THAT one "TOTAL".

And transcribe the whole summary block into "totals", in printed order,
labels exactly as they appear — TOTAL, TAX, TOTAL SALE, Tip, Amount Paid,
and the card line. Do not decide which of them is the real total, do not
drop one because it repeats the figure above it, and do not tidy the
labels. Choosing is done elsewhere; getting the lines down accurately is
the job here, and it is the job you are good at.

Where a second image is given, it is the lower part of the SAME receipt,
enlarged. Read the money off that one — it is the same print, bigger.

HANDWRITING COUNTS. A restaurant runs the card for the printed total and
the customer then writes the tip and the new total on the slip by hand:

    Total     31.35        <- printed, and NOT what was charged
    Amount    31.35        <- printed on the card line, also not it
    + Tip:     6.00        <- written in pen
    = Total:  37.35        <- written in pen, and this is the charge

Read the pen. Put the written tip in "tip", the written total in "paid",
and give both as lines in "totals" labelled as they appear. A total that
ignores the handwriting is short by exactly the tip, every time, and turns
an ordinary meal into an overclaim. If the writing is there but you cannot
make out the figures, say so in notes rather than passing the printed
total off as the charge.`;

/**
 * What the card was actually charged, which is often not the figure the
 * receipt labels "Total".
 *
 * Two real misreads, a day apart, same shape:
 *
 *   - Texas Roadhouse printed Total 38.24, Tip 7.65, Amount Paid 45.89. The
 *     reading took 38.24 and the app reported an ordinary meal as $7.65 of
 *     overclaiming — the tip, exactly.
 *   - Menards printed TOTAL 12.49, TAX 1.05, TOTAL SALE 13.54. The reading
 *     took 12.49 and the app reported $1.05 of overclaiming — the tax,
 *     exactly. Menards labels its PRE-TAX figure "TOTAL".
 *
 * So the word is worthless and two things are worth more. First, the
 * payment line: a receipt prints what the card was charged against the card
 * ("AMERICAN EXPRESS 1002  13.54"), and where that exists it settles the
 * question outright. Second, the arithmetic: subtotal + tax + tip is what
 * was paid, so a total matching a PARTIAL sum of those is a total read off
 * the wrong line.
 *
 * Nothing is changed unless one of those two proves it. A guess dressed as
 * a correction is worse than the fault, because it will be believed.
 */
/** Labels that name what was actually paid, rather than a running figure. */
const PAYMENT_LINE =
  /amount\s*paid|total\s*(sale|charge|due|paid)|charged|balance\s*due|visa|master|amex|american\s*express|discover|debit|credit\s*card|card\s*\d/i;

/** Labels that are not the purchase at all, and must never be taken for it. */
const NOT_A_TOTAL = /change|tender|cash\s*back|rebate|savings|you\s*saved|points|balance\s*remaining/i;

/**
 * The charged figure read off the transcribed summary block.
 *
 * The block is the receipt's own words, so the choosing is done here where
 * it can be read and tested: a line that names a payment wins, and failing
 * that the largest line that is not change or a rebate — because a summary
 * block runs upwards, subtotal to total to total-with-tip, and the end of
 * that climb is what the card paid.
 */
function fromTotalsBlock(totals: { label: string; amount: number }[]): number | null {
  const usable = totals.filter((t) => Number.isFinite(t.amount) && t.amount > 0 && !NOT_A_TOTAL.test(t.label));
  if (usable.length === 0) return null;
  // Last, not first: a card line repeats the figure below the total, and
  // the later one is the one the receipt ends on.
  const named = usable.filter((t) => PAYMENT_LINE.test(t.label));
  if (named.length > 0) return named[named.length - 1]!.amount;
  return usable.reduce((a, b) => (b.amount > a ? b.amount : a), 0) || null;
}

export function chargedTotal(r: ReceiptReading): ReceiptReading {
  const { subtotal, tax, tip, total, paid } = r;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.011;
  /**
   * Record a correction — or make none, when there is nothing to correct.
   *
   * The guard matters. A receipt with a handwritten tip the reader could
   * not make out has total = subtotal + tax and no tip figure, so the
   * "before the tip" branch fires and adds nothing: the total is unchanged
   * and the reading acquires a note announcing a correction that did not
   * happen, which is worse than saying nothing at all.
   */
  const note = (was: number | null, now: number, why: string): ReceiptReading =>
    was !== null && near(was, now) ? r : ({
    ...r,
    total: now,
    notes: [
      r.notes.trim(),
      `${was === null ? "No total was printed clearly" : `The printed total of ${was.toFixed(2)}`}` +
      ` ${why}; the amount charged is ${now.toFixed(2)}.`,
    ].filter(Boolean).join(" "),
  });

  // The payment line, when there is one. It is the figure the card was
  // charged, stated by the receipt itself, and it beats any arithmetic.
  if (paid !== null && paid > 0 && (total === null || !near(total, paid))) {
    return note(total, paid, "is not what the card paid");
  }
  // Failing that, the summary block as printed. This is what catches the
  // receipt where the reading put 12.49 in `total`, nothing in `subtotal`
  // and nothing in `paid` — leaving the arithmetic below with nothing to
  // work from, while "TOTAL SALE 13.54" sat on the page in plain sight.
  const printed = fromTotalsBlock(r.totals ?? []);
  if (printed !== null && (total === null || (printed > total && !near(total, printed)))) {
    return note(total, printed, "is not the last figure on the receipt");
  }
  if (total === null || subtotal === null) return r;

  const whole = Number((subtotal + (tax ?? 0) + (tip ?? 0)).toFixed(2));
  if (near(total, whole)) return r;
  // A total that equals the run-up rather than the sum: read off the line
  // above the tax, or the line above the tip.
  //
  // What is MISSING gets added to the printed total, rather than the parts
  // being re-added from scratch. Both are the same number when everything
  // was read perfectly; they differ when one component is out by a penny,
  // and then the larger printed figure is the better anchor — it is the one
  // the eye and the card agree on.
  if (near(total, subtotal)) {
    return note(total, Number((total + (tax ?? 0) + (tip ?? 0)).toFixed(2)), "is before the tax");
  }
  if (tax !== null && near(total, subtotal + tax)) {
    return note(total, Number((total + (tip ?? 0)).toFixed(2)), "is before the tip");
  }
  // Anything else does not reconcile, and an unreconciled receipt is a
  // thing for a person to look at, not for this to adjust.
  return r;
}

/** Read one receipt image. Throws only for a failure worth retrying. */
export async function readReceipt(image: Buffer, contentType = "image/jpeg"): Promise<ReceiptReading> {
  // The same receipt again, lower part enlarged. The figures that matter are
  // in the smallest type on the page; the item lines read fine and the
  // totals are four smudges. Null when the image is too small to enlarge or
  // could not be decoded — a second look is an improvement, not a
  // requirement.
  const { enlargeTotals } = await import("./receipt-zoom.js");
  const zoom = enlargeTotals(image);

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
          ...(zoom
            ? [
                {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: zoom.mediaType,
                    data: zoom.data.toString("base64"),
                  },
                },
              ]
            : []),
          {
            type: "text",
            text: zoom
              ? "List everything purchased on this receipt. The second image is the lower part " +
                "of the SAME receipt, enlarged — read the money lines off that one."
              : "List everything purchased on this receipt.",
          },
        ],
      },
    ],
  }));

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("The receipt reading came back in an unexpected shape.");
  return chargedTotal(parsed);
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
  /** True when trying again cannot possibly give a different answer. */
  let permanent = false;
  try {
    reading = await readReceipt(blob.bytes, blob.content_type);
  } catch (err) {
    // A configuration failure gets its own sentence. Stored on the row, so a
    // reviewer looking at an unread receipt is told what to fix rather than
    // being shown a status code from a gateway they have never heard of.
    error = describeAiConfig(err)
      ?? (err instanceof Error ? err.message.slice(0, 500) : "The receipt could not be read.");
    // A malformed request fails the same way every time, so retrying it is
    // spending money to be told the same thing. Sending an unsupported
    // parameter failed every read in the queue that way, three times each.
    // A timeout or a rate limit is worth another go.
    permanent = /\b400\b|invalid_request_error|does not support/i.test(error);
  }

  const client2 = await db().connect();
  try {
    await client2.query("BEGIN");
    await client2.query(
      `INSERT INTO receipt_readings
         (sha256, extracted_at, model, legible, merchant, purchased_at, currency,
          subtotal_cents, tax_cents, tip_cents, total_cents, paid_cents, notes, error,
          itemised, attempts, reader_version)
       VALUES ($1, now(), $2, $3, $4, NULLIF($5,'')::date, $6, $7, $8, $9, $10, $15, $11, $12,
               $13, $14, ${READER_VERSION})
       ON CONFLICT (sha256) DO UPDATE SET
         extracted_at = now(), model = EXCLUDED.model, legible = EXCLUDED.legible,
         merchant = EXCLUDED.merchant, purchased_at = EXCLUDED.purchased_at,
         currency = EXCLUDED.currency, subtotal_cents = EXCLUDED.subtotal_cents,
         tax_cents = EXCLUDED.tax_cents, tip_cents = EXCLUDED.tip_cents,
         total_cents = EXCLUDED.total_cents, paid_cents = EXCLUDED.paid_cents,
         notes = EXCLUDED.notes, error = EXCLUDED.error,
         itemised = EXCLUDED.itemised, reader_version = EXCLUDED.reader_version,
         -- Counted on the row rather than passed in, so a retry increments
         -- whatever is already there. A success resets it to zero: the next
         -- time this image is re-read, for a new extracted field say, it
         -- starts with a full allowance rather than an exhausted one.
         -- Success resets the allowance. A failure the caller has already
         -- marked as final (it arrives at the cap) stays there; anything else
         -- increments what is stored, so a retry counts against the row
         -- rather than starting over.
         attempts = CASE WHEN EXCLUDED.error IS NULL THEN 0
                         WHEN EXCLUDED.attempts >= ${MAX_ATTEMPTS} THEN EXCLUDED.attempts
                         ELSE receipt_readings.attempts + 1 END`,
      [sha256, env.audit.model, reading?.legible ?? false, reading?.merchant ?? null,
       reading?.purchasedAt ?? "", reading?.currency ?? null,
       cents(reading?.subtotal), cents(reading?.tax), cents(reading?.tip), cents(reading?.total),
       reading?.notes ?? "", error, reading ? reading.itemised === true : null,
       error === null ? 0 : permanent ? MAX_ATTEMPTS : 1,
       cents(reading?.paid)],
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
            currency, subtotal_cents, tax_cents, tip_cents, total_cents, notes, error,
            auto_reread_at
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
    autoRereadAt: (r.auto_reread_at as Date | null)?.toISOString() ?? null,
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

/**
 * The expenses a receipt image belongs to.
 *
 * One image can sit on several expenses — the same photograph attached
 * twice, or a shared bill — so this is a list, and every one of them has
 * rule verdicts that were computed from what the receipt said BEFORE it
 * was read.
 */
export async function expensesForReceipts(shas: string[]): Promise<string[]> {
  await ensure();
  if (shas.length === 0) return [];
  const { rows } = await db().query<{ dedupe_key: string }>(
    "SELECT DISTINCT dedupe_key FROM expense_receipts WHERE sha256 = ANY($1)", [shas]);
  return rows.map((r) => r.dedupe_key);
}

/** Receipts we hold an image for but have never read. */
/**
 * How many times a failing image is retried before it is left alone.
 *
 * A transient failure — a timeout, a rate limit — deserves another go. A
 * permanent one does not, and the loop could not tell them apart: any read
 * that errored still looked unread, so it came round again on the next pass.
 * The morning a bad request made EVERY read fail, that was several hundred
 * model calls spent re-failing on the same receipts while nothing was being
 * imported.
 */
export const MAX_ATTEMPTS = 3;

/** Receipts we hold an image for and have not yet read successfully. */
export async function unreadReceipts(limit: number): Promise<string[]> {
  await ensure();
  const { rows } = await db().query<{ sha256: string }>(
    `SELECT b.sha256 FROM receipt_blobs b
      WHERE NOT EXISTS (
              SELECT 1 FROM receipt_readings r
               WHERE r.sha256 = b.sha256
                 -- Read by the CURRENT reader, or tried enough times that
                 -- trying again is just spending money to get the same
                 -- answer. A reading from an older reader is not "read":
                 -- that is how a fixed prompt reaches receipts that were
                 -- already done.
                 AND r.reader_version >= $3
                 AND (r.error IS NULL OR r.attempts >= $2))
      ORDER BY b.created_at DESC LIMIT $1`, [limit, MAX_ATTEMPTS, READER_VERSION]);
  return rows.map((r) => r.sha256);
}

/**
 * What the reader still has in front of it.
 *
 * The one number that explains a call count going up while nobody is
 * syncing. The reader wakes every half hour whether or not anything arrived,
 * and a receipt that failed is tried again — up to three times, then never
 * again. So a count that climbs by a few an hour and then stops is the retry
 * budget draining; one that climbs forever means new images keep arriving.
 * Without this on screen the only way to tell was to read the server log.
 */
export type ReadingBacklog = {
  /** Images with no reading yet, and retries left. Each will cost a call. */
  waiting: number;
  /** Tried the full three times and failed. These cost nothing further. */
  gaveUp: number;
  /** The most common reason among those, so the cause is named not guessed. */
  commonError: string | null;
};

export async function readingBacklog(): Promise<ReadingBacklog> {
  await ensure();
  const [waiting, gaveUp] = await Promise.all([
    db().query<{ n: string }>(
      `SELECT count(*) AS n FROM receipt_blobs b
        WHERE NOT EXISTS (
                SELECT 1 FROM receipt_readings r
                 WHERE r.sha256 = b.sha256
                   AND (r.error IS NULL OR r.attempts >= $1))`, [MAX_ATTEMPTS]),
    db().query<{ error: string; n: string }>(
      `SELECT error, count(*) AS n FROM receipt_readings
        WHERE error IS NOT NULL AND attempts >= $1
        GROUP BY error ORDER BY count(*) DESC LIMIT 1`, [MAX_ATTEMPTS]),
  ]);
  const top = gaveUp.rows[0];
  const total = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM receipt_readings WHERE error IS NOT NULL AND attempts >= $1`,
    [MAX_ATTEMPTS]);
  return {
    waiting: Number(waiting.rows[0]?.n ?? 0),
    gaveUp: Number(total.rows[0]?.n ?? 0),
    commonError: top?.error ?? null,
  };
}

export const canReadReceipts = (): boolean => isAuditConfigured() && isDbConfigured();
