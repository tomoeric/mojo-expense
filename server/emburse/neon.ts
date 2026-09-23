import { db } from "../db.js";
import { withFlags } from "./policy.js";
import { hitsFor, type Hit } from "../rules/store.js";
import type { EmburseProvider, ExpenseLine, ExpenseReport, FetchWindow, PolicyFlag, ProviderResult } from "./types.js";

/**
 * Reads imported expenses out of Neon.
 *
 * Emburse Spend is transaction-shaped — there is no submit/approve "report"
 * entity — so expenses are grouped into one reviewable item per employee per
 * day. That is a real unit of review rather than an invented one: it gives the
 * drawer genuine line detail, lets duplicate detection work within a day, and
 * keeps one receipt attached per line.
 *
 * Status comes from the inbox flag, which is the only workflow signal the
 * export carries: still in the Emburse inbox means awaiting review; gone from
 * it means processed upstream.
 */

type Row = {
  dedupe_key: string;
  employee: string;
  expense_date: Date | null;
  merchant: string;
  amount_cents: string;
  category: string | null;
  department: string | null;
  location: string | null;
  note: string | null;
  method: string | null;
  in_inbox: boolean;
  first_seen_at: Date;
  left_inbox_at: Date | null;
  section: string | null;
  receipt_count: string;
  changes: { field: string; before_value: string | null; after_value: string | null }[] | null;
};

export class NeonProvider implements EmburseProvider {
  readonly id = "neon";
  readonly label = "Imported expenses";

  async fetchReports(window: FetchWindow): Promise<ProviderResult> {
    const { rows } = await db().query<Row>(
      `SELECT e.dedupe_key, e.employee, e.expense_date, e.merchant, e.amount_cents,
              e.category, e.department, e.location, e.note, e.method,
              e.in_inbox, e.first_seen_at, e.left_inbox_at, e.section,
              (SELECT count(*) FROM expense_receipts r WHERE r.dedupe_key = e.dedupe_key) AS receipt_count,
              -- Only the newest import's changes. Older ones stay in the table
              -- for history, but "what changed" on screen means "since the last
              -- sync", and carrying every edit ever would drown that.
              (SELECT json_agg(json_build_object(
                        'field', c.field, 'before_value', c.before_value, 'after_value', c.after_value)
                        ORDER BY c.id)
                 FROM expense_changes c
                WHERE c.dedupe_key = e.dedupe_key
                  AND c.import_id = (SELECT max(id) FROM expense_imports)) AS changes
         FROM expenses e
        WHERE e.expense_date BETWEEN $1::date AND $2::date
        ORDER BY e.expense_date DESC, e.employee, e.merchant`,
      [window.startDate, window.endDate],
    );

    // One group per employee per day.
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = `${r.employee}|${iso(r.expense_date)}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(r);
      else groups.set(key, [r]);
    }

    // What the rules make of these expenses. Read once for the whole window
    // rather than per report: the queue is hundreds of reports and this is the
    // difference between one query and hundreds.
    let hits = new Map<string, Hit[]>();
    try {
      hits = await hitsFor(rows.map((r) => r.dedupe_key));
    } catch (err) {
      console.error("rules: could not read hits:", err);
    }

    const reports = [...groups.entries()].map(([key, group]) => toReport(key, group, hits));

    const warnings: string[] = [];
    const undated = rows.filter((r) => !r.expense_date).length;
    if (undated > 0) warnings.push(`${undated} imported expenses have no date and are excluded from this window.`);

    return { reports, warnings, fetchedAt: new Date().toISOString() };
  }
}

function toReport(key: string, group: Row[], hits: Map<string, Hit[]>): ExpenseReport {
  const first = group[0]!;
  const date = iso(first.expense_date);
  const lines: ExpenseLine[] = group.map((r) => ({
    id: r.dedupe_key,
    reportId: key,
    date,
    category: r.category || "Uncategorised",
    merchant: r.merchant || "—",
    amount: Number(r.amount_cents) / 100,
    currency: "USD",
    reimbursable: (r.method ?? "").toLowerCase().includes("corporate card") ? false : true,
    billable: false,
    hasReceipt: Number(r.receipt_count) > 0,
    receiptId: Number(r.receipt_count) > 0 ? r.dedupe_key : "",
    receiptUrl: "",
    glCode: "",
    note: r.note ?? "",
    location: r.location ?? "",
    method: r.method ?? "",
    section: r.section,
    changes: (r.changes ?? []).map((c) => ({
      field: c.field, before: c.before_value, after: c.after_value,
    })),
  }));

  const total = lines.reduce((a, l) => a + l.amount, 0);
  // Still in the Emburse inbox = nobody has actioned it yet.
  const open = group.some((r) => r.in_inbox);
  const processedAt = group.map((r) => r.left_inbox_at).filter(Boolean).sort()[0] ?? null;

  const sites = [...new Set(group.map((r) => r.location).filter(Boolean))];
  // A rule mismatch is a flag like any other, so it lands in the same place a
  // reviewer already looks — one per rule, naming the rule, because "three
  // problems" tells nobody which three.
  const ruleFlags: PolicyFlag[] = [];
  const byRule = new Map<string, { label: string; lineIds: string[] }>();
  for (const line of lines) {
    for (const hit of hits.get(line.id) ?? []) {
      const seen = byRule.get(hit.ruleName);
      if (seen) seen.lineIds.push(line.id);
      else byRule.set(hit.ruleName, { label: hit.detail, lineIds: [line.id] });
    }
  }
  for (const [name, { label, lineIds }] of byRule) {
    ruleFlags.push({
      code: "rule-mismatch",
      label: `${name}${label ? ` — ${label}` : ""}`,
      severity: "warn",
      lineIds,
    });
  }

  return withFlags({
    id: key,
    name: lines.length === 1 ? lines[0]!.merchant : `${lines.length} expenses`,
    // The grouping key is an internal id; show the sites instead.
    reference: sites.length === 1 ? sites[0]! : sites.length > 1 ? `${sites.length} sites` : "",
    employeeName: first.employee,
    employeeEmail: "",
    department: first.department || "Unassigned",
    status: open ? "submitted" : "processed",
    submittedDate: date,
    approvedDate: null,
    processedDate: open ? null : isoDateOnly(processedAt),
    approverName: "",
    total,
    // The export does not say what is reimbursable; card spend is the company's
    // own money, so nothing is treated as owed back to the employee.
    reimbursableTotal: lines.filter((l) => l.reimbursable).reduce((a, l) => a + l.amount, 0),
    currency: "USD",
    lineCount: lines.length,
    lines,
  }, ruleFlags);
}

const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const isoDateOnly = (d: Date | string | null): string | null =>
  d ? new Date(d).toISOString().slice(0, 10) : null;
