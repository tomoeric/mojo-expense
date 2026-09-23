import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ListChecks, FileText, BarChart3, Loader2, Upload, Tags, MapPin, Building2, Scale,
  SlidersHorizontal, ChevronRight, ChevronDown, type LucideIcon,
} from "lucide-react";
import { useAuth, useConfig, useReports, type ExpenseReport } from "@/lib/api";
import { SectionTitle, LiveStrip, SegmentedControl, Empty } from "@/components/ui";
import { NotConnected } from "@/components/not-connected";
import { SignIn } from "@/components/sign-in";
import { UserMenu } from "@/components/user-menu";
import { ViewAsBanner } from "@/components/view-as";
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
import { timeOfDay } from "@/lib/format";

type PageKey =
  | "queue" | "reports" | "analytics" | "rules" | "import"
  | "configuration" | "categories" | "locations" | "departments";

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
  const [open, setOpen] = useState<ExpenseReport | null>(null);

  const queryClient = useQueryClient();
  const auth = useAuth();
  const config = useConfig();

  // Only fetch reports once we know the viewer is allowed to see them —
  // otherwise every anonymous page load fires a request that 401s.
  const signedIn = Boolean(auth.data?.user) || auth.data?.authConfigured === false;
  const reports = useReports(WINDOW_DAYS, signedIn);

  useEffect(() => {
    // The drawer belongs to the list behind it; leaving it open over another
    // section is disorienting.
    setOpen(null);
  }, [route]);

  // Who an admin can look at the app as: the people who can decide, which is
  // the only group whose view differs in a way worth inspecting.
  const deciders = config.data?.deciders ?? [];

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

  // A refetch can replace the open report; keep the drawer showing live data.
  const openReport = open ? (data?.reports.find((r) => r.id === open.id) ?? open) : null;

  return (
    <div className="min-h-screen">
      {/* Above the header, full width, impossible to miss: everything below it
          is somebody else's view and none of it can act. */}
      {auth.data?.viewingAs && <ViewAsBanner viewingAs={auth.data.viewingAs} />}
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
              <UserMenu
                user={auth.data.user}
                isAdmin={auth.data.isAdmin}
                viewAsPeople={deciders}
              />
            )}
          </div>
        </div>
      </header>

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
                ? `${data.demo ? "Demo data" : "Live"} — ${data.reports.reduce((a, r) => a + r.lines.length, 0).toLocaleString()} expenses · updated ${timeOfDay(data.fetchedAt)}`
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
            <QueuePage data={data} onOpen={setOpen} />
          )}
          {data && route === "reports" && <ReportsPage data={data} config={config.data} onOpen={setOpen} />}
          {data && route === "analytics" && <AnalyticsPage data={data} />}
          {route === "import" && <ImportPage />}
          {route === "configuration" && (
            <ConfigurationPage onOpen={setRoute} isAdmin={auth.data?.isAdmin ?? false} />
          )}
          {route in LISTS && <TaxonomyPage kind={LISTS[route as keyof typeof LISTS]} />}
          {route === "rules" && <RulesPage isAdmin={auth.data?.isAdmin ?? false} />}
          {route === "settings" && <ExportSettingsPage isAdmin={auth.data?.isAdmin ?? false} />}
          {route === "emburse-login" && <MyEmburseLoginPage />}
        </main>
      </div>

      {openReport && (
        <ReportDrawer
          report={openReport}
          onClose={() => setOpen(null)}
          days={WINDOW_DAYS}
          auditConfigured={config.data?.auditConfigured ?? false}
        />
      )}
    </div>
  );
}
