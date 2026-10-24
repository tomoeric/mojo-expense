import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, Loader2, Search } from "lucide-react";

type Person = {
  email: string;
  name: string;
  role: "super" | "admin" | "user";
  status: "invited" | "active" | "disabled";
  authMethod: "microsoft" | "link";
  business: string | null;
  pages: number;
};

/**
 * Look at Dutch Miller as one of its users.
 *
 * Page access is granted one at a time, so "what can you see?" is a
 * question nobody can answer down a phone line — least of all a dealer
 * who has never seen the full app and does not know what is missing.
 *
 * Read-only, and the SERVER enforces that: every request that is not a GET
 * is refused while a view is on. This component cannot make it safe and
 * does not try to.
 */
export function DmViewAs({
  canViewAs, viewingAs,
}: {
  canViewAs: boolean;
  viewingAs: { real: string; viewed: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const people = useQuery({
    queryKey: ["dm-view-as-people"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/view-as/people");
      if (!res.ok) return { people: [] as Person[] };
      return (await res.json()) as { people: Person[] };
    },
    enabled: open && canViewAs,
    staleTime: 60_000,
  });

  const swap = async (email: string | null) => {
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
      // A full reload: every cached query was answered for the other
      // person, and leaving them in place is how a view half-ends.
      window.location.href = "/";
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (viewingAs) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => void swap(null)}
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-3 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
        Stop viewing
      </button>
    );
  }

  if (!canViewAs) return null;

  const list = (people.data?.people ?? []).filter((p) => {
    const q = filter.trim().toLowerCase();
    return q === "" || p.email.includes(q) || p.name.toLowerCase().includes(q)
      || (p.business ?? "").toLowerCase().includes(q);
  });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      >
        <Eye className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">View as</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg">
            <div className="border-b border-border px-3 py-2.5">
              <p className="text-sm font-semibold">View as somebody</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                See exactly what they see. Nothing can be changed while viewing.
              </p>
            </div>
            <div className="border-b border-border px-3 py-2">
              <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Name, email or dealership"
                  className="w-full bg-transparent text-sm outline-none"
                />
              </div>
            </div>
            {error && <p className="px-3 py-2 text-xs text-red-600">{error}</p>}
            <div className="max-h-80 overflow-auto">
              {people.isPending && (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">Loading…</p>
              )}
              {people.data && list.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {filter ? "Nobody matches that." : "No users yet."}
                </p>
              )}
              {list.map((p) => (
                <button
                  key={p.email}
                  type="button"
                  disabled={busy}
                  onClick={() => void swap(p.email)}
                  className="block w-full border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted disabled:opacity-50"
                >
                  <span className="block truncate text-sm">{p.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {p.email}
                  </span>
                  {/* What the view will actually show, before entering it —
                      often the whole answer to "why can't they see X". */}
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {p.role === "user" ? `${p.pages} page${p.pages === 1 ? "" : "s"}` : p.role}
                    {p.status !== "active" ? ` · ${p.status}` : ""}
                    {p.business ? ` · ${p.business}` : ""}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
