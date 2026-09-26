/**
 * The normalised domain model the UI talks to.
 *
 * Each Emburse product returns a differently-shaped payload; every provider in
 * this folder maps its own response into these types, so the frontend never
 * has to know which product is behind it.
 */

export type ReportStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "processed"
  | "rejected";

/** Statuses that put a report in front of a reviewer. */
export const OPEN_STATUSES: readonly ReportStatus[] = ["submitted", "approved"];

export type PolicyFlagCode =
  | "missing-receipt"
  | "large-line"
  | "weekend-spend"
  | "possible-duplicate"
  | "ageing"
  | "rule-mismatch";

export type PolicyFlag = {
  code: PolicyFlagCode;
  label: string;
  /**
   * What to bucket this flag under on screen.
   *
   * For a rule it is the rule's name, so the queue can separate "Meal Count
   * > 3" from "Gas Category" rather than lumping every rule together. Parsing
   * it back out of `label` would work until a rule name contained the
   * separator, which is the kind of bug that surfaces months later.
   */
  group?: string;
  severity: "info" | "warn";
  /** Line ids the flag points at; empty when the flag is report-level. */
  lineIds: string[];
};

export type ExpenseLine = {
  id: string;
  reportId: string;
  /** ISO date (YYYY-MM-DD) the expense was incurred. */
  date: string | null;
  category: string;
  merchant: string;
  amount: number;
  currency: string;
  reimbursable: boolean;
  billable: boolean;
  hasReceipt: boolean;
  /** Tenant's own receipt id, when the line exposes one. */
  receiptId: string;
  /**
   * Absolute receipt URL, when the line carries one instead of an id. Only
   * ever fetched server-side, and only when the host matches the Emburse API
   * host — see `receipts.ts`.
   */
  receiptUrl: string;
  glCode: string;
  note: string;
  /**
   * Emburse's Location / Site. Its own field rather than appended to the note,
   * so it can be a column, sorted and searched, instead of prose inside one.
   */
  location: string;
  /** How it was paid — "Corporate card", "Out of pocket". */
  method: string;
  /** Emburse section, when an import made it knowable. */
  section: string | null;
  /**
   * What the most recent import changed on this expense. Empty for everything
   * that arrived unchanged, which is almost every row on almost every day —
   * that is what makes the few that did change worth a second look.
   */
  changes: FieldChange[];
};

export type FieldChange = {
  field: string;
  before: string | null;
  after: string | null;
};

export type ExpenseReport = {
  id: string;
  name: string;
  /** Short human label under the name — a report number, a site, or blank. */
  reference: string;
  employeeName: string;
  employeeEmail: string;
  department: string;
  status: ReportStatus;
  submittedDate: string | null;
  approvedDate: string | null;
  processedDate: string | null;
  approverName: string;
  total: number;
  reimbursableTotal: number;
  currency: string;
  lineCount: number;
  lines: ExpenseLine[];
  flags: PolicyFlag[];
};

export type FetchWindow = {
  /** ISO date, inclusive. */
  startDate: string;
  /** ISO date, inclusive. */
  endDate: string;
};

export type ProviderResult = {
  reports: ExpenseReport[];
  /** Non-fatal problems worth surfacing in the UI's Warnings pill. */
  warnings: string[];
  fetchedAt: string;
};

export interface EmburseProvider {
  readonly id: string;
  readonly label: string;
  fetchReports(window: FetchWindow): Promise<ProviderResult>;
}
