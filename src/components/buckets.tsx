import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown, ArrowUp, ArrowUpToLine, Check, GripVertical, Loader2, Lock, Pencil,
  Plus, RotateCcw, Settings2, X,
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
  | "rfid-instructions" | "rfid-review" | "account-registration";

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
  /** Promoting reaches other partners, so it is the platform's. */
  canPromote: boolean;
  impact: { following: string[]; keeping: string[]; hasOwn: boolean };
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


/* ------------------------------------------------------------------ *
 * Editing a page, in place
 * ------------------------------------------------------------------ */

/**
 * The editor, modelled on WashIQ Conversations.
 *
 * It edits the LIVE page rather than a list of controls beside it. A
 * list is easier to build and is the wrong thing: somebody arranging
 * a page is deciding how it will look, and a panel of dropdowns makes
 * them imagine the result instead of seeing it.
 *
 * Three control clusters, each in a fixed place so they are learnt
 * once:
 *
 *   TOP-RIGHT of a bucket — settings, remove, drag handle. These act
 *   on the bucket.
 *   TOP-LEFT of a field — remove. This acts on the one field, and is
 *   deliberately at the opposite corner so it can never be mistaken
 *   for the bucket's.
 *   RIGHT-HAND INSPECTOR — width, columns, height, and the buttons
 *   that end the session.
 *
 * Everything is a DRAFT until Save. Cancel restores what was there,
 * which is only true because nothing here writes as it goes.
 */

type Draft = Placed[];

const HEIGHT_STEP: Record<string, number> = { auto: 0, short: 1, tall: 2 };
const STEP_HEIGHT: ("auto" | "short" | "tall")[] = ["auto", "short", "tall"];

/**
 * A page, as this account arranged it — and the pencil that changes it.
 *
 * One component so a page adds all of this in a line, and so the
 * admin-only check is made in one place rather than on each page.
 */
export function ArrangedPage({
  page, render, fallback,
}: {
  page: BlockPage;
  render: (itemKey: string) => React.ReactNode;
  /** What to show before the layout lands. Never a spinner on a working page. */
  fallback?: React.ReactNode;
}) {
  const q = useLayout(page);
  const [editing, setEditing] = useState(false);
  const answer = q.data;

  if (!answer) return <>{fallback ?? null}</>;

  if (editing) {
    return (
      <PageEditor
        answer={answer}
        render={render}
        onClose={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="space-y-3">
      {answer.canArrange && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={`Arrange ${answer.label}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border
                       px-2.5 py-1 text-xs"
          >
            <Pencil className="h-3.5 w-3.5" />
            Arrange this page
          </button>
          <span className="text-xs text-muted-foreground">
            {answer.layout.some((b) => b.overridden)
              ? `${answer.account.name} has its own arrangement of this page.`
              : "Following the shared layout."}
          </span>
        </div>
      )}
      <BucketGrid layout={answer.layout} render={render} />
    </div>
  );
}

function PageEditor({
  answer, render, onClose,
}: {
  answer: LayoutAnswer;
  render: (itemKey: string) => React.ReactNode;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => answer.layout.map((b) => ({ ...b })));
  const [selected, setSelected] = useState<string>(answer.layout[0]?.id ?? "");
  const [dragging, setDragging] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const byKey = useMemo(
    () => new Map(answer.items.map((i) => [i.key, i])), [answer.items]);
  const essentialIn = (b: Placed) => b.items.filter((k) => byKey.get(k)?.essential);
  const here = draft.find((b) => b.id === selected) ?? draft[0];

  /** Everything the SHARED bucket holds. The account chooses from it. */
  const fullOf = (id: string) =>
    answer.available.find((a) => a.id === id)?.items ?? [];
  /**
   * What this bucket could still show.
   *
   * Its template fields minus the ones already placed in it. A field
   * in the bucket must not also appear as something to add — that is
   * the duplicate somebody would create first. Deliberately NOT
   * excluded from other buckets on the page: the brief leaves that
   * open, so the narrower rule is the one implemented.
   */
  const spareIn = (b: Placed) => fullOf(b.id).filter((k) => !b.items.includes(k));

  const patch = (id: string, change: Partial<Placed>) =>
    setDraft((rows) => rows.map((r) => (r.id === id ? { ...r, ...change } : r)));

  const move = (id: string, by: number) => setDraft((rows) => {
    const i = rows.findIndex((r) => r.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= rows.length) return rows;
    const next = [...rows];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });

  const dropBucketOn = (id: string) => {
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

  /** Take a field's PLACEMENT off. Not the field, and not its data. */
  const dropField = (b: Placed, key: string) => {
    if (byKey.get(key)?.essential) return;
    patch(b.id, { items: b.items.filter((k) => k !== key) });
  };

  /** Put one back, in the shared bucket's order so two accounts match. */
  const addField = (b: Placed, key: string) => {
    const full = fullOf(b.id);
    patch(b.id, { items: full.filter((k) => b.items.includes(k) || k === key) });
  };

  const moveField = (b: Placed, key: string, by: number) => {
    const i = b.items.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= b.items.length) return;
    const next = [...b.items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    patch(b.id, { items: next });
  };

  const post = async (url: string, body?: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? "That did not work.");
    return out;
  };
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["dm-layout", answer.page] });
    onClose();
  };

  const save = useMutation({
    mutationFn: () => post(`/api/dutch-miller/blocks/${answer.page}/layout`, {
      layout: draft.map((b, i) => ({
        blockId: b.id, position: (i + 1) * 10, width: b.width,
        height: b.height, hidden: b.hidden, items: b.items,
      })),
    }),
    onSuccess: done,
    onError: (e) => setError((e as Error).message),
  });
  const restore = useMutation({
    mutationFn: () => post(`/api/dutch-miller/blocks/${answer.page}/reset`),
    onSuccess: done,
    onError: (e) => setError((e as Error).message),
  });
  const promote = useMutation({
    mutationFn: () => post(`/api/dutch-miller/blocks/${answer.page}/promote`),
    onSuccess: done,
    onError: (e) => setError((e as Error).message),
  });

  const placed = new Set(draft.map((b) => b.id));
  const spareBuckets = answer.available.filter((b) => !placed.has(b.id));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-foreground/20
                      bg-muted/40 px-3 py-2">
        <Pencil className="h-3.5 w-3.5" />
        <span className="text-sm font-semibold">Arranging {answer.label}</span>
        <span className="text-xs text-muted-foreground">
          For {answer.account.name} only. Click a bucket to open its settings.
        </span>
      </div>

      {error && <p className="text-sm font-semibold text-rose-600">{error}</p>}

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* The page itself, edited where it lives. */}
        <div className="min-w-0 flex-1">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
            {draft.map((b, i) => (
              <EditableBucket
                key={b.id}
                bucket={b}
                index={i}
                count={draft.length}
                selected={b.id === selected}
                dragging={dragging === b.id}
                locked={essentialIn(b)}
                labelOf={(k) => byKey.get(k)?.label ?? k}
                essential={(k) => byKey.get(k)?.essential === true}
                render={render}
                onSelect={() => setSelected(b.id)}
                onDragStart={() => setDragging(b.id)}
                onDragEnd={() => setDragging(null)}
                onDrop={() => dropBucketOn(b.id)}
                onMove={(by) => move(b.id, by)}
                onRemove={() => {
                  setDraft((rows) => rows.filter((r) => r.id !== b.id));
                  setSelected("");
                }}
                onDropField={(k) => dropField(b, k)}
                onMoveField={(k, by) => moveField(b, k, by)}
              />
            ))}
          </div>
          {draft.length === 0 && (
            <p className="rounded-xl border border-dashed border-border px-6 py-12
                          text-center text-sm text-muted-foreground">
              Every bucket has been taken off this page. Add one from the panel.
            </p>
          )}
        </div>

        {/* The inspector. Width, columns, height, and the way out. */}
        <aside className="w-full shrink-0 space-y-3 lg:w-72" aria-label="Bucket settings">
          <div className="space-y-3 rounded-xl border border-border bg-card p-3">
            {here ? (
              <>
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <Settings2 className="h-3.5 w-3.5" />
                  {here.name}
                </p>

                <fieldset>
                  <legend className="text-xs font-medium">Width</legend>
                  <div className="mt-1 flex gap-1">
                    {answer.widths.map((w) => (
                      <button
                        key={w}
                        type="button"
                        aria-pressed={here.width === w}
                        onClick={() => patch(here.id, { width: w })}
                        className={`flex-1 rounded-md border px-1.5 py-1 text-xs ${
                          here.width === w
                            ? "border-foreground bg-foreground text-background font-semibold"
                            : "border-border"}`}
                      >
                        {w}/6
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label className="block text-xs font-medium">
                  Columns inside it
                  <select
                    value={here.columns}
                    onChange={(e) => patch(here.id, { columns: Number(e.target.value) })}
                    className="mt-1 w-full rounded-md border border-border bg-background
                               px-2 py-1 text-xs"
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </label>

                <label className="block text-xs font-medium">
                  Height
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={1}
                    value={HEIGHT_STEP[here.height] ?? 0}
                    onChange={(e) => patch(here.id,
                      { height: STEP_HEIGHT[Number(e.target.value)] ?? "auto" })}
                    className="mt-1 w-full"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {here.height === "auto" ? "Fits its content"
                      : here.height === "short" ? "Short — scrolls" : "Tall"}
                  </span>
                </label>

                {/* The fields this bucket is not showing. A field that
                    IS placed never appears here — that is the
                    duplicate somebody would make first. */}
                <div>
                  <p className="text-xs font-medium">Fields it is not showing</p>
                  {spareIn(here).length === 0 ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Every field this bucket offers is on the page.
                    </p>
                  ) : (
                    <div className="mt-1 space-y-1">
                      {spareIn(here).map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => addField(here, k)}
                          className="flex w-full items-center gap-1.5 rounded-md border
                                     border-dashed border-border px-2 py-1 text-left text-xs
                                     hover:bg-muted"
                        >
                          <Plus className="h-3 w-3 shrink-0" />
                          {byKey.get(k)?.label ?? k}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {essentialIn(here).length > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    Always shown:{" "}
                    {essentialIn(here).map((k) => byKey.get(k)?.label ?? k).join(", ")} —
                    hiding one would not change the rule behind it, only your ability to
                    see why a submission was refused.
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Click a bucket to open its settings.
              </p>
            )}
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-card p-3">
            {spareBuckets.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setAdding((v) => !v)}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md
                             border border-border px-2.5 py-1.5 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add a bucket ({spareBuckets.length})
                </button>
                {adding && (
                  <div className="space-y-1">
                    {spareBuckets.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => {
                          setDraft((rows) => [...rows, {
                            ...b, position: (rows.length + 1) * 10, width: 6,
                            height: "auto", hidden: false, overridden: true,
                          } as Placed]);
                          setSelected(b.id);
                          setAdding(false);
                        }}
                        className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                      >
                        <span className="font-semibold">{b.name}</span>
                        <span className="block truncate text-muted-foreground">
                          {b.items.map((k) => byKey.get(k)?.label ?? k).join(" · ")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Every bucket the template offers for this page is already on it.
              </p>
            )}
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-card p-3">
            {/* Named apart from the page's own buttons. On Add New
                this panel sits beside a form with its own Cancel and
                Submit, and two controls called Cancel is a trap for
                anybody reading the page rather than looking at it. */}
            <button
              type="button"
              aria-label="Save this page's arrangement"
              disabled={save.isPending}
              onClick={() => { setError(""); save.mutate(); }}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md
                         bg-foreground px-3 py-1.5 text-sm font-semibold text-background
                         disabled:opacity-50"
            >
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Check className="h-3.5 w-3.5" />}
              Save
            </button>
            <button
              type="button"
              aria-label="Cancel arranging, discarding the changes"
              onClick={onClose}
              className="w-full rounded-md border border-border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              aria-label="Restore the shared layout"
              disabled={restore.isPending}
              title="Put this page back to the shared layout and keep following it"
              onClick={() => { setError(""); restore.mutate(); }}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md
                         border border-border px-3 py-1.5 text-xs disabled:opacity-50"
            >
              <RotateCcw className="h-3 w-3" />
              Restore shared layout
            </button>
            {answer.canPromote && answer.impact.hasOwn && (
              <>
                <button
                  type="button"
                  disabled={promote.isPending}
                  onClick={() => { setError(""); promote.mutate(); }}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md
                             border border-sky-600/50 px-3 py-1.5 text-xs font-semibold
                             disabled:opacity-50"
                >
                  <ArrowUpToLine className="h-3 w-3" />
                  Promote to the shared template
                </button>
                <p className="text-[11px] text-muted-foreground">
                  {answer.impact.following.length === 0
                    ? "No existing partner still follows the shared layout, so this would "
                      + "change only accounts created from here on."
                    : `Reaches ${answer.impact.following.length} partner`
                      + `${answer.impact.following.length === 1 ? "" : "s"} still following `
                      + `it${answer.impact.keeping.length > 0
                        ? `; ${answer.impact.keeping.length} with their own keep it` : ""}.`}
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * One bucket, while the page is being edited.
 *
 * The white canvas inside is divided into sections, one per field
 * plus an empty one at the end, so where a field can go is visible
 * rather than implied. A bucket does not have to be full.
 */
function EditableBucket({
  bucket, index, count, selected, dragging, locked,
  labelOf, essential, render,
  onSelect, onDragStart, onDragEnd, onDrop, onMove, onRemove, onDropField, onMoveField,
}: {
  bucket: Placed;
  index: number;
  count: number;
  selected: boolean;
  dragging: boolean;
  locked: string[];
  labelOf: (key: string) => string;
  essential: (key: string) => boolean;
  render: (key: string) => React.ReactNode;
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onMove: (by: number) => void;
  onRemove: () => void;
  onDropField: (key: string) => void;
  onMoveField: (key: string, by: number) => void;
}) {
  return (
    <section
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onClick={onSelect}
      className={`relative rounded-xl border bg-card p-4 ${SPAN[bucket.width] ?? "md:col-span-6"} ${
        dragging ? "opacity-50" : ""} ${
        selected ? "border-foreground ring-1 ring-foreground/20" : "border-border"}`}
    >
      {/* The bucket's own controls, always top-right so they are
          learnt once and never confused with a field's. */}
      <div className="absolute right-2 top-2 flex items-center gap-1">
        <button
          type="button"
          aria-label={`${bucket.name} bucket settings`}
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          className="rounded-md border border-border bg-background p-1"
        >
          <Settings2 className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={`Remove ${bucket.name} bucket`}
          disabled={locked.length > 0}
          title={locked.length > 0
            ? `Cannot be removed — it holds ${locked.map(labelOf).join(", ")}, which the `
              + "page's workflow depends on."
            : `Take ${bucket.name} off this account's page`}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="rounded-md border border-border bg-background p-1 disabled:opacity-30"
        >
          <X className="h-3 w-3" />
        </button>
        {/* Dragging moves it; the two arrows do the same thing with a
            keyboard, which is the only way it works on a phone. */}
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          aria-hidden
          className="cursor-grab rounded-md border border-border bg-background p-1"
        >
          <GripVertical className="h-3 w-3" />
        </span>
        <button
          type="button"
          aria-label={`Move ${bucket.name} bucket up`}
          disabled={index === 0}
          onClick={(e) => { e.stopPropagation(); onMove(-1); }}
          className="rounded-md border border-border bg-background p-1 disabled:opacity-30"
        >
          <ArrowUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={`Move ${bucket.name} bucket down`}
          disabled={index === count - 1}
          onClick={(e) => { e.stopPropagation(); onMove(1); }}
          className="rounded-md border border-border bg-background p-1 disabled:opacity-30"
        >
          <ArrowDown className="h-3 w-3" />
        </button>
      </div>

      <h3 className="mb-3 pr-44 text-sm font-semibold">{bucket.name}</h3>

      <div className={`grid gap-2 rounded-lg bg-white p-2 dark:bg-background ${
        INNER[bucket.columns] ?? INNER[3]}`}>
        {bucket.items.map((key, i) => (
          <div
            key={key}
            className="relative rounded-md border border-dashed border-border/70 p-2"
          >
            {/* The FIELD's control, top-left, at the opposite corner
                from the bucket's so the two can never be mistaken. */}
            <button
              type="button"
              aria-label={`Remove ${labelOf(key)} field`}
              disabled={essential(key)}
              title={essential(key)
                ? `${labelOf(key)} cannot be removed — the page's workflow depends on it.`
                : `Take ${labelOf(key)} off this bucket`}
              onClick={(e) => { e.stopPropagation(); onDropField(key); }}
              className="absolute -left-1.5 -top-1.5 z-10 rounded-full border border-border
                         bg-background p-0.5 disabled:opacity-30"
            >
              {essential(key) ? <Lock className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
            </button>
            <span className="absolute -top-1.5 right-1 z-10 flex gap-0.5">
              <button
                type="button"
                aria-label={`Move ${labelOf(key)} earlier`}
                disabled={i === 0}
                onClick={(e) => { e.stopPropagation(); onMoveField(key, -1); }}
                className="rounded-full border border-border bg-background p-0.5
                           disabled:opacity-20"
              >
                <ArrowUp className="h-2.5 w-2.5" />
              </button>
              <button
                type="button"
                aria-label={`Move ${labelOf(key)} later`}
                disabled={i === bucket.items.length - 1}
                onClick={(e) => { e.stopPropagation(); onMoveField(key, 1); }}
                className="rounded-full border border-border bg-background p-0.5
                           disabled:opacity-20"
              >
                <ArrowDown className="h-2.5 w-2.5" />
              </button>
            </span>
            <div className="pointer-events-none pt-1">{render(key) ?? (
              <span className="text-xs text-muted-foreground">{labelOf(key)}</span>
            )}</div>
          </div>
        ))}
        {/* An empty section, so a bucket that is not full says so and
            there is somewhere obvious for the next field to go. */}
        <div className="flex min-h-14 items-center justify-center rounded-md border
                        border-dashed border-border/50 text-[11px] text-muted-foreground">
          {selected ? "Add a field from the panel" : "Empty"}
        </div>
      </div>
    </section>
  );
}
