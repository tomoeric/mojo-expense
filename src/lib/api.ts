import { useQuery } from "@tanstack/react-query";

export type ReportStatus = "draft" | "submitted" | "approved" | "processed" | "rejected";

export type PolicyFlag = {
  code: "missing-receipt" | "large-line" | "weekend-spend" | "possible-duplicate" | "ageing";
  label: string;
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
  receiptId: string;
  receiptUrl: string;
  glCode: string;
  note: string;
};

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

export async function auditReport(reportId: string, days: number): Promise<AuditResult[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const qs = new URLSearchParams({
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  });
  const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/audit?${qs}`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Check failed (${res.status})`);
  }
  const json = (await res.json()) as { results: AuditResult[] };
  return json.results;
}

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

export type SessionUser = { id: string; email: string; name: string; exp: number };

export type AuthResponse = { user: SessionUser | null; authConfigured: boolean };

export type ConfigResponse = {
  configured: boolean;
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
  });
}

export const STATUS_LABEL: Record<ReportStatus, string> = {
  draft: "Draft",
  submitted: "Awaiting review",
  approved: "Approved",
  processed: "Processed",
  rejected: "Rejected",
};
