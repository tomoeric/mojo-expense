import { AlertTriangle } from "lucide-react";
import type { ExpenseReport } from "@/lib/api";
import { money, shortDate, daysAgo } from "@/lib/format";
import { StatusPill, Empty } from "./ui";

export function ReportsTable({
  reports,
  onOpen,
  ageingAfterDays,
  emptyMessage,
}: {
  reports: ExpenseReport[];
  onOpen: (r: ExpenseReport) => void;
  ageingAfterDays: number;
  emptyMessage: string;
}) {
  if (reports.length === 0) return <Empty>{emptyMessage}</Empty>;

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2.5 font-semibold">Report</th>
            <th className="px-3 py-2.5 font-semibold">Employee</th>
            <th className="px-3 py-2.5 font-semibold">Department</th>
            <th className="px-3 py-2.5 font-semibold">Status</th>
            <th className="px-3 py-2.5 font-semibold">Submitted</th>
            <th className="px-3 py-2.5 text-right font-semibold">Lines</th>
            <th className="px-3 py-2.5 text-right font-semibold">Total</th>
            <th className="px-3 py-2.5 font-semibold">Flags</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => {
            const age = daysAgo(r.submittedDate);
            const ageing = r.status === "submitted" && age !== null && age >= ageingAfterDays;
            const warns = r.flags.filter((f) => f.severity === "warn");
            return (
              <tr
                key={r.id}
                onClick={() => onOpen(r)}
                className="cursor-pointer border-t border-border transition-colors hover:bg-muted/60"
              >
                <td className="px-3 py-2.5">
                  <div className="font-semibold">{r.name}</div>
                  {r.reference && <div className="text-xs text-muted-foreground">{r.reference}</div>}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">{r.employeeName}</td>
                <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{r.department}</td>
                <td className="px-3 py-2.5">
                  <StatusPill status={r.status} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className={ageing ? "font-semibold text-amber-700" : "text-muted-foreground"}>
                    {shortDate(r.submittedDate)}
                    {ageing && age !== null && <span className="ml-1 text-xs">· {age}d</span>}
                  </span>
                </td>
                <td className="tnum px-3 py-2.5 text-right text-muted-foreground">{r.lineCount}</td>
                <td className="tnum px-3 py-2.5 text-right font-bold">{money(r.total)}</td>
                <td className="px-3 py-2.5">
                  {warns.length > 0 ? (
                    <span
                      title={warns.map((f) => f.label).join("\n")}
                      className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700"
                    >
                      <AlertTriangle className="h-3 w-3" />
                      {warns.length}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
