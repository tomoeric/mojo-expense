import { useState, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/* --------------------------------------------------------------------------
 * The MOJO section shell, ported to this standalone app: compact chips and
 * segmented controls instead of big stat cards, a green Live strip carrying
 * Refresh, and warnings behind an amber pill rather than an inline banner.
 * ------------------------------------------------------------------------ */

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-muted p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={on}
            className={`inline-flex items-center whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              on ? "bg-black text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {on && <span className="mr-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export type ChipTone = "default" | "emerald" | "amber" | "slate" | "red" | "blue";

const DOT: Record<ChipTone, string> = {
  default: "",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  slate: "bg-slate-400",
  red: "bg-red-500",
  blue: "bg-blue-500",
};
const TXT: Record<ChipTone, string> = {
  default: "text-foreground",
  emerald: "text-emerald-600",
  amber: "text-amber-600",
  slate: "text-slate-600",
  red: "text-red-600",
  blue: "text-blue-600",
};

export function StatChip({
  value,
  label,
  tone = "default",
  active,
  onClick,
  title,
}: {
  value: ReactNode;
  label: ReactNode;
  tone?: ChipTone;
  active?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-baseline gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors ${
        active ? "border-foreground ring-1 ring-foreground" : "border-border hover:border-muted-foreground/40"
      } ${onClick ? "cursor-pointer" : "cursor-default"}`}
    >
      {tone !== "default" && <span className={`h-2 w-2 self-center rounded-full ${DOT[tone]}`} />}
      <span className={`tnum text-base leading-none font-extrabold ${tone !== "default" ? TXT[tone] : ""}`}>
        {value}
      </span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">{label}</span>
    </button>
  );
}

export function StatChipRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function LiveStrip({
  label,
  onRefresh,
  isRefreshing,
}: {
  label: ReactNode;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-2.5">
      <span className="flex min-w-0 items-center gap-2.5 text-sm font-semibold text-emerald-700">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
        <span className="truncate">{label}</span>
      </span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      )}
    </div>
  );
}

/** Warnings live behind a pill next to the title, never in an inline banner. */
export function WarningsButton({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false);
  if (warnings.length === 0) return null;

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-100"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {warnings.length} warning{warnings.length === 1 ? "" : "s"}
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <span className="absolute top-full left-0 z-20 mt-2 block w-80 rounded-lg border border-border bg-card p-3 shadow-lg">
            <ul className="space-y-2">
              {warnings.map((w, i) => (
                <li key={i} className="text-xs leading-relaxed text-muted-foreground">
                  {w}
                </li>
              ))}
            </ul>
          </span>
        </>
      )}
    </span>
  );
}

export function SectionTitle({
  title,
  description,
  warnings = [],
  right,
}: {
  title: string;
  description: string;
  warnings?: string[];
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          <WarningsButton warnings={warnings} />
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {right}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone: Record<string, string> = {
    draft: "bg-slate-100 text-slate-700 border-slate-200",
    submitted: "bg-amber-50 text-amber-700 border-amber-200",
    approved: "bg-blue-50 text-blue-700 border-blue-200",
    processed: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rejected: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${
        tone[status] ?? tone.draft
      }`}
    >
      {status}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
