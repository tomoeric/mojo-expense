import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CornerDownRight, Loader2, Plus, X } from "lucide-react";

/**
 * The rail every new partner starts on.
 *
 * The account-level Add Page puts a button on ONE account. This puts
 * it on the shared rail, which reaches every account that has not
 * already got that page — because the rail is resolved on read, not
 * copied at provisioning. Adding a page to twelve partners one
 * account at a time is how eleven of them end up with it.
 *
 * The catalogue is still code: a page is a route, a guard and a
 * component, so "create a page" here could only ever mean a blank
 * one. What this chooses is which of the real ones are on the rail,
 * and what sits under what.
 */

type Row = {
  key: string; label: string; blurb: string; parent: string | null;
  position: number; group: boolean;
};
type Options = {
  rail: Row[];
  pages: {
    key: string; label: string; blurb: string; parentable: boolean;
    naturalParent?: string;
  }[];
  parents: { key: string; label: string }[];
};

export function TemplateNav() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pageKey, setPageKey] = useState("");
  const [parentKey, setParentKey] = useState("");
  const [error, setError] = useState("");

  const q = useQuery({
    queryKey: ["dm-template-nav"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/template/nav");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load it.");
      return (await res.json()) as Options;
    },
    enabled: open,
  });

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? "That did not work.");
    return out;
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["dm-template-nav"] });
    void qc.invalidateQueries({ queryKey: ["dm-nav-options"] });
    void qc.invalidateQueries({ queryKey: ["dm-me"] });
  };

  const chosen = (q.data?.pages ?? []).find((p) => p.key === pageKey);
  const onRail = new Set((q.data?.rail ?? []).map((r) => r.key));
  /*
   * The page belongs under a heading the shared rail has not got.
   * Asked rather than refused: somebody adding "Review Existing"
   * meant to add Member Signups too, and a refusal naming a button
   * they cannot see is a dead end.
   */
  const needsParent = chosen?.naturalParent && !onRail.has(chosen.naturalParent)
    ? chosen.naturalParent : null;

  const add = useMutation({
    mutationFn: () => post("/api/dutch-miller/template/nav", {
      pageKey,
      parentKey: parentKey || null,
      withParent: needsParent !== null,
    }),
    onSuccess: () => { refresh(); setPageKey(""); setParentKey(""); setError(""); },
    onError: (e) => setError((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (key: string) => post("/api/dutch-miller/template/nav/remove", { pageKey: key }),
    onSuccess: refresh,
    onError: (e) => setError((e as Error).message),
  });

  const rail = q.data?.rail ?? [];
  const tops = rail.filter((r) => r.parent === null);

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-3 text-left"
      >
        <ChevronRight className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="flex-1 text-sm font-semibold">Shared navigation</span>
        <span className="text-xs text-muted-foreground">
          The rail every new partner starts on
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-5 py-4">
          <p className="text-xs text-muted-foreground">
            A page added here appears for every account that has not already got it, because
            the rail is read fresh rather than copied when an account is created. Taking one
            off removes the button, not the page: its route, its records and its history are
            untouched, and an account that needs it can add it back for itself.
          </p>

          {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}

          <div className="space-y-1">
            {tops.map((top) => (
              <div key={top.key}>
                <RailRow row={top} onRemove={() => remove.mutate(top.key)} />
                {rail.filter((r) => r.parent === top.key).map((kid) => (
                  <div key={kid.key} className="ml-5">
                    <RailRow row={kid} child onRemove={() => remove.mutate(kid.key)} />
                  </div>
                ))}
              </div>
            ))}
          </div>

          {(q.data?.pages ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Every page in the catalogue is on the shared rail.
            </p>
          ) : (
            <div className="space-y-2 rounded-lg border border-border bg-background p-3">
              <label className="block text-xs font-medium">
                Add a page
                <select
                  value={pageKey}
                  onChange={(e) => { setPageKey(e.target.value); setParentKey(""); }}
                  className="mt-1 w-full rounded-md border border-border bg-background
                             px-2 py-1 text-sm"
                >
                  <option value="">Choose one…</option>
                  {(q.data?.pages ?? []).map((p) => (
                    <option key={p.key} value={p.key}>{p.label}</option>
                  ))}
                </select>
              </label>
              {chosen && (
                <p className="text-[11px] text-muted-foreground">{chosen.blurb}</p>
              )}

              {needsParent && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5
                              text-[11px]">
                  <span className="font-semibold">{chosen?.label}</span> sits under{" "}
                  <span className="font-semibold">{needsParent.replace(/-/g, " ")}</span>, which
                  is not on the shared rail. Adding it will add that heading too — otherwise
                  the page would have nothing to sit under.
                </p>
              )}

              {!needsParent && (q.data?.parents ?? []).length > 0 && (
                <label className="block text-xs font-medium">
                  Under
                  <select
                    value={parentKey}
                    onChange={(e) => setParentKey(e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-background
                               px-2 py-1 text-sm"
                  >
                    <option value="">Nothing — a main button</option>
                    {(q.data?.parents ?? []).map((p) => (
                      <option key={p.key} value={p.key}>{p.label}</option>
                    ))}
                  </select>
                </label>
              )}

              <button
                type="button"
                disabled={!pageKey || add.isPending}
                onClick={() => { setError(""); add.mutate(); }}
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3
                           py-1.5 text-sm font-semibold text-background disabled:opacity-50"
              >
                {add.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Plus className="h-3.5 w-3.5" />}
                Add it to the shared rail
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RailRow({
  row, child, onRemove,
}: {
  row: Row; child?: boolean; onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-background
                    px-2 py-1.5 text-xs">
      {child && <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
      <span className="flex-1 truncate font-semibold">{row.label}</span>
      {row.group && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          heading
        </span>
      )}
      <button
        type="button"
        aria-label={`Take ${row.label} off the shared rail`}
        onClick={onRemove}
        className="rounded-md border border-border p-1"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
