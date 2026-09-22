import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, FlaskConical, Loader2, CheckCircle2, XCircle, Image, ChevronDown, Wrench, ShieldQuestion } from "lucide-react";
import { SelectorEditor } from "@/components/selector-editor";

type Step = { name: string; ok: boolean; detail: string; ms: number };

type Challenge = {
  id: string;
  prompt: string;
  screenshot: string | null;
  owner: string;
  mine: boolean;
  startedAt: string;
  expiresAt: string;
  attempts: number;
  attemptsLeft: number;
  lastError: string | null;
};

type Run = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  localDate: string;
  attempt: number;
  trigger: string;
  ok: boolean | null;
  steps: Step[];
  itemLine: string | null;
  error: string | null;
  importId: number | null;
  hasScreenshot: boolean;
};

/**
 * Run the export by hand and watch every step.
 *
 * This is how the selectors get fixed. Emburse's markup is not knowable from
 * outside their tenant, so the first real run will stop somewhere — and what
 * makes that tractable rather than a guessing game is seeing exactly which step
 * stopped it, what it was looking for, and a picture of the page it was looking
 * at. Correct one selector, run again.
 *
 * A test run does everything up to the point of clicking Export, so it can be
 * repeated as often as needed without asking Emburse to build a file or sending
 * anybody an email.
 */
export function ExportRunner({
  isAdmin,
  selectors,
  help,
  stepSelectors,
  defaults,
  onSaveSelectors,
}: {
  isAdmin: boolean;
  selectors: Record<string, string>;
  help: Record<string, string>;
  stepSelectors: Record<string, string[]>;
  defaults: Record<string, string>;
  onSaveSelectors: (next: Record<string, string>) => Promise<void>;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"" | "dry" | "real">("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [answering, setAnswering] = useState(false);
  const [codeError, setCodeError] = useState("");

  const q = useQuery({
    queryKey: ["export-runs"],
    queryFn: async () => {
      const res = await fetch("/api/export-runs");
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      return (await res.json()) as {
        configured: boolean;
        due: { due: boolean; attempt: number; reason: string };
        runs: Run[];
        challenge: Challenge | null;
      };
    },
    // While a run is going, the list is the only progress indicator there is.
    // The slow poll when idle is for the parked-sign-in case: a challenge can
    // be waiting from a run somebody started in another tab, and a browser
    // held open with nobody looking at it is the whole thing to avoid.
    refetchInterval: (query) => (busy || query.state.data?.challenge ? 3000 : 20_000),
  });

  const challenge = q.data?.challenge ?? null;

  async function run(dry: boolean) {
    setBusy(dry ? "dry" : "real");
    setError("");
    try {
      const res = await fetch(`/api/export-run${dry ? "?dryRun=1" : ""}`, { method: "POST" });
      const body = (await res.json()) as { error?: string; id?: number };
      if (!res.ok) throw new Error(body.error ?? `Run failed (${res.status})`);
      if (body.id) setOpen(body.id);
      await qc.invalidateQueries({ queryKey: ["export-runs"] });
      await qc.invalidateQueries({ queryKey: ["imports"] });
      await qc.invalidateQueries({ queryKey: ["reports"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function sendCode() {
    setAnswering(true);
    setCodeError("");
    try {
      const res = await fetch("/api/export-challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Could not send the code (${res.status})`);
      setCode("");
      // The run carries on inside the request that started it; the poll below
      // is what tells us whether Emburse accepted this.
      await qc.invalidateQueries({ queryKey: ["export-runs"] });
    } catch (err) {
      setCodeError((err as Error).message);
    } finally {
      setAnswering(false);
    }
  }

  async function giveUp() {
    setCodeError("");
    try {
      const res = await fetch("/api/export-challenge", { method: "DELETE" });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Could not cancel");
      await qc.invalidateQueries({ queryKey: ["export-runs"] });
    } catch (err) {
      setCodeError((err as Error).message);
    }
  }

  const runs = q.data?.runs ?? [];

  return (
    <div className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Play className="h-4 w-4" />
          Run the export
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The app signs into Emburse and fetches today&rsquo;s export itself. Start one here to see every
          step — a <strong>test run</strong> stops just before clicking Export, so nothing is produced and
          nobody is emailed.
        </p>
      </div>

      {q.data && !q.data.configured && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          No Emburse login is stored yet. Add one under <strong>Your Emburse login</strong> in the user
          menu, then come back.
        </p>
      )}

      {q.data?.due && (
        <p className="text-xs text-muted-foreground">
          Scheduler: {q.data.due.due ? "an attempt is due now" : q.data.due.reason}.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!isAdmin || busy !== ""}
          onClick={() => void run(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm font-semibold transition-colors hover:bg-muted disabled:opacity-40"
        >
          {busy === "dry" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
          {busy === "dry" ? "Testing…" : "Test run"}
        </button>

        <button
          type="button"
          disabled={!isAdmin || busy !== ""}
          onClick={() => void run(false)}
          className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
        >
          {busy === "real" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {busy === "real" ? "Running…" : "Run export now"}
        </button>

        {busy !== "" && (
          <span className="text-xs text-muted-foreground">
            Emburse queues the export, so a real run can take several minutes.
          </span>
        )}
      </div>

      {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">{error}</p>}

      {/* A sign-in parked mid-way, waiting on a person. This is the only screen
          in the app where a browser is sitting open on the server holding a
          half-finished login, so it says plainly what is happening, who it is
          waiting for, and how long it will wait. */}
      {challenge && (
        <div className="space-y-3 rounded-xl border border-sky-500/40 bg-sky-500/5 p-4">
          <div className="flex items-start gap-2.5">
            <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-sky-600" aria-hidden />
            <div className="min-w-0">
              <h3 className="text-sm font-bold">Emburse wants a verification code</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {challenge.mine ? (
                  <>
                    The sign-in is paused waiting for it. Enter the code Emburse just sent and the run
                    carries on from where it stopped — and because the app ticks{" "}
                    <em>remember this device</em>, it should not have to ask again.
                  </>
                ) : (
                  <>
                    A run started by <strong>{challenge.owner}</strong> is waiting for a code. Only they can
                    enter it — the code is going into their sign-in, not yours.
                  </>
                )}
              </p>
            </div>
          </div>

          <p className="rounded-lg border border-border bg-background/60 p-2.5 text-xs text-muted-foreground">
            Emburse says: “{challenge.prompt}”
          </p>

          {challenge.lastError && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs">{challenge.lastError}</p>
          )}

          {challenge.mine && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && code.trim() && !answering) void sendCode();
                  }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={10}
                  placeholder="123456"
                  aria-label="Verification code from Emburse"
                  className="tnum w-36 rounded-lg border border-border bg-background px-3 py-2 text-base tracking-[0.3em]"
                />
                <button
                  type="button"
                  disabled={answering || !code.trim()}
                  onClick={() => void sendCode()}
                  className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
                >
                  {answering ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {answering ? "Sending…" : "Send the code"}
                </button>
                <button
                  type="button"
                  onClick={() => void giveUp()}
                  className="rounded-lg border border-border px-3 py-2 text-sm font-semibold transition-colors hover:bg-muted"
                >
                  Cancel the run
                </button>
              </div>

              <p className="text-xs text-muted-foreground">
                {challenge.attemptsLeft} attempt{challenge.attemptsLeft === 1 ? "" : "s"} left · gives up at{" "}
                {new Date(challenge.expiresAt).toLocaleTimeString()}
              </p>
            </>
          )}

          {codeError && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs">{codeError}</p>
          )}

          {challenge.screenshot && (
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
                Show the page Emburse is on
              </summary>
              <img
                src={`data:image/png;base64,${challenge.screenshot}`}
                alt="The Emburse verification page"
                className="mt-2 max-h-96 w-full rounded-lg border border-border object-contain object-top"
              />
            </details>
          )}
        </div>
      )}

      {runs.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {runs.map((r) => {
            const failed = r.steps.find((s) => !s.ok);
            const expanded = open === r.id;
            return (
              <div key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : r.id)}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted"
                >
                  {r.ok === null ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : r.ok ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <XCircle className="h-4 w-4 shrink-0 text-red-600" />
                  )}

                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-semibold">
                      {r.ok === null ? "Running" : r.ok ? "Succeeded" : `Stopped at “${failed?.name ?? "start"}”`}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}· {r.trigger} · {new Date(r.startedAt).toLocaleString()}
                      {r.itemLine ? ` · ${r.itemLine}` : ""}
                    </span>
                  </span>

                  <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground ${expanded ? "rotate-180" : ""}`} />
                </button>

                {expanded && (
                  <div className="space-y-3 border-t border-border bg-muted/30 px-3 py-3">
                    <ol className="space-y-1">
                      {r.steps.map((s, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          {s.ok ? (
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                          ) : (
                            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
                          )}
                          <span className="w-52 shrink-0 font-semibold">{s.name}</span>
                          <span className={`min-w-0 flex-1 break-words ${s.ok ? "text-muted-foreground" : "text-red-600"}`}>
                            {s.detail}
                          </span>
                          <span className="tnum shrink-0 text-muted-foreground">{(s.ms / 1000).toFixed(1)}s</span>
                        </li>
                      ))}
                    </ol>

                    {r.error && (
                      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">{r.error}</p>
                    )}

                    {/* The fix, offered where the failure is reported rather
                        than somewhere else on the page: the step that broke
                        knows exactly which selectors it used. */}
                    {failed && (stepSelectors[failed.name]?.length ?? 0) > 0 && (
                      <div>
                        <button
                          type="button"
                          onClick={() => setFixing(fixing === failed.name ? null : failed.name)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold hover:bg-muted"
                        >
                          <Wrench className="h-3.5 w-3.5" />
                          {fixing === failed.name
                            ? "Hide the selectors"
                            : `Fix the ${stepSelectors[failed.name]!.length} selector(s) this step used`}
                        </button>

                        {fixing === failed.name && (
                          <div className="mt-2">
                            <SelectorEditor
                              selectors={selectors}
                              help={help}
                              stepSelectors={stepSelectors}
                              defaults={defaults}
                              focusStep={failed.name}
                              isAdmin={isAdmin}
                              onSave={onSaveSelectors}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {r.hasScreenshot && (
                      <div>
                        <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                          <Image className="h-3.5 w-3.5" aria-hidden />
                          The page it stopped on
                        </p>
                        {/* The single most useful thing when a selector is wrong:
                            what Emburse was actually showing at that moment. */}
                        <a href={`/api/export-runs/${r.id}/screenshot`} target="_blank" rel="noreferrer">
                          <img
                            src={`/api/export-runs/${r.id}/screenshot`}
                            alt="The Emburse page where the run stopped"
                            className="max-h-96 w-full rounded-lg border border-border object-contain object-top"
                          />
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
