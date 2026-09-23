import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import type { ViewingAs } from "@/lib/api";

/**
 * Looking at the app as somebody else, to work out why it is not working
 * for them.
 *
 * Read-only, and the banner says so plainly. A decision carries the decider's
 * name into Emburse, so an admin clicking Approve while wearing somebody
 * else's face would put their name on a financial approval they did not make —
 * the server refuses every write while this is on, and the banner exists so
 * nobody is surprised by that refusal.
 *
 * It cannot see anybody's password. Those are sealed in the database and only
 * ever opened server-side by the worker; impersonation changes what is
 * displayed and nothing else.
 */
export function ViewAsBanner({ viewingAs }: { viewingAs: ViewingAs }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const stop = async () => {
    setBusy(true);
    await fetch("/api/view-as", { method: "DELETE" }).catch(() => {});
    await qc.invalidateQueries();
    setBusy(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 bg-amber-500 px-5 py-2 text-sm text-amber-950">
      <Eye className="h-4 w-4 shrink-0" />
      <span>
        Viewing as <strong>{viewingAs.as}</strong> — read-only. Nothing you click here can approve or
        deny; you are really {viewingAs.real}.
      </span>
      <button
        type="button"
        onClick={stop}
        disabled={busy}
        className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-amber-950/10 px-2.5 py-1 text-xs font-semibold hover:bg-amber-950/20 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <EyeOff className="h-3.5 w-3.5" />}
        Stop
      </button>
    </div>
  );
}

/** The picker, for the user menu. */
export function ViewAsPicker({ people }: { people: string[] }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = async (email: string) => {
    setBusy(true);
    setError("");
    const res = await fetch("/api/view-as", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not switch.");
      setBusy(false);
      return;
    }
    await qc.invalidateQueries();
    setBusy(false);
  };

  if (people.length === 0) return null;

  return (
    <div className="border-t border-border px-3 py-2">
      <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">View as</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        See what they see. Read-only — you cannot decide as them.
      </p>
      <div className="mt-1.5 space-y-0.5">
        {people.map((email) => (
          <button
            key={email}
            type="button"
            disabled={busy}
            onClick={() => void start(email)}
            className="block w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-muted disabled:opacity-50"
          >
            {email}
          </button>
        ))}
      </div>
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
