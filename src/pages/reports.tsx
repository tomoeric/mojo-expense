import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ConfigResponse, ExpenseReport, ReportStatus, ReportsResponse } from "@/lib/api";
import { STATUS_LABEL } from "@/lib/api";
import { money } from "@/lib/format";
import { StatChip, StatChipRow } from "@/components/ui";
import { ReportsTable } from "@/components/reports-table";

const STATUSES: ReportStatus[] = ["submitted", "approved", "processed", "rejected", "draft"];

const TONE: Record<ReportStatus, "amber" | "blue" | "emerald" | "red" | "slate"> = {
  submitted: "amber",
  approved: "blue",
  processed: "emerald",
  rejected: "red",
  draft: "slate",
};

/** Every report in the window, filterable by status, department and free text. */
export function ReportsPage({
  data,
  config,
  onOpen,
}: {
  data: ReportsResponse;
  config: ConfigResponse | undefined;
  onOpen: (r: ExpenseReport) => void;
}) {
  const [status, setStatus] = useState<ReportStatus | null>(null);
  const [department, setDepartment] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.reports
      .filter((r) => (status ? r.status === status : true))
      .filter((r) => (department ? r.department === department : true))
      .filter((r) =>
        needle
          ? `${r.name} ${r.employeeName} ${r.id} ${r.department}`.toLowerCase().includes(needle)
          : true,
      )
      .sort((a, b) => (b.submittedDate ?? "").localeCompare(a.submittedDate ?? ""));
  }, [data.reports, status, department, q]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatChipRow>
          <StatChip
            value={data.summary.reportCount}
            label="all reports"
            active={status === null}
            onClick={() => setStatus(null)}
          />
          {STATUSES.map((s) => (
            <StatChip
              key={s}
              value={data.summary.byStatus[s] ?? 0}
              label={STATUS_LABEL[s]}
              tone={TONE[s]}
              active={status === s}
              onClick={() => setStatus(status === s ? null : s)}
            />
          ))}
        </StatChipRow>

        <label className="relative">
          <Search className="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search report, employee, ID…"
            className="w-64 rounded-md border border-border py-1.5 pr-3 pl-8 text-sm outline-none focus:border-emerald-400"
          />
        </label>
      </div>

      {/* Aligned "by department" grid — name left, count · total right. */}
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {data.summary.byDepartment.map((d) => {
          const active = department === d.name;
          return (
            <button
              key={d.name}
              type="button"
              onClick={() => setDepartment(active ? null : d.name)}
              title={`${d.name} — ${d.count} reports, ${money(d.total)}`}
              className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                active ? "border-foreground ring-1 ring-foreground" : "border-border hover:border-muted-foreground/40"
              }`}
            >
              <span className="min-w-0 truncate text-sm font-semibold">{d.name}</span>
              <span className="tnum flex shrink-0 items-center gap-2.5 text-xs font-bold">
                <span className="text-muted-foreground">{d.count}</span>
                <span>{money(d.total)}</span>
              </span>
            </button>
          );
        })}
      </div>

      <ReportsTable
        reports={shown}
        onOpen={onOpen}
        ageingAfterDays={config?.policy.ageingAfterDays ?? 5}
        emptyMessage="No reports match the current filters."
      />
    </div>
  );
}
