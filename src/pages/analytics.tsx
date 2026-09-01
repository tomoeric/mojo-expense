import { useMemo } from "react";
import type { ReportsResponse } from "@/lib/api";
import { money } from "@/lib/format";
import { BarList, TrendBars, type Datum } from "@/components/charts";
import { StatChip, StatChipRow } from "@/components/ui";

/** Where the money went — by category, by department, and month over month. */
export function AnalyticsPage({ data }: { data: ReportsResponse }) {
  const byCategory: Datum[] = data.summary.byCategory.map((c) => ({ name: c.name, value: c.total }));
  const byDepartment: Datum[] = data.summary.byDepartment.map((d) => ({ name: d.name, value: d.total }));

  // Monthly spend uses the line's own date, not the report's submitted date, so
  // a report filed late lands in the month the money was actually spent.
  const byMonth = useMemo<Datum[]>(() => {
    const totals = new Map<string, number>();
    for (const r of data.reports) {
      for (const l of r.lines) {
        if (!l.date) continue;
        const key = l.date.slice(0, 7);
        totals.set(key, (totals.get(key) ?? 0) + l.amount);
      }
    }
    return [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ name: monthLabel(key), value }));
  }, [data.reports]);

  const topCategory = byCategory[0];
  const avgReport = data.summary.reportCount > 0 ? data.summary.total / data.summary.reportCount : 0;

  return (
    <div className="space-y-5">
      <StatChipRow>
        <StatChip value={money(data.summary.total)} label="total spend" />
        <StatChip value={money(avgReport)} label="average report" />
        <StatChip value={data.summary.reportCount} label="reports" tone="slate" />
        <StatChip value={data.summary.flagged} label="with warnings" tone={data.summary.flagged > 0 ? "amber" : "slate"} />
        {topCategory && <StatChip value={money(topCategory.value)} label={`top: ${topCategory.name}`} tone="blue" />}
      </StatChipRow>

      <Panel title="Spend by month" subtitle="By the date the expense was incurred">
        <TrendBars data={byMonth} />
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Spend by category" subtitle="Top categories in this window">
          <BarList data={byCategory} />
        </Panel>
        <Panel title="Spend by department" subtitle="Report totals rolled up by department">
          <BarList data={byDepartment} />
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border p-4">
      <header className="mb-4">
        <h2 className="text-sm font-bold">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </header>
      {children}
    </section>
  );
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}
