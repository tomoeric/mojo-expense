import { Loader2, Tags, MapPin, Building2, ChevronRight, type LucideIcon } from "lucide-react";
import { Empty } from "@/components/ui";
import { useTaxonomyCounts, type Kind } from "@/lib/taxonomy";

/**
 * The way in to the permanent lists.
 *
 * Every entry on these lists arrived on an export — nothing here is typed in,
 * and nothing can be. So the page says what it holds and how big each list is,
 * rather than offering an edit affordance that would have to be refused.
 *
 * It exists because a group in the rail whose button goes nowhere is a dead
 * control. Clicking Configuration should land somewhere, and the honest
 * somewhere is a contents page.
 */

/** The routes this page can send you to — the same keys the rail uses. */
export type ConfigPage = "categories" | "locations" | "departments";

type Entry = { key: ConfigPage; kind: Kind; label: string; Icon: LucideIcon; blurb: string };

const ENTRIES: Entry[] = [
  {
    key: "categories",
    kind: "category",
    label: "Categories",
    Icon: Tags,
    blurb: "What each expense was booked to. Nested ones are grouped under their parent.",
  },
  {
    key: "locations",
    kind: "location",
    label: "Locations & Sites",
    Icon: MapPin,
    blurb: "Which site the spend belongs to, read off the Details column of the export.",
  },
  {
    key: "departments",
    kind: "department",
    label: "Departments",
    Icon: Building2,
    blurb: "Which department owns it, from the same Details column.",
  },
];

export function ConfigurationPage({ onOpen }: { onOpen: (key: ConfigPage) => void }) {
  const counts = useTaxonomyCounts();

  if (counts.isError) {
    return (
      <Empty>
        <p className="font-semibold text-red-600">Could not load the lists</p>
        <p className="mt-1">{(counts.error as Error).message}</p>
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        These lists are built from what Emburse actually sends. A name goes on once it has arrived on an
        export and stays there, whether or not anything is using it today — “no open expenses this week”
        and “no longer a real value” are different things, and only Emburse knows which. They are also what
        the dropdowns in <strong>Rules</strong> offer, so a rule cannot be written against a category that
        does not exist.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ENTRIES.map(({ key, kind, label, Icon, blurb }) => {
          const n = counts.data?.counts[kind];
          return (
            <button
              key={key}
              type="button"
              onClick={() => onOpen(key)}
              className="group flex flex-col rounded-xl border border-border p-4 text-left transition-colors hover:border-muted-foreground/40 hover:bg-muted/40"
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                {label}
                <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </span>

              <span className="tnum mt-3 text-2xl leading-none font-extrabold">
                {counts.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : (
                  (n ?? 0).toLocaleString()
                )}
              </span>
              <span className="mt-1 text-xs text-muted-foreground">
                {n === 1 ? "name on the list" : "names on the list"}
              </span>

              <span className="mt-3 text-xs text-muted-foreground">{blurb}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
