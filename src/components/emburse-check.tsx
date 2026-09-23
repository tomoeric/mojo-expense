import { useState } from "react";
import { PlugZap, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";

type Step = { name: string; ok: boolean; detail: string; ms: number };
type Result = { ok: boolean; who?: string; steps?: Step[]; screenshot?: string | null; error?: string };

/**
 * Test your own Emburse connection, without approving anything.
 *
 * Approving used to be the only way to find out whether a login worked, so the
 * first thing a new reviewer learned was that a real expense "did not go
 * through" — with the real cause three screens away in the export log.
 *
 * It goes as far as opening the expenses grid, which is everything a decision
 * does except click the button. So it reproduces the actual failure on demand,
 * and a verification code raised along the way can be answered here — once,
 * after which the device is remembered.
 */
export function EmburseCheck({ canDecide }: { canDecide: boolean }) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/emburse-check", { method: "POST" });
      setResult((await res.json()) as Result);
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <PlugZap className="h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm font-semibold">Your Emburse connection</p>
        <p className="text-xs text-muted-foreground">
          {canDecide
            ? "Signs in as you and opens the expenses grid. Approves nothing."
            : "Add your Emburse login first — there is nothing to test yet."}
        </p>
        <button
          type="button"
          onClick={run}
          disabled={busy || !canDecide}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
          {busy ? "Testing — this takes a minute…" : "Test connection"}
        </button>
      </div>

      {busy && (
        <p className="mt-2 text-xs text-muted-foreground">
          Signing in to Emburse in a real browser. If it asks to verify the device, the prompt appears
          above — the code goes to you.
        </p>
      )}

      {result && (
        <div className="mt-2">
          <p
            className={`flex items-center gap-1.5 text-sm font-semibold ${
              result.ok ? "text-emerald-700" : "text-amber-800"
            }`}
          >
            {result.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {result.ok ? "Connected — approvals should go through." : "Could not connect."}
          </p>

          {result.error && <p className="mt-1 text-xs text-amber-800">{result.error}</p>}

          {/* Every step, not only the failure: knowing it got as far as the
              grid and stopped there is the difference between a login problem
              and a selector problem. */}
          {result.steps && result.steps.length > 0 && (
            <ol className="mt-2 space-y-1">
              {result.steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  {s.ok ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  )}
                  <span className="min-w-0">
                    <span className="font-semibold">{s.name}</span>
                    <span className="text-muted-foreground"> — {s.detail}</span>
                  </span>
                  <span className="tnum ml-auto shrink-0 text-muted-foreground">
                    {(s.ms / 1000).toFixed(1)}s
                  </span>
                </li>
              ))}
            </ol>
          )}

          {result.screenshot && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                What the page looked like when it stopped
              </summary>
              <img
                src={`data:image/png;base64,${result.screenshot}`}
                alt="Emburse at the point of failure"
                className="mt-1 max-h-96 w-full rounded-lg border border-border object-contain"
              />
            </details>
          )}
        </div>
      )}
    </div>
  );
}
