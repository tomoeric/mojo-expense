import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown, ArrowUp, Check, GripVertical, Loader2, Lock, Plus, RotateCcw, Trash2, X,
} from "lucide-react";

/**
 * Buckets: the shared template, arranged per account.
 *
 * A page declares its registered items once, server-side. A BUCKET is
 * a named group of some of those items, shared by every partner. A
 * LAYOUT is which buckets this account's page shows, in what order,
 * at what width. This file renders the layout and lets somebody
 * change it; what the items MEAN is the page's own business, passed
 * in as `render`.
 *
 * Two rules the editor has to make visible rather than merely obey:
 *
 *   An ESSENTIAL item cannot be hidden or unticked. Hiding is
 *   presentation; it deletes nothing and relaxes no validation, so an
 *   item a workflow depends on must stay on screen or the page would
 *   quietly stop working. The control is disabled AND the reason is
 *   written next to it, because a disabled control with no
 *   explanation reads as a bug.
 *
 *   The shared bucket is not this account's to change here. Choosing
 *   WHICH of its items to show is; editing what the bucket contains
 *   for every partner is the Shared Template page, and the editor
 *   says so.
 *
 * Both arrangement controls are offered: buttons that move a bucket
 * one place, and dragging. The buttons are not a fallback — they are
 * the ones that work with a keyboard, and on a phone.
 */

export type BlockPage =
  | "member-signups-review" | "member-signups-add"
  | "rfid-instructions" | "rfid-review";

export type RegisteredItem = {
  key: string;
  label: string;
  kind: "data" | "input" | "content" | "control";
  essential?: boolean;
  note?: string;
};

export type Placed = {
  id: string;
  page: BlockPage;
  name: string;
  items: string[];
  columns: number;
  builtin: boolean;
  archivedAt: string | null;
  position: number;
  width: 2 | 3 | 4 | 6;
  height: "auto" | "short" | "tall";
  hidden: boolean;
  overridden: boolean;
};

export type LayoutAnswer = {
  page: BlockPage;
  label: string;
  account: { id: string; name: string };
  layout: Placed[];
  available: Omit<Placed, "position" | "width" | "height" | "hidden" | "overridden">[];
  items: RegisteredItem[];
  essential: string[];
  widths: (2 | 3 | 4 | 6)[];
  heights: ("auto" | "short" | "tall")[];
  canArrange: boolean;
};

export function useLayout(page: BlockPage) {
  return useQuery({
    queryKey: ["dm-layout", page],
    queryFn: async () => {
      const res = await fetch(`/api/dutch-miller/blocks/${page}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not read the layout.");
      return (await res.json()) as LayoutAnswer;
    },
  });
}

const SPAN: Record<number, string> = {
  2: "md:col-span-2", 3: "md:col-span-3", 4: "md:col-span-4", 6: "md:col-span-6",
};
const TALL: Record<string, string> = {
  auto: "", short: "max-h-56 overflow-auto", tall: "min-h-80",
};
const INNER: Record<number, string> = {
  1: "grid-cols-1", 2: "grid-cols-1 sm:grid-cols-2", 3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
};

/**
 * The page, as this account has arranged it.
 *
 * A bucket whose items all render null is dropped rather than left as
 * an empty titled box — a group with a heading and nothing under it
 * reads as something that failed to load.
 */
export function BucketGrid({
  layout, render, empty,
}: {
  layout: Placed[];
  render: (itemKey: string) => React.ReactNode;
  empty?: React.ReactNode;
}) {
  const shown = layout.filter((b) => !b.hidden);
  if (shown.length === 0) {
    return <>{empty ?? null}</>;
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
      {shown.map((b) => {
        const parts = b.items.map((key) => ({ key, node: render(key) }))
          .filter((p) => p.node !== null && p.node !== undefined && p.node !== false);
        if (parts.length === 0) return null;
        return (
          <section
            key={b.id}
            className={`rounded-xl border border-border bg-card p-4 ${SPAN[b.width] ?? "md:col-span-6"}`}
          >
            <h3 className="mb-3 text-sm font-semibold">{b.name}</h3>
            <div className={`grid gap-3 ${INNER[b.columns] ?? INNER[3]} ${TALL[b.height] ?? ""}`}>
              {parts.map((p) => <div key={p.key}>{p.node}</div>)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

type Draft = Placed[];

/**
 * Arrange this account's page.
 *
 * Works on a DRAFT and writes nothing until Save, so Cancel really
 * does leave the page as it was. Restore is a separate act with its
 * own button: it deletes this account's overrides rather than writing
 * today's shared layout into them, which is what keeps the page
 * following the template afterwards instead of frozen at a copy of it.
 */
export function LayoutEditor({
  answer, onClose,
}: {
  answer: LayoutAnswer;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => answer.layout.map((b) => ({ ...b })));
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => { setDraft(answer.layout.map((b) => ({ ...b }))); }, [answer.layout]);

  const byKey = useMemo(
    () => new Map(answer.items.map((i) => [i.key, i])), [answer.items]);
  const essentialIn = (b: Placed) => b.items.filter((k) => byKey.get(k)?.essential);

  const placed = new Set(draft.map((b) => b.id));
  const spare = answer.available.filter((b) => !placed.has(b.id));

  const move = (id: string, by: number) => {
    setDraft((rows) => {
      const i = rows.findIndex((r) => r.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= rows.length) return rows;
      const next = [...rows];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };

  const dropOn = (id: string) => {
    if (!dragging || dragging === id) return;
    setDraft((rows) => {
      const from = rows.findIndex((r) => r.id === dragging);
      const to = rows.findIndex((r) => r.id === id);
      if (from < 0 || to < 0) return rows;
      const next = [...rows];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
    setDragging(null);
  };

  const patch = (id: string, change: Partial<Placed>) =>
    setDraft((rows) => rows.map((r) => (r.id === id ? { ...r, ...change } : r)));

  const toggleItem = (b: Placed, key: string) => {
    if (byKey.get(key)?.essential) return;
    const has = b.items.includes(key);
    // Kept in the SHARED bucket's order rather than the order they
    // were ticked, so two accounts showing the same fields show them
    // the same way round.
    const full = answer.available.find((a) => a.id === b.id)?.items ?? b.items;
    const next = has
      ? b.items.filter((k) => k !== key)
      : full.filter((k) => b.items.includes(k) || k === key);
    patch(b.id, { items: next });
  };

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/dutch-miller/blocks/${answer.page}/layout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          layout: draft.map((b, i) => ({
            blockId: b.id, position: (i + 1) * 10, width: b.width,
            height: b.height, hidden: b.hidden, items: b.items,
          })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save the layout.");
      return body;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dm-layout", answer.page] });
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  const restore = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/dutch-miller/blocks/${answer.page}/reset`,
        { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not restore it.");
      return body;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dm-layout", answer.page] });
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Arranging {answer.label}</p>
          <p className="text-xs text-muted-foreground">
            For {answer.account.name} only. Other partners keep their own arrangement, and
            a bucket&rsquo;s contents are shared — change those under Shared Template.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => { setError(""); save.mutate(); }}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5
                       text-sm font-semibold text-background disabled:opacity-50"
          >
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Check className="h-3.5 w-3.5" />}
            Save
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={restore.isPending}
            title="Put this page back to the shared layout and keep following it"
            onClick={() => { setError(""); restore.mutate(); }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border
                       px-3 py-1.5 text-sm disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restore shared layout
          </button>
        </div>
      </div>

      {error && <p className="text-sm font-semibold text-red-600">{error}</p>}

      <div className="space-y-2">
        {draft.map((b, i) => {
          const locked = essentialIn(b);
          const full = answer.available.find((a) => a.id === b.id)?.items ?? b.items;
          return (
            <div
              key={b.id}
              draggable
              onDragStart={() => setDragging(b.id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dropOn(b.id)}
              className={`rounded-lg border bg-background p-3 ${dragging === b.id
                ? "border-foreground/40 opacity-60" : "border-border"}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <GripVertical
                  className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground"
                  aria-hidden
                />
                <span className="flex-1 truncate text-sm font-semibold">{b.name}</span>

                {/* Keyboard and touch get the same job done as dragging. */}
                <button
                  type="button" aria-label={`Move ${b.name} up`}
                  disabled={i === 0} onClick={() => move(b.id, -1)}
                  className="rounded-md border border-border p-1 disabled:opacity-30"
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  type="button" aria-label={`Move ${b.name} down`}
                  disabled={i === draft.length - 1} onClick={() => move(b.id, 1)}
                  className="rounded-md border border-border p-1 disabled:opacity-30"
                >
                  <ArrowDown className="h-3 w-3" />
                </button>

                <label className="text-xs">
                  <span className="sr-only">{b.name} width</span>
                  <select
                    value={b.width}
                    onChange={(e) => patch(b.id, { width: Number(e.target.value) as 2 })}
                    className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
                  >
                    {answer.widths.map((w) => (
                      <option key={w} value={w}>{w} of 6 wide</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs">
                  <span className="sr-only">{b.name} height</span>
                  <select
                    value={b.height}
                    onChange={(e) => patch(b.id, { height: e.target.value as "auto" })}
                    className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
                  >
                    {answer.heights.map((h) => (
                      <option key={h} value={h}>
                        {h === "auto" ? "Fits content" : h === "short" ? "Short" : "Tall"}
                      </option>
                    ))}
                  </select>
                </label>

                <label
                  className={`flex items-center gap-1 text-xs ${locked.length > 0
                    ? "opacity-50" : ""}`}
                  title={locked.length > 0
                    ? `Cannot be hidden — it holds ${locked
                      .map((k) => byKey.get(k)?.label ?? k).join(", ")}`
                    : "Hide this bucket on this account's page"}
                >
                  <input
                    type="checkbox"
                    disabled={locked.length > 0}
                    checked={b.hidden}
                    onChange={(e) => patch(b.id, { hidden: e.target.checked })}
                  />
                  Hidden
                </label>

                <button
                  type="button" aria-label={`Remove ${b.name} from this page`}
                  disabled={locked.length > 0}
                  title={locked.length > 0
                    ? "This bucket holds something the page's workflow depends on."
                    : "Take this bucket off this account's page"}
                  onClick={() => setDraft((rows) => rows.filter((r) => r.id !== b.id))}
                  className="rounded-md border border-border p-1 disabled:opacity-30"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>

              {/* The checklist. Everything the SHARED bucket holds, with
                  the ones this account shows ticked. */}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2">
                {full.map((k) => {
                  const item = byKey.get(k);
                  const fixed = item?.essential === true;
                  return (
                    <label
                      key={k}
                      title={fixed
                        ? item?.note ?? "The page's workflow depends on this."
                        : item?.note ?? ""}
                      className={`flex items-center gap-1.5 text-xs ${fixed
                        ? "text-muted-foreground" : ""}`}
                    >
                      <input
                        type="checkbox"
                        disabled={fixed}
                        checked={b.items.includes(k)}
                        onChange={() => toggleItem(b, k)}
                      />
                      {item?.label ?? k}
                      {fixed && <Lock className="h-3 w-3" aria-label="always shown" />}
                    </label>
                  );
                })}
              </div>
              {locked.length > 0 && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Always shown:{" "}
                  {locked.map((k) => byKey.get(k)?.label ?? k).join(", ")} — hiding it would
                  not change the rule behind it, only your ability to see why a submission
                  was refused.
                </p>
              )}
            </div>
          );
        })}
      </div>

      {spare.length > 0 && (
        <div>
          {!adding ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border
                         px-3 py-1.5 text-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              Add a bucket ({spare.length} available)
            </button>
          ) : (
            <div className="space-y-1 rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold">From the shared template</p>
                <button type="button" onClick={() => setAdding(false)} aria-label="Close">
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>
              {spare.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => {
                    setDraft((rows) => [...rows, {
                      ...b, position: (rows.length + 1) * 10, width: 6,
                      height: "auto", hidden: false, overridden: true,
                    } as Placed]);
                    setAdding(false);
                  }}
                  className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left
                             text-xs hover:bg-muted"
                >
                  <span className="font-semibold">{b.name}</span>
                  <span className="truncate text-muted-foreground">
                    {b.items.map((k) => byKey.get(k)?.label ?? k).join(" · ")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The button that opens the editor, and the editor itself.
 *
 * One component so a page adds arranging in one line, and so the
 * admin-only check is made in one place rather than on each page.
 */
export function ArrangeBar({ page }: { page: BlockPage }) {
  const q = useLayout(page);
  const [open, setOpen] = useState(false);
  if (!q.data?.canArrange) return null;
  const changed = q.data.layout.some((b) => b.overridden);
  return (
    <div className="space-y-3">
      {!open && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md border border-border px-2.5 py-1 text-xs"
          >
            Arrange this page
          </button>
          <span className="text-xs text-muted-foreground">
            {changed
              ? `${q.data.account.name} has its own arrangement of this page.`
              : "Following the shared layout."}
          </span>
        </div>
      )}
      {open && <LayoutEditor answer={q.data} onClose={() => setOpen(false)} />}
    </div>
  );
}
