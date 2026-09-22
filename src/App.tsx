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
import { timeOfDay } from "@/lib/format";

const RAIL = [
  { key: "queue", label: "Review Queue", Icon: ListChecks, description: "Expense reports waiting on a decision, oldest first." },
  { key: "reports", label: "All Reports", Icon: FileText, description: "Every report in the window, filterable by status and department." },
  { key: "analytics", label: "Analytics", Icon: BarChart3, description: "Where the money went — by category, department and month." },
  { key: "import", label: "Import", Icon: Upload, description: "Upload the daily Emburse export and review what changed." },
] as const;

type RailKey = (typeof RAIL)[number]["key"];

const WINDOWS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "12 months" },
] as const;

/** Hash routing keeps sub-pages deep-linkable without pulling in a router. */
function useHashRoute(): [RailKey, (k: RailKey) => void] {
  const read = (): RailKey => {
    const raw = window.location.hash.replace(/^#\/?/, "");
    return RAIL.some((r) => r.key === raw) ? (raw as RailKey) : "queue";
  };
  const [route, setRoute] = useState<RailKey>(read);

  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return [
    route,
    (k: RailKey) => {
      window.location.hash = `/${k}`;
      setRoute(k);
    },
  ];
}

export function App() {
  const [route, setRoute] = useHashRoute();
  const [days, setDays] = useState<(typeof WINDOWS)[number]["value"]>("90");
  const [open, setOpen] = useState<ExpenseReport | null>(null);

  const queryClient = useQueryClient();
  const auth = useAuth();
  const config = useConfig();

  // Only fetch reports once we know the viewer is allowed to see them —
  // otherwise every anonymous page load fires a request that 401s.
  const signedIn = Boolean(auth.data?.user) || auth.data?.authConfigured === false;
  const reports = useReports(Number(days), signedIn);

  useEffect(() => {
    // The drawer belongs to the list behind it; leaving it open over another
    // section is disorienting.
    setOpen(null);
  }, [route]);

  const active = RAIL.find((r) => r.key === route) ?? RAIL[0];
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
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-3">
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
            {auth.data?.user && <UserMenu user={auth.data.user} />}
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-5 py-6">
        <nav className="hidden w-56 shrink-0 md:block">
          <ul className="space-y-1">
            {RAIL.map(({ key, label, Icon }) => {
              const on = key === route;
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
            right={
              <SegmentedControl
                value={days}
                onChange={setDays}
                options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
              />
            }
          />

          {data?.demo && <NotConnected config={config.data} />}

          {route !== "import" && <LiveStrip
            label={
              data
                ? `${data.demo ? "Demo data" : "Live"} — ${data.reports.length} reports · updated ${timeOfDay(data.fetchedAt)}`
                : "Loading…"
            }
            onRefresh={() => queryClient.invalidateQueries({ queryKey: ["reports"] })}
            isRefreshing={reports.isFetching}
          />}

          {/* Mobile rail. */}
          <div className="md:hidden">
            <SegmentedControl
              value={route}
              onChange={setRoute}
              options={RAIL.map((r) => ({ value: r.key, label: r.label }))}
            />
          </div>

          {reports.isPending && route !== "import" && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading expense reports…
            </div>
          )}

          {reports.isError && route !== "import" && (
            <Empty>
              <p className="font-semibold text-red-600">Could not load expense reports</p>
              <p className="mt-1">{(reports.error as Error).message}</p>
            </Empty>
          )}

          {data && route === "queue" && <QueuePage data={data} config={config.data} onOpen={setOpen} />}
          {data && route === "reports" && <ReportsPage data={data} config={config.data} onOpen={setOpen} />}
          {data && route === "analytics" && <AnalyticsPage data={data} />}
          {route === "import" && <ImportPage />}
        </main>
      </div>

      {openReport && (
        <ReportDrawer
          report={openReport}
          onClose={() => setOpen(null)}
          days={Number(days)}
          auditConfigured={config.data?.auditConfigured ?? false}
        />
      )}
    </div>
  );
}
