import { useState } from "react";
import { money, moneyExact } from "@/lib/format";

/* --------------------------------------------------------------------------
 * Every chart here plots ONE measure (dollars). With a single series, colour
 * carries no information, so all marks share the app's single accent hue —
 * no categorical palette, no legend. Identity comes from the row label, and
 * magnitude from bar length. Grid and axes stay recessive; each mark gets a
 * hover tooltip with the exact figure.
 * ------------------------------------------------------------------------ */

const BAR = "bg-emerald-600";
const BAR_HOVER = "bg-emerald-500";
const TRACK = "bg-muted";

export type Datum = { name: string; value: number };

/**
 * Ranked horizontal bars. Rows arrive sorted; anything past `limit` is folded
 * into a single "Other" row rather than being given its own hue.
 */
export function BarList({ data, limit = 8 }: { data: Datum[]; limit?: number }) {
  const [hover, setHover] = useState<string | null>(null);

  const head = data.slice(0, limit);
  const tail = data.slice(limit);
  const rows: Datum[] =
    tail.length > 0
      ? [...head, { name: `Other (${tail.length})`, value: tail.reduce((a, d) => a + d.value, 0) }]
      : head;

  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No spend in this window.</p>;
  }

  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const pct = (r.value / max) * 100;
        const on = hover === r.name;
        return (
          <li
            key={r.name}
            onMouseEnter={() => setHover(r.name)}
            onMouseLeave={() => setHover(null)}
            title={`${r.name}: ${moneyExact(r.value)}`}
          >
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-muted-foreground">{r.name}</span>
              <span className="tnum shrink-0 font-bold">{money(r.value)}</span>
            </div>
            {/* Thin mark, rounded only at the data end, anchored to the axis. */}
            <div className={`h-2 w-full overflow-hidden rounded-l-sm ${TRACK}`}>
              <div
                className={`h-full rounded-r-sm transition-colors ${on ? BAR_HOVER : BAR}`}
                style={{ width: `${Math.max(pct, 1.5)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Monthly spend, oldest → newest. Vertical bars because the x-axis is time;
 * only the first, last and peak months carry a direct label, so the axis stays
 * readable at any width.
 */
export function TrendBars({ data }: { data: Datum[] }) {
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No spend in this window.</p>;
  }

  const max = Math.max(1, ...data.map((d) => d.value));
  const peak = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? 0) ? i : best), 0);
  const labelled = new Set([0, data.length - 1, peak]);

  return (
    <div className="relative">
      {/* Bars are width-capped: a 90-day window has only ~4 months, and
          full-width slabs read as a broken chart rather than a trend. */}
      <div className="flex h-44 items-end justify-center gap-[2px]">
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          const on = hover === i;
          return (
            <div
              key={d.name}
              className="flex h-full max-w-16 flex-1 flex-col justify-end"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              title={`${d.name}: ${moneyExact(d.value)}`}
            >
              <div
                className={`w-full rounded-t-sm transition-colors ${on ? BAR_HOVER : BAR}`}
                style={{ height: `${Math.max(pct, 1.5)}%` }}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex justify-center gap-[2px] border-t border-border pt-2">
        {data.map((d, i) => (
          <div key={d.name} className="min-w-0 max-w-16 flex-1 text-center">
            {labelled.has(i) || hover === i ? (
              <span className="block truncate text-[11px] text-muted-foreground">{d.name}</span>
            ) : (
              <span className="block text-[11px] text-transparent">·</span>
            )}
          </div>
        ))}
      </div>

      {hover !== null && data[hover] && (
        <div className="pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 rounded-md border border-border bg-card px-2.5 py-1 text-xs shadow-md">
          <span className="font-semibold">{data[hover].name}</span>
          <span className="tnum ml-2 font-bold">{moneyExact(data[hover].value)}</span>
        </div>
      )}
    </div>
  );
}
