import { useMemo, useState } from "react";
import type { ExpenseReport, ReportsResponse, ConfigResponse } from "@/lib/api";
import { money, daysAgo } from "@/lib/format";
import { SegmentedControl, StatChip, StatChipRow } from "@/components/ui";
import { ReportsTable } from "@/components/reports-table";

type Focus = "all" | "flagged" | "ageing";

/**
 * The reviewer's landing page: only reports still waiting on a decision,
 * oldest first, with the ones that need attention promotable to the top.
 */
export function QueuePage({
  data,
  config,
  onOpen,
}: {
  data: ReportsResponse;
  config: ConfigResponse | undefined;
  onOpen: (r: ExpenseReport) => void;
}) {
  const [focus, setFocus] = useState<Focus>("all");
  const ageingAfterDays = config?.policy.ageingAfterDays ?? 5;

  const awaiting = useMemo(
    () =>
      data.reports
        .filter((r) => r.status === "submitted")
        // Oldest first — the queue is worked from the bottom of the funnel up.
        .sort((a, b) => (a.submittedDate ?? "").localeCompare(b.submittedDate ?? "")),
    [data.reports],
  );

  const flagged = useMemo(() => awaiting.filter((r) => r.flags.some((f) => f.severity === "warn")), [awaiting]);
  const ageing = useMemo(
    () => awaiting.filter((r) => (daysAgo(r.submittedDate) ?? 0) >= ageingAfterDays),
    [awaiting, ageingAfterDays],
  );

  const shown = focus === "flagged" ? flagged : focus === "ageing" ? ageing : awaiting;
  const awaitingTotal = awaiting.reduce((a, r) => a + r.total, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<Focus>
          value={focus}
          onChange={setFocus}
          options={[
            { value: "all", label: "All waiting" },
            { value: "flagged", label: `Flagged (${flagged.length})` },
            { value: "ageing", label: `Ageing (${ageing.length})` },
          ]}
        />
        <StatChipRow>
          <StatChip value={awaiting.length} label="awaiting review" tone="amber" />
          <StatChip value={money(awaitingTotal)} label="in the queue" />
          <StatChip
            value={ageing.length}
            label={`over ${ageingAfterDays}d`}
            tone={ageing.length > 0 ? "red" : "slate"}
          />
        </StatChipRow>
      </div>

      <ReportsTable
        reports={shown}
        onOpen={onOpen}
        ageingAfterDays={ageingAfterDays}
        emptyMessage={
          focus === "all"
            ? "Nothing is waiting on a review in this window."
            : "No reports match this filter."
        }
      />
    </div>
  );
}
