import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Play, FlaskConical, Loader2, CheckCircle2, XCircle, Image, ChevronDown, Wrench,
  ShieldQuestion, ShieldCheck,
} from "lucide-react";
import { SelectorEditor } from "@/components/selector-editor";

type Step = { name: string; ok: boolean; detail: string; ms: number };

/**
 * Read a response that is supposed to be JSON, and say something useful when
 * it is not.
 *
 * The proxy in front of the app answers a request it gave up on with
 * `upstream request timeout` in plain text, which `res.json()` reports as
 * `Unexpected token 'u'` — a message that sends you looking at the wrong
 * thing entirely.
 */
async function readJson<T>(res: Response): Promise<T> {
  const body = await res.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(
      res.status === 504 || /timeout/i.test(body)
        ? "The request timed out on the way to the server. The run itself may still be going — " +
          "give the list below a moment."
        : `The server replied with something unexpected (${res.status}): ${body.slice(0, 120)}`,
    );
  }
}

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

/**
 * Is this run still going?
 *
 * A run records itself before it starts and updates itself when it finishes,
 * so `ok === null` means in progress — unless the process died in between, in
 * which case the row would say that forever and the buttons would stay
 * disabled. The server closes those out on boot; this is the belt to that
 * braces, for a row orphaned by something else.
 */
const isRunning = (r: Run) =>
  r.ok === null && Date.now() - new Date(r.startedAt).getTime() < 30 * 60_000;

/** Milliseconds as mm:ss — what somebody watching a run actually wants. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

const live = (d: { runs?: Run[]; challenge?: Challenge | null } | undefined) =>
  Boolean(d?.challenge) || (d?.runs ?? []).some(isRunning);

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
  /** Whose Needs Review this run read. Blank is the shared import. */
  reviewer: string;
  /** Which Emburse list. Blank is Transactions. */
  source: string;
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
  reviewer,
  lists,
  selectors,
  help,
  stepSelectors,
  defaults,
  onSaveSelectors,
}: {
  isAdmin: boolean;
  /**
   * Whose import this section is for — the reviewer tab selected above.
   *
   * It had no such input: the buttons ran the signed-in person's import
   * whatever tab was open, so pressing Run on Brian's tab imported Eric's
   * queue. Three separate reports of the same thing, each answered with
   * "that section is not part of that tab", which is a true sentence
   * about a page nobody should have to learn.
   */
  reviewer: string | null;
  /**
   * The Emburse lists this reviewer imports.
   *
   * Without it the buttons could only run Transactions, so a second list
   * could be configured and scheduled and never once tried by hand — and
   * the only way to find out whether Reimbursements worked was to wait for
   * tomorrow's scheduled run.
   */
  lists: { key: string; label: string }[];
  selectors: Record<string, string>;
  help: Record<string, string>;
  stepSelectors: Record<string, string[]>;
  defaults: Record<string, string>;
  onSaveSelectors: (next: Record<string, string>) => Promise<void>;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"" | "dry" | "real">("");
  /** Which list the buttons act on. The first one they have, by default. */
  const [source, setSource] = useState<string | null>(null);
  const onList = source ?? lists[0]?.key ?? "";
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [answering, setAnswering] = useState(false);
  const [codeError, setCodeError] = useState("");

  const q = useQuery({
    queryKey: ["export-runs", reviewer ?? ""],
    queryFn: async () => {
      const res = await fetch(
        `/api/export-runs${reviewer ? `?reviewer=${encodeURIComponent(reviewer)}` : ""}`);
      const body = await readJson<{
        error?: string;
        configured: boolean;
        due: { due: boolean; attempt: number; reason: string };
        runs: Run[];
        challenge: Challenge | null;
        deviceRememberedAt: string | null;
        viewingAs: string | null;
        runsFor: string | null;
        legacyDeviceAt: string | null;
        people: string[];
        browser: { holder: { label: string; since: number } | null; waiting: string[] };
        stopping: number[];
      }>(res);
      if (!res.ok) throw new Error(body.error ?? "Failed");
      return body as {
        configured: boolean;
        due: { due: boolean; attempt: number; reason: string };
        runs: Run[];
        challenge: Challenge | null;
        deviceRememberedAt: string | null;
        viewingAs: string | null;
        runsFor: string | null;
        legacyDeviceAt: string | null;
        people: string[];
        browser: { holder: { label: string; since: number } | null; waiting: string[] };
        stopping: number[];
      };
    },
    // While a run is going, the list is the only progress indicator there is.
    // The slow poll when idle is for the parked-sign-in case: a challenge can
    // be waiting from a run somebody started in another tab, and a browser
    // held open with nobody looking at it is the whole thing to avoid.
    refetchInterval: (query) => (live(query.state.data) ? 3000 : 20_000),
    // Keep polling with the tab in the background. This is not a nicety: the
    // one moment the page most needs to be current is while its owner is in
    // their email app looking for the code it is about to ask for. Stopping
    // then is how a prompt goes unseen until it has already timed out.
    refetchIntervalInBackground: true,
  });

  const challenge = q.data?.challenge ?? null;
  // Derived from the data rather than from whether this tab started the run,
  // so a reload, a second tab, or a request the proxy dropped all still show
  // a run in progress.
  // Ticks once a second while something is running, so the clock moves
  // between polls rather than jumping every three seconds.
  const [now, setNow] = useState(() => Date.now());
  const active = (q.data?.runs ?? []).find(isRunning) ?? null;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  const working = busy !== "" || active !== null;
  // Which of the two buttons is the one in flight. Both used to spin, which
  // made a test run look like a real one.
  const kind = active ? (active.trigger === "dry-run" ? "dry" : "real") : busy;

  async function run(dry: boolean) {
    setBusy(dry ? "dry" : "real");
    setError("");
    try {
      // Returns as soon as the run has an id. Everything after that — progress,
      // a verification code prompt, the result — arrives through the poll,
      // which is the only way this can survive a run that outlives a request.
      const res = await fetch(`/api/export-run${dry ? "?dryRun=1" : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Whose import. The selected tab, so the buttons under it mean what
        // the tab says. The list itself is never sent — a real import that
        // took its list from a request is how it reads the wrong queue.
        body: JSON.stringify({
          ...(reviewer ? { reviewer } : {}),
          ...(onList ? { source: onList } : {}),
        }),
      });
      const body = await readJson<{ error?: string; id?: number }>(res);
      if (!res.ok) throw new Error(body.error ?? `Run failed (${res.status})`);
      if (body.id) setOpen(body.id);
      await qc.invalidateQueries({ queryKey: ["export-runs"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  // A finished run refreshes the import and report pages once, so they pick it
  // up without anybody reloading. The request that starts a run no longer waits
  // for it, so this is the only place that knows when one has actually landed.
  const newestDone = q.data?.runs?.find((r) => r.ok !== null)?.id ?? null;
  useEffect(() => {
    if (newestDone === null) return;
    void qc.invalidateQueries({ queryKey: ["imports"] });
    void qc.invalidateQueries({ queryKey: ["reports"] });
  }, [newestDone, qc]);

  async function sendCode() {
    setAnswering(true);
    setCodeError("");
    try {
      const res = await fetch("/api/export-challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await readJson<{ error?: string }>(res);
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

  async function stop(id: number) {
    setError("");
    try {
      const res = await fetch(`/api/export-runs/${id}/stop`, { method: "POST" });
      if (!res.ok) throw new Error((await readJson<{ error?: string }>(res)).error ?? "Could not stop it");
      await qc.invalidateQueries({ queryKey: ["export-runs"] });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** Keep a trust already earned, under the account it belongs to. */
  async function adopt(email: string): Promise<void> {
    setBusy("real");
    try {
      await fetch("/api/export-device/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      await qc.invalidateQueries({ queryKey: ["export-runs"] });
    } finally {
      setBusy("");
    }
  }

  async function forgetDevice() {
    setError("");
    try {
      const res = await fetch("/api/export-device", { method: "DELETE" });
      if (!res.ok) throw new Error((await readJson<{ error?: string }>(res)).error ?? "Could not forget it");
      await qc.invalidateQueries({ queryKey: ["export-runs"] });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function giveUp() {
    setCodeError("");
    try {
      const res = await fetch("/api/export-challenge", { method: "DELETE" });
      if (!res.ok) throw new Error((await readJson<{ error?: string }>(res)).error ?? "Could not cancel");
      await qc.invalidateQueries({ queryKey: ["export-runs"] });
    } catch (err) {
      setCodeError((err as Error).message);
    }
  }

  const runs = q.data?.runs ?? [];

  return (
    <div className="space-y-3">
      {/* No heading, no "whose is this" banner, no second description.
          This sits inside that person's tab now, under their name — the
          three paragraphs that used to say so were there because it did
          not, and they were the bulk of what made the page unreadable. */}
      <h3 className="flex items-center gap-2 text-sm font-bold">
        <Play className="h-4 w-4" />
        Run it
      </h3>
      {/* Which list, when they import more than one. One pair of buttons
          that silently meant Transactions made the second list untestable. */}
      {lists.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
          {lists.map((l) => (
            <button
              key={l.key}
              type="button"
              onClick={() => setSource(l.key)}
              className={`rounded-md px-3 py-1 text-sm font-semibold ${
                onList === l.key ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        A <strong>test run</strong> stops before exporting: nothing produced, nothing imported,
        nobody emailed — it just reads the item count off the list, which tells you whose queue
        it is. <strong>Run export now</strong> does the real import.
      </p>

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

      {/* Whether Emburse still trusts this browser. Worth stating, because the
          alternative is discovering it only when a run stops to ask for a
          code — and because a jar that has gone stale needs a way out. */}
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {q.data?.deviceRememberedAt ? (
          <>
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
            Emburse trusts this browser — remembered {new Date(q.data.deviceRememberedAt).toLocaleString()}.
            {isAdmin && (
              <button
                type="button"
                onClick={() => void forgetDevice()}
                className="underline underline-offset-2 hover:text-foreground"
              >
                Forget it
              </button>
            )}
          </>
        ) : (
          <>
            <ShieldQuestion className="h-3.5 w-3.5" aria-hidden />
            Emburse does not know this browser yet, so the next run may ask for a verification code.
          </>
        )}
      </p>

      {/* A device trusted before the jars were keyed per account. It is
          somebody's, the app cannot know whose, and until that is said the
          person it belongs to would be asked for a code they have already
          given — which for a reviewer who is not the admin means
          interrupting them to read one out. */}
      {isAdmin && q.data?.legacyDeviceAt && !q.data?.deviceRememberedAt && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <p>
            Emburse already trusts this browser from{" "}
            {new Date(q.data.legacyDeviceAt).toLocaleString()}, from before the app kept a
            separate sign-in per account. Say whose it is and they keep it — no new
            verification code.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {(q.data.people ?? []).map((who) => (
              <button
                key={who}
                type="button"
                disabled={working}
                onClick={() => void adopt(who)}
                className="rounded-lg border border-border bg-background px-3 py-1 text-xs font-semibold disabled:opacity-50"
              >
                It is {who}&rsquo;s
              </button>
            ))}
          </div>
        </div>
      )}

      {isAdmin && <WatchBrowser live={working} />}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!isAdmin || working}
          onClick={() => void run(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm font-semibold transition-colors hover:bg-muted disabled:opacity-40"
        >
          {kind === "dry" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
          {kind === "dry" ? "Testing…" : "Test run"}
        </button>

        {/* A trial list applies to a TEST run only — the server ignores it on
            a real one, deliberately, because an import taking its list from
            a request is how it reads the wrong queue. Silently ignoring it
            was worse than refusing: a run went off with "/transactions" in
            the box, used the configured team-wide list, and looked like the
            trial had been honoured and failed. */}
        <button
          type="button"
          disabled={!isAdmin || working}
          onClick={() => void run(false)}
          className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
        >
          {kind === "real" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {kind === "real" ? "Running…" : "Run export now"}
        </button>


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

      {active && (() => {
        // The step list is the canonical order, so "3 of 10" is real rather
        // than a guess, and the step currently running is the one after the
        // last that finished.
        const order = Object.keys(stepSelectors);
        const done = active.steps.length;
        const current = order[done] ?? "finishing up";
        /*
         * Not started is not the same as on step one.
         *
         * One browser runs everything in turn, so a run can be recorded,
         * shown as running, and be doing nothing at all because a decision
         * batch has the browser. With no step finished this said "Step 1 of
         * 12 · open Emburse" and counted upwards, next to a watch panel
         * reading "Nothing is running just now" — two true lines that
         * together describe a hang that is not happening.
         */
        const holder = q.data?.browser?.holder ?? null;
        const queued = done === 0 && holder !== null
          && !holder.label.toLowerCase().includes("export");
        const asked = (q.data?.stopping ?? []).includes(active.id);
        const elapsed = clock(now - new Date(active.startedAt).getTime());
        const stepStarted = active.steps.reduce((sum, st) => sum + st.ms, 0);
        const onStep = clock(now - new Date(active.startedAt).getTime() - stepStarted);

        return (
          <div className="space-y-1.5 rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600" aria-hidden />
              <span className="font-semibold">
                {queued
                  ? `Waiting for the browser — ${holder!.label} has it`
                  : `Step ${Math.min(done + 1, order.length)} of ${order.length} · ${current}`}
              </span>
              <span className="tnum text-muted-foreground">
                {onStep} on this step · {elapsed} total
              </span>
              {isAdmin && (
                <button
                  type="button"
                  disabled={asked}
                  onClick={() => void stop(active.id)}
                  className="ml-auto rounded-lg border border-border px-2.5 py-1 font-semibold hover:bg-muted disabled:opacity-50"
                >
                  {asked ? "Stopping…" : "Stop this run"}
                </button>
              )}
            </div>

            {/* One bar, so how far along it is readable without counting. */}
            <div className="h-1 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-sky-600 transition-all"
                style={{ width: `${Math.round((done / order.length) * 100)}%` }}
              />
            </div>

            <p className="text-muted-foreground">
              {asked
                ? "Stopping — the browser is being shut, which ends whatever it was waiting on."
                : queued
                  ? "Nothing is wrong: one browser runs everything in turn, and this one starts as soon as it is free."
                  : current === "wait for the export and download it"
                    ? "Emburse is building the file. This is the long one — up to 15 minutes."
                    : "Running on the server. You can leave this page and come back."}
            </p>
          </div>
        );
      })()}

      {runs.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {runs.map((r) => {
            const failed = r.steps.find((s) => !s.ok);
            // A run in progress opens itself: its step list is the answer to
            // the only question anybody has while it is going.
            const expanded = open === r.id || (open === null && isRunning(r));
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
                      {/* Whose queue it read. Two reviewers make an unlabelled
                          history unreadable: a successful 320-item pull sitting
                          above your own run looks like what yours is about to
                          do, whoever it actually belonged to. */}
                      {r.reviewer ? ` · ${r.reviewer}` : ""}
                      {r.source ? ` · ${r.source}` : ""}
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

/**
 * Watch the browser while it works.
 *
 * Not a window — the app runs headless on a VM with no display. A frame of
 * the page, fetched while you are looking at it, which is the part of
 * "show me the browser" that anybody actually wants: seeing what it is
 * looking at when a step takes a minute and the log says nothing.
 *
 * Off by default and only polls while open, because each frame is a real
 * screenshot taken by the same Chromium that is driving Emburse, on one
 * vCPU. The server caps the rate too — the page asking faster cannot make
 * it cost more — but not asking at all is cheaper than being capped.
 */
function WatchBrowser({ live }: { live: boolean }) {
  // Open itself when a run starts. The toggle existed and the picture did
  // not appear, because nobody presses a button to see something they
  // assumed was already showing.
  const [on, setOn] = useState(false);
  const [why, setWhy] = useState("");
  useEffect(() => { if (live) setOn(true); }, [live]);
  const [src, setSrc] = useState<string | null>(null);
  const [doing, setDoing] = useState("");
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!on) { setSrc(null); return; }
    let stopped = false;
    let url: string | null = null;

    const grab = async () => {
      try {
        const res = await fetch("/api/export-live.png", { cache: "no-store" });
        if (stopped) return;
        if (!res.ok) {
          setGone(true);
          // Say WHICH no. A 404 is "nothing running", a 403 is "not an
          // admin", and a 500 is a bug — shown as one blank panel before.
          setWhy(res.status === 404
            ? "Nothing is running just now."
            : res.status === 403
              ? "Only an administrator can watch a run."
              : `The server said ${res.status}.`);
          return;
        }
        setGone(false);
        setWhy("");
        setDoing(res.headers.get("x-doing") ?? "");
        const blob = await res.blob();
        if (stopped) return;
        // Revoke the previous frame's URL, or a long watch leaks one object
        // URL every two seconds.
        const next = URL.createObjectURL(blob);
        if (url) URL.revokeObjectURL(url);
        url = next;
        setSrc(next);
      } catch {
        // A dropped poll is not worth reporting; the next one is 2s away.
      }
    };

    void grab();
    const t = setInterval(() => void grab(), 2000);
    return () => {
      stopped = true;
      clearInterval(t);
      if (url) URL.revokeObjectURL(url);
    };
  }, [on]);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOn((v) => !v)}
          className={`rounded-lg border px-3 py-1 text-sm font-semibold ${
            on ? "border-sky-500/50 bg-sky-500/10" : "border-border"
          }`}
        >
          {on ? "Stop watching" : "Watch the browser"}
        </button>
        <span className="text-xs text-muted-foreground">
          {on
            ? gone
              ? why || "Nothing is running."
              : doing ? `Now: ${doing}` : "Taking the first picture…"
            : live
              ? "A run is going — see what it is looking at."
              : "A picture of the page, while a run is going."}
        </span>
      </div>
      {on && src && (
        <img
          src={src}
          alt="What the Emburse browser is looking at"
          className="mt-2 w-full rounded-lg border border-border"
        />
      )}
      {on && !src && !gone && (
        <div className="mt-2 flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
          Waiting for the first frame…
        </div>
      )}
    </div>
  );
}
