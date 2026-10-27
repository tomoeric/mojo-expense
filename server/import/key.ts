import crypto from "node:crypto";
import type { ParsedExpense } from "./parse-pdf.js";

/**
 * Identity for an expense across daily imports.
 *
 * The export carries no transaction id, so the key is composed from the
 * fields that identify the expense. Two choices in here matter:
 *
 *   - `location` IS part of the key. It looks incidental until you meet a
 *     purchase split across sites: one $15.67 Sam's Club run appears five
 *     times, identical in every field except Location. Drop it and those five
 *     rows collapse into one and four expenses are lost.
 *   - `note` is NOT part of the key. Submitters edit descriptions after the
 *     fact; if the note were included, an edit would import as a brand new
 *     row instead of updating the existing one — the exact duplicate this is
 *     meant to prevent.
 *
 * Measured against a real 193-row export, these fields yield 193 distinct
 * keys with no collisions. On a later 317-row export two pairs were genuinely
 * identical in all seven — somebody bought fuel twice at the same pump for the
 * same amount on the same day — hence `occurrence`.
 *
 * `occurrence` is the index of this row among the identical ones in the same
 * export: 0 for the first, 1 for the second. It is the ONLY thing that can
 * separate two rows the export describes identically, and leaving them to
 * collapse silently lost one of the two — it never reached the queue and could
 * never be approved.
 *
 * Occurrence 0 hashes exactly as before, so the keys of every non-duplicated
 * row are unchanged and no existing expense is re-identified.
 *
 * It is stable across imports because the pair keeps arriving as a pair. When
 * one of them is approved, the next export has a single row, it takes
 * occurrence 0, and the other is correctly seen to have left — which of the
 * two "left" is not a meaningful question, because they are identical.
 */
export function dedupeKey(
  e: Pick<ParsedExpense,
    "employee" | "date" | "merchant" | "amountCents" | "category" | "location" | "department">,
  occurrence = 0,
  /**
   * WHICH EMBURSE ACCOUNT this row came from.
   *
   * One person can submit in two tenants, and the same purchase
   * made in each is two expenses that must both survive — the
   * seven fields above cannot tell them apart, and collapsing
   * them loses one silently, exactly as the duplicate pair did
   * before `occurrence` existed.
   *
   * Empty for the manager queue, which hashes exactly as before,
   * so no row already in the table is re-identified. That is not
   * a nicety: a changed key is a new expense and a lost decision
   * history, for every row at once.
   */
  lane = "",
): string {
  const parts = [
    e.employee, e.date, e.merchant, String(e.amountCents),
    e.category, e.location, e.department,
  ].map((p) => (p ?? "").trim().toLowerCase().replace(/\s+/g, " "));
  if (occurrence > 0) parts.push(`#${occurrence}`);
  if (lane) parts.push(`@${lane.trim().toLowerCase()}`);
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

export const sha256 = (b: Buffer | Uint8Array): string =>
  crypto.createHash("sha256").update(b).digest("hex");
