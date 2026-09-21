import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, Loader2, CheckCircle2, AlertTriangle, Database, FolderSync } from "lucide-react";
import { money, timeOfDay } from "@/lib/format";
import { StatChip, StatChipRow, Empty } from "@/components/ui";

type ImportResult = {
  filename: string;
  parsedRows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  leftInbox: number;
  receiptsAdded: number;
  totalCents: number;
  statedTotalCents: number | null;
  reconciled: boolean;
  duplicateFile: boolean;
  warnings: string[];
};

type HistoryRow = {
  id: number;
  filename: string;
  imported_at: string;
  imported_by: string | null;
  parsed_rows: number | null;
  inserted_count: number | null;
  updated_count: number | null;
  left_inbox_count: number | null;
  receipts_added: number | null;
  total_cents: string | null;
  reconciled: boolean | null;
};

type Stats = {
  expenses: string;
  in_inbox: string;
  total_cents: string;
  earliest: string | null;
  latest: string | null;
  receipts: string;
  receipt_bytes: string;
};

/** Upload the daily Emburse export and see what each import changed. */
export function ImportPage() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [syncNote, setSyncNote] = useState("");
  const qc = useQueryClient();

  const history = useQuery({
    queryKey: ["imports"],
    queryFn: async () => {
      const res = await fetch("/api/imports");
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      return (await res.json()) as {
        imports: HistoryRow[];
        stats: Stats | null;
        sharepoint: boolean;
        sources: { filename: string; status: string; imported_at: string; error: string | null }[];
      };
    },
  });

  async function upload(file: File) {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch(`/api/import?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: file,
      });
      const body = (await res.json()) as ImportResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Import failed (${res.status})`);
      setResult(body);
      // The expense views are now stale.
      void qc.invalidateQueries({ queryKey: ["reports"] });
      void history.refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const stats = history.data?.stats;

  async function sync() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/import/sync", { method: "POST" });
      const body = (await res.json()) as {
        checked: number; skipped: number;
        imported: { name: string; inserted: number; updated: number; receipts: number }[];
        failed: { name: string; error: string }[];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `Sync failed (${res.status})`);
      setSyncNote(
        body.imported.length === 0
          ? `Checked ${body.checked} files in SharePoint — nothing new.`
          : `Imported ${body.imported.length}: ` +
            body.imported.map((i) => `${i.name} (+${i.inserted} new, ${i.receipts} receipts)`).join(", "),
      );
      if (body.failed.length) setError(body.failed.map((f) => `${f.name}: ${f.error}`).join(" · "));
      void qc.invalidateQueries({ queryKey: ["reports"] });
      void history.refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {stats && Number(stats.expenses) > 0 && (
        <StatChipRow>
          <StatChip value={Number(stats.expenses).toLocaleString()} label="expenses stored" />
          <StatChip value={Number(stats.in_inbox).toLocaleString()} label="awaiting review" tone="amber" />
          <StatChip value={money(Number(stats.total_cents) / 100)} label="total" />
          <StatChip value={Number(stats.receipts).toLocaleString()} label="receipts" tone="emerald" />
          <StatChip value={`${(Number(stats.receipt_bytes) / 1e6).toFixed(1)} MB`} label="receipt storage" tone="slate" />
        </StatChipRow>
      )}

      <section className="rounded-xl border border-dashed border-border p-6 text-center">
        <Database className="mx-auto h-6 w-6 text-muted-foreground" />
        <h2 className="mt-2 text-sm font-bold">Upload the daily Emburse export</h2>
        <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
          The Expenses PDF from Emburse Spend. Re-uploading a file you have already imported changes
          nothing, and expenses that have left the Emburse inbox are kept rather than deleted.
        </p>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {busy ? "Working…" : "Choose PDF"}
          </button>
          {history.data?.sharepoint && (
            <button
              type="button"
              onClick={() => void sync()}
              disabled={busy}
              title="Pull any new exports from the watched SharePoint folder"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold transition-colors hover:bg-muted disabled:opacity-60"
            >
              <FolderSync className="h-4 w-4" />
              Sync SharePoint
            </button>
          )}
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p className="font-semibold">Import failed</p>
          <p className="mt-1">{error}</p>
        </div>
      )}

      {syncNote && (
        <div className="rounded-xl border border-border bg-muted px-4 py-3 text-sm">{syncNote}</div>
      )}

      {result && <ImportSummary result={result} />}

      {history.data?.sources && history.data.sources.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-bold tracking-wide text-muted-foreground uppercase">
            Watched SharePoint folder
          </h2>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {history.data.sources.map((s) => (
              <li key={s.filename + s.imported_at} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{s.filename}</span>
                <span className="flex shrink-0 items-center gap-3">
                  {s.error && <span className="max-w-72 truncate text-xs text-red-600">{s.error}</span>}
                  <span className={`text-xs font-semibold ${s.status === "failed" ? "text-red-600" : "text-muted-foreground"}`}>
                    {s.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xs font-bold tracking-wide text-muted-foreground uppercase">Recent imports</h2>
        {history.data?.imports.length ? (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">File</th>
                  <th className="px-3 py-2 text-right font-semibold">Rows</th>
                  <th className="px-3 py-2 text-right font-semibold">New</th>
                  <th className="px-3 py-2 text-right font-semibold">Updated</th>
                  <th className="px-3 py-2 text-right font-semibold">Left inbox</th>
                  <th className="px-3 py-2 text-right font-semibold">Receipts</th>
                  <th className="px-3 py-2 text-right font-semibold">Total</th>
                  <th className="px-3 py-2 font-semibold">Check</th>
                </tr>
              </thead>
              <tbody>
                {history.data.imports.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {new Date(r.imported_at).toLocaleDateString()} {timeOfDay(r.imported_at)}
                    </td>
                    <td className="max-w-48 truncate px-3 py-2">{r.filename}</td>
                    <td className="tnum px-3 py-2 text-right">{r.parsed_rows ?? "—"}</td>
                    <td className="tnum px-3 py-2 text-right font-semibold">{r.inserted_count ?? 0}</td>
                    <td className="tnum px-3 py-2 text-right">{r.updated_count ?? 0}</td>
                    <td className="tnum px-3 py-2 text-right">{r.left_inbox_count ?? 0}</td>
                    <td className="tnum px-3 py-2 text-right">{r.receipts_added ?? 0}</td>
                    <td className="tnum px-3 py-2 text-right">{money(Number(r.total_cents ?? 0) / 100)}</td>
                    <td className="px-3 py-2">
                      {r.reconciled ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5" /> balanced
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
                          <AlertTriangle className="h-3.5 w-3.5" /> check
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {history.isError
              ? (history.error as Error).message
              : "Nothing imported yet. Upload an export to get started."}
          </Empty>
        )}
      </section>
    </div>
  );
}

function ImportSummary({ result }: { result: ImportResult }) {
  const ok = result.reconciled && !result.duplicateFile;
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        result.duplicateFile
          ? "border-blue-200 bg-blue-50"
          : ok
            ? "border-emerald-200 bg-emerald-50"
            : "border-amber-300 bg-amber-50"
      }`}
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
        {result.duplicateFile
          ? "Already imported — nothing changed"
          : `${result.filename}: ${result.parsedRows} rows read`}
      </p>
      {!result.duplicateFile && (
        <div className="mt-2 flex flex-wrap gap-4 text-sm">
          <Fact label="new" value={result.inserted} />
          <Fact label="updated" value={result.updated} />
          <Fact label="unchanged" value={result.unchanged} />
          <Fact label="left inbox" value={result.leftInbox} />
          <Fact label="receipts added" value={result.receiptsAdded} />
          <Fact label="total" value={money(result.totalCents / 100)} />
        </div>
      )}
      {/* Reconciliation against the figure printed on the export is the single
          best signal that the parse was complete. */}
      {!result.duplicateFile && (
        <p className="mt-2 text-xs text-muted-foreground">
          {result.reconciled
            ? `Total matches the ${money((result.statedTotalCents ?? 0) / 100)} printed on the export.`
            : "Could not reconcile against the export's own total — see the warnings below."}
        </p>
      )}
      {result.warnings.map((w, i) => (
        <p key={i} className="mt-1.5 text-xs text-amber-800">
          {w}
        </p>
      ))}
    </div>
  );
}

const Fact = ({ label, value }: { label: string; value: number | string }) => (
  <span className="tnum">
    <strong>{value}</strong> <span className="text-muted-foreground">{label}</span>
  </span>
);
