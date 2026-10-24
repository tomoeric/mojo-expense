import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload } from "lucide-react";

type Status = "active" | "inactive" | "used";
type Row = {
  number: string; status: Status; addedAt: string; addedBy: string;
  batch: string; usedAt: string | null; usedBy: string | null; usedFor: string | null;
};
type Counts = { active: number; inactive: number; used: number; total: number };
type UploadResult = {
  added: number;
  duplicatesInFile: { number: string; copies: number }[];
  alreadyHeld: { number: string; status: Status }[];
  rejected: { raw: string; problem: string }[];
  cells: number;
  counts: Counts;
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

/** Upload RFID numbers, and review what is in the pool. */
export function DmRfidPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"all" | Status>("active");
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState("");
  const pick = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: ["dm-rfid", tab, search],
    queryFn: async () => {
      const q = new URLSearchParams({ status: tab, search, limit: "200" });
      const res = await fetch(`/api/dutch-miller/rfid?${q}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as { rows: Row[]; total: number; counts: Counts };
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
      if (!res.ok) throw new Error(body.error ?? "The upload failed.");
      return body as UploadResult;
    },
    onSuccess: (r) => { setResult(r); setError(""); void qc.invalidateQueries({ queryKey: ["dm-rfid"] }); },
    onError: (e) => { setError((e as Error).message); setResult(null); },
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

  const counts = list.data?.counts;
  const chips: { key: "all" | Status; label: string; n: number | undefined }[] = [
    { key: "active", label: "Active", n: counts?.active },
    { key: "used", label: "Used", n: counts?.used },
    { key: "inactive", label: "Held back", n: counts?.inactive },
    { key: "all", label: "All", n: counts?.total },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">RFID Review</h1>
        <p className="text-sm text-muted-foreground">
          Upload RFID numbers, and review which are available and which have been used.
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
          <p className="text-xs text-muted-foreground">
            Numbers are <code>nnnnn+nnnnnn</code>. Every cell is read, so no column needs naming.
            A number already in the pool is never added twice.
          </p>
        </div>

        {error && <p className="mt-3 text-sm font-semibold text-red-600">{error}</p>}

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
                lines={result.alreadyHeld.map((d) => `${d.number} · ${d.status}`)}
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

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Number</th>
              <th className="px-3 py-2 text-left font-semibold">Status</th>
              <th className="px-3 py-2 text-left font-semibold">Added</th>
              <th className="px-3 py-2 text-left font-semibold">Used</th>
              <th className="px-3 py-2 text-left font-semibold">Used for</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {list.data?.rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                Nothing here yet.
              </td></tr>
            )}
            {list.data?.rows.map((r) => (
              <tr key={r.number} className="border-t border-border">
                <td className="px-3 py-2 font-mono tabular-nums">{r.number}</td>
                <td className="px-3 py-2">
                  <span className={
                    r.status === "used" ? "text-muted-foreground"
                      : r.status === "active" ? "font-semibold text-emerald-700 dark:text-emerald-400"
                      : "text-amber-700 dark:text-amber-400"
                  }>
                    {r.status === "inactive" ? "held back" : r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{day(r.addedAt)}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {r.usedAt ? `${day(r.usedAt)}${r.usedBy ? ` · ${r.usedBy}` : ""}` : "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{r.usedFor ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  {/* A used number is never offered a way back into the pool —
                      the server refuses it, and a button that always fails is
                      worse than no button. */}
                  {r.status !== "used" && (
                    <button
                      type="button"
                      onClick={() => setActive.mutate({
                        numbers: [r.number], active: r.status !== "active",
                      })}
                      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                    >
                      {r.status === "active" ? "Hold back" : "Make active"}
                    </button>
                  )}
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
