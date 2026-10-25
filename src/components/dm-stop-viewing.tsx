import { useState } from "react";
import { Eye, Loader2 } from "lucide-react";

/**
 * The way back out of viewing as somebody.
 *
 * There is deliberately no picker beside it. A view is STARTED from the
 * eye icon on a person's row in Users, because "view as" is a question
 * about one person and the row already says who they are, what role they
 * hold and how many pages they can see — a second list in the header was
 * the same list, worse, next to the account menu where it read as part
 * of the signed-in identity.
 *
 * Ending one is different, and has to be here: once the view is on, the
 * whole app below is the other person's, Users included, so the exit
 * cannot live inside it.
 */
export function DmStopViewing({
  viewingAs,
}: {
  viewingAs: { real: string; viewed: string } | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!viewingAs) return null;

  const stop = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/view-as", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not change the view.");
      }
      // A full reload: every cached query was answered for the other
      // person, and leaving them in place is how a view half-ends.
      window.location.href = "/";
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void stop()}
      title={error || `Go back to ${viewingAs.real}`}
      className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-3 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
      Stop viewing
    </button>
  );
}
