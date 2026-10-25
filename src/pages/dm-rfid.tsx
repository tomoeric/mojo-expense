import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Loader2, Trash2, Upload, X } from "lucide-react";

type Status = "active" | "inactive" | "used";
/** The views. `deleted` is its own: every other one hides deleted numbers. */
type Tab = "all" | Status | "deleted";
type Row = {
  number: string; status: Status; addedAt: string; addedBy: string;
  batch: string; usedAt: string | null; usedBy: string | null; usedFor: string | null;
  deletedAt: string | null; deletedBy: string | null; deleteNote: string | null;
};
type Counts = {
  active: number; inactive: number; used: number; deleted: number; total: number;
};
type Refusal = {
  refused: true;
  error: string;
  rejected: { raw: string; problem: string }[];
  cells: number;
  readable: number;
};
type UploadResult = {
  added: number;
  duplicatesInFile: { number: string; copies: number }[];
  alreadyHeld: { number: string; status: Status; deleted: boolean }[];
  rejected: { raw: string; problem: string }[];
  cells: number;
  counts: Counts;
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

/**
 * The words people use, over the values the database stores.
 *
 * `active`/`used` are what every role, guard and query names, so they
 * stay. What a person holding a sheet of stickers means is available
 * and assigned.
 */
const STATUS_LABEL: Record<Status, string> = {
  active: "available", inactive: "held back", used: "assigned",
};

const STATUS_NOTE: Record<Status, string> = {
  active: "In the pool. The next member signed up can be given this one.",
  inactive: "Still unused, deliberately kept out of the pool. Can be made "
    + "available again at any time.",
  used: "Issued to a member. Permanent — a tag is a physical sticker, and a "
    + "number handed out twice would end up on two vehicles.",
};

/**
 * The member a tag was issued to, if any.
 *
 * Read out of `used_for`, which the signup writes as "Member signup
 * <guid>". A free-text column being parsed is not lovely, but the
 * alternative is a foreign key on a column that also records tags
 * issued by hand for reasons that are not signups at all.
 */
const MEMBER_REF = /^Member signup ([0-9a-f-]{36})$/i;
const memberOf = (r: Row): string | null => MEMBER_REF.exec(r.usedFor ?? "")?.[1] ?? null;
const memberLink = (r: Row): string => `/member-signups/review?open=${memberOf(r)}`;

/** Upload RFID numbers, and review what is in the pool. */
export function DmRfidPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("active");
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [error, setError] = useState("");
  const [showFormat, setShowFormat] = useState(false);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const pick = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: ["dm-rfid", tab, search],
    queryFn: async () => {
      const q = new URLSearchParams({ status: tab, search, limit: "200" });
      const res = await fetch(`/api/dutch-miller/rfid?${q}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        rows: Row[]; total: number; counts: Counts; canDelete: boolean;
      };
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const res = await fetch("/api/dutch-miller/rfid/upload", {
        method: "POST",
        headers: { "content-type": file.name.toLowerCase().endsWith(".csv")
          ? "text/csv"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) {
        // A refusal is an answer, not a failure: it carries which
        // numbers could not be read so the page can name them.
        if (body.refused) {
          const err = new Error(body.error) as Error & { refusal?: Refusal };
          err.refusal = body as Refusal;
          throw err;
        }
        throw new Error(body.error ?? "The upload failed.");
      }
      return body as UploadResult;
    },
    onSuccess: (r) => {
      setResult(r);
      setRefused(null);
      setError("");
      void qc.invalidateQueries({ queryKey: ["dm-rfid"] });
    },
    onError: (e) => {
      const err = e as Error & { refusal?: Refusal };
      setResult(null);
      setRefused(err.refusal ?? null);
      setError(err.refusal ? "" : err.message);
    },
  });

  const setActive = useMutation({
    mutationFn: async (v: { numbers: string[]; active: boolean }) => {
      const res = await fetch("/api/dutch-miller/rfid/active", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not change it.");
      return res.json();
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["dm-rfid"] }),
    onError: (e) => setError((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: async (v: { numbers: string[]; note: string }) => {
      const res = await fetch("/api/dutch-miller/rfid/delete", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(v),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not remove it.");
      return body as { deleted: number };
    },
    onSuccess: () => {
      setDeleting(null);
      setError("");
      void qc.invalidateQueries({ queryKey: ["dm-rfid"] });
      void qc.invalidateQueries({ queryKey: ["dm-signups"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const counts = list.data?.counts;
  const canDelete = list.data?.canDelete ?? false;
  // "Available" and "Assigned" are what the states actually mean to
  // somebody holding a sheet of stickers. The stored values stay
  // `active` and `used` — every role, guard and query names them.
  const chips: { key: Tab; label: string; n: number | undefined }[] = [
    { key: "active", label: "Available", n: counts?.active },
    { key: "used", label: "Assigned", n: counts?.used },
    { key: "inactive", label: "Held back", n: counts?.inactive },
    { key: "all", label: "All", n: counts?.total },
  ];
  // Shown once there is something in it, or to the one person who can
  // put something in it. Nobody else needs a permanently empty filter.
  if (canDelete || (counts?.deleted ?? 0) > 0) {
    chips.push({ key: "deleted", label: "Deleted", n: counts?.deleted });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">RFID Inventory</h1>
        <p className="text-sm text-muted-foreground">
          Every tag the pool has ever held — available, assigned, held back and removed.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={pick}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => pick.current?.click()}
            disabled={upload.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background disabled:opacity-50"
          >
            {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {upload.isPending ? "Reading…" : "Upload CSV or Excel"}
          </button>
          <button
            type="button"
            onClick={() => setShowFormat((v) => !v)}
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          >
            {showFormat ? "Hide required format" : "See required format"}
          </button>
          <p className="text-xs text-muted-foreground">
            Numbers are <code>nnnnn+nnnnnn</code>. Every cell is read, so no column needs naming.
          </p>
        </div>

        {showFormat && <FormatHelp />}

        {error && <p className="mt-3 text-sm font-semibold text-red-600">{error}</p>}

        {/* All or nothing, as with the member upload: a pool half-loaded
            from a file somebody has since corrected leaves nobody able
            to say which numbers are in it. */}
        {refused && (
          <div className="mt-3 space-y-2">
            <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <strong>{refused.error}</strong> Fix the file and upload it again — a pool
                half-loaded from a file that is being corrected leaves nobody able to say
                which numbers are in it.
              </span>
            </p>
            {refused.rejected.length > 0 && (
              <div className="max-h-56 overflow-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <tbody>
                    {refused.rejected.map((r, i) => (
                      <tr key={`${r.raw}-${i}`} className="border-b border-border last:border-b-0">
                        <td className="px-3 py-1.5 font-mono">{r.raw || "(blank)"}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{r.problem}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {refused.readable} of {refused.cells.toLocaleString()} cells read as numbers.
              Nothing was added to the pool.
            </p>
          </div>
        )}

        {result && (
          <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
            <p>
              <strong className="tabular-nums">{result.added.toLocaleString()}</strong> added
              <span className="text-muted-foreground"> · {result.cells.toLocaleString()} cells read</span>
            </p>
            {result.duplicatesInFile.length > 0 && (
              <Detail
                title={`${result.duplicatesInFile.length} repeated inside the file — kept once each`}
                lines={result.duplicatesInFile.map((d) => `${d.number} · ${d.copies} copies`)}
              />
            )}
            {result.alreadyHeld.length > 0 && (
              <Detail
                title={`${result.alreadyHeld.length} already in the pool — not added again`}
                lines={result.alreadyHeld.map((d) =>
                  `${d.number} · ${d.deleted ? "removed from the pool — not restored" : d.status}`)}
              />
            )}
            {result.rejected.length > 0 && (
              <Detail
                title={`${result.rejected.length} could not be read`}
                lines={result.rejected.map((d) => `${d.raw} — ${d.problem}`)}
              />
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setTab(c.key)}
            className={`rounded-full border px-3 py-1 text-xs ${
              tab === c.key ? "border-foreground font-semibold" : "border-border text-muted-foreground"
            }`}
          >
            {c.label}{c.n === undefined ? "" : ` ${c.n.toLocaleString()}`}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search a number…"
          className="ml-auto w-56 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
      </div>

      {/* What each view means, where somebody choosing between them
          will read it. "Held back" and "Deleted" are the two people
          get wrong, and they differ in exactly one way that matters:
          one is reversible and one is not. */}
      <p className="text-xs text-muted-foreground">
        {tab === "active" && STATUS_NOTE.active}
        {tab === "used" && STATUS_NOTE.used}
        {tab === "inactive" && STATUS_NOTE.inactive}
        {tab === "deleted" && (
          "Removed from the pool for good, with the reason attached. The row stays "
          + "so the number can still be accounted for. Not reversible here, and "
          + "re-uploading a file containing it will not bring it back."
        )}
        {tab === "all" && (
          "Every tag the pool holds. Held back is reversible; deleted is not. "
          + "Deleting a MEMBER does not free their tag unless whoever deleted the "
          + "record explicitly released it — a sticker already on a windshield must "
          + "never be handed out again."
        )}
      </p>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Number</th>
              <th className="px-3 py-2 text-left font-semibold">Status</th>
              <th className="px-3 py-2 text-left font-semibold">Added</th>
              <th className="px-3 py-2 text-left font-semibold">Added by</th>
              <th className="px-3 py-2 text-left font-semibold">Used</th>
              <th className="px-3 py-2 text-left font-semibold">Used by</th>
              <th className="px-3 py-2 text-left font-semibold">Used for</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {list.data?.rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                Nothing here yet.
              </td></tr>
            )}
            {list.data?.rows.map((r) => (
              <tr
                key={r.number}
                onClick={() => { if (memberOf(r)) window.location.hash = memberLink(r); }}
                className={`border-t border-border ${
                  memberOf(r) ? "cursor-pointer hover:bg-muted/40" : ""
                }`}
                title={memberOf(r) ? "Open the member this tag was issued to" : undefined}
              >
                <td className="px-3 py-2 font-mono tabular-nums">
                  <span className={r.deletedAt ? "line-through text-muted-foreground" : ""}>
                    {r.number}
                  </span>
                  {/* The reason, next to the number rather than behind a
                      hover: it is the only thing this row is still for. */}
                  {r.deletedAt && (
                    <span className="mt-0.5 block font-sans text-xs text-rose-700 dark:text-rose-400">
                      Removed {day(r.deletedAt)}{r.deletedBy ? ` by ${r.deletedBy}` : ""}
                      {r.deleteNote ? ` — ${r.deleteNote}` : ""}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {r.deletedAt ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:text-rose-400">
                      <Trash2 className="h-3 w-3" />
                      deleted
                    </span>
                  ) : (
                    <span
                      title={STATUS_NOTE[r.status]}
                      className={
                        r.status === "used" ? "text-muted-foreground"
                          : r.status === "active" ? "font-semibold text-emerald-700 dark:text-emerald-400"
                            : "text-amber-700 dark:text-amber-400"
                      }
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{day(r.addedAt)}</td>
                {/* Which upload it arrived on, for tracing a bad file back
                    to the person and the batch that brought it in. */}
                <td
                  className="max-w-40 truncate px-3 py-2 text-muted-foreground"
                  title={r.batch ? `${r.addedBy || "—"} · batch ${r.batch}` : r.addedBy}
                >
                  {r.addedBy || "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{day(r.usedAt)}</td>
                <td className="max-w-40 truncate px-3 py-2 text-muted-foreground" title={r.usedBy ?? ""}>
                  {r.usedBy || "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {memberOf(r)
                    ? <span className="text-sky-600 hover:underline">Member signup</span>
                    : (r.usedFor ?? "—")}
                </td>
                <td className="px-3 py-2 text-right">
                  <span className="inline-flex items-center justify-end gap-1.5">
                    {/* A used number is never offered a way back into the pool —
                        the server refuses it, and a button that always fails is
                        worse than no button. */}
                    {r.status !== "used" && !r.deletedAt && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setActive.mutate({
                          numbers: [r.number], active: r.status !== "active",
                        }); }}
                        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                      >
                        {r.status === "active" ? "Hold back" : "Make active"}
                      </button>
                    )}
                    {canDelete && !r.deletedAt && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDeleting(r); }}
                        aria-label={`Delete ${r.number}`}
                        title="Remove this number from the pool"
                        className="rounded-md border border-rose-500/40 p-1 text-rose-700 hover:bg-rose-500/10 dark:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.data && list.data.total > list.data.rows.length && (
        <p className="text-xs text-muted-foreground">
          Showing {list.data.rows.length.toLocaleString()} of {list.data.total.toLocaleString()}.
          Narrow it with the search box.
        </p>
      )}

      {deleting && (
        <DeleteRfid
          row={deleting}
          busy={remove.isPending}
          error={remove.isError ? (remove.error as Error).message : ""}
          onCancel={() => setDeleting(null)}
          onConfirm={(note) => remove.mutate({ numbers: [deleting.number], note })}
        />
      )}
    </div>
  );
}

/**
 * Removing a number from the pool.
 *
 * The note is required for the same reason it is on a member record:
 * a tag that simply stopped existing leaves nobody able to say whether
 * it was a bad batch, a damaged sticker or a mistake in a file. The
 * number does NOT come free — it leaves the pool rather than returning
 * to it, so a tag that may be on a windscreen can never be issued
 * again.
 */
function DeleteRfid({
  row, busy, error, onCancel, onConfirm,
}: {
  row: Row;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const short = note.trim().length < 5;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Delete RFID number"
        className="w-full max-w-lg space-y-4 rounded-xl border border-border bg-background p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">Remove RFID from the pool</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong className="font-mono">{row.number}</strong> stays in the list,
            marked removed, with your note attached. It cannot be issued, and
            re-uploading a file containing it will not bring it back.
            {row.status === "used" && (
              <span className="mt-1 block">
                This number has already been issued. Removing it does not undo that.
              </span>
            )}
          </span>
        </p>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">
            Why is this number being removed? <span className="text-rose-600">Required</span>
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Damaged in the batch delivered 14 October — stickers would not adhere."
            className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
          />
        </label>

        {error && <p className="text-sm font-semibold text-red-600">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || short}
            onClick={() => onConfirm(note.trim())}
            className="inline-flex items-center gap-2 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Remove number
          </button>
        </div>
      </div>
    </div>
  );
}

/** What the file has to look like, without leaving the page to find out. */
function FormatHelp() {
  const q = useQuery({
    queryKey: ["dm-rfid-format"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/rfid/format");
      if (!res.ok) throw new Error("Could not load.");
      return (await res.json()) as { pattern: string; rules: string[]; csv: string };
    },
  });

  const download = () => {
    if (!q.data) return;
    const url = URL.createObjectURL(
      new Blob([`\ufeff${q.data.csv}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "rfid-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
      <p className="text-sm font-semibold">
        Required format — <code>{q.data?.pattern ?? "nnnnn+nnnnnn"}</code>
      </p>
      <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
        {(q.data?.rules ?? []).map((r) => <li key={r}>• {r}</li>)}
      </ul>
      <button
        type="button"
        onClick={download}
        className="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
      >
        <Download className="h-3.5 w-3.5" />
        Download template
      </button>
    </div>
  );
}

/** A count that can be opened, so a long list does not bury the summary. */
function Detail({ title, lines }: { title: string; lines: string[] }) {
  return (
    <details className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <summary className="cursor-pointer text-sm">{title}</summary>
      <ul className="mt-2 max-h-60 space-y-0.5 overflow-auto font-mono text-xs text-muted-foreground">
        {lines.map((l) => <li key={l}>{l}</li>)}
      </ul>
    </details>
  );
}
