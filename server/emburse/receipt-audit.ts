import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { env, isAuditConfigured, isEmburseConfigured } from "../env.js";
import { callAnthropic, describeAiConfig } from "../ai.js";
import { fetchReceipt, ReceiptError } from "./receipts.js";
import type { ExpenseLine } from "./types.js";

/**
 * Reads the total off a receipt image and compares it to what was claimed.
 *
 * The honest framing matters here: a difference is a PROMPT TO LOOK, not proof
 * of anything. A receipt total legitimately differs from the claim when a bill
 * was split between colleagues, a tip was added after printing, personal items
 * were excluded, or the amount was converted from another currency. So the two
 * directions are reported separately — claiming MORE than the receipt shows is
 * the signal worth a reviewer's time; claiming less is usually benign.
 */

const ReceiptReading = z.object({
  total: z
    .number()
    .nullable()
    .describe("The final total actually charged, after tax and tip. Null if not legible."),
  subtotal: z.number().nullable().describe("Pre-tax subtotal, or null."),
  tip: z.number().nullable().describe("Tip or gratuity, or null."),
  currency: z.string().nullable().describe("ISO code such as USD, or null."),
  merchant: z.string().nullable().describe("Merchant name as printed, or null."),
  date: z.string().nullable().describe("Transaction date as YYYY-MM-DD, or null."),
  legible: z.boolean().describe("False if the image is too unclear to read a total."),
  notes: z
    .string()
    .describe(
      "One short sentence for a reviewer — e.g. an itemised bill covering several people, or a total that is hard to make out. Empty string if unremarkable.",
    ),
});

export type ReceiptReading = z.infer<typeof ReceiptReading>;

export type AuditVerdict =
  /** Receipt total agrees with the claim, within tolerance. */
  | "match"
  /** Claimed MORE than the receipt shows — the one worth reviewing. */
  | "claimed-more"
  /** Claimed LESS than the receipt shows — usually a split bill. */
  | "claimed-less"
  /** Receipt reached us but no total could be read from it. */
  | "unreadable"
  /** No receipt, or auditing is not configured. */
  | "unavailable";

export type AuditResult = {
  lineId: string;
  verdict: AuditVerdict;
  claimed: number;
  receiptTotal: number | null;
  /** receiptTotal − claimed. Positive means the receipt is larger. */
  difference: number | null;
  reading: ReceiptReading | null;
  message: string;
  checkedAt: string;
  /** True when the result is simulated because Emburse is not connected. */
  demo: boolean;
};

/**
 * In-memory only, and deliberately so — this app has no database. Results are
 * lost on restart, which is fine for a reviewer working a queue but means this
 * is NOT an audit trail. Persisting verdicts would need a real table.
 */
const cache = new Map<string, AuditResult>();
const key = (line: ExpenseLine) => `${line.id}:${line.amount.toFixed(2)}`;

/** Slack allowed before a difference is called out at all. */
function tolerance(claimed: number): number {
  return Math.max(env.audit.toleranceAbs, Math.abs(claimed) * env.audit.tolerancePct);
}

export async function auditLine(line: ExpenseLine, force = false): Promise<AuditResult> {
  const cached = cache.get(key(line));
  if (cached && !force) return cached;

  const result = await runAudit(line);
  cache.set(key(line), result);
  return result;
}

export function cachedAudit(line: ExpenseLine): AuditResult | null {
  return cache.get(key(line)) ?? null;
}

async function runAudit(line: ExpenseLine): Promise<AuditResult> {
  const base = {
    lineId: line.id,
    claimed: line.amount,
    checkedAt: new Date().toISOString(),
    demo: false,
  };

  if (!line.hasReceipt) {
    return { ...base, verdict: "unavailable", receiptTotal: null, difference: null, reading: null,
      message: "No receipt is attached to this line." };
  }

  // Without Emburse the only "receipt" is our own drawn placeholder, so there
  // is nothing real to read. Simulate a spread of verdicts instead of spending
  // tokens on a picture we generated ourselves.
  if (!isEmburseConfigured()) return simulate(line, base);

  if (!isAuditConfigured()) {
    return { ...base, verdict: "unavailable", receiptTotal: null, difference: null, reading: null,
      message: "Receipt checking is unavailable — ANTHROPIC_API_KEY is not set." };
  }

  let receipt;
  try {
    receipt = await fetchReceipt(line);
  } catch (err) {
    return { ...base, verdict: "unavailable", receiptTotal: null, difference: null, reading: null,
      message: err instanceof ReceiptError ? err.message : "Could not fetch the receipt." };
  }

  let reading: ReceiptReading;
  try {
    reading = await read(receipt.contentType, receipt.body);
  } catch (err) {
    return { ...base, verdict: "unavailable", receiptTotal: null, difference: null, reading: null,
      message: describe(err) };
  }

  if (!reading.legible || reading.total === null) {
    return { ...base, verdict: "unreadable", receiptTotal: null, difference: null, reading,
      message: reading.notes || "The total could not be read from this receipt." };
  }

  return { ...base, ...compare(line.amount, reading.total), reading };
}

/** Turn a read total into a verdict + reviewer-facing sentence. */
function compare(claimed: number, receiptTotal: number) {
  const difference = Number((receiptTotal - claimed).toFixed(2));
  const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;

  if (Math.abs(difference) <= tolerance(claimed)) {
    return {
      verdict: "match" as const,
      receiptTotal,
      difference,
      message: `Receipt total ${money(receiptTotal)} matches the claim.`,
    };
  }

  if (difference < 0) {
    return {
      verdict: "claimed-more" as const,
      receiptTotal,
      difference,
      message: `Claim is ${money(difference)} more than the receipt total of ${money(receiptTotal)}.`,
    };
  }

  return {
    verdict: "claimed-less" as const,
    receiptTotal,
    difference,
    message: `Receipt total is ${money(receiptTotal)}, ${money(difference)} more than claimed — often a split bill.`,
  };
}

const SYSTEM = `You read expense receipts and report exactly what is printed on them.

Report the FINAL TOTAL CHARGED — the bottom-line amount including tax and tip, not the subtotal.
If a tip was handwritten on top of a printed total, the final total is printed plus handwritten.
Report only what you can actually see. If the total is illegible, cropped, or obscured, set
legible to false rather than guessing or inferring it from the other figures.
Never adjust what you read to make it agree with any amount you may have been told.`;

async function read(contentType: string, body: Buffer): Promise<ReceiptReading> {
  const data = body.toString("base64");

  // PDFs go in a document block; everything else is an image block.
  const media: Anthropic.ContentBlockParam =
    contentType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data,
          },
        };

  const response = await callAnthropic((c) => c.messages.parse({
    model: env.audit.model,
    max_tokens: 2000,
    system: SYSTEM,
    // Low effort: this is short-form extraction, not reasoning, and the whole
    // point is that it stays cheap enough to run across a report.
    output_config: { effort: "low", format: zodOutputFormat(ReceiptReading) },
    messages: [
      {
        role: "user",
        // The claimed amount is deliberately NOT sent — telling the model what
        // it "should" see invites it to agree. The comparison happens in code.
        content: [media, { type: "text", text: "Read this receipt." }],
      },
    ],
  }));

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("The receipt reading came back in an unexpected shape.");
  return parsed;
}

/** Deterministic stand-in so the feature is demonstrable before Emburse exists. */
function simulate(
  line: ExpenseLine,
  base: { lineId: string; claimed: number; checkedAt: string; demo: boolean },
): AuditResult {
  // Stable hash of the line id — the same line always simulates the same way.
  // The final avalanche matters: ids in one report differ only in a trailing
  // digit, and a plain rolling hash would put a whole report in one bucket.
  let h = 0x811c9dc5;
  for (const ch of line.id) {
    h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  }
  // `>>> 0` after every step: Math.imul and ^ both yield SIGNED 32-bit ints,
  // and a negative h makes h % 100 negative — which silently dumps most ids
  // into the first bucket.
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  const roll = h % 100;

  if (roll < 12) {
    const receiptTotal = Number((line.amount - Math.max(1, line.amount * 0.08)).toFixed(2));
    return { ...base, demo: true, reading: null, ...compare(line.amount, receiptTotal),
      message: `SAMPLE — claim is $${(line.amount - receiptTotal).toFixed(2)} more than the receipt total of $${receiptTotal.toFixed(2)}.` };
  }
  if (roll < 20) {
    const receiptTotal = Number((line.amount * 2).toFixed(2));
    return { ...base, demo: true, reading: null, ...compare(line.amount, receiptTotal),
      message: `SAMPLE — receipt total $${receiptTotal.toFixed(2)} is larger; looks like a split bill.` };
  }
  if (roll < 26) {
    return { ...base, demo: true, verdict: "unreadable", receiptTotal: null, difference: null,
      reading: null, message: "SAMPLE — the total could not be read from this receipt." };
  }
  return { ...base, demo: true, verdict: "match", receiptTotal: line.amount, difference: 0,
    reading: null, message: `SAMPLE — receipt total $${line.amount.toFixed(2)} matches the claim.` };
}

function describe(err: unknown): string {
  // Configuration failures first: "HTTP 404" is true and useless, and this one
  // has a fix that nobody would guess from it.
  const config = describeAiConfig(err);
  if (config) return config;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited while reading the receipt — try again shortly.";
  if (err instanceof Anthropic.BadRequestError) {
    return `The receipt could not be sent for reading (${err.message.slice(0, 120)}).`;
  }
  if (err instanceof Anthropic.APIError) return `Reading the receipt failed (HTTP ${err.status}).`;
  return err instanceof Error ? err.message : "Reading the receipt failed.";
}
