import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, ChevronsUpDown, Search, Receipt, AlertTriangle,
  Columns3, ChevronLeft, ChevronRight, RotateCcw, X, Sparkles, Plus,
} from "lucide-react";
import type { ExpenseReport, ExpenseLine, ReportsResponse } from "@/lib/api";
import { money, shortDate, daysAgo } from "@/lib/format";
import { Empty } from "@/components/ui";

/**
 * Set by the table so a flag chip can filter to the set it belongs to.
 *
 * COLUMNS is a module-level array and its render functions take only a row,
 * which is what keeps the column definitions readable. A context reaches the
 * one cell that needs a handler without making every column a factory.
 */
const GroupFilter = createContext<((employee: string, date: string) => void) | null>(null);

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
  /** What to bucket those flags under — a rule's name, or the kind of check. */
  flagGroups: string[];
  ageDays: number | null;
  /** The decision on this expense, when there is one. */
  decision?: { state: string } | undefined;
  /** The control for deciding it, supplied by whoever renders the table. */
  decide?: React.ReactNode;
};

type ColumnKey =
  | "date" | "employee" | "merchant" | "category" | "department" | "location"
  | "note" | "receipt" | "changed" | "age" | "flags" | "amount" | "decide";

type Column = {
  key: ColumnKey;
  label: string;
  /** Right-aligned, tabular figures. */
  numeric?: boolean;
  /**
   * Share of the table width. `table-fixed` divides only what is left over
   * between columns with no width — with eleven columns that rounds to zero and
   * they vanish under their neighbours, so every column states its own share.
   *
   * These are relative, not absolute: hiding a column would otherwise leave its
   * share as dead space, so the visible ones are rescaled to fill the table.
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
  { key: "merchant", label: "Merchant", pct: 13, value: (r) => r.line.merchant },
  { key: "category", label: "Category", pct: 9, value: (r) => r.line.category },
  { key: "department", label: "Department", pct: 10, value: (r) => r.department },
  // Hidden by default: twelve columns already fill the width, and this one is
  // worth adding deliberately rather than shrinking everything else on its
  // behalf. It is what the Add column control has to offer on a fresh install.
  { key: "location", label: "Location / Site", pct: 9, value: (r) => r.line.location },
  { key: "note", label: "Note", pct: 10, value: (r) => r.line.note },
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
        <FlagChip row={r} />
      ) },
  { key: "amount", label: "Amount", pct: 7, numeric: true,
    value: (r) => r.line.amount,
    render: (r) => <span className="font-semibold">{money(r.line.amount)}</span> },
  // Last by default, and sortable by state so everything still waiting to
  // reach Emburse can be brought together.
  { key: "decide", label: "Decision", pct: 12,
    value: (r) => r.decision?.state ?? "",
    render: (r) => r.decide ?? <span className="text-xs text-muted-foreground">—</span> },
];

/**
 * The flag count, and a way into the group behind it.
 *
 * A day rule — "more than three meals" — flags every expense in the day,
 * because the problem is the set rather than any one receipt. Read one row at
 * a time that looks like an $11 McDonald's nobody could object to. Clicking
 * the chip narrows the table to that person on that date, which is the only
 * view in which the flag makes sense.
 *
 * It stops the click reaching the row, which would open the drawer over the
 * table it just filtered.
 */
function FlagChip({ row }: { row: Row }) {
  const onGroup = useContext(GroupFilter);
  const label = row.flags.join("\n");
  // Bound before the guard: narrowing a property does not survive into the
  // click handler's closure.
  const date = row.line.date;
  if (!onGroup || !date) {
    return (
      <span title={label} className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {row.flags.length}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`${label}\n\nClick to see everything flagged for ${row.employee} that day.`}
      onClick={(e) => {
        e.stopPropagation();
        onGroup(row.employee, date);
      }}
      className="inline-flex items-center gap-1 rounded px-1 text-xs font-semibold text-amber-600 hover:bg-amber-500/15"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {row.flags.length}
    </button>
  );
}

const DEFAULT_ORDER: ColumnKey[] = COLUMNS.map((c) => c.key);
const DEFAULT_HIDDEN: ColumnKey[] = ["location"];
const ORDER_STORAGE = "mojo-expense.columns.v1";
const HIDDEN_STORAGE = "mojo-expense.columns.hidden.v1";

const read = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Private windows, cleared site data and blocked storage all land here.
    return null;
  }
};

const write = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Not worth telling anyone: the table still works, it just forgets. */
  }
};

/**
 * Which columns are shown, and in what order — a per-viewer preference, so it
 * belongs in their browser rather than the database.
 *
 * Order and visibility are stored under separate keys so that adding this did
 * not invalidate an order somebody had already arranged.
 */
function useColumns() {
  const [order, setOrder] = useState<ColumnKey[]>(DEFAULT_ORDER);
  const [hidden, setHidden] = useState<ColumnKey[]>(DEFAULT_HIDDEN);

  useEffect(() => {
    const savedOrder = read<ColumnKey[]>(ORDER_STORAGE);
    if (savedOrder) {
      // Reconcile rather than trust: a stored order from an older build can be
      // missing a column that now exists, or name one that no longer does.
      const known = savedOrder.filter((k) => DEFAULT_ORDER.includes(k));
      setOrder([...known, ...DEFAULT_ORDER.filter((k) => !known.includes(k))]);
    }
    const savedHidden = read<ColumnKey[]>(HIDDEN_STORAGE);
    // A column added in a later build is hidden by default for existing
    // viewers too — otherwise a new column silently rearranges their table.
    if (savedHidden) {
      const known = savedHidden.filter((k) => DEFAULT_ORDER.includes(k));
      const unknownToThem = DEFAULT_HIDDEN.filter(
        (k) => !savedOrder?.includes(k) && !known.includes(k),
      );
      setHidden([...known, ...unknownToThem]);
    }
  }, []);

  const saveOrder = (next: ColumnKey[]) => {
    setOrder(next);
    write(ORDER_STORAGE, next);
  };
  const saveHidden = (next: ColumnKey[]) => {
    setHidden(next);
    write(HIDDEN_STORAGE, next);
  };

  const visible = order.filter((k) => !hidden.includes(k));

  return {
    order,
    hidden,
    visible,
    move: (key: ColumnKey, delta: number) => {
      // Step over hidden columns: moving left past something invisible looks
      // like the button did nothing.
      const i = visible.indexOf(key);
      const target = visible[i + delta];
      if (i < 0 || target === undefined) return;
      const next = [...order];
      const from = next.indexOf(key);
      const to = next.indexOf(target);
      [next[from], next[to]] = [next[to]!, next[from]!];
      saveOrder(next);
    },
    /** Refuses the last one: a table with no columns is not a state to allow. */
    hide: (key: ColumnKey) => {
      if (visible.length <= 1) return;
      if (!hidden.includes(key)) saveHidden([...hidden, key]);
    },
    show: (key: ColumnKey) => saveHidden(hidden.filter((k) => k !== key)),
    reset: () => {
      saveOrder(DEFAULT_ORDER);
      saveHidden(DEFAULT_HIDDEN);
    },
  };
}

export function buildRows(data: ReportsResponse, reports?: ExpenseReport[]): Row[] {
  const source = reports ?? data.reports;
  return source.flatMap((report) => {
    // A flag either names specific lines or applies to the whole report; both
    // have to reach the line, or a report-level duplicate warning disappears.
    const warn = report.flags.filter((f) => f.severity === "warn");
    return report.lines.map((line) => {
      const mine = warn.filter((f) => f.lineIds.length === 0 || f.lineIds.includes(line.id));
      return {
      line,
      report,
      employee: report.employeeName,
      department: report.department,
      flags: mine.map((f) => f.label),
      flagGroups: [...new Set(mine.map((f) => f.group ?? BUILT_IN_GROUP[f.code] ?? f.code))],
      ageDays: daysAgo(report.submittedDate),
      };
    });
  });
}

/** Readable names for the checks that are not rules. */
const BUILT_IN_GROUP: Record<string, string> = {
  "missing-receipt": "No receipt",
  "large-line": "Large amount",
  "weekend-spend": "Weekend",
  "possible-duplicate": "Possible duplicate",
  ageing: "Waiting too long",
};

/**
 * Flagged, unflagged, and which rule did the flagging.
 *
 * A queue of 126 with 16 flagged reads as 126 things to do. The split says
 * what actually needs a human and what is only waiting for a click — and
 * inside flagged, one rule at a time, because "the category is wrong" and
 * "that is a fourth meal today" are different jobs judged differently.
 *
 * Counts are on the tabs rather than discovered by clicking: an empty tab you
 * have to open to find empty is worse than a zero.
 */
function FlagTabs({
  rows,
  tab,
  onTab,
  flagGroup,
  onFlagGroup,
}: {
  rows: Row[];
  tab: "all" | "flagged" | "clean";
  onTab: (t: "all" | "flagged" | "clean") => void;
  flagGroup: string | null;
  onFlagGroup: (g: string | null) => void;
}) {
  const flagged = rows.filter((r) => r.flags.length > 0);
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of flagged) for (const g of r.flagGroups) counts.set(g, (counts.get(g) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [flagged]);

  const tabs = [
    { key: "all" as const, label: "All", n: rows.length },
    { key: "flagged" as const, label: "Flagged", n: flagged.length },
    { key: "clean" as const, label: "Unflagged", n: rows.length - flagged.length },
  ];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
              tab === t.key ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            <span className="ml-1.5 tabular-nums opacity-60">{t.n.toLocaleString()}</span>
          </button>
        ))}
      </div>

      {tab === "flagged" && groups.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onFlagGroup(null)}
            className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
              flagGroup === null ? "border-foreground" : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            Every flag
          </button>
          {groups.map(([name, n]) => (
            <button
              key={name}
              type="button"
              onClick={() => onFlagGroup(flagGroup === name ? null : name)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                flagGroup === name
                  ? "border-amber-500 bg-amber-500/10 font-semibold text-amber-800"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              {name}
              <span className="tabular-nums opacity-60">{n}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
  const { visible, hidden, move, hide, show, reset } = useColumns();
  const [sort, setSort] = useState<{ key: ColumnKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [query, setQuery] = useState("");
  // One person, one date: the unit a day rule is about.
  const [group, setGroup] = useState<{ employee: string; date: string } | null>(null);
  // Flagged / unflagged, and which rule's catches within flagged.
  const [tab, setTab] = useState<"all" | "flagged" | "clean">("all");
  const [flagGroup, setFlagGroup] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const byKey = useMemo(() => new Map(COLUMNS.map((c) => [c.key, c] as const)), []);
  const columns = visible.map((k) => byKey.get(k)).filter((c): c is Column => Boolean(c));
  const hiddenColumns = hidden.map((k) => byKey.get(k)).filter((c): c is Column => Boolean(c));

  // Widths are relative, so a hidden column's share is given back to the rest
  // rather than left as dead space at the end of the row.
  const widthTotal = columns.reduce((a, c) => a + c.pct, 0) || 1;

  // Sorting by a column nobody can see is a table that reorders for no visible
  // reason. Moved to the first column still on screen.
  useEffect(() => {
    if (visible.length > 0 && !visible.includes(sort.key)) {
      setSort({ key: visible[0]!, dir: 1 });
    }
  }, [visible, sort.key]);

  const filtered = useMemo(() => {
    // The group narrows first: it is an explicit "show me this set", and a
    // leftover search term silently hiding half of it would misrepresent the
    // very thing the rule is complaining about.
    let base = group
      ? rows.filter((r) => r.employee === group.employee && r.line.date === group.date)
      : rows;
    if (tab === "flagged") base = base.filter((r) => r.flags.length > 0);
    if (tab === "clean") base = base.filter((r) => r.flags.length === 0);
    // Within flagged, one rule at a time. Every rule's catches in one list is
    // the pile the tabs exist to break up: "Gas Category" and "Meal Count > 3"
    // are different jobs and get judged differently.
    if (flagGroup) base = base.filter((r) => r.flagGroups.includes(flagGroup));
    const q = query.trim().toLowerCase();
    if (!q) return base;
    // Person-first, but merchant and note are searched too: reviewers arrive
    // with "who was this" as often as with a name.
    return base.filter((r) =>
      [r.employee, r.line.merchant, r.department, r.line.category, r.line.note, r.line.location]
        .some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [rows, query, group, tab, flagGroup]);

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

  const groupTotal = group ? filtered.reduce((a, r) => a + r.line.amount, 0) : 0;

  return (
    <GroupFilter.Provider value={(employee, date) => setGroup({ employee, date })}>
    <div className="space-y-3">
      {group && (
        // Says what is being shown and how to leave. A filter you cannot see
        // is a table that is silently lying about how much work is left.
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Showing what was flagged for <strong>{group.employee}</strong> on{" "}
            <strong>{group.date}</strong> — {filtered.length}{" "}
            {filtered.length === 1 ? "expense" : "expenses"}, {money(groupTotal)}.
          </span>
          <button
            type="button"
            onClick={() => setGroup(null)}
            className="ml-auto rounded-md border border-amber-300 px-2 py-1 text-xs font-semibold hover:bg-amber-100"
          >
            Show the whole queue
          </button>
        </div>
      )}
      <FlagTabs
        rows={group ? rows.filter((r) => r.employee === group.employee && r.line.date === group.date) : rows}
        tab={tab}
        onTab={(t) => {
          setTab(t);
          // A rule filter left behind on the unflagged tab shows nothing and
          // reads as an empty queue.
          if (t !== "flagged") setFlagGroup(null);
        }}
        flagGroup={flagGroup}
        onFlagGroup={setFlagGroup}
      />

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
          <span className="mr-1 text-xs font-semibold text-muted-foreground">Columns:</span>
          {columns.map((c, i) => (
            <span key={c.key} className="inline-flex items-center gap-0.5 rounded-md border border-border bg-card py-0.5 pr-0.5 pl-1.5 text-xs">
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
              {/* Separated from the arrows, because the cost of a misclick is
                  different: one nudges, the other takes the column away. */}
              <button
                type="button"
                disabled={columns.length <= 1}
                onClick={() => hide(c.key)}
                aria-label={`Remove the ${c.label} column`}
                title={columns.length <= 1 ? "The last column cannot be removed." : `Remove ${c.label}`}
                className="ml-0.5 rounded-sm border-l border-border pl-1 text-muted-foreground hover:text-red-600 disabled:opacity-30 disabled:hover:text-muted-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}

          <AddColumn hidden={hiddenColumns} onAdd={show} />

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
                    <th
                      key={c.key}
                      style={{ width: `${(c.pct / widthTotal) * 100}%` }}
                      className={`px-2 py-2 font-semibold ${c.numeric ? "text-right" : ""}`}
                    >
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
    </GroupFilter.Provider>
  );
}

/**
 * Bringing a removed column back.
 *
 * A menu rather than a row of greyed-out chips: the columns somebody has taken
 * away are, by definition, the ones they did not want taking up room.
 */
function AddColumn({ hidden, onAdd }: { hidden: Column[]; onAdd: (key: ColumnKey) => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // A click anywhere else, or Escape, dismisses it — the usual way out of a
    // menu, and cheaper than a backdrop element.
    window.addEventListener("click", close);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={hidden.length === 0}
        onClick={() => setOpen((v) => !v)}
        title={hidden.length === 0 ? "Every column is already shown." : "Add a column"}
        className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-xs transition-colors ${
          open ? "border-sky-500 bg-sky-500/10" : "border-dashed border-border hover:bg-muted"
        } disabled:opacity-40`}
      >
        <Plus className="h-3.5 w-3.5" />
        Add column
        {hidden.length > 0 && <span className="text-muted-foreground">({hidden.length})</span>}
      </button>

      {open && hidden.length > 0 && (
        <span className="absolute top-full left-0 z-20 mt-1 block min-w-44 rounded-lg border border-border bg-card p-1 shadow-lg">
          {hidden.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                onAdd(c.key);
                setOpen(false);
              }}
              className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
            >
              {c.label}
            </button>
          ))}
        </span>
      )}
    </span>
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
