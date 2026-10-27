import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, ChevronRight, Layers, LayoutGrid, Loader2, Lock, Plus, RotateCcw,
  Sparkles, Trash2, X,
} from "lucide-react";
import { SectionTitle } from "@/components/ui";
import { NewFlag, isNew, type BlockPage, type Placed, type RegisteredItem }
  from "@/components/buckets";
import { TemplateCanvas } from "@/components/template-canvas";
import { TemplateNav } from "@/components/template-nav";

/**
 * Shared Template — the catalogue every partner's pages are built from.
 *
 * One bucket definition, shared. Change what a bucket holds and every
 * partner using it gets the change on the next load, with nothing to
 * re-copy and no account left behind on an older version. That is the
 * whole reason the definition lives here and not in each account.
 *
 * What an account keeps is its ARRANGEMENT — which buckets its page
 * shows, in what order, how wide, and which of a bucket's fields it
 * shows. Those are untouched by anything on this page, which is why
 * the editor says how many partners have arranged a page before
 * letting somebody change the base layout underneath them.
 *
 * The vocabulary is fixed. A bucket is composed from the items the
 * application has registered for that page — real fields, real
 * content — and nothing else. There is no box here for a field name,
 * deliberately: a name nobody registered would render as a gap, and
 * the person who finds the gap is a dealership.
 */

type Block = {
  id: string;
  page: BlockPage;
  name: string;
  items: string[];
  columns: number;
  builtin: boolean;
  archivedAt: string | null;
  newUntil: string | null;
  createdAt: string;
  createdBy: string;
};

/** A field the template defines rather than code registering it. */
export type CustomField = {
  key: string;
  page: BlockPage;
  label: string;
  input: "text" | "textarea" | "number" | "date" | "select" | "checkbox";
  options: string[];
  note: string;
  archivedAt: string | null;
  newUntil: string | null;
};

type PageInfo = {
  key: BlockPage;
  label: string;
  items: RegisteredItem[];
  essential: string[];
  blocks: Block[];
  /** The shared layout itself, so it can be arranged on a canvas. */
  base: Placed[];
  /** The fields this template defines for the page. */
  fields: CustomField[];
  /** How many partners have their own arrangement of this page. */
  arranging: number;
};

export function DmTemplatePage() {
  const q = useQuery({
    queryKey: ["dm-template-blocks"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/template/blocks");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not read the template.");
      return (await res.json()) as { pages: PageInfo[] };
    },
  });
  const version = useQuery({
    queryKey: ["dm-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/accounts");
      if (!res.ok) throw new Error("Could not read the partner accounts.");
      return (await res.json()) as { templateVersion: number };
    },
  }).data?.templateVersion ?? 1;

  const [open, setOpen] = useState<string>("");

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Shared Template"
        description="The buckets every partner account's pages are built from."
      />

      <div className="space-y-2 rounded-xl border border-border bg-card p-5 text-sm">
        <p className="flex items-center gap-2 font-semibold">
          <Layers className="h-4 w-4" />
          Template v{version}
        </p>
        <p className="text-muted-foreground">
          One application and one copy of every page, form, validation rule and workflow in
          it. A bucket defined here is the same bucket in every account that places it, so a
          change reaches them all on the next load — there is no per-partner fork and no
          snapshot taken at provisioning.
        </p>
        <p className="text-muted-foreground">
          Each account keeps its own arrangement: which buckets its page shows, their order
          and width, and which of a bucket&rsquo;s fields it shows. Nothing here overwrites
          that.
        </p>
      </div>

      {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && (
        <p className="text-sm font-semibold text-red-600">{(q.error as Error).message}</p>
      )}

      <TemplateNav />

      {(q.data?.pages ?? []).map((page) => (
        <PageCatalogue
          key={page.key}
          page={page}
          open={open === page.key}
          onToggle={() => setOpen(open === page.key ? "" : page.key)}
        />
      ))}
    </div>
  );
}

function PageCatalogue({
  page, open, onToggle,
}: {
  page: PageInfo;
  open: boolean;
  onToggle: () => void;
}) {
  const [editing, setEditing] = useState<Block | "new" | null>(null);
  const [arranging, setArranging] = useState(false);
  const live = page.blocks.filter((b) => b.archivedAt === null);
  const retired = page.blocks.filter((b) => b.archivedAt !== null);

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-3 text-left"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="flex-1 truncate text-sm font-semibold">{page.label}</span>
        <span className="text-xs text-muted-foreground">
          {live.length} bucket{live.length === 1 ? "" : "s"}
          {page.arranging > 0 && ` · ${page.arranging} partner`}
          {page.arranging > 1 && "s"}
          {page.arranging > 0 && " arranged it"}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-5 py-4">
          {/* Said before anybody edits, not after. A bucket here is
              shared, and the number is the blast radius. */}
          {page.arranging > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/40
                          bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {page.arranging} partner{page.arranging === 1 ? " has" : "s have"} arranged
                this page. Changing what a bucket holds reaches all of them; their order,
                widths and hidden buckets are untouched.
              </span>
            </p>
          )}

          {/* The canvas. The list below is still here because it
              answers a different question — what a bucket HOLDS,
              read without clicking — and the canvas answers what the
              page will look like, which a list cannot. */}
          {arranging ? (
            <TemplateCanvas page={page} onDone={() => setArranging(false)} />
          ) : (
            <button
              type="button"
              onClick={() => setArranging(true)}
              aria-label={`Arrange the shared ${page.label} page`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border
                         px-3 py-1.5 text-sm"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              Arrange the shared page
            </button>
          )}

          <PageFields page={page} />

          {live.map((b) => (
            <BlockRow
              key={b.id}
              block={b}
              page={page}
              onEdit={() => setEditing(b)}
            />
          ))}

          {retired.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Retired
              </p>
              {retired.map((b) => (
                <BlockRow key={b.id} block={b} page={page} onEdit={() => setEditing(b)} />
              ))}
            </div>
          )}

          {editing === null && (
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="inline-flex items-center gap-1.5 rounded-md border border-border
                         px-3 py-1.5 text-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              Create a bucket
            </button>
          )}

          {editing !== null && (
            <BlockEditor
              page={page}
              block={editing === "new" ? null : editing}
              onClose={() => setEditing(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function BlockRow({
  block, page, onEdit,
}: {
  block: Block;
  page: PageInfo;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const byKey = new Map(page.items.map((i) => [i.key, i]));
  const archive = useMutation({
    mutationFn: async (archived: boolean) => {
      const res = await fetch(
        `/api/dutch-miller/template/blocks/${block.id}/archive`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived }),
        });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not change it.");
      return body;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["dm-template-blocks"] }),
  });

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 truncate text-sm font-semibold">{block.name}</span>
        {block.builtin && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold
                           text-muted-foreground">
            ships with the app
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {block.columns} column{block.columns === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-border px-2.5 py-1 text-xs"
        >
          Edit
        </button>
        {!block.builtin && (
          <button
            type="button"
            disabled={archive.isPending}
            title={block.archivedAt
              ? "Offer it again. Every account's arrangement of it comes back as it was."
              : "Stop offering it. Nothing is deleted and no account loses its arrangement."}
            onClick={() => archive.mutate(block.archivedAt === null)}
            className="inline-flex items-center gap-1 rounded-md border border-border
                       px-2.5 py-1 text-xs disabled:opacity-50"
          >
            {block.archivedAt ? <RotateCcw className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {block.archivedAt ? "Bring back" : "Retire"}
          </button>
        )}
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {block.items.map((k) => byKey.get(k)?.label ?? k).join(" · ")}
      </p>
      {archive.isError && (
        <p className="mt-1 text-xs font-semibold text-red-600">
          {(archive.error as Error).message}
        </p>
      )}
    </div>
  );
}

/**
 * Create a bucket, or change one.
 *
 * The checklist IS the vocabulary: every item the page has
 * registered, with the ones in this bucket ticked. There is no free
 * text field for a field name, on purpose — a name nobody registered
 * would render as nothing, and nothing is the hardest bug to notice.
 *
 * An essential item cannot be unticked out of the bucket holding it.
 * Every account's page would lose it at once, and the pages whose
 * workflow depends on it would stop working everywhere without
 * anybody having touched their own layout.
 */
function BlockEditor({
  page, block, onClose,
}: {
  page: PageInfo;
  block: Block | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(block?.name ?? "");
  const [items, setItems] = useState<string[]>(block?.items ?? []);
  const [columns, setColumns] = useState(block?.columns ?? 3);
  const [error, setError] = useState("");

  const byKey = useMemo(() => new Map(page.items.map((i) => [i.key, i])), [page.items]);
  // An item already in this bucket and essential cannot leave it.
  const pinned = useMemo(
    () => (block?.items ?? []).filter((k) => byKey.get(k)?.essential),
    [block, byKey]);

  const toggle = (key: string) => {
    if (pinned.includes(key)) return;
    setItems((v) => (v.includes(key)
      ? v.filter((k) => k !== key)
      // Kept in the page's registered order, so two buckets holding
      // the same fields read the same way round.
      : page.items.filter((i) => v.includes(i.key) || i.key === key).map((i) => i.key)));
  };

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/template/blocks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: block?.id, page: page.key, name, items, columns }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save it.");
      return body;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dm-template-blocks"] });
      void qc.invalidateQueries({ queryKey: ["dm-layout"] });
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-3 rounded-lg border border-foreground/20 bg-muted/30 p-3">
      <p className="text-sm font-semibold">
        {block ? `Editing “${block.name}”` : "A new bucket"}
        <span className="ml-2 font-normal text-muted-foreground">on {page.label}</span>
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-xs font-medium sm:col-span-2">
          Bucket name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Customer"
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5
                       text-sm"
          />
        </label>
        <label className="block text-xs font-medium">
          Columns inside it
          <select
            value={columns}
            onChange={(e) => setColumns(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5
                       text-sm"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold">
          What it holds — everything this page has registered
        </p>
        <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {page.items.map((i) => {
            const fixed = pinned.includes(i.key);
            return (
              <label
                key={i.key}
                title={i.note ?? ""}
                className={`flex items-start gap-1.5 text-xs ${fixed
                  ? "text-muted-foreground" : ""}`}
              >
                <input
                  type="checkbox"
                  disabled={fixed}
                  checked={items.includes(i.key)}
                  onChange={() => toggle(i.key)}
                  className="mt-0.5"
                />
                <span>
                  {i.label}
                  {fixed && <Lock className="ml-1 inline h-3 w-3" aria-label="cannot be removed" />}
                  <span className="ml-1 text-muted-foreground">({i.kind})</span>
                  {/* Said while the bucket is being composed, not
                      discovered afterwards when a hide is refused. An
                      essential item is fine to include — it is what
                      including it COSTS that somebody needs to know. */}
                  {i.essential && (
                    <span className="ml-1 rounded-full bg-amber-500/15 px-1.5 py-0.5
                                     text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                      the workflow depends on it
                    </span>
                  )}
                  {i.note && <span className="block text-[11px] text-muted-foreground">{i.note}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* The order is the page's registered order, not the order they
          were ticked — so two partners showing the same fields show
          them the same way round, and nobody has to drag eleven
          checkboxes into place. */}
      {items.some((k) => page.items.find((i) => i.key === k)?.essential) && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          This bucket holds something the page&rsquo;s workflow depends on, so no account
          will be able to hide it or untick it. That is the point of putting it here —
          but put it where it belongs, because it pins the whole bucket.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Items appear in the order the page registers them. Each account arranges the
        buckets themselves — order, width and which fields it shows — on its own page.
      </p>

      {error && (
        <p className="flex items-start gap-1.5 text-xs font-semibold text-red-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={save.isPending || name.trim().length < 2 || items.length === 0}
          onClick={() => { setError(""); save.mutate(); }}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5
                     text-sm font-semibold text-background disabled:opacity-50"
        >
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Check className="h-3.5 w-3.5" />}
          Save to the template
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The page's fields
 * ------------------------------------------------------------------ */

/**
 * Every field this page has, and the ones the template added.
 *
 * Two jobs in one list, because they are the same question asked
 * twice. DEFINING a field is how a partner gets "Deal Jacket #"
 * without waiting for a deploy — shared like everything else here,
 * with each account's answers its own. FLAGGING one as new is how
 * anybody finds out, and it has to work on a field the application
 * registered in 2019 as much as one defined this morning: a feature
 * nobody notices was still shipped.
 */
function PageFields({ page }: { page: PageInfo }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CustomField | "new" | null>(null);
  const [error, setError] = useState("");

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
  const refresh = () => void qc.invalidateQueries({ queryKey: ["dm-template-blocks"] });

  const flag = useMutation({
    mutationFn: (v: { itemKey: string; on: boolean }) =>
      post("/api/dutch-miller/template/new", { page: page.key, days: 14, ...v }),
    onSuccess: refresh,
    onError: (e) => setError((e as Error).message),
  });
  const archive = useMutation({
    mutationFn: (v: { key: string; archived: boolean }) =>
      post(`/api/dutch-miller/template/fields/${v.key}/archive`, { archived: v.archived }),
    onSuccess: refresh,
    onError: (e) => setError((e as Error).message),
  });

  const custom = page.fields;
  const code = page.items.filter((i) => !i.custom);

  return (
    <div className="rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="flex-1 text-sm font-semibold">Fields on this page</span>
        <span className="text-xs text-muted-foreground">
          {code.length} from the application
          {custom.length > 0 && ` · ${custom.length} defined here`}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}

          <div className="space-y-1">
            {custom.map((f) => (
              <div
                key={f.key}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border
                           px-2 py-1.5 text-xs"
              >
                <span className="flex-1 truncate font-semibold">{f.label}</span>
                <span className="text-muted-foreground">{f.input}</span>
                {isNew(f) && <NewFlag />}
                <button
                  type="button"
                  onClick={() => setEditing(f)}
                  className="rounded-md border border-border px-2 py-0.5"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => flag.mutate({ itemKey: f.key, on: !isNew(f) })}
                  title="Show a New badge beside it for fourteen days"
                  className="inline-flex items-center gap-1 rounded-md border border-border
                             px-2 py-0.5"
                >
                  <Sparkles className="h-3 w-3" />
                  {isNew(f) ? "Not new" : "New"}
                </button>
                <button
                  type="button"
                  disabled={archive.isPending}
                  title="Stop offering it. Every answer written into it is kept, and bringing
                         it back brings them with it."
                  onClick={() => archive.mutate({ key: f.key, archived: true })}
                  className="inline-flex items-center gap-1 rounded-md border border-border
                             px-2 py-0.5 disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" />
                  Retire
                </button>
              </div>
            ))}
          </div>

          {editing !== null ? (
            <FieldEditor
              page={page}
              field={editing === "new" ? null : editing}
              onClose={() => setEditing(null)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="inline-flex items-center gap-1.5 rounded-md border border-border
                         px-3 py-1.5 text-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              Define a field
            </button>
          )}

          {/* Flagging content that is already there. The case the
              brief asks for by name, and the one a "new since your
              last visit" scheme never covers: a field that shipped
              years ago and that nobody has ever noticed. */}
          <div className="space-y-1 border-t border-border pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              From the application
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              {code.map((i) => (
                <div
                  key={i.key}
                  className="flex items-center gap-2 rounded-md border border-border px-2
                             py-1 text-xs"
                >
                  <span className="flex-1 truncate">{i.label}</span>
                  {i.essential && <Lock className="h-3 w-3 text-muted-foreground" />}
                  {isNew(i) && <NewFlag />}
                  <button
                    type="button"
                    aria-label={`Flag ${i.label} as new`}
                    onClick={() => flag.mutate({ itemKey: i.key, on: !isNew(i) })}
                    className="rounded-md border border-border px-1.5 py-0.5"
                  >
                    {isNew(i) ? "Not new" : "New"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Define a field, or change one.
 *
 * The label can change freely because the KEY cannot: answers point
 * at the key, so renaming "Deal Jacket #" to "Jacket #" does not
 * orphan a year of them. That is said on the form rather than left
 * for somebody to find out.
 */
function FieldEditor({
  page, field, onClose,
}: {
  page: PageInfo;
  field: CustomField | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(field?.label ?? "");
  const [input, setInput] = useState<CustomField["input"]>(field?.input ?? "text");
  const [options, setOptions] = useState((field?.options ?? []).join("\n"));
  const [note, setNote] = useState(field?.note ?? "");
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/template/fields", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: field?.key, page: page.key, label, input, note,
          options: options.split("\n").map((o) => o.trim()).filter(Boolean),
        }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "Could not save it.");
      return out;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dm-template-blocks"] });
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-2 rounded-lg border border-foreground/20 bg-muted/30 p-3">
      <p className="text-sm font-semibold">
        {field ? `Editing “${field.label}”` : "A new field"}
      </p>
      <p className="text-[11px] text-muted-foreground">
        Shared with every partner. What each one types into it is theirs, and stays theirs
        {field && " — renaming this changes the label everywhere and loses no answers"}.
      </p>
      {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}

      <label className="block text-xs font-medium">
        Label
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
      </label>
      <label className="block text-xs font-medium">
        Typed into as
        <select
          value={input}
          onChange={(e) => setInput(e.target.value as CustomField["input"])}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="text">A line of text</option>
          <option value="textarea">Several lines</option>
          <option value="number">A number</option>
          <option value="date">A date</option>
          <option value="select">One of a list</option>
          <option value="checkbox">Yes or no</option>
        </select>
      </label>
      {input === "select" && (
        <label className="block text-xs font-medium">
          The choices, one per line
          <textarea
            rows={4}
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1
                       text-sm"
          />
        </label>
      )}
      <label className="block text-xs font-medium">
        Help text
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="One line, under the field"
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
      </label>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={save.isPending || label.trim().length < 2}
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
      </div>
    </div>
  );
}
