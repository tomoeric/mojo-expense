import type { ReportStatus } from "./types.js";

type Row = Record<string, unknown>;

/** Case-insensitive field pick — Emburse products vary between PascalCase and camelCase. */
export function pick(row: Row, ...names: string[]): unknown {
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) lower.set(k.toLowerCase(), v);
  for (const n of names) {
    const v = lower.get(n.toLowerCase());
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

export function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string") {
    // Tolerate "1,234.56" and "$1,234.56".
    const n = Number.parseFloat(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return true;
    if (["false", "no", "n", "0"].includes(s)) return false;
  }
  return fallback;
}

/** Normalise any recognisable date to `YYYY-MM-DD`; null when unparseable. */
export function asDate(v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Map a product's own status vocabulary onto our five states. Emburse
 * Professional reports move Draft → Submitted → Approved → Processed, with
 * Rejected as a side exit; Enterprise and Spend use their own words for the
 * same stages.
 */
export function asStatus(v: unknown): ReportStatus {
  const s = asString(v).toLowerCase();
  if (!s) return "draft";
  if (/(reject|denied|declin|returned)/.test(s)) return "rejected";
  if (/(processed|paid|reimbursed|exported|closed|complete)/.test(s)) return "processed";
  if (/(approv)/.test(s)) return "approved";
  if (/(submit|pending|review|awaiting|open)/.test(s)) return "submitted";
  return "draft";
}

/**
 * Emburse endpoints wrap their collections inconsistently — sometimes a bare
 * array, sometimes `{ ExpenseReports: [...] }`, sometimes `{ data: [...] }`.
 * Pull the first array we find.
 */
export function rowsOf(payload: unknown): Row[] {
  if (Array.isArray(payload)) return payload.filter(isRow);
  if (payload && typeof payload === "object") {
    for (const v of Object.values(payload as Row)) {
      if (Array.isArray(v)) return v.filter(isRow);
    }
  }
  return [];
}

function isRow(v: unknown): v is Row {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
