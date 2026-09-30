import { db } from "../db.js";
import { withFlags } from "./policy.js";
import { hitsFor, type Hit } from "../rules/store.js";
import { MAX_ATTEMPTS } from "./receipt-items.js";
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
  receipt_label: string | null;
  share_peers: string | null;
  share_total_cents: string | null;
  receipt_unread: boolean;
  changes: { field: string; before_value: string | null; after_value: string | null }[] | null;
};

export class NeonProvider implements EmburseProvider {
  readonly id = "neon";
  readonly label = "Imported expenses";

  async fetchReports(window: FetchWindow): Promise<ProviderResult> {
    const { rows } = await db().query<Row>(
      `SELECT e.dedupe_key, e.employee, e.expense_date, e.merchant, e.amount_cents,
              e.category, e.department, e.location, e.note, e.method,
              e.in_inbox, e.first_seen_at, e.left_inbox_at, e.section, e.receipt_label,
              (SELECT count(*) FROM expense_receipts r WHERE r.dedupe_key = e.dedupe_key) AS receipt_count,
              -- One receipt divided across expenses, and whether the shares
              -- add up to it. Identified by content hash, so this is proven
              -- rather than inferred from a matching merchant and date.
              (SELECT count(DISTINCT er2.dedupe_key)
                 FROM expense_receipts er
                 JOIN expense_receipts er2 ON er2.sha256 = er.sha256
                WHERE er.dedupe_key = e.dedupe_key) AS share_peers,
              (SELECT sum(x.amount_cents) FROM (
                 SELECT DISTINCT er2.dedupe_key, e2.amount_cents
                   FROM expense_receipts er
                   JOIN expense_receipts er2 ON er2.sha256 = er.sha256
                   JOIN expenses e2 ON e2.dedupe_key = er2.dedupe_key
                  WHERE er.dedupe_key = e.dedupe_key) x) AS share_total_cents,
              -- A receipt attached that nobody has managed to read yet.
              --
              -- Never read, not "not read by the CURRENT reader": bumping
              -- READER_VERSION re-queues everything already read, and if
              -- that counted here the whole queue would drop into "Reading
              -- receipts" after every reader improvement. This is about a
              -- newly imported expense whose receipt has not been looked at
              -- once.
              --
              -- And not one the reader has given up on. Three failed
              -- attempts is not "being read", it is finished and unreadable,
              -- and parking those in a waiting bucket for ever is how a
              -- status stops meaning anything.
              (EXISTS (
                SELECT 1 FROM expense_receipts r
                 WHERE r.dedupe_key = e.dedupe_key
                   AND NOT EXISTS (
                         SELECT 1 FROM receipt_readings rr
                          WHERE rr.sha256 = r.sha256
                            AND (rr.error IS NULL OR rr.attempts >= ${MAX_ATTEMPTS})))
               -- OR read, and not judged on it yet.
               --
               -- The second half closes a window the queue was lying in.
               -- The reader works through a batch one receipt at a time and
               -- re-runs the rules for the whole batch at the end — half a
               -- minute later for twenty-five — so an expense read early
               -- had a total, no verdict, and showed as Unflagged. Which is
               -- supposed to mean judged and clean, and is the entire
               -- reason this state exists.
               OR EXISTS (
                SELECT 1 FROM expense_receipts r
                  JOIN receipt_readings rr ON rr.sha256 = r.sha256
                 WHERE r.dedupe_key = e.dedupe_key
                   AND rr.error IS NULL
                   AND (e.rules_run_at IS NULL OR rr.extracted_at > e.rules_run_at))
              ) AS receipt_unread,
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
    // Attached, and still waiting for its first reading.
    receiptUnread: r.receipt_unread === true,
    receiptId: Number(r.receipt_count) > 0 ? r.dedupe_key : "",
    // What the export's Receipt column said — "Receipt 1 of 2". Imported
    // since the beginning and never shown, which mattered: it is Emburse's
    // own count, and an expense whose receipt column says 2 while we hold
    // one image is a different problem from one with none.
    receiptLabel: r.receipt_label ?? "",
    receiptCount: Number(r.receipt_count),
    firstSeenAt: r.first_seen_at instanceof Date ? r.first_seen_at.toISOString() : null,
    sharedWith: Number(r.share_peers ?? 1),
    shareTotal: r.share_total_cents === null ? null : Number(r.share_total_cents) / 100,
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
  // Keyed by rule AND, for a day rule, by the day it judged. A rule that
  // judges the whole day produces one flag per day rather than one overall,
  // so each carries the date its verdict was about.
  const byRule = new Map<string, {
    name: string; label: string; lineIds: string[]; day: string | null;
  }>();
  for (const line of lines) {
    for (const hit of hits.get(line.id) ?? []) {
      const day = hit.dayGroup ? line.date : null;
      const key = day ? `${hit.ruleName}\u0000${day}` : hit.ruleName;
      const seen = byRule.get(key);
      if (seen) seen.lineIds.push(line.id);
      else byRule.set(key, { name: hit.ruleName, label: hit.detail, lineIds: [line.id], day });
    }
  }
  for (const { name, label, lineIds, day } of byRule.values()) {
    ruleFlags.push({
      code: "rule-mismatch",
      label: `${name}${label ? ` — ${label}` : ""}`,
      // The rule's name on its own, so the queue can separate one rule's
      // catches from another's without splitting the label back apart.
      group: name,
      ...(day ? { dayGroup: day } : {}),
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
