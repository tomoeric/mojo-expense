import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ListChecks, FileText, BarChart3, Loader2, Upload } from "lucide-react";
import { useAuth, useConfig, useReports, type ExpenseReport } from "@/lib/api";
import { SectionTitle, LiveStrip, SegmentedControl, Empty } from "@/components/ui";
import { NotConnected } from "@/components/not-connected";
import { SignIn } from "@/components/sign-in";
import { UserMenu } from "@/components/user-menu";
import { ReportDrawer } from "@/components/report-drawer";
import { QueuePage } from "@/pages/queue";
import { ReportsPage } from "@/pages/reports";
import { AnalyticsPage } from "@/pages/analytics";
import { ImportPage } from "@/pages/import";
import { ExportSettingsPage } from "@/pages/export-settings";
import { MyEmburseLoginPage } from "@/pages/my-emburse-login";
import { timeOfDay } from "@/lib/format";
import { useSyncStatus } from "@/lib/sync";

const RAIL = [
  { key: "queue", label: "Review Queue", Icon: ListChecks, description: "Expense reports waiting on a decision, oldest first." },
  { key: "reports", label: "All Reports", Icon: FileText, description: "Every report in the window, filterable by status and department." },
  { key: "analytics", label: "Analytics", Icon: BarChart3, description: "Where the money went — by category, department and month." },
  { key: "import", label: "Import", Icon: Upload, description: "Upload the daily Emburse export and review what changed." },
] as const;

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

type RailKey = (typeof RAIL)[number]["key"] | (typeof MENU_PAGES)[number]["key"];

/** Pages that stand alone — no report window, no live strip. */
const isStandalone = (k: RailKey) => k === "import" || k === "settings";

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

/** Hash routing keeps sub-pages deep-linkable without pulling in a router. */
function useHashRoute(): {
  route: RailKey;
  view: string;
  setRoute: (k: RailKey) => void;
  setView: (v: string) => void;
} {
  // `#/queue/flagged` — the second segment is the section's own sub-view, so a
  // chosen filter survives a reload and can be linked to.
  const read = () => {
    const [first = "", ...rest] = window.location.hash.replace(/^#\/?/, "").split("/");
    const known = [...RAIL.map((r) => r.key), ...MENU_PAGES.map((m) => m.key)] as string[];
    return {
      route: (known.includes(first) ? first : "queue") as RailKey,
      view: decodeURIComponent(rest.join("/")) || "all",
    };
  };
  const [state, setState] = useState(read);

  useEffect(() => {
    const onChange = () => setState(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const go = (route: RailKey, view: string) => {
    window.location.hash = view && view !== "all" ? `/${route}/${encodeURIComponent(view)}` : `/${route}`;
    setState({ route, view: view || "all" });
  };

  return {
    route: state.route,
    view: state.view,
    setRoute: (k) => go(k, "all"),
    setView: (v) => go(state.route, v),
  };
}

export function App() {
  const { route, view, setRoute, setView } = useHashRoute();
  const [open, setOpen] = useState<ExpenseReport | null>(null);

  const queryClient = useQueryClient();
  const auth = useAuth();
  const config = useConfig();
  const syncing = useSyncStatus();

  // Only fetch reports once we know the viewer is allowed to see them —
  // otherwise every anonymous page load fires a request that 401s.
  const signedIn = Boolean(auth.data?.user) || auth.data?.authConfigured === false;
  const reports = useReports(WINDOW_DAYS, signedIn);

  useEffect(() => {
    // The drawer belongs to the list behind it; leaving it open over another
    // section is disorienting.
    setOpen(null);
  }, [route]);

  const active =
    RAIL.find((r) => r.key === route) ?? MENU_PAGES.find((m) => m.key === route) ?? RAIL[0];
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
            {/* A sync outlives the page that started it, so say so everywhere. */}
            {syncing && (
              <span className="hidden items-center gap-1.5 text-xs text-white/70 sm:inline-flex">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Syncing SharePoint…
              </span>
            )}
            {auth.data?.user && <UserMenu user={auth.data.user} isAdmin={auth.data.isAdmin} />}
          </div>
        </div>
      </header>

      {/* Wider than a reading column on purpose: the queue is an eleven-column
          table, and squeezing it into prose width is what made columns collapse. */}
      <div className="mx-auto flex max-w-[1800px] gap-6 px-5 py-6">
        <nav className="hidden w-56 shrink-0 md:block">
          <ul className="space-y-1">
            {RAIL.map(({ key, label, Icon }) => {
              const on = key === route;
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
                  </button>
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

          {/* Mobile rail. Hidden on menu pages, which are not in it. */}
          <div className={MENU_PAGES.some((m) => m.key === route) ? "hidden" : "md:hidden"}>
            <SegmentedControl
              value={route}
              onChange={setRoute}
              options={RAIL.map((r) => ({ value: r.key, label: r.label }))}
            />
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
            <QueuePage data={data} config={config.data} onOpen={setOpen} view={view} onView={setView} />
          )}
          {data && route === "reports" && <ReportsPage data={data} config={config.data} onOpen={setOpen} />}
          {data && route === "analytics" && <AnalyticsPage data={data} />}
          {route === "import" && <ImportPage />}
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
