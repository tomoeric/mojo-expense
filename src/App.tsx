import { useEffect, useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ListChecks, FileText, BarChart3, Loader2, Upload, Tags, MapPin, Building2, Scale, BookOpen,
  SlidersHorizontal, ChevronRight, ChevronDown, type LucideIcon,
} from "lucide-react";
import {
  useAuth, useConfig, useReports,
  type AppKey, type ExpenseReport, type SessionUser,
} from "@/lib/api";
import { useDecisions } from "@/lib/decisions";
import { SectionTitle, LiveStrip, SegmentedControl, Empty } from "@/components/ui";
import { NotConnected } from "@/components/not-connected";
import { SignIn } from "@/components/sign-in";
import { UserMenu } from "@/components/user-menu";
import { DutchMillerApp } from "@/pages/dutch-miller";
import { ViewAs } from "@/components/view-as";
import { ReportDrawer } from "@/components/report-drawer";
import { QueuePage } from "@/pages/queue";
import { ReportsPage } from "@/pages/reports";
import { AnalyticsPage } from "@/pages/analytics";
import { ImportPage } from "@/pages/import";
import { ExportSettingsPage } from "@/pages/export-settings";
import { MyEmburseLoginPage } from "@/pages/my-emburse-login";
import { TaxonomyPage } from "@/pages/taxonomy";
import { RulesPage } from "@/pages/rules";
import { ConfigurationPage } from "@/pages/configuration";
import { HowEmburseWorksPage } from "@/pages/how-emburse-works";
import { timeOfDay } from "@/lib/format";

type PageKey =
  | "queue" | "reports" | "analytics" | "rules" | "import"
  | "configuration" | "categories" | "locations" | "departments" | "how-emburse-works";

type RailItem = {
  key: PageKey;
  label: string;
  Icon: LucideIcon;
  description: string;
  /** Sub-pages, shown nested beneath the parent while you are inside it. */
  children?: RailItem[];
};

/**
 * The main navigation.
 *
 * The permanent lists sit under Configuration rather than beside the places
 * people work. They are reference data — what Emburse offers, not what anybody
 * does today — and four of the eight top-level buttons being lists buried the
 * three that are actual work.
 */
const RAIL: RailItem[] = [
  { key: "queue", label: "Review Queue", Icon: ListChecks, description: "Expense reports waiting on a decision, oldest first." },
  { key: "reports", label: "All Reports", Icon: FileText, description: "Every report in the window, filterable by status and department." },
  { key: "analytics", label: "Analytics", Icon: BarChart3, description: "Where the money went — by category, department and month." },
  { key: "rules", label: "Rules", Icon: Scale, description: "What an expense has to look like — and what happens to the ones that do not." },
  { key: "import", label: "Import", Icon: Upload, description: "What the daily export brought in, and a way to load one by hand." },
  {
    key: "configuration",
    label: "Configuration",
    Icon: SlidersHorizontal,
    description: "The permanent lists behind every expense — what Emburse offers, and what is actually being used.",
    children: [
      { key: "categories", label: "Categories", Icon: Tags, description: "Every expense category Emburse has sent, whether or not anything is using it today." },
      { key: "locations", label: "Locations & Sites", Icon: MapPin, description: "Every location / site Emburse has sent, whether or not anything is using it today." },
      { key: "departments", label: "Departments", Icon: Building2, description: "Every department Emburse has sent, whether or not anything is using it today." },
      // The reference, where the questions get asked. It lived only in
      // docs/, which means GitHub — a relative link from the README does
      // not resolve in Replit's editor, so clicking through to it simply
      // failed and the answers stayed where nobody could reach them.
      { key: "how-emburse-works", label: "How Emburse is driven", Icon: BookOpen, description: "Emburse has no expense API, so the app drives a browser. How the grid URL is built, what the export run does, and how an approve or deny finds its row." },
    ],
  },
];

/** Every rail destination, parents and children alike, for lookups. */
const RAIL_PAGES: RailItem[] = RAIL.flatMap((r) => [r, ...(r.children ?? [])]);

/**
 * The permanent lists, and the field each is drawn from. Kept as a map rather
 * than three near-identical routes, so adding a fourth list is one line here
 * and one line in the rail.
 */
const LISTS = { categories: "category", locations: "location", departments: "department" } as const;

/**
 * Pages reachable from the user menu rather than the rail. They are settings
 * rather than places to work, so they do not belong in the main navigation, but
 * they still need to be a route so the back button and a pasted link behave.
 */
const MENU_PAGES = [
  {
    key: "settings",
    label: "Export settings",
    description: "What the daily Emburse export is supposed to contain, and what each import is checked against.",
  },
  {
    key: "emburse-login",
    label: "Your Emburse login",
    description: "The account the app signs into Emburse with. Only you can see or change yours.",
  },
] as const;

type RailKey = PageKey | (typeof MENU_PAGES)[number]["key"];

/** Pages that stand alone — no report window, no live strip. */
const isStandalone = (k: RailKey) =>
  k === "import" || k === "settings" || k === "rules" || k === "configuration" || k in LISTS;

/**
 * How far back to load, with no selector to change it.
 *
 * The window was a hangover from a live API, where narrowing the range saved a
 * paged fetch. Reading imported rows out of Postgres it saves nothing, and it
 * cost something real: a reviewer could be looking at a filtered subset without
 * noticing, and wonder where an expense went. Two years is past the useful life
 * of an expense claim and inside the server's own cap.
 */
const WINDOW_DAYS = 730;

/** Hash routing keeps pages deep-linkable without pulling in a router. */
function useHashRoute(): { route: RailKey; setRoute: (k: RailKey) => void } {
  // Just `#/queue`. There used to be a second segment for a page's own
  // sub-view — `#/queue/flagged` — and nothing has sub-views any more, so a
  // stale link like that now lands on the page itself rather than a filter
  // that no longer exists.
  const read = () => {
    const first = window.location.hash.replace(/^#\/?/, "").split("/")[0] ?? "";
    const known = [...RAIL_PAGES.map((r) => r.key), ...MENU_PAGES.map((m) => m.key)] as string[];
    return (known.includes(first) ? first : "queue") as RailKey;
  };
  const [route, setState] = useState(read);

  useEffect(() => {
    const onChange = () => setState(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return {
    route,
    setRoute: (k) => {
      window.location.hash = `/${k}`;
      setState(k);
    },
  };
}

export function App() {
  const { route, setRoute } = useHashRoute();
  // Which expense was clicked, alongside the day it belongs to. The drawer
  // used to be handed the day alone, so clicking one receipt opened
  // "3 expenses" and showed whichever receipt happened to be first — the row
  // you picked was somewhere in a list. The line id is what makes the drawer
  // open on the thing you actually clicked.
  const [open, setOpen] = useState<{ report: ExpenseReport; lineId?: string } | null>(null);
  const openOne = (report: ExpenseReport, lineId?: string) => setOpen({ report, lineId });

  const queryClient = useQueryClient();
  const auth = useAuth();

  /**
   * Switch product.
   *
   * A full reload rather than a re-render: the two shells have entirely
   * different polling, routes and caches, and swapping them in place
   * leaves the old app's queries running against endpoints the server
   * has just started refusing.
   */
  const switchApp = (next: AppKey) => {
    void fetch("/api/auth/app", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: next }),
    }).then((res) => {
      if (res.ok) {
        window.location.hash = "";
        window.location.reload();
      }
    });
  };
  const config = useConfig();

  // Only fetch reports once we know the viewer is allowed to see them —
  // otherwise every anonymous page load fires a request that 401s.
  const signedIn = Boolean(auth.data?.user) || auth.data?.authConfigured === false;
  const reports = useReports(WINDOW_DAYS, signedIn);
  /**
   * Every expense on screen, in the order the lists show them.
   *
   * Used for ONE thing: knowing what to open next when a decision is made
   * in the drawer. Reviewing is "read a receipt, say yes or no, read the
   * next one", and closing the drawer after every decision put the whole
   * queue between somebody and the next receipt — scroll, find your place,
   * click, wait for the image.
   */
  const everyLine = useMemo(
    () => (reports.data?.reports ?? []).flatMap((r) => r.lines.map((l) => ({ report: r, line: l }))),
    [reports.data],
  );
  // Keyed by the ids, so this is its own read rather than a share of the
  // queue's — the cost of knowing which expenses are already spoken for
  // without asking the drawer to know about reports it is not showing.
  const { applied, byExpense } = useDecisions(everyLine.map((e) => e.line.id));

  /**
   * The next expense nobody has decided, after the one just decided.
   *
   * Wraps once, so deciding the last one in the list picks up anything
   * still waiting above it rather than closing on a queue that is not
   * finished. Returns null only when there is genuinely nothing left,
   * which is the one time closing the drawer is the right answer.
   */
  const nextUndecided = (afterLineId: string): { report: ExpenseReport; lineId: string } | null => {
    const at = everyLine.findIndex((e) => e.line.id === afterLineId);
    const order = at < 0 ? everyLine : [...everyLine.slice(at + 1), ...everyLine.slice(0, at)];
    const next = order.find((e) => !byExpense[e.line.id]);
    return next ? { report: next.report, lineId: next.line.id } : null;
  };

  useEffect(() => {
    // The drawer belongs to the list behind it; leaving it open over another
    // section is disorienting.
    setOpen(null);
  }, [route]);

  const active =
    RAIL_PAGES.find((r) => r.key === route) ?? MENU_PAGES.find((m) => m.key === route) ?? RAIL[0]!;
  const data = reports.data;

  if (auth.isPending) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (auth.data && !auth.data.user && auth.data.authConfigured) {
    return <SignIn authConfigured />;
  }

  /*
   * WHICH APP. One deployment, two products, and somebody assigned to one
   * must not get the other's shell at all.
   *
   * Rendered as a different app rather than as hidden nav items: the
   * Emburse chrome is the queue, the rail, the drawer and a dozen polling
   * hooks, and "Dutch Miller with all of that greyed out" is not a second
   * product, it is the first one with the labels filed off. The server
   * refuses the other side's routes regardless — this is the shell, not
   * the control.
   */
  const apps = auth.data?.apps ?? [];
  const activeApp = auth.data?.app ?? apps[0] ?? "emburse";

  if (auth.data?.user && apps.length === 0) {
    return <NoAppAssigned email={auth.data.user.email} />;
  }

  if (activeApp === "dutch-miller") {
    return (
      <DutchMillerApp
        user={auth.data?.user ?? null}
        isAdmin={auth.data?.isAdmin ?? false}
        apps={apps}
        onSwitchApp={switchApp}
      />
    );
  }

  // A refetch can replace the open report; keep the drawer showing live data.
  const openReport = open ? (data?.reports.find((r) => r.id === open.report.id) ?? open.report) : null;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-black text-white">
        <div className="mx-auto flex max-w-[1800px] items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-baseline gap-2.5">
            <span className="text-base font-extrabold tracking-tight">MOJO Expense</span>
            <span className="text-xs text-white/60">Emburse reviewer console</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-white/60 sm:inline">
              {config.data?.source === "imported"
                ? "imported data"
                : config.data?.source === "demo"
                  ? "demo mode"
                  : (config.data?.source ?? "")}
            </span>
            {auth.data?.user && (
              <ViewAs isAdmin={auth.data.isAdmin} viewingAs={auth.data.viewingAs} />
            )}
            {auth.data?.user && (
              <UserMenu
                user={auth.data.user}
                isAdmin={auth.data.isAdmin}
                apps={apps}
                app={activeApp}
                onSwitchApp={switchApp}
              />
            )}
          </div>
        </div>
      </header>

      {/* Impossible to miss, because the cost of forgetting is real: every
          count, every flag and every admin control below is somebody
          else's, and a decision attempted here is refused by the server
          rather than quietly recorded under the wrong name. */}
      {auth.data?.viewingAs && (
        <div className="border-b border-amber-500/40 bg-amber-500/15 px-5 py-1.5 text-center text-xs text-amber-900 dark:text-amber-200">
          {/* "read from their own Emburse Needs Review" is what this used to
              claim, and it is the sentence that made a separation look real
              when it was not: the export reads the TEAM-WIDE tab with no
              per-person filter, so what their import brought may be the very
              same rows as everybody else's. The banner says what is true —
              these are the expenses their import holds — and the Import page
              says who holds what. */}
          Viewing as <strong>{auth.data.viewingAs.viewed}</strong> — everything below is the
          queue their own import holds. Read-only: nothing can be approved,
          denied or changed until you go back to {auth.data.viewingAs.real}.{" "}
          {/* The one action allowed from in here. Checking somebody's view is
              worth little if the view is whatever it was when they last
              signed in — and an import reads Emburse and writes our own
              tables, deciding nothing. */}
          <a href="#/import" className="font-semibold underline underline-offset-2">
            Run their import
          </a>{" "}
          on the Import page to refresh it.
        </div>
      )}

      {/* Wider than a reading column on purpose: the queue is an eleven-column
          table, and squeezing it into prose width is what made columns collapse. */}
      <div className="mx-auto flex max-w-[1800px] gap-6 px-5 py-6">
        <nav className="hidden w-56 shrink-0 md:block">
          <ul className="space-y-1">
            {RAIL.map((item) => {
              const { key, label, Icon, children } = item;
              const on = key === route;
              // A group opens when you are inside it and closes when you leave.
              // No toggle: a collapse control that the current page immediately
              // overrides is a dead control, and the group's own page lists the
              // same three destinations anyway.
              const inGroup = Boolean(children?.some((c) => c.key === route)) || on;
              const Chevron = inGroup ? ChevronDown : ChevronRight;
              /* A menu page leaves every rail item unselected, which is the
                 honest state: you are not in any of them. */
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => setRoute(key)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      on ? "bg-muted font-semibold" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                    {children && <Chevron className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />}
                  </button>

                  {children && inGroup && (
                    // Indented and hung off a rule, so the nesting is visible
                    // without a second level of icons competing with the first.
                    <ul className="mt-1 ml-[1.45rem] space-y-0.5 border-l border-border pl-2">
                      {children.map((child) => (
                        <li key={child.key}>
                          <button
                            type="button"
                            onClick={() => setRoute(child.key)}
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                              child.key === route
                                ? "bg-muted font-semibold"
                                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                            }`}
                          >
                            <child.Icon className="h-3.5 w-3.5 shrink-0" />
                            {child.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <main className="min-w-0 flex-1 space-y-4">
          <SectionTitle
            title={active.label}
            description={active.description}
            warnings={data?.warnings ?? []}
            right={null}
          />

          {data?.demo && <NotConnected config={config.data} />}

          {!isStandalone(route) && <LiveStrip
            label={
              data
                // "572 expenses" over a queue showing 126 reads as a backlog
                // nobody can find. Say what the number counts.
                ? `${data.demo ? "Demo data" : "Live"} — ${Math.max(
                    0,
                    data.reports
                      .filter((r) => r.status === "submitted")
                      .reduce((a, r) => a + r.lines.length, 0) - applied,
                  ).toLocaleString()} expenses awaiting a decision · updated ${timeOfDay(data.fetchedAt)}`
                : "Loading…"
            }
            onRefresh={() => queryClient.invalidateQueries({ queryKey: ["reports"] })}
            isRefreshing={reports.isFetching}
          />}

          {/* Mobile rail. Hidden on menu pages, which are not in it. The group's
              children get their own row rather than being flattened in, which
              would put nine options on a phone. */}
          <div className={MENU_PAGES.some((m) => m.key === route) ? "hidden" : "space-y-2 md:hidden"}>
            <SegmentedControl
              value={RAIL.find((r) => r.key === route || r.children?.some((c) => c.key === route))?.key ?? route}
              onChange={setRoute}
              options={RAIL.map((r) => ({ value: r.key, label: r.label }))}
            />
            {RAIL.filter((r) => r.children && (r.key === route || r.children.some((c) => c.key === route)))
              .map((r) => (
                <SegmentedControl
                  key={r.key}
                  value={route}
                  onChange={setRoute}
                  options={[
                    { value: r.key, label: "Overview" },
                    ...r.children!.map((c) => ({ value: c.key, label: c.label })),
                  ]}
                />
              ))}
          </div>

          {reports.isPending && !isStandalone(route) && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading expense reports…
            </div>
          )}

          {reports.isError && !isStandalone(route) && (
            <Empty>
              <p className="font-semibold text-red-600">Could not load expense reports</p>
              <p className="mt-1">{(reports.error as Error).message}</p>
            </Empty>
          )}

          {data && route === "queue" && (
            <QueuePage data={data} onOpen={openOne} />
          )}
          {data && route === "reports" && <ReportsPage data={data} config={config.data} onOpen={openOne} />}
          {data && route === "analytics" && <AnalyticsPage data={data} />}
          {route === "import" && <ImportPage />}
          {route === "configuration" && (
            <ConfigurationPage
              onOpen={setRoute}
              isAdmin={auth.data?.isAdmin ?? false}
              viewingAs={auth.data?.viewingAs?.viewed ?? null}
            />
          )}
          {route in LISTS && <TaxonomyPage kind={LISTS[route as keyof typeof LISTS]} />}
          {route === "how-emburse-works" && <HowEmburseWorksPage />}
          {route === "rules" && <RulesPage isAdmin={auth.data?.isAdmin ?? false} />}
          {route === "settings" && <ExportSettingsPage isAdmin={auth.data?.isAdmin ?? false} />}
          {route === "emburse-login" && <MyEmburseLoginPage />}
        </main>
      </div>

      {openReport && (
        <ReportDrawer
          report={openReport}
          focusId={open?.lineId}
          onClose={() => setOpen(null)}
          onDecided={(lineId) => setOpen(nextUndecided(lineId))}
          days={WINDOW_DAYS}
          auditConfigured={config.data?.auditConfigured ?? false}
        />
      )}
    </div>
  );
}

/**
 * Signed in, and assigned to nothing.
 *
 * Only reachable once somebody has been removed from both lists, which is
 * a configuration mistake rather than a state to design around — but it
 * has to say so plainly. The alternative is an empty Emburse shell whose
 * every request answers 403, which reads as the app being broken.
 */
function NoAppAssigned({ email }: { email: string }) {
  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center">
        <p className="text-sm font-semibold">No app is assigned to this account</p>
        <p className="mt-1 text-sm text-muted-foreground">
          You are signed in as {email}, but it has not been given access to Emburse or
          Dutch Miller. An administrator can add it to the relevant list.
        </p>
        <a
          href="/api/logout"
          className="mt-4 inline-block rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Sign out
        </a>
      </div>
    </div>
  );
}
