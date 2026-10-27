import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check, Loader2, Plus, Settings2, Sparkles, Type, Users, X,
} from "lucide-react";
import {
  EditableBucket, HEIGHT_STEP, NewFlag, STEP_HEIGHT, isNew,
  type BlockPage, type Placed, type RegisteredItem,
} from "@/components/buckets";

/**
 * The shared template, arranged on the same canvas an account uses.
 *
 * It was a list of checkboxes, and a list of checkboxes is the wrong
 * tool for the only question being asked here: what will this page
 * LOOK like for every partner who has not arranged it themselves.
 * So it is the page, edited where it lives, with the same controls
 * in the same corners — somebody who has arranged one account's page
 * already knows how to use this one.
 *
 * What makes it the TEMPLATE rather than an account's page is what a
 * change reaches, and that is the thing it has to keep saying out
 * loud:
 *
 *   Moving or resizing a bucket changes the base layout. Every
 *   account that has not arranged this page gets it on the next
 *   load; the ones that have are TOLD and offered it, which is the
 *   drift notice on their own page.
 *
 *   Taking a field out of a bucket, or putting one in, changes the
 *   bucket ITSELF — for every partner at once, including the ones
 *   with their own arrangement, because a bucket's contents are the
 *   shared definition and not an arrangement of it.
 *
 * The two are deliberately different blast radii and the panel says
 * which is which before the save, not after.
 */

/** A bucket in the catalogue, whether or not the base layout places it. */
type Catalogued = {
  id: string; page: BlockPage; name: string; items: string[]; columns: number;
  builtin: boolean; archivedAt: string | null; newUntil?: string | null;
};

type TemplatePage = {
  key: BlockPage;
  label: string;
  items: RegisteredItem[];
  essential: string[];
  blocks: Catalogued[];
  base: Placed[];
  arranging: number;
};

export function TemplateCanvas({
  page, onDone,
}: {
  page: TemplatePage;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Placed[]>(() => page.base.map((b) => ({ ...b })));
  const [selected, setSelected] = useState(page.base[0]?.id ?? "");
  const [dragging, setDragging] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");

  const byKey = useMemo(
    () => new Map(page.items.map((i) => [i.key, i])), [page.items]);
  const here = draft.find((b) => b.id === selected) ?? draft[0];
  const essentialIn = (b: Placed) => b.items.filter((k) => byKey.get(k)?.essential);

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

  /**
   * The palette: every field this page has, minus the ones the
   * selected bucket already holds.
   *
   * Not minus the ones other buckets hold — a field can legitimately
   * appear twice on a page (a reference repeated beside the thing it
   * refers to), and the duplicate that actually causes trouble is
   * the one INSIDE a bucket. Those it does exclude.
   */
  const palette = here ? page.items.filter((i) => !here.items.includes(i.key)) : [];

  const addField = (key: string) => {
    if (!here) return;
    patch(here.id, { items: [...here.items, key] });
  };
  const dropField = (key: string) => {
    if (!here || byKey.get(key)?.essential) return;
    patch(here.id, { items: here.items.filter((k) => k !== key) });
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

  /** Which buckets' CONTENTS changed, as against which merely moved. */
  const contentChanged = draft.filter((b) => {
    const was = page.blocks.find((x) => x.id === b.id);
    if (!was) return true;
    return was.items.join(",") !== b.items.join(",") || was.columns !== b.columns;
  });

  const save = useMutation({
    mutationFn: async () => {
      // Contents first: a layout that places a bucket whose fields
      // failed to save would be a page arranged around a bucket that
      // is not what the canvas showed.
      for (const b of contentChanged) {
        await post("/api/dutch-miller/template/blocks", {
          id: b.id, page: page.key, name: b.name, items: b.items, columns: b.columns,
        });
      }
      await post(`/api/dutch-miller/template/layout/${page.key}`, {
        layout: draft.map((b, i) => ({
          blockId: b.id, position: (i + 1) * 10, width: b.width, height: b.height,
        })),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dm-template-blocks"] });
      onDone();
    },
    onError: (e) => setError((e as Error).message),
  });

  const create = useMutation({
    mutationFn: async () => post("/api/dutch-miller/template/blocks", {
      page: page.key, name: newName, items: [page.items[0]?.key ?? ""], columns: 3,
    }),
    onSuccess: (out: { block: Catalogued }) => {
      setDraft((rows) => [...rows, {
        ...out.block, position: (rows.length + 1) * 10, width: 6,
        height: "auto", hidden: false, overridden: false,
      }]);
      setSelected(out.block.id);
      setNaming(false); setNewName("");
      void qc.invalidateQueries({ queryKey: ["dm-template-blocks"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const flagNew = useMutation({
    mutationFn: (v: { itemKey: string; kind: string; on: boolean }) =>
      post("/api/dutch-miller/template/new", { page: page.key, days: 14, ...v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["dm-template-blocks"] }),
    onError: (e) => setError((e as Error).message),
  });

  const placed = new Set(draft.map((b) => b.id));
  const spare = page.blocks.filter((b) => !placed.has(b.id) && b.archivedAt === null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-600/40
                      bg-sky-500/5 px-3 py-2">
        <Users className="h-3.5 w-3.5" />
        <span className="text-sm font-semibold">Shared template — {page.label}</span>
        <span className="text-xs text-muted-foreground">
          {page.arranging === 0
            ? "No partner has arranged this page, so every account gets this."
            : `${page.arranging} partner${page.arranging === 1 ? " has" : "s have"} `
              + "their own arrangement. They keep it, and are told this changed."}
        </span>
      </div>

      {error && <p className="text-sm font-semibold text-rose-600">{error}</p>}

      <div className="flex flex-col gap-4 lg:flex-row">
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
                itemOf={(k) => byKey.get(k)}
                page={page.key}
                subject=""
                render={() => null}
                onSelect={() => setSelected(b.id)}
                onDragStart={() => setDragging(b.id)}
                onDragEnd={() => setDragging(null)}
                onDrop={() => dropOn(b.id)}
                onMove={(by) => move(b.id, by)}
                onRemove={() => {
                  setDraft((rows) => rows.filter((r) => r.id !== b.id));
                  setSelected("");
                }}
                onDropField={(k) => { setSelected(b.id); dropField(k); }}
                onMoveField={(k, by) => moveField(b, k, by)}
              />
            ))}
          </div>
          {draft.length === 0 && (
            <p className="rounded-xl border border-dashed border-border px-6 py-12
                          text-center text-sm text-muted-foreground">
              Nothing is on the shared layout for this page. Every new partner would see an
              empty page — add a bucket from the panel.
            </p>
          )}
        </div>

        <aside className="w-full shrink-0 space-y-3 lg:w-80" aria-label="Template settings">
          {/* The palette. Every field the page has, including the
              ones the template itself defines, minus what this
              bucket already holds. */}
          <div className="space-y-2 rounded-xl border border-border bg-card p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <Type className="h-3.5 w-3.5" />
              Fields
            </p>
            {!here ? (
              <p className="text-xs text-muted-foreground">
                Click a bucket to put fields in it.
              </p>
            ) : palette.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Every field on this page is already in “{here.name}”.
              </p>
            ) : (
              <>
                <p className="text-[11px] text-muted-foreground">
                  Into <span className="font-semibold text-foreground">{here.name}</span>,
                  for every partner.
                </p>
                <div className="max-h-72 space-y-1 overflow-auto">
                  {palette.map((i) => (
                    <button
                      key={i.key}
                      type="button"
                      onClick={() => addField(i.key)}
                      className="flex w-full items-center gap-1.5 rounded-md border border-dashed
                                 border-border px-2 py-1 text-left text-xs hover:bg-muted"
                    >
                      <Plus className="h-3 w-3 shrink-0" />
                      <span className="flex-1 truncate">{i.label}</span>
                      {i.custom && (
                        <span className="text-[10px] text-muted-foreground">template</span>
                      )}
                      {isNew(i) && <NewFlag />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {here && (
            <div className="space-y-3 rounded-xl border border-border bg-card p-3">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <Settings2 className="h-3.5 w-3.5" />
                {here.name}
              </p>
              <p className="rounded-md bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
                <span className="font-semibold text-foreground">{here.width}/6 wide</span>
                {" · "}{here.columns} column{here.columns === 1 ? "" : "s"}
                {" · "}
                {here.height === "auto" ? "fits its content"
                  : here.height === "short" ? "short, scrolls" : "tall"}
              </p>
              <fieldset>
                <legend className="text-xs font-medium">Width</legend>
                <div className="mt-1 flex gap-1">
                  {[2, 3, 4, 6].map((w) => (
                    <button
                      key={w}
                      type="button"
                      aria-pressed={here.width === w}
                      onClick={() => patch(here.id, { width: w as 2 | 3 | 4 | 6 })}
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
              </label>
              <label className="block text-xs font-medium">
                Name
                <input
                  value={here.name}
                  onChange={(e) => patch(here.id, { name: e.target.value })}
                  className="mt-1 w-full rounded-md border border-border bg-background
                             px-2 py-1 text-xs"
                />
              </label>
              <button
                type="button"
                onClick={() => flagNew.mutate({
                  itemKey: here.id, kind: "bucket", on: !isNew(here),
                })}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md
                           border border-border px-2 py-1 text-xs"
              >
                <Sparkles className="h-3 w-3" />
                {isNew(here) ? "Stop flagging it as new" : "Flag it as new for 14 days"}
              </button>
            </div>
          )}

          <div className="space-y-2 rounded-xl border border-border bg-card p-3">
            {spare.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium">Buckets not on this layout</p>
                {spare.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      setDraft((rows) => [...rows, {
                        ...b, position: (rows.length + 1) * 10, width: 6,
                        height: "auto", hidden: false, overridden: false,
                      }]);
                      setSelected(b.id);
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
            {naming ? (
              <div className="space-y-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="What is this group called?"
                  className="w-full rounded-md border border-border bg-background px-2 py-1
                             text-xs"
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    disabled={create.isPending || newName.trim().length < 2}
                    onClick={() => { setError(""); create.mutate(); }}
                    className="flex-1 rounded-md bg-foreground px-2 py-1 text-xs font-semibold
                               text-background disabled:opacity-50"
                  >
                    Add it
                  </button>
                  <button
                    type="button"
                    onClick={() => { setNaming(false); setNewName(""); }}
                    className="rounded-md border border-border px-2 py-1 text-xs"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setNaming(true)}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md
                           border border-border px-2.5 py-1.5 text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                New bucket
              </button>
            )}
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-card p-3">
            {contentChanged.length > 0 && (
              <p className="rounded-md bg-amber-500/10 px-2 py-1 text-[11px]">
                {contentChanged.length} bucket{contentChanged.length === 1 ? "" : "s"} changed
                inside. That reaches every partner, including the ones with their own
                arrangement — a bucket&rsquo;s contents are the shared definition.
              </p>
            )}
            <button
              type="button"
              aria-label="Save the shared template"
              disabled={save.isPending}
              onClick={() => { setError(""); save.mutate(); }}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md
                         bg-foreground px-3 py-1.5 text-sm font-semibold text-background
                         disabled:opacity-50"
            >
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Check className="h-3.5 w-3.5" />}
              Save the template
            </button>
            <button
              type="button"
              aria-label="Stop editing the shared template"
              onClick={onDone}
              className="w-full rounded-md border border-border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
