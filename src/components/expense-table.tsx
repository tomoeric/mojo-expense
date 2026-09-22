import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, ChevronsUpDown, Search, Receipt, AlertTriangle,
  Columns3, ChevronLeft, ChevronRight, RotateCcw, X, Sparkles,
} from "lucide-react";
import type { ExpenseReport, ExpenseLine, ReportsResponse } from "@/lib/api";
import { money, shortDate, daysAgo } from "@/lib/format";
import { Empty } from "@/components/ui";

/**
 * One row per expense, which is one row per receipt.
 *
 * The grouped view (one card per employee per day) was a reasonable guess at
 * the unit of review, but it hides exactly what a reviewer is checking: a
 * receipt against a claim. Flattening makes every claim its own line, sortable
 * against every other, which is what makes an outlier visible.
 */

export type Row = {
  line: ExpenseLine;
  report: ExpenseReport;
  employee: string;
  department: string;
  /** Warn-level flags naming this specific line. */
  flags: string[];
  ageDays: number | null;
};

type ColumnKey =
  | "date" | "employee" | "merchant" | "category" | "department"
  | "note" | "receipt" | "changed" | "age" | "flags" | "amount";

type Column = {
  key: ColumnKey;
  label: string;
  /** Right-aligned, tabular figures. */
  numeric?: boolean;
  /**
   * Share of the table width. `table-fixed` divides only what is left over
   * between columns with no width — with eleven columns that rounds to zero and
   * they vanish under their neighbours, so every column states its own share
   * and they add up to 100.
   */
  pct: number;
  value: (r: Row) => string | number;
  render?: (r: Row) => React.ReactNode;
};

const COLUMNS: Column[] = [
  { key: "date", label: "Date", pct: 6,
    value: (r) => r.line.date ?? "",
    render: (r) => <span className="whitespace-nowrap">{r.line.date ? shortDate(r.line.date) : "—"}</span> },
  { key: "employee", label: "Employee", pct: 11, value: (r) => r.employee },
  { key: "merchant", label: "Merchant", pct: 16, value: (r) => r.line.merchant },
  { key: "category", label: "Category", pct: 11, value: (r) => r.line.category },
  { key: "department", label: "Department", pct: 10, value: (r) => r.department },
  { key: "note", label: "Note", pct: 14, value: (r) => r.line.note },
  { key: "receipt", label: "Receipt", pct: 6,
    value: (r) => (r.line.hasReceipt ? 1 : 0),
    render: (r) =>
      r.line.hasReceipt ? (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
          <Receipt className="h-3.5 w-3.5" /> yes
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">none</span>
      ) },
  { key: "changed", label: "Updated", pct: 9,
    value: (r) => r.line.changes.length,
    render: (r) =>
      r.line.changes.length === 0 ? (
        <span className="text-xs text-muted-foreground">—</span>
      ) : (
        <span
          data-changed="1"
          title={r.line.changes.map((c) => c.field).join(", ")}
          className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-sky-600"
        >
          <Sparkles className="h-3 w-3" />
          {r.line.changes.length === 1 ? r.line.changes[0]!.field : `${r.line.changes.length} fields`}
        </span>
      ) },
  { key: "age", label: "Age", pct: 4, numeric: true,
    value: (r) => r.ageDays ?? -1,
    render: (r) => (r.ageDays === null ? "—" : `${r.ageDays}d`) },
  { key: "flags", label: "Flags", pct: 6,
    value: (r) => r.flags.length,
    render: (r) =>
      r.flags.length === 0 ? (
        <span className="text-xs text-muted-foreground">—</span>
      ) : (
        // A count, not the label: flag text runs to "Waiting 9 days for
        // review", which truncates to "Wait" in a column this narrow and reads
        // as a status rather than a warning. Hover has the words.
        <span title={r.flags.join("\n")} className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {r.flags.length}
        </span>
      ) },
  { key: "amount", label: "Amount", pct: 7, numeric: true,
    value: (r) => r.line.amount,
    render: (r) => <span className="font-semibold">{money(r.line.amount)}</span> },
];

const DEFAULT_ORDER: ColumnKey[] = COLUMNS.map((c) => c.key);
const ORDER_STORAGE = "mojo-expense.columns.v1";

/** Column order is a per-viewer preference, so it belongs in their browser. */
function useColumnOrder() {
  const [order, setOrder] = useState<ColumnKey[]>(DEFAULT_ORDER);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(ORDER_STORAGE);
      if (!raw) return;
      const saved = JSON.parse(raw) as ColumnKey[];
      // Reconcile rather than trust: a stored order from an older build can be
      // missing a column that now exists, or name one that no longer does.
      const known = saved.filter((k) => DEFAULT_ORDER.includes(k));
      setOrder([...known, ...DEFAULT_ORDER.filter((k) => !known.includes(k))]);
    } catch {
      /* Private windows and cleared site data both land here; the default is fine. */
    }
  }, []);

  const save = (next: ColumnKey[]) => {
    setOrder(next);
    try {
      localStorage.setItem(ORDER_STORAGE, JSON.stringify(next));
    } catch {
      /* Not worth telling anyone: the table still works, it just forgets. */
    }
  };

  return {
    order,
    move: (key: ColumnKey, delta: number) => {
      const i = order.indexOf(key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= order.length) return;
      const next = [...order];
      [next[i], next[j]] = [next[j]!, next[i]!];
      save(next);
    },
    reset: () => save(DEFAULT_ORDER),
  };
}

export function buildRows(data: ReportsResponse, reports?: ExpenseReport[]): Row[] {
  const source = reports ?? data.reports;
  return source.flatMap((report) => {
    // A flag either names specific lines or applies to the whole report; both
    // have to reach the line, or a report-level duplicate warning disappears.
    const warn = report.flags.filter((f) => f.severity === "warn");
    return report.lines.map((line) => ({
      line,
      report,
      employee: report.employeeName,
      department: report.department,
      flags: warn
        .filter((f) => f.lineIds.length === 0 || f.lineIds.includes(line.id))
        .map((f) => f.label),
      ageDays: daysAgo(report.submittedDate),
    }));
  });
}

export function ExpenseTable({
  rows,
  onOpen,
  emptyMessage = "Nothing here.",
}: {
  rows: Row[];
  onOpen: (r: Row) => void;
  emptyMessage?: string;
}) {
  const [diff, setDiff] = useState<Row | null>(null);
  const { order, move, reset } = useColumnOrder();
  const [sort, setSort] = useState<{ key: ColumnKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);

  const byKey = useMemo(() => new Map(COLUMNS.map((c) => [c.key, c])), []);
  const columns = order.map((k) => byKey.get(k)!).filter(Boolean);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    // Person-first, but merchant and note are searched too: reviewers arrive
    // with "who was this" as often as with a name.
    return rows.filter((r) =>
      [r.employee, r.line.merchant, r.department, r.line.category, r.line.note]
        .some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [rows, query]);

  const sorted = useMemo(() => {
    const col = byKey.get(sort.key);
    if (!col) return filtered;
    return [...filtered].sort((a, b) => {
      const av = col.value(a);
      const bv = col.value(b);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return cmp * sort.dir;
    });
  }, [filtered, sort, byKey]);

  const total = useMemo(() => sorted.reduce((a, r) => a + r.line.amount, 0), [sorted]);

  const toggle = (key: ColumnKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "amount" || key === "date" || key === "age" ? -1 : 1 }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a person, merchant, category…"
            className="w-full rounded-lg border border-border bg-transparent py-1.5 pr-8 pl-8 text-sm outline-none focus:border-sky-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <span className="tnum text-sm text-muted-foreground">
          {sorted.length.toLocaleString()} {sorted.length === 1 ? "expense" : "expenses"} · {money(total)}
        </span>

        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
            editing ? "border-sky-500 bg-sky-500/10 font-semibold" : "border-border hover:bg-muted"
          }`}
        >
          <Columns3 className="h-4 w-4" />
          Columns
        </button>
      </div>

      {editing && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/40 p-2">
          <span className="mr-1 text-xs font-semibold text-muted-foreground">Order:</span>
          {columns.map((c, i) => (
            <span key={c.key} className="inline-flex items-center gap-0.5 rounded-md border border-border bg-card px-1.5 py-0.5 text-xs">
              <button
                type="button"
                disabled={i === 0}
                onClick={() => move(c.key, -1)}
                aria-label={`Move ${c.label} left`}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              {c.label}
              <button
                type="button"
                disabled={i === columns.length - 1}
                onClick={() => move(c.key, 1)}
                aria-label={`Move ${c.label} right`}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={reset}
            className="ml-1 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </button>
        </div>
      )}

      {sorted.length === 0 ? (
        <Empty>{rows.length === 0 ? emptyMessage : `Nothing matches “${query}”.`}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full table-fixed text-xs">
            <thead className="bg-muted text-left text-[11px] text-muted-foreground">
              <tr>
                {columns.map((c) => {
                  const on = sort.key === c.key;
                  const Icon = !on ? ChevronsUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
                  return (
                    <th key={c.key} style={{ width: `${c.pct}%` }} className={`px-2 py-2 font-semibold ${c.numeric ? "text-right" : ""}`}>
                      <button
                        type="button"
                        onClick={() => toggle(c.key)}
                        className={`inline-flex items-center gap-1 hover:text-foreground ${
                          on ? "text-foreground" : ""
                        } ${c.numeric ? "flex-row-reverse" : ""}`}
                      >
                        {c.label}
                        <Icon className={`h-3 w-3 ${on ? "" : "opacity-40"}`} />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.line.id}
                  onClick={(e) => {
                    // The Updated tag answers a different question from the row
                    // itself — "what moved" rather than "show me this expense" —
                    // so it opens the diff instead of the drawer behind it.
                    if ((e.target as HTMLElement).closest('[data-changed]')) setDiff(r);
                    else onOpen(r);
                  }}
                  className="cursor-pointer border-t border-border hover:bg-muted/60"
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`truncate px-2 py-2 ${c.numeric ? "tnum text-right" : ""}`}
                      // Everything truncates so eleven columns fit one line;
                      // hover gives back whatever the ellipsis ate.
                      title={c.render ? undefined : String(c.value(r))}
                    >
                      {c.render ? c.render(r) : (c.value(r) || "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {diff && <ChangeDialog row={diff} onClose={() => setDiff(null)} />}
    </div>
  );
}

/** What the last import changed on one expense, before against after. */
function ChangeDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-xl overflow-auto rounded-xl border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="flex items-center gap-2 text-sm font-bold">
          <Sparkles className="h-4 w-4 text-sky-500" />
          Changed in the last import
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {row.line.merchant} · {row.employee} · {row.line.date ? shortDate(row.line.date) : "no date"} ·{" "}
          {money(row.line.amount)}
        </p>

        <div className="mt-4 space-y-3">
          {row.line.changes.map((c, i) => (
            <div key={i} className="rounded-lg border border-border">
              <p className="border-b border-border bg-muted px-3 py-1.5 text-xs font-semibold">{c.field}</p>
              <div className="grid gap-px sm:grid-cols-2">
                <div className="p-3">
                  <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Before</p>
                  <p className="mt-1 text-sm break-words text-red-600 line-through decoration-red-600/40">
                    {c.before ?? <span className="text-muted-foreground no-underline">(empty)</span>}
                  </p>
                </div>
                <div className="border-t border-border p-3 sm:border-t-0 sm:border-l">
                  <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">After</p>
                  <p className="mt-1 text-sm break-words text-emerald-600">
                    {c.after ?? <span className="text-muted-foreground">(empty)</span>}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-muted"
        >
          Close
        </button>
      </div>
    </div>
  );
}
