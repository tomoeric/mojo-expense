import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus, Trash2, X } from "lucide-react";

/**
 * Add a page to this account's rail.
 *
 * It lives UNDER the rail rather than in a settings screen somewhere
 * else, because that is the thing being changed and somebody should
 * be able to see the result without navigating away from it.
 *
 * Two rules the picker makes visible and the server makes true:
 *
 *   Only pages that already exist in the shared template, and only
 *   ones this account is not already showing. There is deliberately
 *   no "create a page" here — a page is a route, a guard and a
 *   component, so creating one from an account editor could only
 *   ever produce a blank, and a blank page in a dealership's rail is
 *   worse than no page.
 *
 *   One instance per account. The picker hides what is used; the
 *   server refuses it anyway, because a picker is defeated by a
 *   second tab, a stale page and a retried request — and the result
 *   would be the same page twice in one rail, one copy under a
 *   different parent.
 */

type NavPage = {
  key: string; label: string; blurb: string; grant: string; route: string;
  parentable: boolean;
};
type Options = {
  pages: NavPage[];
  parents: { key: string; label: string }[];
  rail: {
    key: string; label: string; added: boolean; group: boolean;
    children: { key: string; label: string; added: boolean }[];
  }[];
  account: { id: string; name: string; slug: string };
  catalogue: number;
};

export function AddPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pageKey, setPageKey] = useState("");
  const [kind, setKind] = useState<"main" | "sub">("main");
  const [parentKey, setParentKey] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");

  const q = useQuery({
    queryKey: ["dm-nav-options"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/nav/options");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as Options;
    },
    enabled: open,
  });

  const done = () => {
    void qc.invalidateQueries({ queryKey: ["dm-nav-options"] });
    void qc.invalidateQueries({ queryKey: ["dm-me"] });
    setOpen(false); setPageKey(""); setParentKey(""); setLabel("");
    setKind("main"); setError("");
  };

  const add = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/nav", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pageKey,
          parentKey: kind === "sub" ? parentKey : null,
          label,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not add it.");
      return body;
    },
    onSuccess: done,
    onError: (e) => setError((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch("/api/dutch-miller/nav/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageKey: key }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not remove it.");
      return body;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dm-nav-options"] });
      void qc.invalidateQueries({ queryKey: ["dm-me"] });
      setError("");
    },
    onError: (e) => setError((e as Error).message),
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex w-full items-center gap-2 rounded-md border border-dashed
                   border-border px-3 py-2 text-left text-xs text-muted-foreground
                   hover:bg-muted/50"
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        Add a page
      </button>
    );
  }

  const chosen = q.data?.pages.find((p) => p.key === pageKey);
  const spare = q.data?.pages ?? [];
  const parents = q.data?.parents ?? [];
  const added = (q.data?.rail ?? []).flatMap((i) => [
    ...(i.added ? [{ key: i.key, label: i.label, where: "" }] : []),
    ...i.children.filter((c) => c.added)
      .map((c) => ({ key: c.key, label: c.label, where: i.label })),
  ]);

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold">
          Add a page to {q.data?.account.name ?? "this account"}
        </p>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close">
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>

      {q.isPending && <p className="text-xs text-muted-foreground">Loading…</p>}
      {q.isError && (
        <p className="text-xs font-semibold text-rose-600">{(q.error as Error).message}</p>
      )}

      {/* Every page in the catalogue is already on the rail. Said
          plainly, with no offer to invent one. */}
      {q.data && spare.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Every page in the shared template is already on this account&rsquo;s navigation.
          A new page has to be added to the template first — that is a shared change, not
          an account one.
        </p>
      )}

      {spare.length > 0 && (
        <>
          <label className="block text-xs font-medium">
            Page
            <select
              value={pageKey}
              onChange={(e) => { setPageKey(e.target.value); setLabel(""); }}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5
                         text-xs"
            >
              <option value="">Choose…</option>
              {spare.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
          {chosen && (
            <p className="text-[11px] text-muted-foreground">{chosen.blurb}</p>
          )}

          <fieldset className="text-xs">
            <legend className="font-medium">Button type</legend>
            <div className="mt-1 flex gap-3">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio" name="nav-kind" checked={kind === "main"}
                  onChange={() => setKind("main")}
                />
                Main button
              </label>
              <label
                className={`flex items-center gap-1.5 ${parents.length === 0
                  ? "opacity-50" : ""}`}
                title={parents.length === 0
                  ? "There is no main button it could go under."
                  : undefined}
              >
                <input
                  type="radio" name="nav-kind" checked={kind === "sub"}
                  disabled={parents.length === 0}
                  onChange={() => setKind("sub")}
                />
                Sub button
              </label>
            </div>
          </fieldset>

          {kind === "sub" && (
            <label className="block text-xs font-medium">
              Under
              <select
                value={parentKey}
                onChange={(e) => setParentKey(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5
                           text-xs"
              >
                <option value="">Choose a main button…</option>
                {parents.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </label>
          )}

          <label className="block text-xs font-medium">
            Name it <span className="font-normal text-muted-foreground">(optional)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={chosen?.label ?? ""}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5
                         text-xs"
            />
          </label>

          {/* What will happen, before it happens. The route is the
              thing somebody actually wants to check. */}
          {chosen && (
            <p className="rounded-md bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
              <strong>{label.trim() || chosen.label}</strong>
              {kind === "sub" && parentKey
                ? ` under ${parents.find((p) => p.key === parentKey)?.label ?? ""}`
                : " at the top of the rail"}
              , opening <span className="font-mono">/{q.data?.account.slug}#/{chosen.route}</span>
              . For {q.data?.account.name} only.
            </p>
          )}

          {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={!pageKey || (kind === "sub" && !parentKey) || add.isPending}
              onClick={() => { setError(""); add.mutate(); }}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1
                         text-xs font-semibold text-background disabled:opacity-50"
            >
              {add.isPending ? <Loader2 className="h-3 w-3 animate-spin" />
                : <Check className="h-3 w-3" />}
              Save
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-border px-2.5 py-1 text-xs"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {/* Only what this account added. The shared base is not an
          account's to empty — a dealership without Member Signups is
          not a layout choice, it is an outage with no way back. */}
      {added.length > 0 && (
        <div className="space-y-1 border-t border-border pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Added by this account
          </p>
          {added.map((a) => (
            <div key={a.key} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate">
                {a.label}
                {a.where && <span className="text-muted-foreground"> · under {a.where}</span>}
              </span>
              <button
                type="button"
                aria-label={`Remove ${a.label}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(a.key)}
                className="rounded-md border border-border p-1 disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
