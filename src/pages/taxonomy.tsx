import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, AlertTriangle, RefreshCw } from "lucide-react";
import { money, shortDate } from "@/lib/format";
import { StatChip, StatChipRow, SegmentedControl, Empty } from "@/components/ui";
import { isNew, useTaxonomy, type Kind, type TaxonomyEntry } from "@/lib/taxonomy";

/**
 * One of the three permanent lists — Categories, Locations/Sites, Departments.
 *
 * The same page three times over rather than three pages: the lists differ
 * only in which column they are drawn from, and a copy each would be three
 * places to fix the next time a column is added to the table.
 *
 * The list is permanent. A name stays on it once seen, even when nothing is
 * using it today, because "no open expenses" and "not a real value any more"
 * are different things and only Emburse knows which. So the page shows both:
 * every name, and how much is actually behind each one.
 */

type Filter = "all" | "waiting" | "unused";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "waiting", label: "In the queue" },
  { value: "unused", label: "Not in use" },
];

const compare = new Intl.Collator("en", { sensitivity: "base" }).compare;

export function TaxonomyPage({ kind }: { kind: Kind }) {
  const qc = useQueryClient();
  const list = useTaxonomy(kind);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const entries = list.data?.entries ?? [];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((e) => (q ? e.name.toLowerCase().includes(q) : true))
      .filter((e) =>
        filter === "waiting" ? e.waiting > 0 : filter === "unused" ? e.uses === 0 : true,
      )
      .sort((a, b) => compare(a.name, b.name));
  }, [entries, query, filter]);

  // Categories arrive as "Parent › Leaf"; grouping by the parent is the only
  // way the list reads like the menu it came from rather than 60 flat strings.
  const groups = useMemo(() => {
    const byParent = new Map<string, TaxonomyEntry[]>();
    for (const e of shown) {
      const key = e.parent ?? "";
      const bucket = byParent.get(key);
      if (bucket) bucket.push(e);
      else byParent.set(key, [e]);
    }
    return [...byParent.entries()].sort((a, b) => compare(a[0], b[0]));
  }, [shown]);

  const nested = groups.some(([parent]) => parent !== "");

  if (list.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the list…
      </div>
    );
  }

  if (list.isError) {
    return (
      <Empty>
        <p className="font-semibold text-red-600">Could not load the list</p>
        <p className="mt-1">{(list.error as Error).message}</p>
      </Empty>
    );
  }

  const data = list.data!;
  const waiting = entries.filter((e) => e.waiting > 0).length;
  const unused = entries.filter((e) => e.uses === 0).length;
  const fresh = entries.filter(isNew).length;

  return (
    <div className="space-y-4">
      <StatChipRow>
        <StatChip value={entries.length} label={`${data.label.many.toLowerCase()} on the list`} />
        <StatChip value={waiting} label="with expenses in the queue" tone="amber" />
        <StatChip value={unused} label="with no expenses" tone="slate" />
        {fresh > 0 && <StatChip value={fresh} label="new this fortnight" tone="blue" />}
        <button
          type="button"
          onClick={() => void qc.invalidateQueries({ queryKey: ["taxonomy"] })}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${list.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </StatChipRow>

      {/* The one thing this page can say that nothing else can: whether the
          field is actually arriving on the export at all. */}
      {data.blank > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {data.blank.toLocaleString()} of {data.expenses.toLocaleString()} expenses have no{" "}
            {data.label.one.toLowerCase()}
            {entries.length === 0
              ? ` — and no ${data.label.one.toLowerCase()} has ever arrived, which means the export is not carrying the field.`
              : ". Either it was left blank in Emburse, or the export truncated it."}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl value={filter} onChange={setFilter} options={FILTERS} />
        <label className="relative ml-auto">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Find a ${data.label.one.toLowerCase()}…`}
            className="w-56 rounded-lg border border-border bg-background py-1.5 pr-3 pl-8 text-sm outline-none focus:border-muted-foreground/50"
          />
        </label>
      </div>

      {shown.length === 0 ? (
        <Empty>
          <p className="font-semibold">Nothing to show</p>
          <p className="mt-1">
            {entries.length === 0
              ? `No ${data.label.one.toLowerCase()} has arrived on an export yet. The list fills itself as expenses come in.`
              : "No name matches that filter."}
          </p>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">{data.label.one}</th>
                <th className="px-3 py-2 text-right font-semibold">Expenses</th>
                <th className="px-3 py-2 text-right font-semibold">In queue</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="px-3 py-2 text-right font-semibold">Last used</th>
                <th className="px-3 py-2 text-right font-semibold">First seen</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([parent, rows]) => (
                <Group key={parent || "—"} parent={parent} rows={rows} nested={nested} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Group({ parent, rows, nested }: { parent: string; rows: TaxonomyEntry[]; nested: boolean }) {
  return (
    <>
      {nested && parent !== "" && (
        <tr className="border-t border-border bg-muted/30">
          <td colSpan={6} className="px-3 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {parent}
          </td>
        </tr>
      )}
      {rows.map((e) => (
        <tr key={e.name} className="border-t border-border">
          <td className={`px-3 py-2 ${nested && parent !== "" ? "pl-6" : ""}`}>
            <span className={e.uses === 0 ? "text-muted-foreground" : ""}>{e.leaf}</span>
            {isNew(e) && (
              <span className="ml-2 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                NEW
              </span>
            )}
          </td>
          <td className="tnum px-3 py-2 text-right">{e.uses.toLocaleString()}</td>
          <td className="tnum px-3 py-2 text-right">
            {e.waiting > 0 ? <span className="font-semibold text-amber-600">{e.waiting}</span> : <span className="text-muted-foreground">—</span>}
          </td>
          <td className="tnum px-3 py-2 text-right">
            {e.uses === 0 ? <span className="text-muted-foreground">—</span> : money(e.totalCents / 100)}
          </td>
          <td className="tnum px-3 py-2 text-right text-muted-foreground">
            {e.lastUsed ? shortDate(e.lastUsed) : "—"}
          </td>
          <td className="tnum px-3 py-2 text-right text-muted-foreground">{shortDate(e.firstSeen)}</td>
        </tr>
      ))}
    </>
  );
}
