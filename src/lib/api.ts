import { useQuery } from "@tanstack/react-query";

export type ReportStatus = "draft" | "submitted" | "approved" | "processed" | "rejected";

export type PolicyFlag = {
  code:
    | "missing-receipt" | "large-line" | "weekend-spend" | "possible-duplicate"
    | "ageing" | "rule-mismatch";
  label: string;
  /** What to bucket it under on the queue — a rule's name, for a rule flag. */
  group?: string;
  /**
   * The day (YYYY-MM-DD) this flag judged, when the rule judged a whole day
   * rather than one expense. Every expense in that person's day carries the
   * same value, which is how the queue draws them as one group.
   */
  dayGroup?: string;
  severity: "info" | "warn";
  lineIds: string[];
};

export type ExpenseLine = {
  id: string;
  reportId: string;
  date: string | null;
  category: string;
  merchant: string;
  amount: number;
  currency: string;
  reimbursable: boolean;
  billable: boolean;
  hasReceipt: boolean;
  /**
   * A receipt is attached and has not been read yet.
   *
   * Not the same as "no receipt": the image is there, the reader simply
   * has not got to it. Until it has, every rule about what the receipt
   * says returns UNKNOWN, so the expense is neither flagged nor cleared —
   * a state the queue used to show as an ordinary unflagged row, which
   * reads as "nothing wrong with this one".
   */
  receiptUnread?: boolean;
  receiptId: string;
  receiptUrl: string;
  glCode: string;
  note: string;
  /** Emburse's Location / Site. */
  location: string;
  /** How it was paid — "Corporate card", "Out of pocket". */
  method: string;
  /** Emburse section, when an import made it knowable. */
  section: string | null;
  /** What the most recent import changed on this expense; usually empty. */
  changes: FieldChange[];
};

export type FieldChange = { field: string; before: string | null; after: string | null };

export type ExpenseReport = {
  id: string;
  name: string;
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

export type AuditVerdict =
  | "match"
  | "claimed-more"
  | "claimed-less"
  | "unreadable"
  | "unavailable";

export type AuditResult = {
  lineId: string;
  verdict: AuditVerdict;
  claimed: number;
  receiptTotal: number | null;
  difference: number | null;
  message: string;
  checkedAt: string;
  demo: boolean;
};



export type Summary = {
  reportCount: number;
  total: number;
  awaitingTotal: number;
  flagged: number;
  byStatus: Partial<Record<ReportStatus, number>>;
  byDepartment: { name: string; count: number; total: number }[];
  byCategory: { name: string; total: number }[];
};

export type ReportsResponse = {
  window: { startDate: string; endDate: string };
  demo: boolean;
  fetchedAt: string;
  warnings: string[];
  reports: ExpenseReport[];
  summary: Summary;
};

export type SessionUser = { id: string; email: string; name: string; exp: number; isAdmin?: boolean };

export type AuthResponse = { user: SessionUser | null; authConfigured: boolean; isAdmin: boolean };

export type ConfigResponse = {
  configured: boolean;
  /** When the server process started — how the queue tells a stale failure. */
  bootedAt?: string;
  source: "imported" | "demo" | string;
  authConfigured: boolean;
  auditConfigured: boolean;
  product: "professional" | "enterprise" | "spend";
  baseUrl: string | null;
  policy: { receiptRequiredOver: number; largeLineOver: number; ageingAfterDays: number };
  missing: string[];
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function useAuth() {
  return useQuery({
    queryKey: ["auth"],
    queryFn: () => get<AuthResponse>("/api/auth/user"),
    // Re-check on focus: a session can lapse while the tab sits open.
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });
}

export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: () => get<ConfigResponse>("/api/config") });
}

export function useReports(days: number, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["reports", days],
    queryFn: () => {
      const end = new Date();
      const start = new Date(end.getTime() - days * 86_400_000);
      const qs = new URLSearchParams({
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
      });
      return get<ReportsResponse>(`/api/reports?${qs}`);
    },
    /**
     * Poll ONLY while receipts are still being read.
     *
     * The reader works through a backlog in the background, and an expense
     * moves out of "Receipt being read" into a flag or into Unflagged the
     * moment it has been. Without this the move only happened on a reload,
     * so the tab sat there full while the work was already done — and a
     * queue that needs a refresh to tell the truth is a queue nobody
     * trusts.
     *
     * Off the rest of the time, which is almost all of the time: a page
     * with nothing outstanding has nothing to poll for, and this response
     * is the expensive one.
     */
    refetchInterval: (query) =>
      (query.state.data?.reports ?? []).some((r) => r.lines.some((l) => l.receiptUnread))
        ? 15_000
        : false,
    refetchIntervalInBackground: false,
  });
}

export const STATUS_LABEL: Record<ReportStatus, string> = {
  draft: "Draft",
  submitted: "Awaiting review",
  approved: "Approved",
  processed: "Processed",
  rejected: "Rejected",
};
