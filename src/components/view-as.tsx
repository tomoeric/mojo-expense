import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2 } from "lucide-react";

type Person = {
  email: string;
  loginEmail: string;
  lastOkAt: string | null;
  needsReentry: boolean;
  lastError: string | null;
};

/**
 * Look at the app as one of the people the automation acts for.
 *
 * Half of what this app shows depends on who is asking: whether an Emburse
 * login is stored and so whether anything can be decided, which failures are
 * yours, what the automation did while you were away, which admin controls
 * exist at all. Asking somebody down a phone line what their screen says is
 * a poor way to find out why their imports are not landing.
 *
 * Read-only, and the server enforces that rather than this component: every
 * request that is not a GET is refused while the mode is on. That is not
 * caution for its own sake — an approval reaches Emburse under the decider's
 * own login and carries their name in the finance system permanently, so a
 * view that could write would be a way to act as another person.
 */
export function ViewAs({
  isAdmin, viewingAs,
}: {
  isAdmin: boolean;
  viewingAs: { real: string; viewed: string } | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const people = useQuery<{ people: Person[] }>({
    queryKey: ["view-as-people"],
    queryFn: async () => {
      const res = await fetch("/api/auth/view-as/people");
      if (!res.ok) return { people: [] };
      return (await res.json()) as { people: Person[] };
    },
    enabled: open && isAdmin,
    staleTime: 60_000,
  });

  async function swap(email: string | null): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/view-as", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not change the view.");
      }
      setOpen(false);
      /*
       * Reload the page, rather than re-fetching into the app that is
       * already running.
       *
       * Two goes at the clever version, both wrong. `invalidateQueries`
       * refetches while STILL SERVING what it has, so for a second the page
       * renders one person's expenses under the other's name — merchants,
       * notes, amounts and all — which is the exact failure this mode
       * exists to prevent. `clear()` fixes that and swaps it for a worse
       * one: every query loses its data at once and the app sits there, so
       * pressing the button looked like it did nothing at all.
       *
       * Identity is not query state. It is who the whole app is for, it is
       * carried in a cookie the server reads on every request, and there is
       * no honest way to keep half the screen while it changes. A reload
       * costs a second and cannot show the wrong person's data on the way.
       */
      window.location.reload();
      return;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Not an admin and not currently viewing as somebody: nothing to offer.
  // The exit stays visible in the second case whatever else is true, because
  // the one control that must never disappear is the one that gets you back.
  if (!isAdmin && !viewingAs) return null;

  if (viewingAs) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => void swap(null)}
        title={`You are ${viewingAs.real}, looking at the app as ${viewingAs.viewed}. Nothing can be changed in this mode.`}
        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/60 bg-amber-400/15 px-2.5 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-400/25 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <EyeOff className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">Viewing as {shortName(viewingAs.viewed)} — </span>back to me
      </button>
    );
  }

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Look at the app as one of the people the automation acts for. Read-only."
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-2.5 py-1 text-xs font-semibold text-white/80 hover:bg-white/10"
      >
        <Eye className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">View as</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1.5 w-80 rounded-xl border border-border bg-background p-2 text-foreground shadow-xl">
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            See the app as they see it — their imports, their failures, whether their Emburse
            login is stored. <strong className="text-foreground">Read-only:</strong> nothing can be
            approved, denied or changed while viewing as somebody else.
          </p>
          {people.isLoading && (
            <p className="px-2 py-2 text-xs text-muted-foreground">Looking…</p>
          )}
          {!people.isLoading && (people.data?.people.length ?? 0) === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              Nobody has stored an Emburse login yet, so there is no other view to look at.
            </p>
          )}
          <ul className="max-h-72 overflow-auto">
            {people.data?.people.map((p) => (
              <li key={p.email}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void swap(p.email)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted disabled:opacity-50"
                >
                  <span className="text-sm font-semibold">{p.email}</span>
                  {/* Whose-and-whether, never what. The state of somebody's
                      login is the thing most worth seeing before you go and
                      look through their eyes. */}
                  <span className="text-xs text-muted-foreground">
                    {p.needsReentry
                      ? "their Emburse login needs re-entering"
                      : p.lastOkAt
                        ? `last signed in ${new Date(p.lastOkAt).toLocaleDateString()}`
                        : "stored, never used yet"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="px-2 py-1.5 text-xs text-red-600">{error}</p>}
        </div>
      )}
    </span>
  );
}

const shortName = (email: string): string => email.split("@")[0] ?? email;
