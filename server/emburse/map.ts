import { withFlags } from "./policy.js";
import { asBool, asDate, asNumber, asStatus, asString, pick } from "./normalize.js";
import type { ExpenseLine, ExpenseReport } from "./types.js";

type Row = Record<string, unknown>;

const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);

let seq = 0;
const fallbackId = (prefix: string): string => `${prefix}-${(seq += 1)}`;

/**
 * Row → line/report mapping shared by every provider.
 *
 * The alias lists cover the spellings seen across Emburse Professional
 * (PascalCase, Certify lineage), Enterprise/Chrome River, and Spend (camelCase),
 * so one mapper serves all three. `pick` is case-insensitive, so a variant that
 * differs only in casing needs no new alias.
 */
export function toLine(row: Row): ExpenseLine {
  return {
    // Change tracking is a property of the import pipeline; a live API payload
    // carries no before-state to diff against.
    changes: [],
    section: null,
    id: asString(pick(row, "ExpenseID", "ExpenseId", "LineID", "id", "uuid"), fallbackId("line")),
    reportId: asString(
      pick(row, "ExpenseReportID", "ExpenseReportId", "ReportID", "reportId", "report_id", "expense_report_id"),
    ),
    date: asDate(
      pick(row, "ExpenseDate", "TransactionDate", "Date", "date", "transaction_date", "created_at", "posted_at"),
    ),
    category: asString(
      pick(row, "Category", "CategoryName", "category", "category_name", "expense_type", "expense_category"),
      "Uncategorised",
    ),
    merchant: asString(
      pick(row, "Vendor", "Merchant", "Payee", "merchant", "merchant_name", "Description", "description", "note"),
      "—",
    ),
    amount: asNumber(pick(row, "Amount", "amount", "ExpenseAmount", "total", "amount_cents_converted")),
    currency: asString(pick(row, "Currency", "CurrencyCode", "currency"), "USD"),
    reimbursable: asBool(pick(row, "Reimbursable", "IsReimbursable", "reimbursable"), true),
    billable: asBool(pick(row, "Billable", "IsBillable", "billable"), false),
    hasReceipt: asBool(pick(row, "HasReceipt", "ReceiptAttached", "hasReceipt", "receipt"), false),
    receiptId: asString(pick(row, "ReceiptID", "ReceiptId", "receiptId", "receipt_id", "AttachmentID")),
    receiptUrl: asString(pick(row, "ReceiptURL", "ReceiptUrl", "receiptUrl", "receipt_url", "ImageURL")),
    glCode: asString(pick(row, "GLCode", "GlCode", "AccountCode", "glCode", "gl_code")),
    note: asString(pick(row, "Note", "Notes", "Reason", "note", "memo")),
    location: asString(pick(row, "Location", "Site", "LocationSite", "location", "site")),
  };
}

export function toReport(row: Row, linesByReport: Map<string, ExpenseLine[]>): ExpenseReport {
  const id = asString(
    pick(row, "ExpenseReportID", "ExpenseReportId", "ReportID", "id", "uuid", "report_id"),
    fallbackId("report"),
  );
  const lines = linesByReport.get(id) ?? [];

  return withFlags({
    id,
    reference: id,
    name: asString(pick(row, "ExpenseReportName", "ReportName", "Name", "Title", "name"), `Report ${id}`),
    employeeName: asString(
      pick(row, "EmployeeName", "UserName", "SubmitterName", "employeeName", "employee_name", "owner_name"),
      "Unknown",
    ),
    employeeEmail: asString(pick(row, "EmployeeEmail", "Email", "UserEmail", "employeeEmail", "email")),
    department: asString(pick(row, "Department", "DepartmentName", "department"), "Unassigned"),
    status: asStatus(pick(row, "Status", "ReportStatus", "State", "status", "state")),
    submittedDate: asDate(pick(row, "SubmittedDate", "DateSubmitted", "submittedDate", "submitted_at")),
    approvedDate: asDate(pick(row, "ApprovedDate", "DateApproved", "approvedDate", "approved_at")),
    // TrueProcessedDate is when a report was actually processed; ProcessedDate
    // can be back- or forward-dated by an accountant, so prefer the true one.
    processedDate: asDate(
      pick(row, "TrueProcessedDate", "ProcessedDate", "DateProcessed", "processedDate", "processed_at"),
    ),
    approverName: asString(pick(row, "ApproverName", "Approver", "approverName", "approver")),
    total: asNumber(pick(row, "TotalAmount", "Total", "Amount", "total"), sum(lines.map((l) => l.amount))),
    reimbursableTotal: asNumber(
      pick(row, "ReimbursableAmount", "ReimbursableTotal"),
      sum(lines.filter((l) => l.reimbursable).map((l) => l.amount)),
    ),
    currency: asString(pick(row, "Currency", "CurrencyCode", "currency"), "USD"),
    lineCount: lines.length || asNumber(pick(row, "ExpenseCount", "LineCount", "expense_count"), 0),
    lines,
  });
}

/** Group already-mapped lines by their parent report id. */
export function groupLines(rows: Row[]): Map<string, ExpenseLine[]> {
  const byReport = new Map<string, ExpenseLine[]>();
  for (const row of rows) {
    const line = toLine(row);
    if (!line.reportId) continue;
    const bucket = byReport.get(line.reportId);
    if (bucket) bucket.push(line);
    else byReport.set(line.reportId, [line]);
  }
  return byReport;
}
