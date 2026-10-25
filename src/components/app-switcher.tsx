import { useState } from "react";
import { Check, ChevronDown, LayoutGrid } from "lucide-react";
import { APP_LABEL, type AppKey } from "@/lib/api";

/**
 * Which product you are in, in the header.
 *
 * Moved out of the account menu, where it sat under a person's name and
 * read as part of their identity rather than as a place to go. It is
 * navigation, so it belongs beside the product name.
 *
 * Shown ONLY to somebody who holds more than one product. For everybody
 * else it is a menu with a single choice — furniture — and the one
 * thing it must never be is a door into a 403, so it offers nothing the
 * server has not already said this person holds.
 *
 * Hidden entirely while viewing as somebody. `apps` is the REAL
 * person's, because a view changes whose data is on screen and never
 * which products you hold, so under the viewed person's name it reads
 * as a claim about them.
 */
export function AppSwitcher({
  apps, app, onSwitch, viewingAs = false,
}: {
  apps: AppKey[];
  app: AppKey | null;
  onSwitch?: (next: AppKey) => void;
  viewingAs?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (apps.length < 2 || !onSwitch || viewingAs) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-2.5 py-1 text-xs text-white/80 transition-colors hover:bg-white/10 hover:text-white"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{app ? APP_LABEL[app] : "App"}</span>
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute left-0 z-20 mt-2 w-52 overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg"
          >
            <p className="border-b border-border px-3 py-2 text-[11px] font-semibold text-muted-foreground">
              Your apps
            </p>
            {apps.map((key) => (
              <button
                key={key}
                role="menuitem"
                type="button"
                onClick={() => { setOpen(false); if (key !== app) onSwitch(key); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted"
              >
                <span className="flex-1 text-left">{APP_LABEL[key]}</span>
                {key === app && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
