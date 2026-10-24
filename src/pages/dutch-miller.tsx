import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Users } from "lucide-react";
import { UserMenu } from "@/components/user-menu";
import { DmRfidPage } from "@/pages/dm-rfid";
import { DmUsersPage } from "@/pages/dm-users";
import type { AppKey, SessionUser } from "@/lib/api";

/**
 * Dutch Miller — the second app on this deployment.
 *
 * Its own shell rather than a borrowed one. Emburse's header is built
 * around the review queue's navigation, and reusing it would put sections
 * in front of somebody who cannot open any of them. The user menu IS
 * shared, because identity, sign-out and the app switcher are the same job
 * in both products.
 *
 * The rail is built from what the server says this person may open, not
 * from a list kept here. A page they cannot reach is never offered — and
 * the 403 behind each route is what makes that a rule rather than a
 * decoration.
 */

type Access = {
  role: "admin" | "user";
  pages: string[];
  unconfigured: boolean;
  email: string;
  allPages: readonly { key: string; label: string; blurb: string }[];
};

/** Reachable from the user menu as well as the rail — it administers, not works. */
const USERS_PAGE = {
  key: "users",
  label: "Users",
  blurb: "Who may open Dutch Miller, and what they can reach.",
};

function useHash(fallback: string, known: string[]): [string, (k: string) => void] {
  const read = () => {
    const first = window.location.hash.replace(/^#\/?/, "").split("/")[0] ?? "";
    return known.includes(first) ? first : fallback;
  };
  const [route, set] = useState(read);
  // `known` is empty until access arrives, so re-read once it lands: a pasted
  // link to a real page would otherwise be rewritten to the fallback purely
  // because the answer had not come back yet.
  const keys = known.join(",");
  useEffect(() => {
    set(read());
    const on = () => set(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [keys]);
  return [route, (k) => { window.location.hash = `/${k}`; set(k); }];
}

export function DutchMillerApp({
  user,
  isAdmin,
  apps,
  onSwitchApp,
}: {
  user: SessionUser | null;
  isAdmin: boolean;
  apps: AppKey[];
  onSwitchApp: (next: AppKey) => void;
}) {
  const me = useQuery({
    queryKey: ["dm-me"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/me");
      if (!res.ok) throw new Error("Could not read your Dutch Miller access.");
      return (await res.json()) as Access;
    },
  });

  const access = me.data;
  const dmAdmin = access?.role === "admin";
  const rail = (access?.allPages ?? []).filter(
    (p) => dmAdmin || (access?.pages ?? []).includes(p.key));
  const known = [...rail.map((p) => p.key), ...(dmAdmin ? [USERS_PAGE.key] : [])];
  const [route, setRoute] = useHash(known[0] ?? "", known);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-black text-white">
        <div className="mx-auto flex max-w-[1800px] items-center justify-between gap-4 px-5 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Dutch Miller</p>
            <p className="truncate text-xs text-white/60">Mammoth Holdings</p>
          </div>
          {user && (
            <UserMenu
              user={user}
              isAdmin={isAdmin}
              apps={apps}
              app="dutch-miller"
              onSwitchApp={onSwitchApp}
              product="dutch-miller"
              dmAdmin={dmAdmin}
              onDmUsers={() => setRoute(USERS_PAGE.key)}
            />
          )}
        </div>
      </header>

      {access?.unconfigured && (
        <div className="border-b border-amber-500/40 bg-amber-500/15 px-5 py-1.5 text-center text-xs text-amber-900 dark:text-amber-200">
          No users have been set up yet, so everyone with Dutch Miller access is an
          administrator. Adding the first one under <strong>Users</strong> closes that.
        </div>
      )}

      <div className="mx-auto flex max-w-[1600px] gap-6 px-5 py-6">
        <nav className="hidden w-52 shrink-0 space-y-1 md:block">
          {rail.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setRoute(p.key)}
              title={p.blurb}
              className={`block w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                route === p.key
                  ? "bg-muted font-semibold"
                  : "text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {p.label}
            </button>
          ))}
          {dmAdmin && (
            <button
              type="button"
              onClick={() => setRoute(USERS_PAGE.key)}
              title={USERS_PAGE.blurb}
              className={`mt-2 flex w-full items-center gap-2 rounded-md border-t border-border px-3 pt-3 pb-2 text-left text-sm transition-colors ${
                route === USERS_PAGE.key
                  ? "font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Users className="h-3.5 w-3.5 shrink-0" />
              {USERS_PAGE.label}
            </button>
          )}
        </nav>

        <div className="min-w-0 flex-1">
          {/* The same choices as the rail, for a phone. */}
          {known.length > 1 && (
            <select
              value={route}
              onChange={(e) => setRoute(e.target.value)}
              className="mb-4 w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm md:hidden"
            >
              {rail.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              {dmAdmin && <option value={USERS_PAGE.key}>{USERS_PAGE.label}</option>}
            </select>
          )}

          {me.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {me.isError && (
            <p className="text-sm font-semibold text-red-600">{(me.error as Error).message}</p>
          )}
          {access && known.length === 0 && <NothingAssigned email={access.email} />}
          {access && route === "rfid-review" && <DmRfidPage />}
          {access && route === USERS_PAGE.key && dmAdmin && <DmUsersPage me={access.email} />}
        </div>
      </div>
    </div>
  );
}

/**
 * In Dutch Miller, with no page to open.
 *
 * Distinct from having no app at all: this person was let through the door
 * and given nothing inside, which is an administrator's omission. Unsaid,
 * it reads as a broken app.
 */
function NothingAssigned({ email }: { email: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-8">
      <div className="flex items-start gap-3">
        <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm font-semibold">No pages are assigned to you</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {email} can reach Dutch Miller, but has not been given access to any page
            inside it. A Dutch Miller administrator can grant that under Users.
          </p>
        </div>
      </div>
    </div>
  );
}
