import { env } from "../env.js";
import type { ExpenseReport, ExpenseLine, PolicyFlag } from "./types.js";

const DAY_MS = 86_400_000;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

function isWeekend(iso: string | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const day = new Date(t).getUTCDay();
  return day === 0 || day === 6;
}

/** Same merchant + same amount + same day, more than once in one report. */
function duplicateLineIds(lines: ExpenseLine[]): string[] {
  const seen = new Map<string, string[]>();
  for (const l of lines) {
    const key = `${l.merchant.trim().toLowerCase()}|${l.amount.toFixed(2)}|${l.date ?? ""}`;
    const bucket = seen.get(key);
    if (bucket) bucket.push(l.id);
    else seen.set(key, [l.id]);
  }
  return [...seen.values()].filter((ids) => ids.length > 1).flat();
}

/**
 * Derive the reviewer-facing flags for one report. Pure and deterministic, so
 * the same report always flags the same way regardless of which provider
 * produced it. Thresholds come from env (see CONFIG in the README).
 */
export function flagsForReport(report: Omit<ExpenseReport, "flags">): PolicyFlag[] {
  const flags: PolicyFlag[] = [];
  const { receiptRequiredOver, largeLineOver, ageingAfterDays } = env.policy;

  const missingReceipt = report.lines
    .filter((l) => !l.hasReceipt && l.amount >= receiptRequiredOver)
    .map((l) => l.id);
  if (missingReceipt.length > 0) {
    flags.push({
      code: "missing-receipt",
      label: `${missingReceipt.length} line${missingReceipt.length === 1 ? "" : "s"} over $${receiptRequiredOver} without a receipt`,
      severity: "warn",
      lineIds: missingReceipt,
    });
  }

  const large = report.lines.filter((l) => l.amount >= largeLineOver).map((l) => l.id);
  if (large.length > 0) {
    flags.push({
      code: "large-line",
      label: `${large.length} line${large.length === 1 ? "" : "s"} at or over $${largeLineOver}`,
      severity: "info",
      lineIds: large,
    });
  }

  const weekend = report.lines.filter((l) => isWeekend(l.date)).map((l) => l.id);
  if (weekend.length > 0) {
    flags.push({
      code: "weekend-spend",
      label: `${weekend.length} weekend-dated line${weekend.length === 1 ? "" : "s"}`,
      severity: "info",
      lineIds: weekend,
    });
  }

  const dupes = duplicateLineIds(report.lines);
  if (dupes.length > 0) {
    flags.push({
      code: "possible-duplicate",
      label: `${dupes.length} lines share a merchant, amount and date`,
      severity: "warn",
      lineIds: dupes,
    });
  }

  const age = daysSince(report.submittedDate);
  if (report.status === "submitted" && age !== null && age >= ageingAfterDays) {
    flags.push({
      code: "ageing",
      label: `Waiting ${age} days for review`,
      severity: "warn",
      lineIds: [],
    });
  }

  return flags;
}

/**
 * Attach flags to a report built by a provider.
 *
 * `extra` is for flags the provider worked out for itself — today, the ones
 * the user's own rules raised. They go FIRST: a rule is something somebody
 * deliberately asked to be told about, which outranks the built-in policy
 * checks that fire on every report.
 */
export function withFlags(
  report: Omit<ExpenseReport, "flags">,
  extra: PolicyFlag[] = [],
): ExpenseReport {
  return { ...report, flags: [...extra, ...flagsForReport(report)] };
}
