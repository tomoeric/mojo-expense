import { useQuery } from "@tanstack/react-query";

export type ReportStatus = "draft" | "submitted" | "approved" | "processed" | "rejected";

export type PolicyFlag = {
  code:
    | "missing-receipt" | "large-line" | "weekend-spend" | "possible-duplicate"
    | "shared-receipt"
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
  /** Emburse's own Receipt column — "Receipt 1 of 2". */
  receiptLabel?: string;
  /** Where an email-matched receipt has got to; null if none was matched. */
  matchState?: "sent" | "already" | "queued" | "failed" | "matched" | "candidate" | null;
  /** How many receipt images we actually hold for it. */
  receiptCount?: number;
  /** When this expense first appeared in an import. */
  firstSeenAt?: string | null;
  /** How many expenses share this one's receipt image, itself included. */
  sharedWith?: number;
  /** What all those shares add up to — compare it with the receipt total. */
  shareTotal?: number | null;
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

/** One queue to switch between: the manager one, or a personal account. */
export type Queue = {
  key: string;
  label: string;
  /** The Emburse account it reads. Empty on the manager queue. */
  loginEmail: string;
  connected: boolean;
};

export type ReportsResponse = {
  window: { startDate: string; endDate: string };
  /** Which queue this is. "all" when every account was asked for. */
  lane?: string;
  /**
   * The queues this person can switch between.
   *
   * Empty when there is only one, which is every deployment with a
   * single Emburse account — a switcher offering one choice is
   * noise, and the page hides it.
   */
  queues?: Queue[];
  demo: boolean;
  fetchedAt: string;
  warnings: string[];
  reports: ExpenseReport[];
  summary: Summary;
};

export type SessionUser = { id: string; email: string; name: string; exp: number; isAdmin?: boolean };

/** The products that share this deployment. */
export const APPS = ["emburse", "dutch-miller"] as const;
export type AppKey = (typeof APPS)[number];
/**
 * What each product is CALLED.
 *
 * The key stays `dutch-miller` — it is the wire value, the cookie
 * value and the route prefix, and renaming it would break a cached
 * client mid-deploy for nothing a reader can see. The LABEL moved,
 * because the product stopped being one dealership's app: Dutch
 * Miller is now one partner account inside MOJO Partners, and a
 * switcher offering "Dutch Miller" while the header says MOJO
 * Partners reads as two different places.
 */
export const APP_LABEL: Record<AppKey, string> = {
  emburse: "Emburse",
  "dutch-miller": "MOJO Partners",
};

export type AuthResponse = {
  user: SessionUser | null;
  authConfigured: boolean;
  isAdmin: boolean;
  /** The account owner, pinned in configuration. Narrower than isAdmin. */
  isOwner?: boolean;
  /** Set only while an admin is looking through somebody else's eyes. */
  viewingAs?: { real: string; viewed: string } | null;
  /**
   * Every app this person may use, and the one they are in.
   *
   * Both come from the server and neither is a client decision: the shell
   * uses them to pick which product to render, and the server refuses the
   * other one's routes regardless. Judged on the REAL person, so a view
   * changes whose data is on screen and never which product you are in.
   */
  apps?: AppKey[];
  app?: AppKey | null;
};

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

export function useReports(days: number, enabled = true, lane = "") {
  return useQuery({
    enabled,
    /*
     * The QUEUE is part of the key. Two queues asking for the same
     * window are asking two different questions, and sharing a
     * cache entry would serve whichever was fetched first to both
     * — one company's expenses under the other's name.
     */
    queryKey: ["reports", days, lane],
    queryFn: () => {
      const end = new Date();
      const start = new Date(end.getTime() - days * 86_400_000);
      const qs = new URLSearchParams({
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
      });
      if (lane) qs.set("lane", lane);
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
