import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PlugZap, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { useDecisions } from "@/lib/decisions";
import { CodePrompt } from "./code-prompt";

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
 * and a verification code raised along the way is answered HERE.
 *
 * That last word used to be a lie. The run parks for ten minutes waiting for
 * somebody to type a code, this component said "the prompt appears above",
 * and the only page that rendered one was the queue — which is not where
 * anybody is when they are setting their login up. So a new reviewer pressed
 * Test, watched "this takes a minute" for ten of them, and was told nobody
 * had entered the code. The prompt is in this box now, where the person who
 * just pressed the button is looking.
 */
export function EmburseCheck({ canDecide }: { canDecide: boolean }) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const { challenge, answerCode } = useDecisions([]);

  /**
   * Ask for the challenge while a test is running.
   *
   * The decisions poll only runs itself when something is already pending or
   * a challenge is already known, and at the moment the test starts neither
   * is true — so nothing would ever notice the prompt appearing. Two seconds
   * is cheap against a run that takes sixty.
   */
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ["decisions"] }), 2000);
    return () => clearInterval(t);
  }, [busy, qc]);

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

      {busy && !challenge && (
        <p className="mt-2 text-xs text-muted-foreground">
          Signing in to Emburse in a real browser. If it asks to verify the device, the prompt
          appears here — the code is emailed to you. It can also be waiting behind an import, which
          takes a few minutes.
        </p>
      )}

      {/* Right here, because here is where the person who pressed the button
          is looking. It is also shown when a test is NOT running: a code can
          be raised by the scheduled import, and whoever can answer it should
          be able to without hunting for the page that happens to render it. */}
      {challenge && (
        <div className="mt-2">
          <CodePrompt
            challenge={challenge}
            busy={answerCode.isPending}
            error={answerCode.error ? (answerCode.error as Error).message : ""}
            onAnswer={(code) => answerCode.mutate(code)}
          />
        </div>
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
