import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, X,
} from "lucide-react";

type Column = { key: string; header: string; required: boolean; note: string };
type Row = { line: number; values: Record<string, string>; errors: Record<string, string> };
type Check = {
  ok: boolean;
  rows: Row[];
  fileErrors: string[];
  headers: string[];
  available: number;
  enoughTags: boolean;
};

/**
 * Bulk member signups from a spreadsheet.
 *
 * Three stages, and the file is refused outright between the first and
 * the second if anything is wrong with it. That is deliberate: every
 * accepted row spends an RFID tag permanently, so a partial import
 * leaves tags issued against members who are not there and no way to
 * tell which half landed except by reading both. Fix the file, upload
 * it again.
 *
 * The one real decision is the third stage: review each row before it
 * goes, or send them all. That choice lives in this component's state
 * and nowhere else, so it lasts exactly as long as the upload it was
 * made for — a "don't ask me again" that survived the dialog would
 * quietly turn every later import into a straight-through one.
 */
export function DmBulkDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const pick = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [showLayout, setShowLayout] = useState(false);

  /** null until asked, then the answer for this upload only. */
  const [reviewing, setReviewing] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [at, setAt] = useState(0);
  const [added, setAdded] = useState<{ line: number; name: string; rfid: string }[]>([]);
  const [failed, setFailed] = useState<{ line: number; name: string; why: string }[]>([]);
  const [finished, setFinished] = useState(false);

  const loadLayout = async () => {
    setShowLayout((v) => !v);
    if (columns.length > 0) return;
    const res = await fetch("/api/dutch-miller/signups/bulk/template");
    if (res.ok) setColumns(((await res.json()) as { columns: Column[] }).columns);
  };

  const downloadTemplate = async () => {
    const res = await fetch("/api/dutch-miller/signups/bulk/template");
    if (!res.ok) return;
    const { csv } = (await res.json()) as { csv: string };
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "member-signups-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError("");
    setCheck(null);
    setReviewing(null);
    setAt(0);
    setAdded([]);
    setFailed([]);
    setFinished(false);
    try {
      const res = await fetch("/api/dutch-miller/signups/bulk/check", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? "That file could not be read."); return; }
      setCheck(body as Check);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  /** Send one row and record what happened to it. */
  const commitOne = async (row: Row): Promise<boolean> => {
    const name = `${row.values.firstName} ${row.values.lastName}`.trim();
    try {
      const res = await fetch("/api/dutch-miller/signups/bulk/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ row: row.values }),
      });
      const body = await res.json();
      if (!res.ok) {
        setFailed((f) => [...f, {
          line: row.line, name,
          why: body.error ?? Object.values(body.errors ?? {}).join(" ") ?? "Refused.",
        }]);
        return false;
      }
      setAdded((a) => [...a, { line: row.line, name, rfid: body.row.customer.rfid }]);
      return true;
    } catch {
      setFailed((f) => [...f, { line: row.line, name, why: "The server could not be reached." }]);
      return false;
    }
  };

  const finish = async (reviewed: boolean) => {
    setFinished(true);
    void qc.invalidateQueries({ queryKey: ["dm-signups"] });
    void qc.invalidateQueries({ queryKey: ["dm-rfid"] });
    void qc.invalidateQueries({ queryKey: ["dm-rfid-options"] });
    await fetch("/api/dutch-miller/signups/bulk/done", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ added: added.length, failed: failed.length, reviewed }),
    }).catch(() => {});
  };

  /** Straight through: every remaining row, one request at a time. */
  const sendAll = async () => {
    if (!check) return;
    setBusy(true);
    for (let i = at; i < check.rows.length; i++) {
      setAt(i);
      await commitOne(check.rows[i]!);
    }
    setAt(check.rows.length);
    setBusy(false);
    await finish(false);
  };

  const sendOne = async () => {
    if (!check) return;
    setBusy(true);
    await commitOne(check.rows[at]!);
    const next = at + 1;
    setAt(next);
    setBusy(false);
    if (next >= check.rows.length) await finish(true);
  };

  const rows = check?.rows ?? [];
  const bad = rows.filter((r) => Object.keys(r.errors).length > 0);
  const current = rows[at];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Bulk upload members"
        className="w-full max-w-3xl rounded-xl border border-border bg-background shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <FileSpreadsheet className="h-4 w-4" />
              Bulk upload members
            </h2>
            <p className="text-sm text-muted-foreground">
              One row per member. Each gets the next available RFID when it is submitted.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { onDone(); onClose(); }}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Stage one: get a good file. */}
          {!finished && added.length === 0 && failed.length === 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={pick}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => pick.current?.click()}
                  className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background disabled:opacity-50"
                >
                  {busy
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Upload className="h-4 w-4" />}
                  {busy ? "Checking…" : "Choose CSV"}
                </button>
                <button
                  type="button"
                  onClick={() => void loadLayout()}
                  className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                >
                  {showLayout ? "Hide required layout" : "See required layout"}
                </button>
                <button
                  type="button"
                  onClick={() => void downloadTemplate()}
                  className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                >
                  <Download className="h-4 w-4" />
                  Download template
                </button>
              </div>

              {showLayout && (
                <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    The first line must be the headers below, in any order. Extra columns are
                    ignored. Do not include an RFID column — the pool assigns one per row.
                  </p>
                  <table className="mt-2 w-full text-xs">
                    <tbody>
                      {columns.map((c) => (
                        <tr key={c.key} className="border-t border-border">
                          <td className="py-1 pr-4 font-mono">{c.header}</td>
                          <td className="py-1 pr-3">
                            {c.required
                              ? <span className="font-semibold text-red-600">Required</span>
                              : <span className="text-muted-foreground">Optional</span>}
                          </td>
                          <td className="py-1 text-muted-foreground">{c.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm font-semibold text-red-600">{error}</p>}

          {/* Stage two: refused, with the reasons. */}
          {check && !check.ok && (
            <div className="space-y-2">
              <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong>Nothing was imported.</strong> Fix the file and upload it again —
                  a part-finished import would spend RFID tags on the rows that worked and
                  leave no way to tell which those were.
                </span>
              </p>
              {check.fileErrors.map((f) => (
                <p key={f} className="text-sm text-red-700 dark:text-red-400">{f}</p>
              ))}
              {bad.length > 0 && (
                <div className="max-h-60 overflow-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <tbody>
                      {bad.map((r) => (
                        <tr key={r.line} className="border-b border-border last:border-b-0">
                          <td className="w-16 px-3 py-1.5 align-top text-muted-foreground">
                            Row {r.line}
                          </td>
                          <td className="px-3 py-1.5">
                            {Object.entries(r.errors).map(([col, why]) => (
                              <span key={col} className="block">
                                <strong>{col}</strong> — {why}
                              </span>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Stage two, good file: how many, and are there tags for them. */}
          {check?.ok && !check.enoughTags && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                The file is fine, but there are only <strong>{check.available}</strong> active
                RFID numbers for <strong>{rows.length}</strong> members. Upload more under
                RFID Review first, or the run will stop when the pool empties.
              </span>
            </p>
          )}

          {check?.ok && reviewing === null && !asking && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <p className="flex-1 text-sm">
                <strong>{rows.length}</strong> member{rows.length === 1 ? "" : "s"} ready.
                Each will take the next available RFID.
              </p>
              <button
                type="button"
                onClick={() => setAsking(true)}
                className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white"
              >
                Submit
              </button>
            </div>
          )}

          {/* Stage three: the one real decision. */}
          {asking && reviewing === null && (
            <div className="space-y-2 rounded-lg border border-border bg-card p-4">
              <p className="text-sm font-semibold">How do you want to submit these?</p>
              <p className="text-xs text-muted-foreground">
                Each submission takes an RFID tag out of the pool for good. This choice
                applies to this upload only.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { setReviewing(true); setAsking(false); }}
                  className="rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background"
                >
                  Review each one
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReviewing(false);
                    setAsking(false);
                    void sendAll();
                  }}
                  className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                >
                  Submit all {rows.length} without reviewing
                </button>
              </div>
            </div>
          )}

          {/* Review mode: one at a time. */}
          {reviewing === true && !finished && current && (
            <div className="space-y-3 rounded-lg border border-border bg-card p-4">
              <p className="text-sm font-semibold">
                Row {current.line} · {at + 1} of {rows.length}
              </p>
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                {Object.entries(current.values)
                  .filter(([, v]) => v !== "")
                  .map(([k, v]) => (
                    <div key={k}>
                      <span className="block text-xs text-muted-foreground">{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendOne()}
                  className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Submit this one
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const next = at + 1;
                    setAt(next);
                    if (next >= rows.length) void finish(true);
                  }}
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  Skip
                </button>
                {/* Offered mid-run, because patience for this runs out
                    somewhere around the fourth identical row. */}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendAll()}
                  className="ml-auto rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  Submit the remaining {rows.length - at} without reviewing
                </button>
              </div>
            </div>
          )}

          {reviewing === false && !finished && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Submitting {at + 1} of {rows.length}…
            </p>
          )}

          {(added.length > 0 || failed.length > 0) && (
            <div className="space-y-2">
              {finished && (
                <p className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-800 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  {added.length} member{added.length === 1 ? "" : "s"} added
                  {failed.length > 0 ? `, ${failed.length} not` : ""}.
                </p>
              )}
              <details open={failed.length > 0} className="rounded-lg border border-border px-4 py-2">
                <summary className="cursor-pointer text-sm">
                  {added.length} added{failed.length > 0 ? ` · ${failed.length} failed` : ""}
                </summary>
                <ul className="mt-2 max-h-52 space-y-0.5 overflow-auto text-xs">
                  {added.map((a) => (
                    <li key={`a${a.line}`} className="text-muted-foreground">
                      Row {a.line} · {a.name} · {a.rfid}
                    </li>
                  ))}
                  {failed.map((f) => (
                    <li key={`f${f.line}`} className="text-red-600">
                      Row {f.line} · {f.name} — {f.why}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={() => { onDone(); onClose(); }}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {finished ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
