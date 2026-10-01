import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Tag } from "lucide-react";
import { correctCategory } from "@/lib/decisions";
import { useTaxonomy } from "@/lib/taxonomy";

/**
 * Put the right category on an expense, in Emburse.
 *
 * A fuel purchase at an Exxon filed under Travel · Mileage & Ground
 * Transportation is not a thing to deny: the spend is fine and the coding is
 * wrong, and denying it sends an employee a message about a mistake that is
 * not theirs to fix. Until now the only honest options were deny it or go
 * and fix it in Emburse by hand, which is the errand this app exists to
 * save.
 *
 * The categories offered are the ones this tenant actually uses, gathered
 * from every import — not a list typed in here, which would drift from
 * Emburse's the first time somebody added one.
 */
export function FixCategory({
  target, current, onDone,
}: {
  target: { employee: string; merchant: string; amount: number; date: string | null };
  current: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const qc = useQueryClient();
  const categories = useTaxonomy("category");

  const choices = (categories.data?.entries ?? [])
    .map((e) => e.name)
    .filter((n: string) => n && n.toLowerCase() !== current.toLowerCase());

  async function run(): Promise<void> {
    if (!picked) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await correctCategory(target, picked);
      setNote({ ok: r.ok, text: r.detail || (r.ok ? "Changed in Emburse." : "It did not go through.") });
      if (r.ok) {
        // The category is on the expense, the flag is about the category,
        // and the next import carries the new one — so everything on screen
        // is a sentence or two out of date.
        await qc.invalidateQueries();
        onDone();
      }
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Change this expense's category in Emburse. Signs in as you; takes about a minute."
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
        {busy ? "Changing in Emburse…" : "Send to Emburse"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => { setOpen(false); setNote(null); }}
        className="rounded-lg border border-border px-2 py-1 font-semibold hover:bg-muted disabled:opacity-50"
      >
        Cancel
      </button>
      {busy && (
        <span className="text-muted-foreground">
          Signing in as you and editing the row — about a minute, and it queues behind any import.
        </span>
      )}
      {note && (
        <span className={`block w-full ${note.ok ? "text-emerald-700" : "text-amber-700"}`}>
          {note.text}
        </span>
      )}
    </span>
  );
}
