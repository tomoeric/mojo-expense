import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Tags, MapPin, Building2, ChevronRight, Sparkles, CheckCircle2, AlertTriangle, ListChecks,
  type LucideIcon,
} from "lucide-react";
import { Empty } from "@/components/ui";
import { useTaxonomyCounts, type Kind } from "@/lib/taxonomy";

type AiCheck = {
  ok: boolean;
  via: "replit" | "direct" | null;
  gatewayUrl: string;
  model: string;
  served?: string;
  error?: string;
};

/**
 * The way in to the permanent lists.
 *
 * Every entry on these lists arrived on an export — nothing here is typed in,
 * and nothing can be. So the page says what it holds and how big each list is,
 * rather than offering an edit affordance that would have to be refused.
 *
 * It exists because a group in the rail whose button goes nowhere is a dead
 * control. Clicking Configuration should land somewhere, and the honest
 * somewhere is a contents page.
 */

/** The routes this page can send you to — the same keys the rail uses. */
export type ConfigPage = "categories" | "locations" | "departments";

/**
 * Whether the Anthropic credential actually works, testable where it is set.
 *
 * Reading receipts is the one thing in this app that depends on a credential
 * nobody can see. Replit's integration is not a key — it injects a placeholder
 * and points at a sidecar on localhost — so both secrets look filled in
 * whether or not an integration exists behind them, and the only symptom used
 * to be a receipt check failing three screens away. Pressing this makes one
 * four-token call and says what came back.
 */
function AiConnection({ isAdmin }: { isAdmin: boolean }) {
  const [result, setResult] = useState<AiCheck | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isAdmin) return null;

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      // The server keeps a few seconds between checks so nobody can hold this
      // down at a fraction of a cent a time. That is a fact about the button,
      // not about the credential — and rendering it in the same amber box as a
      // real diagnosis made a double-click look like the answer, on a panel
      // whose whole job is answering one question. So it waits and goes again
      // rather than reporting back.
      let res = await fetch("/api/ai-check", { method: "POST" });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 3200));
        res = await fetch("/api/ai-check", { method: "POST" });
      }
      const body = (await res.json()) as AiCheck & { error?: string };
      setResult(res.ok ? body : { ok: false, via: null, gatewayUrl: "", model: "", error: body.error });
    } catch (err) {
      setResult({ ok: false, via: null, gatewayUrl: "", model: "", error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const source =
    result?.via === "replit"
      ? `Replit's AI integration${result.gatewayUrl ? ` (${result.gatewayUrl})` : ""}`
      : result?.via === "direct"
        ? "a direct ANTHROPIC_API_KEY"
        : "no credential";

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm font-semibold">Reading receipts</p>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {busy ? "Testing…" : "Test the connection"}
        </button>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        Pulling the line items off each receipt, and checking its total against the claim, both need an
        Anthropic credential. Everything else in the app works without one.
      </p>

      {result && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
            result.ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div className="min-w-0">
            {result.ok ? (
              <p>
                Working — through <strong>{source}</strong>, answered by{" "}
                <strong>{result.served ?? result.model}</strong>.
              </p>
            ) : (
              <>
                <p>{result.error}</p>
                {result.via && (
                  <p className="mt-1 text-xs opacity-80">Tried through {source}.</p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <AiSpend isAdmin={isAdmin} />
    </div>
  );
}

type Entry = { key: ConfigPage; kind: Kind; label: string; Icon: LucideIcon; blurb: string };

const ENTRIES: Entry[] = [
  {
    key: "categories",
    kind: "category",
    label: "Categories",
    Icon: Tags,
    blurb: "What each expense was booked to. Nested ones are grouped under their parent.",
  },
  {
    key: "locations",
    kind: "location",
    label: "Locations & Sites",
    Icon: MapPin,
    blurb: "Which site the spend belongs to, read off the Details column of the export.",
  },
  {
    key: "departments",
    kind: "department",
    label: "Departments",
    Icon: Building2,
    blurb: "Which department owns it, from the same Details column.",
  },
];

export function ConfigurationPage({ onOpen, isAdmin }: { onOpen: (key: ConfigPage) => void; isAdmin: boolean }) {
  const counts = useTaxonomyCounts();

  if (counts.isError) {
    return (
      <Empty>
        <p className="font-semibold text-red-600">Could not load the lists</p>
        <p className="mt-1">{(counts.error as Error).message}</p>
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        These lists are built from what Emburse actually sends. A name goes on once it has arrived on an
        export and stays there, whether or not anything is using it today — “no open expenses this week”
        and “no longer a real value” are different things, and only Emburse knows which. They are also what
        the dropdowns in <strong>Rules</strong> offer, so a rule cannot be written against a category that
        does not exist.
      </p>

      <AiConnection isAdmin={isAdmin} />

      <DecisionTrace isAdmin={isAdmin} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ENTRIES.map(({ key, kind, label, Icon, blurb }) => {
          const n = counts.data?.counts[kind];
          return (
            <button
              key={key}
              type="button"
              onClick={() => onOpen(key)}
              className="group flex flex-col rounded-xl border border-border p-4 text-left transition-colors hover:border-muted-foreground/40 hover:bg-muted/40"
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                {label}
                <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </span>

              <span className="tnum mt-3 text-2xl leading-none font-extrabold">
                {counts.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : (
                  (n ?? 0).toLocaleString()
                )}
              </span>
              <span className="mt-1 text-xs text-muted-foreground">
                {n === 1 ? "name on the list" : "names on the list"}
              </span>

              <span className="mt-3 text-xs text-muted-foreground">{blurb}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type Window = { calls: number; tokens: number; cost: number | null };
type PerModel = {
  model: string; calls: number; input: number; output: number;
  cacheRead: number; cacheWrite: number; cost: number | null;
};
type Spend = {
  today: Window; month: Window; total: Window;
  byModel: PerModel[]; unpriced: string[]; perReceipt: number | null;
};

const dollars = (n: number | null): string =>
  n === null ? "—" : n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;

/**
 * What the AI has actually cost.
 *
 * Every estimate of this made before it existed was wrong, once by a factor of
 * fifty, because it rested on assumed token counts. These are the counts the
 * API reported, priced at render time — so the figure moves when the published
 * price does, without anything needing a backfill.
 */
function AiSpend({ isAdmin }: { isAdmin: boolean }) {
  const { data } = useQuery<Spend>({
    queryKey: ["ai-usage"],
    enabled: isAdmin,
    queryFn: async () => {
      const res = await fetch("/api/ai-usage");
      if (!res.ok) throw new Error("Could not read AI usage");
      return (await res.json()) as Spend;
    },
  });

  if (!isAdmin || !data) return null;
  // Nothing spent yet says more as one quiet line than as an empty table.
  if (data.total.calls === 0) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        No AI calls yet, so nothing has been spent.
      </p>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <Fig label="today" value={dollars(data.today.cost)} sub={`${data.today.calls} calls`} />
        <Fig label="this month" value={dollars(data.month.cost)} sub={`${data.month.calls} calls`} />
        <Fig label="all time" value={dollars(data.total.cost)} sub={`${data.total.calls} calls`} />
        <Fig
          label="per receipt"
          value={data.perReceipt === null ? "—" : `$${data.perReceipt.toFixed(4)}`}
          sub="average"
        />
      </div>

      <table className="mt-3 w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="font-medium">Model</th>
            <th className="text-right font-medium">Calls</th>
            <th className="text-right font-medium">In</th>
            <th className="text-right font-medium">Out</th>
            <th className="text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {data.byModel.map((m) => (
            <tr key={m.model} className="border-t border-border/60">
              <td className="py-1 font-medium">{m.model}</td>
              <td className="tnum py-1 text-right">{m.calls.toLocaleString()}</td>
              <td className="tnum py-1 text-right">{m.input.toLocaleString()}</td>
              <td className="tnum py-1 text-right">{m.output.toLocaleString()}</td>
              <td className="tnum py-1 text-right">{dollars(m.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.unpriced.length > 0 && (
        <p className="mt-2 text-xs text-amber-700">
          No published price on file for {data.unpriced.join(", ")}, so any total including it reads
          as —. The tokens are still counted.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Priced from published rates held in the app, so treat it as close rather than exact. Usage
        billed through a Replit AI integration appears on the Replit bill instead.
      </p>
    </div>
  );
}

function Fig({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <p className="text-lg font-bold tnum">{value}</p>
      <p className="text-xs text-muted-foreground">
        {label} · {sub}
      </p>
    </div>
  );
}

/**
 * The small admin switches.
 *
 * Only one so far, and it earns its place: before it, the only way to learn
 * WHERE an approval failed was to approve a real expense and read a
 * one-sentence error that could mean a wrong password, a device check, an
 * account without the team view, or a renamed button — four causes, four
 * different fixes, one message.
 *
 * Off by default, and said plainly rather than left to be discovered: it
 * attaches a browser transcript to every decision, which a working queue has
 * no use for.
 */
function DecisionTrace({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery<Record<string, boolean>>({
    queryKey: ["flags"],
    enabled: isAdmin,
    queryFn: async () => {
      const res = await fetch("/api/flags");
      if (!res.ok) throw new Error("Could not read the settings");
      return (await res.json()) as Record<string, boolean>;
    },
  });
  const [busy, setBusy] = useState(false);
  if (!isAdmin || !data) return null;
  const on = Boolean(data.traceDecisions);

  const toggle = async () => {
    setBusy(true);
    try {
      await fetch("/api/flags/traceDecisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !on }),
      });
      await qc.invalidateQueries({ queryKey: ["flags"] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm font-semibold">Record every step of an approve or deny</p>
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          className={`ml-auto rounded-lg border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 ${
            on
              ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-700"
              : "border-border hover:bg-muted"
          }`}
        >
          {busy ? "Saving…" : on ? "On" : "Off"}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        With this on, each decision keeps the browser run stage by stage — signing in, switching to
        the team view, finding the row, verifying it, clicking. Open a failed decision to read it.
        Turn it on to work out <em>where</em> something fails; turn it off once it works, because a
        healthy queue has no use for a transcript on every row.
      </p>
    </div>
  );
}
