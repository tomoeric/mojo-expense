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

export function ConfigurationPage({ onOpen, isAdmin, viewingAs }: {
  onOpen: (key: ConfigPage) => void; isAdmin: boolean; viewingAs: string | null;
}) {
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

      <AutoApprove isAdmin={isAdmin} viewingAs={viewingAs} />
      <AutoFixGasCategory isAdmin={isAdmin} />
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
  backlog: { waiting: number; gaveUp: number; commonError: string | null } | null;
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
/**
 * Why the call count is still moving.
 *
 * The reader wakes every half hour whether or not anything was imported, and
 * retries a failed receipt up to three times before giving up on it for good.
 * So the count creeping up with nobody syncing is normal and finite — but
 * from the cost figures alone it looks like money leaking, and the only way
 * to tell the difference was to read the server log. This says which it is.
 */
function ReadingBacklog({ backlog }: { backlog: Spend["backlog"] }) {
  if (!backlog) return null;
  const { waiting, gaveUp, commonError } = backlog;
  if (waiting === 0 && gaveUp === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Every receipt held has been read. The count above will not move again until new
        receipts arrive.
      </p>
    );
  }
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      {waiting > 0 ? (
        <>
          <strong className="font-semibold text-foreground">{waiting}</strong> receipt
          {waiting === 1 ? "" : "s"} still to read — the reader wakes every 30 minutes and takes
          up to 25 at a time, so expect that many more calls even with nothing syncing.{" "}
        </>
      ) : (
        <>Nothing is waiting to be read.{" "}</>
      )}
      {gaveUp > 0 && (
        <>
          <strong className="font-semibold text-foreground">{gaveUp}</strong> given up on after
          three tries — these cost nothing further.
          {commonError && (
            <span className="mt-1 block opacity-80">Most common reason: {commonError}</span>
          )}
        </>
      )}
    </p>
  );
}

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

      <ReadingBacklog backlog={data.backlog} />

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
 * Why nothing is being approved: every expense in the queue, in the bucket
 * of the first reason it does not qualify.
 *
 * This is the whole point of the card. "On" with an unchanging queue is
 * indistinguishable from a broken feature, and each of these counts has a
 * different next step: flagged means go read the flags, waiting on the
 * rules means run them, waiting on a receipt means the reader is behind,
 * and ready with nothing queued means the pass has not run yet — which is
 * what the button is for.
 */
function WhyNothingMoved({ report }: { report: AutoReport }) {
  const c = report.counts;
  const parts: string[] = [];
  if (c.flagged) parts.push(`${c.flagged} flagged by a rule`);
  if (c.awaitingRules) parts.push(`${c.awaitingRules} waiting for the rules to run`);
  if (c.awaitingReceipt) parts.push(`${c.awaitingReceipt} waiting for a receipt to be read`);
  if (c.decided) parts.push(`${c.decided} already decided, queued, or failed`);

  return (
    <div className="mt-3 rounded-lg bg-muted/50 p-3 text-xs">
      {c.inbox === 0 ? (
        <p>
          {report.elsewhere > 0 && report.owner
            ? `Nothing of ${report.owner}'s is in the queue, so there is nothing to approve.`
            : "Nothing is in the queue, so there is nothing to approve."}
        </p>
      ) : (
        <>
          <p>
            <strong className="font-semibold tabular-nums">{c.eligible}</strong> of{" "}
            <span className="tabular-nums">{c.inbox}</span> in the queue qualify right now.
          </p>
          {parts.length > 0 && (
            <p className="mt-1 text-muted-foreground">The rest: {parts.join(" · ")}.</p>
          )}
          {c.eligible > 0 && !report.blocked && (
            <p className="mt-1 text-muted-foreground">
              Up to {report.perRun} go on the next pass. Press Run now rather than waiting for it.
            </p>
          )}
        </>
      )}
      {report.blocked && <p className="mt-1 text-amber-700">Nothing will run: {report.blocked}.</p>}
      {report.elsewhere > 0 && (
        <p className="mt-1 text-muted-foreground">
          <span className="tabular-nums">{report.elsewhere}</span> more are in another reviewer's
          Emburse account and are not counted above. An approval is made by signing in as{" "}
          {report.owner ?? "the owner"}, and those rows are not in their Needs Review — each
          reviewer switches this on for their own queue, under <em>Per-reviewer imports and
          approvals</em> in Export settings.
          {report.others.length > 0 && (
            <>
              {" "}
              {report.others.map((o, i) => (
                <span key={o.reviewer}>
                  {i > 0 ? " · " : ""}
                  <strong className="tabular-nums">{o.count}</strong> {o.reviewer} (
                  {o.on ? "theirs is on" : "theirs is off"})
                </span>
              ))}
            </>
          )}
        </p>
      )}
      {c.awaitingReceipt > 0 && (
        <p className="mt-1 text-muted-foreground">
          A receipt nobody has read is unflagged because nothing has been checked, not because
          everything passed — so those are held back on purpose, not stuck.
        </p>
      )}
      {/* The two inside that number which will never clear on their own.
          Emburse will not accept an expense without a receipt, so a row
          with none means our import lost it — a receipt page that matched
          no row and was skipped. Neither of these is patience, and both
          showed on the queue as plain Unflagged. */}
      {(report.stuck?.noReceipt > 0 || report.stuck?.unreadable > 0) && (
        <p className="mt-1 text-amber-700 dark:text-amber-300">
          {report.stuck.noReceipt > 0 && (
            <>
              <strong className="tabular-nums">{report.stuck.noReceipt}</strong> have no receipt
              stored at all. Emburse will not accept one without, so the import lost it — most
              likely a receipt page that matched no row.{" "}
            </>
          )}
          {report.stuck.unreadable > 0 && (
            <>
              <strong className="tabular-nums">{report.stuck.unreadable}</strong> have a receipt
              the reader tried three times and gave up on.{" "}
            </>
          )}
          Neither will clear by waiting, and neither can be approved automatically — they need
          a person, or a re-import to fetch the receipt again.
        </p>
      )}
    </div>
  );
}

type AutoReport = {
  on: boolean;
  owner: string | null;
  perRun: number;
  rules: number;
  receiptMatters: boolean;
  blocked: string | null;
  counts: {
    inbox: number; flagged: number; decided: number;
    awaitingRules: number; awaitingReceipt: number; eligible: number;
  };
  stuck: { noReceipt: number; unreadable: number };
  /** In the queue but in somebody else's Emburse account. Never touched. */
  elsewhere: number;
  others: { reviewer: string; count: number; on: boolean }[];
};

/**
 * Approving the expenses no rule had anything to say about, unattended.
 *
 * The most consequential switch in the app, so the page says what it does
 * in the plainest terms available and names whose login it will use. An
 * automation that approves spending should not be something somebody
 * turns on without noticing what they turned on.
 *
 * It also has to be answerable. Switching it on used to produce nothing
 * visible until the next import — the automation ran on the back of an
 * import or a receipt-reading pass, and a settled queue triggers neither —
 * so "it is on and nothing is happening" had no explanation anywhere in the
 * app. Hence the count of what qualifies and why, and a button that runs a
 * pass now.
 */
function AutoApprove({ isAdmin, viewingAs }: { isAdmin: boolean; viewingAs: string | null }) {
  // Inside a view this card is about THEM: their switch, their eligible
  // count, their reasons. The switch can be flipped from here — it is an
  // admin setting the same admin could set for the same person without
  // entering the view at all, and it is recorded against whoever pressed
  // it. Running a pass by hand is not offered, because the sweep that
  // would run is everybody's; theirs comes round within fifteen minutes.
  const theirs = Boolean(viewingAs);
  const qc = useQueryClient();
  const { data } = useQuery<Record<string, unknown>>({
    queryKey: ["flags"],
    enabled: isAdmin,
    queryFn: async () => {
      const res = await fetch("/api/flags");
      if (!res.ok) throw new Error("Could not read the settings");
      return (await res.json()) as Record<string, unknown>;
    },
  });
  const report = useQuery<AutoReport>({
    queryKey: ["auto-approve-report"],
    enabled: isAdmin,
    queryFn: async () => {
      const res = await fetch("/api/flags/autoApprove/report");
      if (!res.ok) throw new Error("Could not read what qualifies");
      return (await res.json()) as AutoReport;
    },
  });
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [ran, setRan] = useState<string | null>(null);
  if (!isAdmin || !data) return null;

  // Whose switch this card is showing. In a view the report is the viewed
  // person's, so reading `on` off the global flag would put their queue and
  // somebody else's switch on the same card.
  const on = theirs ? Boolean(report.data?.on) : Boolean(data.autoApprove);
  const perRun = Number(data.autoApprovePerRun ?? 10);
  const owner = typeof data.autoApproveOwner === "string" ? data.autoApproveOwner : null;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["flags"] });
    await qc.invalidateQueries({ queryKey: ["auto-approve-report"] });
  };

  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      // Their own switch in a view, the global one otherwise. Two different
      // settings behind one button, deliberately: the card always means
      // "the automation for the person this page is about".
      await (theirs
        ? fetch("/api/reviewer-imports", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email: viewingAs,
              autoApprove: body.enabled === true,
              autoApprovePerRun: typeof body.perRun === "number" ? body.perRun : undefined,
            }),
          })
        : fetch("/api/flags/autoApprove", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Run a pass now, and say what came of it in the same place.
   *
   * "Queued 0" on its own would be the same dead end as before, so a run
   * that queues nothing reports the reason the server gave, and the counts
   * underneath refresh so the reason is visible rather than asserted.
   */
  const runNow = async () => {
    setBusy(true);
    setRan(null);
    try {
      const res = await fetch("/api/flags/autoApprove/run", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { queued?: number; skipped?: string | null; error?: string }
        | null;
      if (!res.ok) {
        setRan(body?.error ?? `The run failed (${res.status}).`);
      } else if ((body?.queued ?? 0) > 0) {
        setRan(
          `Queued ${body?.queued} for approval as ${owner}. They are applied by the decision ` +
            `worker within a minute or so — the queue shows each one as it lands.`,
        );
      } else if (body?.skipped) {
        setRan(`Nothing was queued: ${body.skipped}.`);
      } else {
        setRan("Nothing qualified. The counts below say why.");
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">Approve unflagged expenses automatically</p>
        <button
          type="button"
          onClick={() => void runNow()}
          disabled={busy || !on || theirs}
          title={theirs
            ? `Viewing as ${viewingAs}. Their next sweep is within fifteen minutes.`
            : on ? "Run a pass now instead of waiting for the next one" : "Switch it on first"}
          className="ml-auto rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"
        >
          Run now
        </button>
        <button
          type="button"
          onClick={() => void save({ enabled: !on })}
          disabled={busy}
          title={theirs ? `Start or stop ${viewingAs}'s automatic approvals.` : undefined}
          className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 ${
            on ? "border-amber-600/50 bg-amber-500/10 text-amber-700" : "border-border hover:bg-muted"
          }`}
        >
          {busy ? "Working…" : on ? "On" : "Off"}
        </button>
      </div>

      {theirs && (
        <p className="mt-2 rounded-lg bg-sky-500/10 p-2 text-xs">
          This is <strong>{viewingAs}</strong>&rsquo;s automation — their switch, their queue,
          their reasons. Starting or stopping it here is recorded against you, and every
          approval it then makes is applied by signing in as them, with their name on it in
          Emburse. Their next sweep is within fifteen minutes, so there is no Run now.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor="auto-per-run">At most</label>
        <input
          id="auto-per-run"
          type="number"
          min={1}
          max={100}
          value={draft ?? String(perRun)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft);
            setDraft(null);
            if (Number.isFinite(n) && n >= 1 && Math.round(n) !== perRun) void save({ amount: Math.round(n) });
          }}
          className="w-20 rounded-md border border-border bg-background px-2 py-1 tabular-nums"
        />
        <span>per pass.</span>
        {owner ? (
          <span className="text-muted-foreground">
            Made in Emburse as <strong className="font-semibold text-foreground">{owner}</strong>.
          </span>
        ) : (
          <span className="text-amber-700">Nobody owns it yet — whoever switches it on does.</span>
        )}
      </div>

      {ran && <p className="mt-2 whitespace-normal text-xs text-foreground">{ran}</p>}
      {report.data && <WhyNothingMoved report={report.data} />}

      <p className="mt-2 text-xs text-muted-foreground">
        Expenses that <em>no enabled rule flagged</em> are queued for approval without anybody
        clicking — every fifteen minutes, after each import, and whenever the receipt reader
        finishes a batch. They are applied under the login of whoever switched this on, and that
        person's name is what Emburse records against every one of them.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Two things it will not do. It never touches an expense a rule caught, one already decided,
        or one whose earlier decision failed and is waiting for somebody. And when any rule reads
        receipts, it skips an expense whose receipt has not been read yet — an unread receipt is
        unflagged because nothing has been checked, not because everything passed, so the newest
        expenses would otherwise be the ones it approved most readily.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        With no rules enabled it does nothing at all, and says so above: &ldquo;no flags&rdquo;
        means nothing when nothing is looking.
      </p>
    </div>
  );
}

type FuelFix = {
  dedupeKey: string; employee: string; merchant: string; note: string;
  from: string; to: string; reviewer: string; because: string;
};
type FuelReport = {
  on: boolean;
  rules: { id: number; name: string; to: string }[];
  would: FuelFix[];
};

/**
 * Putting the right category on a fuel purchase, without anybody clicking.
 *
 * Shows its working before it is switched on, because the whole case for
 * it is "these are obviously the same thing" and the only honest way to
 * make that case is to list them. Nine of ten under the Gas Category flag
 * on one morning were fuel filed as Travel or Meals or Small Tools, each
 * needing somebody to choose the category the rule had already named.
 */
function AutoFixGasCategory({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const report = useQuery<FuelReport>({
    queryKey: ["fuel-category-report"],
    enabled: isAdmin,
    queryFn: async () => {
      const res = await fetch("/api/flags/autoFixGasCategory/report");
      if (!res.ok) throw new Error("Could not read it");
      return (await res.json()) as FuelReport;
    },
  });
  if (!isAdmin) return null;

  const on = Boolean(report.data?.on);
  const would = report.data?.would ?? [];
  const rules = report.data?.rules ?? [];

  async function set(enabled: boolean): Promise<void> {
    setBusy(true);
    try {
      await fetch("/api/flags/autoFixGasCategory", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await qc.invalidateQueries({ queryKey: ["fuel-category-report"] });
      await qc.invalidateQueries({ queryKey: ["flags"] });
    } finally {
      setBusy(false);
    }
  }

  async function runNow(): Promise<void> {
    setBusy(true);
    setSaid("");
    try {
      const res = await fetch("/api/flags/autoFixGasCategory/run", { method: "POST" });
      const body = (await res.json()) as { queued?: number; skipped?: string; error?: string };
      setSaid(body.error
        ?? (body.queued ? `Sent ${body.queued} to Emburse.` : body.skipped ?? "Nothing qualified."));
      await qc.invalidateQueries({ queryKey: ["fuel-category-report"] });
      await qc.invalidateQueries({ queryKey: ["decisions"] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <h2 className="text-base font-bold">Fix a fuel category automatically</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A rule that says a category <em>must be</em> something has already named the right
        answer. This makes it true — but only where the receipt itself shows fuel, or came
        from a merchant that sells it, <strong>and</strong> the note says so. Either alone is
        not enough: a forecourt receipt can be a sandwich, and a note reading “gas” against a
        hotel bill is somebody typing in the wrong box.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        It changes a category and nothing else — never approves, never denies, never touches an
        amount. Each change goes to Emburse under the login of the reviewer whose queue it is
        in, and appears under <strong>Category sent</strong> in the queue.
      </p>

      {rules.length === 0 && (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          No rule names a category as its expectation, so there is nothing for this to make
          true. A rule whose <strong>must</strong> is “category is …” is what switches this on
          in practice.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void set(!on)}
          className={`rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${
            on ? "border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-200"
               : "border-border"
          }`}
        >
          {on ? "On" : "Off"}
        </button>
        <button
          type="button"
          disabled={busy || would.length === 0}
          onClick={() => void runNow()}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
        >
          Send these now
        </button>
        {said && <span className="text-sm text-muted-foreground">{said}</span>}
      </div>

      <p className="mt-3 text-sm">
        <strong className="tabular-nums">{would.length}</strong>
        {" "}would change right now{would.length > 0 ? ":" : "."}
      </p>
      {would.length > 0 && (
        <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
          {would.slice(0, 12).map((f) => (
            <li key={f.dedupeKey}>
              <span className="font-semibold text-foreground">{f.employee}</span>
              {" · "}{f.merchant}{" · "}
              <span className="line-through">{f.from || "no category"}</span>
              {" → "}<span className="font-semibold text-foreground">{f.to}</span>
              <span className="block pl-3 opacity-80">{f.because}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Keeping the step-by-step trace of each approve and deny.
 *
 * It earns its place: before it, the only way to learn WHERE an approval
 * failed was to approve a real expense and read a one-sentence error that
 * could mean a wrong password, a device check, an account without the team
 * view, or a renamed button — four causes, four different fixes, one
 * message.
 *
 * Off by default, and said plainly rather than left to be discovered: it
 * attaches a browser transcript to every decision, which a working queue
 * has no use for.
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
        <p className="text-sm font-semibold">Show every step of an approve or deny</p>
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
        With this on, the browser run is shown stage by stage — signing in, switching to the team
        view, finding the row, verifying it, clicking — on each decision, where a failed one keeps
        its trace to open later.
        Turn it on to work out <em>where</em> something breaks; turn it off once it works, because a
        healthy queue has no use for a six-line transcript above it.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        A run that <em>fails</em> shows its steps either way. That is the moment they are wanted,
        and having to switch this on and then reproduce the failure is how a one-off gets lost.
      </p>
    </div>
  );
}
