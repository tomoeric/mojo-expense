import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronRight, Crown, SlidersHorizontal, Users } from "lucide-react";
import { AppSwitcher } from "@/components/app-switcher";
import { DmStopViewing } from "@/components/dm-stop-viewing";
import { UserMenu } from "@/components/user-menu";
import { DmRfidInstructionsPage } from "@/pages/dm-rfid-instructions";
import { DmRfidPage } from "@/pages/dm-rfid";
import { DmSignupsPage } from "@/pages/dm-signups";
import { useLiveUpdates } from "@/lib/live";
import { DmPeopleDialog } from "@/pages/dm-people";
import { DmRolesPage } from "@/pages/dm-roles";
import { DmAuditPage } from "@/pages/dm-audit";
import { DmSecurityPage } from "@/pages/dm-security";
import { DmSettingsPage } from "@/pages/dm-settings";
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

type PageDef = {
  key: string;
  label: string;
  blurb: string;
  /** Sub-pages, shown as a dropdown under the rail item. May be empty. */
  children: readonly { key: string; label: string }[];
};

type Access = {
  role: "super" | "admin" | "user";
  pages: string[];
  status: "invited" | "active" | "disabled";
  email: string;
  /** Signed in through Microsoft SSO on one of our own domains. */
  staff: boolean;
  via: "microsoft" | "link";
  allPages: readonly PageDef[];
  /** Set only while a super admin is looking through somebody else's eyes. */
  viewingAs: { real: string; viewed: string } | null;
  /** Which face of the glass the sticker goes on. Drives the wording. */
  stickerPlacement: "inside" | "outside";
};

/**
 * The administrator's pages, reached from the USER ICON rather than the rail.
 *
 * The rail is for the pages people come here to do work in. Users, Roles
 * and Settings administer the app itself, and putting them in the same
 * column makes an occasional errand look like part of the job. They are
 * still routes, so the back button and a pasted link behave.
 *
 * Users is not a page at all — it opens as a dialog over whatever you
 * were doing, because setting somebody's role is a thirty-second errand
 * and losing your place to run it is the annoying part.
 */
/**
 * The administrative destinations, each reached DIRECTLY.
 *
 * They sit under the account icon rather than in the rail, because
 * the rail is for the pages people come here to work in. There is no
 * Administration entry and no landing page in front of them: one
 * click from the menu opens the actual page, with its own title.
 *
 * Each is still a real route — `#/admin/<key>` — so the back button,
 * a refresh and a pasted link all behave, and links bookmarked when
 * these were tabs still land in the right place.
 */
const ADMIN_PAGES: { key: string; label: string; superOnly?: boolean }[] = [
  { key: "users", label: "Users & Access" },
  { key: "roles", label: "Roles & Permissions", superOnly: true },
  { key: "security", label: "Security" },
  { key: "email", label: "Email & Notifications" },
  { key: "audit", label: "Audit History" },
];

/**
 * Which of them this person may open.
 *
 * Filtered here AND enforced on every route behind them: this decides
 * what the menu offers, never what the server allows.
 */
const adminFor = (role: "super" | "admin" | "user") =>
  ADMIN_PAGES.filter((p) => !p.superOnly || role === "super");

/** One routable page holding all of them, so `#/admin/<key>` works. */
const MENU_PAGES: PageDef[] = [{
  key: "admin", label: "Administration", blurb: "",
  children: ADMIN_PAGES.map((p) => ({ key: p.key, label: p.label })),
}];

/**
 * `#/<page>` or `#/<page>/<sub-page>`.
 *
 * The sub-page is part of the address rather than state inside the page,
 * so the rail's dropdown items are real links: back, forward and a pasted
 * URL all land where they say they will.
 */
type Route = { page: string; sub: string };

function useRoute(pages: readonly PageDef[]): [Route, (page: string, sub?: string) => void] {
  const keys = pages.map((p) => `${p.key}:${p.children.map((c) => c.key).join("|")}`).join(",");

  const read = (): Route => {
    const [first = "", second = ""] = window.location.hash
      .replace(/^#\/?/, "").split("?")[0]!.split("/");
    const page = pages.find((p) => p.key === first) ?? pages[0];
    if (!page) return { page: "", sub: "" };
    const sub = page.children.some((c) => c.key === second)
      ? second
      : (page.children[0]?.key ?? "");
    return { page: page.key, sub };
  };

  const [route, set] = useState(read);

  // `pages` is empty until the server answers, so re-read once it lands: a
  // pasted link to a real page would otherwise be rewritten to the first one
  // purely because the answer had not come back yet.
  useEffect(() => {
    set(read());
    const on = () => set(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [keys]);

  return [route, (page, sub) => {
    const target = pages.find((p) => p.key === page);
    const use = sub ?? target?.children[0]?.key ?? "";
    window.location.hash = use ? `/${page}/${use}` : `/${page}`;
    set({ page, sub: use });
  }];
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

  // One connection for the whole shell, once there is somebody to open
  // it for. Everything below reacts through the query cache.
  useLiveUpdates(Boolean(me.data));

  const access = me.data;
  const dmAdmin = access?.role === "admin" || access?.role === "super";
  const rail: PageDef[] = (access?.allPages ?? [])
    .filter((p) => dmAdmin || (access?.pages ?? []).includes(p.key));
  // The menu pages are routable without being in the rail.
  const admin = adminFor(access?.role ?? "user");
  const [route, go] = useRoute([
    ...rail,
    ...(dmAdmin ? [{ ...MENU_PAGES[0]!, children: admin }] : []),
  ]);
  const [users, setUsers] = useState(false);
  // Audit History, filtered to one account. Set by the history icon on
  // a person's row, cleared the moment another tab is picked.
  const [historyFor, setHistoryFor] = useState("");

  /**
   * Enter a view. Started from a person's row, never from the header.
   *
   * A full reload afterwards: every cached query was answered for the
   * real person, and leaving them in place is how a view half-starts.
   */
  const startViewAs = (email: string) => {
    void fetch("/api/auth/view-as", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }).then(() => { window.location.href = "/"; });
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-black text-white">
        <div className="mx-auto flex max-w-[1800px] items-center justify-between gap-4 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Dutch Miller</p>
              <p className="truncate text-xs text-white/60">
                Mammoth Holdings — SUDS Car Wash
              </p>
            </div>
            {/* Navigation, so it sits beside the product name rather than
                under somebody's photograph. */}
            <AppSwitcher
              apps={apps}
              app="dutch-miller"
              onSwitch={onSwitchApp}
              viewingAs={Boolean(access?.viewingAs)}
            />
          </div>
          <div className="flex items-center gap-3">
            <DmStopViewing viewingAs={access?.viewingAs ?? null} />
            {user && (
              <UserMenu
                user={user}
                isAdmin={isAdmin}
                product="dutch-miller"
                dmAdmin={dmAdmin}
                dmDestinations={admin}
                onDmGo={(key) => { setHistoryFor(""); go("admin", key); }}
              />
            )}
          </div>
        </div>
      </header>

      {/* Impossible to miss, and the way out is in it. Everything below is
          somebody else's app: their rail, their pages, their refusals. The
          server rejects every write while this is on, so a control that
          looks available here would fail rather than act as them. */}
      {access?.viewingAs && (
        <div className="border-b border-amber-500/40 bg-amber-500/15 px-5 py-1.5 text-center text-xs text-amber-900 dark:text-amber-200">
          Viewing as <strong>{access.viewingAs.viewed}</strong> — this is their app, with
          their pages and their access. Read-only: nothing can be changed until you go
          back to {access.viewingAs.real}.
        </div>
      )}

      <div className="mx-auto flex max-w-[1600px] gap-6 px-5 py-6">
        <nav aria-label="Dutch Miller" className="hidden w-56 shrink-0 space-y-0.5 md:block">
          {rail.map((p) => (
            <RailItem
              key={p.key}
              page={p}
              route={route}
              icon={null}
              onGo={go}
            />
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {/* The same destinations as the rail, for a phone. */}
          {rail.length > 0 && (
            <select
              value={`${route.page}/${route.sub}`}
              onChange={(e) => {
                const [page = "", sub = ""] = e.target.value.split("/");
                go(page, sub);
              }}
              className="mb-4 w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm md:hidden"
            >
              {rail.map((p) => (
                p.children.length === 0
                  ? <option key={p.key} value={`${p.key}/`}>{p.label}</option>
                  : p.children.map((c) => (
                      <option key={`${p.key}/${c.key}`} value={`${p.key}/${c.key}`}>
                        {p.label} › {c.label}
                      </option>
                    ))
              ))}
            </select>
          )}

          {me.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {me.isError && (
            <p className="text-sm font-semibold text-red-600">{(me.error as Error).message}</p>
          )}
          {access && rail.length === 0 && <NothingAssigned email={access.email} />}
          {access && route.page === "member-signups" && (
            <DmSignupsPage
              view={route.sub === "add" ? "add" : "review"}
              onView={(v) => go("member-signups", v)}
              viewingAs={access.viewingAs}
              placement={access.stickerPlacement ?? "inside"}
            />
          )}
          {access && route.page === "rfid-instructions" && (
            <DmRfidInstructionsPage isAdmin={dmAdmin} />
          )}
          {access && route.page === "rfid-review" && <DmRfidPage />}
          {/* Straight to the page. No heading above it, no tab row —
              each destination carries its own single title. */}
          {access && route.page === "admin" && dmAdmin && (
            <>
              {route.sub === "users" && (
                <DmPeopleDialog
                  embedded
                  me={access.email}
                  iAmSuper={access.role === "super"}
                  onClose={() => undefined}
                  onViewAs={startViewAs}
                  onHistory={(email) => { setHistoryFor(email); go("admin", "audit"); }}
                />
              )}
              {route.sub === "roles" && access.role === "super" && <DmRolesPage />}
              {route.sub === "security" && <DmSecurityPage />}
              {route.sub === "email" && <DmSettingsPage />}
              {route.sub === "audit" && <DmAuditPage subject={historyFor} />}
            </>
          )}
        </div>
      </div>

      {users && access && (
        <DmPeopleDialog
          me={access.email}
          iAmSuper={access.role === "super"}
          onClose={() => setUsers(false)}
          onViewAs={startViewAs}
          onHistory={(email) => {
            setUsers(false);
            setHistoryFor(email);
            go("admin", "audit");
          }}
        />
      )}
    </div>
  );
}

/**
 * One rail entry, with its sub-pages as a dropdown beneath it.
 *
 * The group opens when you are inside it and can be opened to look without
 * leaving where you are — but clicking the parent navigates as well as
 * expands, because a heading that only toggles is a dead end for anybody
 * who clicked it meaning to go there.
 */
function RailItem({
  page, route, icon, onGo,
}: {
  page: PageDef;
  route: Route;
  icon: React.ReactNode;
  onGo: (page: string, sub?: string) => void;
}) {
  const here = route.page === page.key;
  const [open, setOpen] = useState(here);
  useEffect(() => { if (here) setOpen(true); }, [here]);
  const expandable = page.children.length > 0;

  return (
    <div>
      <button
        type="button"
        title={page.blurb}
        aria-expanded={expandable ? open : undefined}
        onClick={() => {
          if (here && expandable) setOpen((v) => !v);
          else { setOpen(true); onGo(page.key); }
        }}
        className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
          here ? "bg-muted font-semibold" : "text-muted-foreground hover:bg-muted/60"
        }`}
      >
        {icon}
        <span className="flex-1 truncate">{page.label}</span>
        {expandable && (
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {expandable && open && (
        <div className="mt-0.5 space-y-0.5 border-l border-border pb-1 pl-3 ml-4">
          {page.children.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => onGo(page.key, c.key)}
              className={`block w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                here && route.sub === c.key
                  ? "bg-muted/70 font-semibold"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
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
