import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Download, Loader2, Tag } from "lucide-react";
import { correctCategory, type Correction } from "@/lib/decisions";
import { useTaxonomy } from "@/lib/taxonomy";

/**
 * Put the right category on an expense, in Emburse.
 *
 * A fuel purchase at an Exxon filed under Travel · Mileage & Ground
 * Transportation is not a thing to deny: the spend is fine and the coding is
 * wrong, and denying it sends an employee a message about a mistake that is
 * not theirs to fix.
 *
 * The press writes a record and returns. The run — sign in, find the row,
 * edit, save, check — takes about a minute and happens in the worker that
 * already holds the browser, so closing this panel no longer throws away the
 * only thing that knew the answer. What is on screen afterwards comes from
 * that record, on the same poll as everything else.
 */
export function FixCategory({
  dedupeKey, current, correction,
}: {
  dedupeKey: string;
  current: string;
  /** What is already happening to this expense's category, if anything. */
  correction: Correction | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const qc = useQueryClient();
  const categories = useTaxonomy("category");

  const choices = (categories.data?.entries ?? [])
    .map((e) => e.name)
    .filter((n: string) => n && n.toLowerCase() !== current.toLowerCase());

  async function run(): Promise<void> {
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      await correctCategory({ dedupeKey, from: current, category: picked });
      setOpen(false);
      // The row has to show the new category from this moment, not from the
      // next import, and the poll is what carries it.
      await qc.invalidateQueries({ queryKey: ["decisions"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Something is already happening to this expense: say what, and offer
  // nothing else until it is finished.
  if (correction && correction.state === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Changing to “{correction.to}” in Emburse — about a minute
      </span>
    );
  }

  if (correction && correction.state === "failed") {
    return <CorrectionFailed correction={correction} onRetry={() => setOpen(true)} />;
  }

  if (correction && correction.state === "applied") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
        <Check className="h-3.5 w-3.5" />
        Category changed to “{correction.to}” in Emburse
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Change this expense's category in Emburse. Signs in as you; takes about a minute, and carries on if you close this."
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted"
      >
        <Tag className="h-3.5 w-3.5" />
        Fix category
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      <select
        value={picked}
        disabled={busy}
        onChange={(e) => setPicked(e.target.value)}
        className="max-w-64 rounded-lg border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-sky-500 disabled:opacity-50"
      >
        <option value="">Change “{current || "no category"}” to…</option>
        {choices.map((c: string) => <option key={c} value={c}>{c}</option>)}
      </select>
      <button
        type="button"
        disabled={busy || !picked}
        onClick={() => void run()}
        className="inline-flex items-center gap-1.5 rounded-lg bg-sky-700 px-2.5 py-1 font-semibold text-white disabled:opacity-50"
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Send to Emburse
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => { setOpen(false); setError(""); }}
        className="rounded-lg border border-border px-2 py-1 font-semibold hover:bg-muted disabled:opacity-50"
      >
        Cancel
      </button>
      <span className="w-full text-muted-foreground">
        It goes to Emburse under your own login and takes about a minute. You can close this —
        the row will show how it went.
      </span>
      {error && <span className="block w-full text-amber-700">{error}</span>}
    </span>
  );
}

/**
 * A correction that did not land.
 *
 * Says what was asked for, what Emburse said back, and offers the file.
 * Almost every failure here is a control on Emburse's edit form that no
 * longer matches its stored selector, and the error usually names what IS
 * on the form — which is the thing somebody needs in order to fix it, and
 * is useless if it only exists on a screen nobody has open any more.
 */
function CorrectionFailed({
  correction, onRetry,
}: {
  correction: Correction;
  onRetry: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <span className="block w-full rounded-lg border border-amber-500/50 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-900 dark:text-amber-200">
      <span className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <strong>
          The change to “{correction.to}” did not reach Emburse.
        </strong>
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="underline underline-offset-2 hover:no-underline"
        >
          {show ? "Hide what it said" : "What did it say?"}
        </button>
        <a
          href="/api/corrections/report.md"
          download="category-corrections.md"
          className="inline-flex items-center gap-1 rounded-lg border border-amber-600/50 px-2 py-0.5 font-semibold hover:bg-amber-500/15"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-amber-600/50 px-2 py-0.5 font-semibold hover:bg-amber-500/15"
        >
          Try again
        </button>
      </span>
      {show && (
        <span className="mt-1.5 block rounded-lg border border-amber-600/30 bg-background/60 p-2 font-mono text-[11px] break-words">
          {correction.error ?? "Nothing was recorded, which is itself worth reporting."}
        </span>
      )}
      <span className="mt-1 block opacity-80">
        Nothing in Emburse was changed. The file above has the whole run, step by step — it
        usually names the control that could not be found, which is what the selector in
        Export settings should be set to.
      </span>
    </span>
  );
}
