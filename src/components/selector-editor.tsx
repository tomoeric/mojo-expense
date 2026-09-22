import { useState } from "react";
import { Loader2, Save, RotateCcw, Check, Wrench } from "lucide-react";

/**
 * Correct the selectors the export uses, from inside the app.
 *
 * This is the other half of a failed run. Emburse's markup cannot be known from
 * outside their tenant, so the first attempts will stop somewhere — and a
 * diagnosis with no cure is just a nicer way to be stuck. The run says which
 * step failed; this says which selectors that step used and lets them be fixed
 * without a deploy.
 *
 * `focusStep` narrows the list to one step's fields. That is the difference
 * between being handed twenty inputs and being handed the two that matter.
 */
export function SelectorEditor({
  selectors,
  help,
  stepSelectors,
  defaults,
  focusStep,
  isAdmin,
  onSave,
}: {
  selectors: Record<string, string>;
  help: Record<string, string>;
  stepSelectors: Record<string, string[]>;
  defaults: Record<string, string>;
  focusStep?: string | null;
  isAdmin: boolean;
  onSave: (next: Record<string, string>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(selectors);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showAll, setShowAll] = useState(!focusStep);

  const focused = focusStep ? (stepSelectors[focusStep] ?? []) : [];
  const keys = showAll || focused.length === 0 ? Object.keys(defaults) : focused;

  const dirty = keys.some((k) => (draft[k] ?? "") !== (selectors[k] ?? ""));

  async function save() {
    setBusy(true);
    try {
      await onSave(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold">
          <Wrench className="h-4 w-4" />
          {showAll || focused.length === 0
            ? "Selectors"
            : `Selectors used by “${focusStep}”`}
        </h3>

        {focused.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-xs text-sky-600 hover:underline"
          >
            {showAll ? `show only the ${focused.length} this step used` : "show all"}
          </button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        How the app finds each thing on the Emburse page. CSS, or Playwright&rsquo;s{" "}
        <code>text=</code> and <code>:has-text()</code>. Prefer the words on a button over a class
        name — Emburse&rsquo;s class names are generated and change; its labels rarely do.
      </p>

      <div className="space-y-2.5">
        {keys.map((k) => {
          const changed = (draft[k] ?? "") !== (defaults[k] ?? "");
          return (
            <label key={k} className="block">
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-xs font-semibold">{k}</span>
                {changed && <span className="text-[10px] text-sky-600">edited</span>}
                <button
                  type="button"
                  disabled={!isAdmin || !changed}
                  onClick={() => setDraft({ ...draft, [k]: defaults[k] ?? "" })}
                  className="ml-auto text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-0"
                >
                  reset
                </button>
              </span>
              <input
                value={draft[k] ?? ""}
                disabled={!isAdmin}
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                className="mt-0.5 w-full rounded-lg border border-border bg-transparent px-2 py-1.5 font-mono text-xs outline-none focus:border-sky-500 disabled:opacity-60"
              />
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{help[k]}</span>
            </label>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!isAdmin || !dirty || busy}
          onClick={() => void save()}
          className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save selectors
        </button>

        {saved && (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-500">
            <Check className="h-4 w-4" /> Saved — run again
          </span>
        )}

        <button
          type="button"
          disabled={!isAdmin}
          onClick={() => setDraft({ ...draft, ...Object.fromEntries(keys.map((k) => [k, defaults[k] ?? ""])) })}
          className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset these to defaults
        </button>
      </div>
    </div>
  );
}
