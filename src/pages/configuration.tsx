import { useState } from "react";
import {
  Loader2, Tags, MapPin, Building2, ChevronRight, Sparkles, CheckCircle2, AlertTriangle,
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
