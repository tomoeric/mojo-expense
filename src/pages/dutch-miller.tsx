import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Building2, ChevronRight, Crown, Layers, Mail, Settings2, ShieldCheck,
  SlidersHorizontal, Users,
} from "lucide-react";
import { AppSwitcher } from "@/components/app-switcher";
import { DmStopViewing } from "@/components/dm-stop-viewing";
import { UserMenu } from "@/components/user-menu";
import { DmRfidInstructionsPage } from "@/pages/dm-rfid-instructions";
import { DmRfidPage } from "@/pages/dm-rfid";
import { DmSignupsPage } from "@/pages/dm-signups";
import { useLiveUpdates } from "@/lib/live";
import { DmPeopleDialog } from "@/pages/dm-people";
import { DmRolesPage } from "@/pages/dm-roles";
import { DmAccountPage } from "@/pages/dm-account";
import { DmAuditPage } from "@/pages/dm-audit";
import { DmVendorsPage } from "@/pages/dm-vendors";
import { DmSecurityPage } from "@/pages/dm-security";
import { DmSettingsPage } from "@/pages/dm-settings";
import { DmAccountSettingsPage, DmPartnersPage } from "@/pages/dm-partners";
import { DmRegistrationPage } from "@/pages/dm-registration";
import { AddPage } from "@/components/add-page";
import { DmTemplatePage } from "@/pages/dm-template";
import { openAccount, slugInPath } from "@/lib/partner";
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

/**
 * One entry on the account's rail, as the server resolved it.
 *
 * `route` is the hash route, which has not changed and must not:
 * every bookmark and every emailed link is one of these. Where the
 * BUTTON sits is the account's; where the page lives is not.
 */
type RailChild = {
  key: string; label: string; blurb: string; grant: string; route: string;
  added: boolean;
};
type RailItem = RailChild & { children: RailChild[]; group: boolean };

type PageDef = {
  key: string;
  label: string;
  blurb: string;
  /**
   * Sub-pages, shown as a dropdown under the rail item.
   *
   * Each names the GRANT it needs, which is not always the group's own
   * key: Member Signups is one heading over two separately granted
   * pages, so somebody may hold Add New and not Review Existing.
   */
  children: readonly { key: string; label: string; grant?: string }[];
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
  /** Set only while an account admin is looking through somebody else's eyes. */
  viewingAs: { real: string; viewed: string } | null;
  /** Which face of the glass the sticker goes on. Drives the wording. */
  stickerPlacement: "inside" | "outside";
  /** The platform's own name, above the partner's. */
  platform: string;
  /** The partner this request resolved to, or none. */
  account: PartnerRef | null;
  /** Every partner the REAL person may open, for the switcher. */
  accounts: PartnerRef[];
  /** Creating and deactivating partners. The pinned list, nobody else. */
  isAccountAdmin: boolean;
  /** This ACCOUNT's rail: the shared base plus whatever it has added. */
  rail: RailItem[];
};

type PartnerRef = {
  id: string; slug: string; name: string; affiliation: string;
  line: string; status: "active" | "inactive";
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
/*
 * Vendors is NOT here any more.
 *
 * It spent one release in this menu, which was the wrong place for a
 * second reason: the menu is where the app is administered, and
 * approving a company to be paid is work. It is a page in the shared
 * catalogue now — not on the base rail, addable by any account that
 * genuinely has vendors — and every record, route and audit line is
 * exactly where it was.
 */
const ADMIN_PAGES: { key: string; label: string; superOnly?: boolean; grant?: string }[] = [
  // The switch that closes the partner account is the account
  // administrator's, so the page it lives on is too: an ordinary
  // administrator should not be shown a control they cannot use.
  { key: "account", label: "Account", superOnly: true },
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
const adminFor = (
  role: "super" | "admin" | "user", holds: (grant: string) => boolean,
) => ADMIN_PAGES.filter((p) => (p.grant ? holds(p.grant) : true))
  .filter((p) => !p.superOnly || role === "super");

/**
 * The platform's own sections, outside any partner.
 *
 * Reached at the root rather than inside an account, because that is
 * what they are about: which partners exist, who may open them, and
 * the configuration that is the same in all of them.
 */
const PLATFORM_PAGES: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: "partners", label: "Partner Accounts", icon: <Building2 className="h-4 w-4" /> },
  { key: "template", label: "Shared Template", icon: <Layers className="h-4 w-4" /> },
  { key: "users", label: "Users & Access", icon: <Users className="h-4 w-4" /> },
  { key: "roles", label: "Roles & Permissions", icon: <Crown className="h-4 w-4" /> },
  { key: "settings", label: "Account Settings", icon: <Settings2 className="h-4 w-4" /> },
  { key: "security", label: "Security", icon: <ShieldCheck className="h-4 w-4" /> },
  { key: "email", label: "Email & Notifications", icon: <Mail className="h-4 w-4" /> },
];

/**
 * `#/<page>` or `#/<page>/<sub-page>`.
 *
 * The sub-page is part of the address rather than state inside the page,
 * so the rail's dropdown items are real links: back, forward and a pasted
 * URL all land where they say they will.
 */
function useRoute(routes: readonly string[]): [string, (route: string) => void] {
  const keys = routes.join(",");

  const read = (): string => {
    const parts = window.location.hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
    const two = parts.slice(0, 2).join("/");
    const one = parts[0] ?? "";
    // The longer match first: `member-signups/add` and
    // `member-signups/review` are different pages, and matching the
    // prefix would always land on whichever came first.
    if (routes.includes(two)) return two;
    if (routes.includes(one)) return one;
    return routes[0] ?? "";
  };

  const [route, set] = useState(read);

  // `routes` is empty until the server answers, so re-read once it lands: a
  // pasted link to a real page would otherwise be rewritten to the first one
  // purely because the answer had not come back yet.
  useEffect(() => {
    set(read());
    const on = () => set(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [keys]);

  return [route, (next) => { window.location.hash = `/${next}`; set(next); }];
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
  /*
   * The PATH says which partner, and nothing else does.
   *
   * `/dutchmiller` is Dutch Miller; `/` is the platform, outside any
   * partner. A remembered selection would be shared between tabs, so
   * somebody comparing two partners would have both reading the same
   * one — and would not find out until they acted on it.
   */
  const slug = slugInPath();
  /*
   * Vendors used to be a rail page at #/vendors. It is now reached
   * from the account menu, so an old link or bookmark lands on the
   * first rail page with no explanation. Rewritten rather than
   * redirected server-side: the address is a hash, so the server
   * never sees it.
   */
  useEffect(() => {
    if (window.location.hash.replace(/^#\/?/, "").split("/")[0] === "vendors") {
      window.location.hash = "/admin/vendors";
    }
  }, []);
  /*
   * The rail, filtered one SUB-PAGE at a time.
   *
   * A group appears when any of its pages is held, and shows only the
   * ones that are — so a front desk that can enrol but not review sees
   * Member Signups with Add New under it and nothing else, rather than
   * a heading whose first item refuses them.
   */
  const held = (grant: string) => dmAdmin || (access?.pages ?? []).includes(grant);
  /*
   * One account and no slug: open it rather than offer it.
   *
   * Somebody who works for one dealership should land in that
   * dealership, not on a list with one row. An account administrator
   * is the exception — the list IS their page.
   */
  const only = !slug && access && !access.isAccountAdmin && access.accounts.length === 1
    ? access.accounts[0]!.slug
    : "";
  /*
   * A link from before partner accounts existed.
   *
   * Every emailed review link and every bookmark looks like
   * `/#/member-signups/review` — no slug, a page in the hash. Landing
   * them on the platform list would drop the page they asked for, so
   * a hash naming a PARTNER page resolves to the account this request
   * already resolved to, carrying the hash with it. Only a page the
   * shell knows counts; a platform hash like #/partners is left alone.
   */
  const legacy = !slug && access?.account && !only
    ? (() => {
      const first = window.location.hash.replace(/^#\/?/, "").split("/")[0] ?? "";
      const partnerPage = first === "admin" || first === "vendors"
        || access.allPages.some((pg) => pg.key === first);
      return partnerPage ? access.account!.slug : "";
    })()
    : "";
  useEffect(() => {
    if (only) openAccount(only, window.location.hash);
    else if (legacy) openAccount(legacy, window.location.hash);
  }, [only, legacy]);

  /*
   * The tab's own name.
   *
   * One index.html serves both products, so its static title has to
   * be the deployment's — which left this app's tabs reading "MOJO
   * Expense" next to a header that says something else. Set from the
   * shell instead, where the product and the partner are both known.
   */
  const tab = access?.account && slug
    ? `${access.account.name} · ${access.platform}`
    : (access?.platform ?? "MOJO Partners");
  useEffect(() => { document.title = tab; }, [tab]);
  /*
   * The rail, from the SERVER, filtered one entry at a time.
   *
   * The server resolves which buttons this account shows; the grants
   * decide which of them this person may open. A heading whose every
   * child is refused disappears rather than leading nowhere.
   */
  const rail: RailItem[] = (access?.rail ?? [])
    .map((item) => ({ ...item, children: item.children.filter((c) => held(c.grant)) }))
    .filter((item) => (item.group
      ? item.children.length > 0
      : held(item.grant) || item.children.length > 0));
  // The menu pages are routable without being in the rail.
  const admin = adminFor(access?.role ?? "user", held);
  /*
   * Every route this person can reach, flat.
   *
   * Driven by routes rather than by the rail's shape, because the
   * two are now different questions: where a button SITS is the
   * account's arrangement, and where a page LIVES has not moved and
   * must not — every bookmark and emailed link is one of these.
   */
  const routes: string[] = [
    ...rail.flatMap((i) => [
      ...(i.group || !held(i.grant) ? [] : [i.route]),
      ...i.children.map((c) => c.route),
    ]),
    ...admin.map((a) => `admin/${a.key}`),
  ];
  const [route, go] = useRoute(routes);
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

  /*
   * The header, which both shells share.
   *
   * MOJO Partners is the platform and is always what the header says
   * it is. The partner's own line sits under it, and is simply absent
   * outside an account — never a blank line, never a leftover name
   * from the last one, and never an invented affiliation for a
   * partner whose wash nobody has filled in.
   */
  const header = (
    <header className="border-b border-border bg-black text-white">
      <div className="mx-auto flex max-w-[1800px] items-center justify-between gap-4 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => { window.location.href = "/"; }}
            className="min-w-0 text-left"
            title={access && access.accounts.length > 1
              ? "Every partner you can open" : "MOJO Partners"}
          >
            <p className="truncate text-sm font-semibold">
              {access?.platform ?? "MOJO Partners"}
            </p>
            {slug && access?.account && (
              <p className="truncate text-xs text-white/60">{access.account.line}</p>
            )}
          </button>
          {/* Only for somebody who holds more than one. One partner
              and a switcher offering it is a control that does
              nothing but take up the space beside their own name. */}
          {access && access.accounts.length > 1 && (
            <select
              value={slug}
              onChange={(e) => openAccount(e.target.value)}
              aria-label="Partner account"
              className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-xs
                         text-white"
            >
              {!slug && <option value="">All partners</option>}
              {/* A deactivated partner is still listed and still
                  labelled. Somebody attached to it should be able to
                  find out why it went dark, which is what opening it
                  now tells them. */}
              {access.accounts.map((a) => (
                <option key={a.id} value={a.slug} className="text-black">
                  {a.name}{a.status === "inactive" ? " (deactivated)" : ""}
                </option>
              ))}
            </select>
          )}
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
              dmDestinations={admin}
              onDmGo={(key) => { setHistoryFor(""); go(`admin/${key}`); }}
            />
          )}
        </div>
      </div>
    </header>
  );

  /*
   * Outside a partner: the platform.
   *
   * An account administrator lands here on purpose — which partners
   * exist and who may open them is their job. Everybody else only
   * reaches it by holding more than one, in which case it is the
   * list they came for.
   */
  if (!slug && access && !only && !legacy) {
    return (
      <PlatformShell
        header={header}
        access={access}
        onViewAs={startViewAs}
      />
    );
  }

  return (
    <div className="min-h-screen">
      {header}

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
        <nav aria-label="Navigation" className="hidden w-56 shrink-0 space-y-0.5 md:block">
          {rail.map((p) => (
            <RailButton key={p.key} item={p} route={route} onGo={go} />
          ))}
          {/* Adding a page is the account's own navigation, so the
              control lives under it rather than in a settings screen
              somewhere else. Administrators only; the route decides
              again. */}
          {dmAdmin && access && <AddPage />}
        </nav>

        <div className="min-w-0 flex-1">
          {/* The same destinations as the rail, for a phone. */}
          {rail.length > 0 && (
            <select
              value={route}
              onChange={(e) => go(e.target.value)}
              aria-label="Navigation"
              className="mb-4 w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm md:hidden"
            >
              {rail.flatMap((p) => [
                ...(p.group ? [] : [
                  <option key={p.key} value={p.route}>{p.label}</option>,
                ]),
                ...p.children.map((c) => (
                  <option key={`${p.key}/${c.key}`} value={c.route}>
                    {p.label} › {c.label}
                  </option>
                )),
              ])}
            </select>
          )}

          {me.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {me.isError && (
            <p className="text-sm font-semibold text-red-600">{(me.error as Error).message}</p>
          )}
          {access && rail.length === 0 && <NothingAssigned email={access.email} />}
          {/* The two halves are granted separately now, so a link into
              the one somebody does not hold must say so rather than
              render a page whose every request is refused. */}
          {/* The two halves are granted separately, so a link into the
              one somebody does not hold must say so rather than render
              a page whose every request is refused. */}
          {access && route.startsWith("member-signups/")
            && !held(route.endsWith("/add") ? "member-signups-add" : "member-signups") && (
            <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
              You do not have access to{" "}
              <strong>{route.endsWith("/add") ? "Add New" : "Review Existing"}</strong>.
              Member Signups is granted in two parts; ask an administrator for this one.
            </p>
          )}
          {access && route.startsWith("member-signups/")
            && held(route.endsWith("/add") ? "member-signups-add" : "member-signups") && (
            <DmSignupsPage
              view={route.endsWith("/add") ? "add" : "review"}
              onView={(v) => go(`member-signups/${v}`)}
              viewingAs={access.viewingAs}
              placement={access.stickerPlacement ?? "inside"}
            />
          )}

          {access && route === "account-registration" && held("account-registration")
            && <DmRegistrationPage />}
          {access && route === "vendors" && held("vendors") && <DmVendorsPage />}
          {access && route === "rfid-instructions" && (
            <DmRfidInstructionsPage isAdmin={dmAdmin} />
          )}
          {access && route === "rfid-review" && <DmRfidPage />}
          {/* Straight to the page. No heading above it, no tab row —
              each destination carries its own single title. */}
          {access && route.startsWith("admin/") && (
            <>
              {route === "admin/users" && dmAdmin && (
                <DmPeopleDialog
                  embedded
                  me={access.email}
                  iAmSuper={access.role === "super"}
                  onClose={() => undefined}
                  onViewAs={startViewAs}
                  onHistory={(email) => { setHistoryFor(email); go("admin/audit"); }}
                />
              )}
              {route === "admin/account" && access.role === "super" && (
                <DmAccountPage canSwitch />
              )}
              {route === "admin/roles" && access.role === "super" && <DmRolesPage />}
              {route === "admin/security" && dmAdmin && <DmSecurityPage />}
              {route === "admin/email" && dmAdmin && <DmSettingsPage />}
              {route === "admin/audit" && dmAdmin && <DmAuditPage subject={historyFor} />}
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
            go("admin/audit");
          }}
        />
      )}
    </div>
  );
}

/**
 * The platform, outside any partner account.
 *
 * Its own shell rather than the partner one with the pages swapped,
 * because the two answer different questions and share only the
 * header. Here there is no member list and no RFID stock — there is
 * no partner whose they would be — and a rail that offered them
 * would be offering pages that cannot load.
 *
 * Users & Access, Roles & Permissions, Security and Email &
 * Notifications are the SAME pages as inside an account, because
 * they are the same configuration: one set of people, one set of
 * roles, one security record, one set of recipients, shared across
 * every partner. Opening them from here rather than from inside one
 * account is the honest place for them.
 */
function PlatformShell({
  header, access, onViewAs,
}: {
  header: React.ReactNode;
  access: Access;
  onViewAs: (email: string) => void;
}) {
  const read = (): string => {
    const first = window.location.hash.replace(/^#\/?/, "").split("?")[0]!.split("/")[0] ?? "";
    return PLATFORM_PAGES.some((p) => p.key === first) ? first : "partners";
  };
  const [page, setPage] = useState(read);
  useEffect(() => {
    const on = () => setPage(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (key: string) => { window.location.hash = `/${key}`; setPage(key); };

  /*
   * An ordinary administrator holding several partners gets the list
   * and nothing else. The other six sections change configuration
   * that reaches every partner on the platform, which is the account
   * administrator's — and the routes behind them refuse anybody else
   * regardless, so this decides the menu rather than the access.
   */
  const sections = access.isAccountAdmin
    ? PLATFORM_PAGES
    : PLATFORM_PAGES.filter((p) => p.key === "partners");
  const here = sections.some((p) => p.key === page) ? page : "partners";

  return (
    <div className="min-h-screen">
      {header}

      {access.viewingAs && (
        <div className="border-b border-amber-500/40 bg-amber-500/15 px-5 py-1.5 text-center
                        text-xs text-amber-900 dark:text-amber-200">
          Viewing as <strong>{access.viewingAs.viewed}</strong> — read-only until you go
          back to {access.viewingAs.real}.
        </div>
      )}

      <div className="mx-auto flex max-w-[1600px] gap-6 px-5 py-6">
        <nav aria-label="Platform" className="hidden w-56 shrink-0 space-y-0.5 md:block">
          {sections.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => go(p.key)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm
                          transition-colors ${here === p.key
                ? "bg-muted font-semibold"
                : "text-muted-foreground hover:bg-muted/60"}`}
            >
              {p.icon}
              <span className="flex-1 truncate">{p.label}</span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          <select
            value={here}
            onChange={(e) => go(e.target.value)}
            className="mb-4 w-full rounded-md border border-border bg-background px-2.5 py-2
                       text-sm md:hidden"
          >
            {sections.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>

          {here === "partners" && <DmPartnersPage />}
          {here === "template" && <DmTemplatePage />}
          {here === "users" && (
            <DmPeopleDialog
              embedded
              me={access.email}
              iAmSuper={access.isAccountAdmin}
              onClose={() => undefined}
              onViewAs={onViewAs}
              onHistory={() => undefined}
            />
          )}
          {here === "roles" && <DmRolesPage />}
          {here === "settings" && <DmAccountSettingsPage />}
          {here === "security" && <DmSecurityPage />}
          {here === "email" && <DmSettingsPage />}
        </div>
      </div>
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
function RailButton({
  item, route, onGo,
}: {
  item: RailItem;
  route: string;
  onGo: (route: string) => void;
}) {
  const mine = [item.route, ...item.children.map((c) => c.route)].filter(Boolean);
  const here = mine.includes(route);
  const [open, setOpen] = useState(here);
  useEffect(() => { if (here) setOpen(true); }, [here]);
  const expandable = item.children.length > 0;

  return (
    <div>
      <button
        type="button"
        title={item.blurb}
        aria-expanded={expandable ? open : undefined}
        onClick={() => {
          // A heading has nowhere of its own to go, so it only
          // expands. A page that has children both navigates AND
          // expands, because a button that only toggles is a dead end
          // for anybody who clicked it meaning to go there.
          if (item.group) { setOpen((v) => !v); return; }
          if (route === item.route && expandable) setOpen((v) => !v);
          else { setOpen(true); onGo(item.route); }
        }}
        className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
          route === item.route || (item.group && here)
            ? "bg-muted font-semibold"
            : "text-muted-foreground hover:bg-muted/60"
        }`}
      >
        <span className="flex-1 truncate">{item.label}</span>
        {expandable && (
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {expandable && open && (
        <div className="mt-0.5 space-y-0.5 border-l border-border pb-1 pl-3 ml-4">
          {item.children.map((c) => (
            <button
              key={c.key}
              type="button"
              title={c.blurb}
              onClick={() => onGo(c.route)}
              className={`block w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                route === c.route
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
