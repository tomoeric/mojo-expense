import { AlertTriangle, Check, HelpCircle, Info } from "lucide-react";
import type { AuditResult, AuditVerdict } from "@/lib/api";

const STYLE: Record<AuditVerdict, { cls: string; Icon: typeof Check; label: string }> = {
  // Only "claimed-more" is styled as a problem. A receipt larger than the claim
  // is usually a split bill, and colouring it red would train reviewers to
  // ignore the badge entirely.
  "claimed-more": { cls: "border-red-200 bg-red-50 text-red-700", Icon: AlertTriangle, label: "Over" },
  "claimed-less": { cls: "border-blue-200 bg-blue-50 text-blue-700", Icon: Info, label: "Under" },
  match: { cls: "border-emerald-200 bg-emerald-50 text-emerald-700", Icon: Check, label: "Match" },
  unreadable: { cls: "border-amber-200 bg-amber-50 text-amber-700", Icon: HelpCircle, label: "Unread" },
  unavailable: { cls: "border-border bg-muted text-muted-foreground", Icon: HelpCircle, label: "—" },
};

export function AuditBadge({ result }: { result: AuditResult }) {
  const { cls, Icon, label } = STYLE[result.verdict];
  return (
    <span
      title={result.message}
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${cls}`}
    >
      <Icon className="h-3 w-3" />
      {label}
      {result.verdict === "claimed-more" && result.difference !== null && (
        <span className="tnum">${Math.abs(result.difference).toFixed(2)}</span>
      )}
    </span>
  );
}
