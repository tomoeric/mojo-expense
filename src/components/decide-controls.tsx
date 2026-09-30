import { useState } from "react";
import {
  Check, X, Loader2, Clock, AlertTriangle, Undo2, FlaskConical, ShieldCheck, Bot, CircleSlash,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { inspectEditForm, retryDecision, testDecision, type QueuedDecision } from "@/lib/decisions";
import { useConfig } from "@/lib/api";
import { moneyExact } from "@/lib/format";

/**
 * Approve or deny one expense, from the row it is on.
 *
 * Approving is one click, because it is the common case and it is reversible
 * right up until the worker picks it up. Denying opens a dialog, because it
 * needs a reason the employee will read and because it is the decision people
 * regret.
 */
export function DecideButtons({
  expense,
  decision,
  busy,
  canDecide,
  onApprove,
  onDeny,
  onCancel,
}: {
  expense: { dedupeKey: string; employee: string; merchant: string; amount: number; date: string | null };
  decision: QueuedDecision | undefined;
  busy: boolean;
  /** False when this person has no Emburse login, so nothing could carry it out. */
  canDecide: boolean;
  onApprove: () => void;
  onDeny: (reason: string) => void;
  onCancel: (id: number) => void;
}) {
  const [denying, setDenying] = useState(false);

  // Already decided AND it stuck: show what happened, not another pair of
  // buttons. A failure is different — it left the expense undecided in
  // Emburse, so it has to be re-doable or the row is simply stranded, which
  // is what happened the first time somebody hit one.
  const settled = decision && decision.state !== "cancelled" && decision.state !== "failed";
  if (settled) {
    return (
      <>
        <DecisionBadge decision={decision} onCancel={onCancel} />
        {denying && (
          <DenyDialog expense={expense} onClose={() => setDenying(false)} onConfirm={onDeny} />
        )}
      </>
    );
  }

  if (!canDecide) {
    return decision?.state === "failed" ? (
      <DecisionBadge decision={decision} onCancel={onCancel} />
    ) : (
      <span className="text-xs text-muted-foreground">—</span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {decision?.state === "failed" && (
        <DecisionBadge decision={decision} onCancel={onCancel} />
      )}
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onApprove();
        }}
        title="Approve in Emburse"
        className="inline-flex items-center gap-1 rounded-lg border border-emerald-600/40 px-2 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-600/10 disabled:opacity-40 dark:text-emerald-400"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        Approve
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setDenying(true);
        }}
        title="Deny in Emburse"
        className="inline-flex items-center gap-1 rounded-lg border border-red-600/40 px-2 py-1 text-xs font-semibold text-red-700 transition-colors hover:bg-red-600/10 disabled:opacity-40 dark:text-red-400"
      >
        <X className="h-3.5 w-3.5" />
        Deny
      </button>

      {denying && (
        <DenyDialog expense={expense} onClose={() => setDenying(false)} onConfirm={onDeny} />
      )}
    </div>
  );
}

/**
 * What became of a decision, and the one way back out of it.
 *
 * The detail opens in a DIALOG rather than under the badge. It used to
 * expand in place — inside the Decision column, which is about 180px wide,
 * holding a six-stage trace, a Playwright error and a full screenshot of a
 * transactions grid. Every line wrapped to two words and the picture was a
 * thumbnail of a page. The information was all there and none of it was
 * legible, which is the same as not having it.
 */
/**
 * How long ago, in the fewest words that are still true.
 *
 * Null is "at some point" — rows that failed before there was a column
 * recording when. Saying "just now" about one of those would be a guess
 * dressed as a fact, and the whole reason this is here is that a pile of
 * failures of unknown age reads as one event.
 */
function failedAgo(iso: string | null | undefined): string {
  if (!iso) return "at some point";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function FailedBadge({ decision, word }: { decision: QueuedDecision; word: string }) {
  const [open, setOpen] = useState(false);
  const why = decision.error?.trim();
  const when = failedAgo(decision.failedAt);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={why ? "Open the details" : "No reason was recorded."}
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400"
      >
        <AlertTriangle className="h-3 w-3" />
        {word} · did not go through
        {/* Which run this one is from. Without it, a failure from Tuesday
            and one from four minutes ago are the same amber pill, and the
            only way to tell a new problem from an old one is to open every
            row in turn. */}
        <span className="font-normal opacity-70">· {when}</span>
      </button>
      {open && (
        <FailureDialog decision={decision} word={word} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * When it was decided, in words, plus the exact time.
 *
 * "Tried 2 times" said nothing about WHEN, and a failure keeps its error
 * for ever, so a three-day-old sentence read exactly like a fresh one.
 */
function when(iso: string): { relative: string; exact: string; at: number } {
  const at = new Date(iso).getTime();
  const mins = Math.round((Date.now() - at) / 60_000);
  const relative =
    mins < 2 ? "just now"
      : mins < 60 ? `${mins} minutes ago`
        : mins < 60 * 36 ? `${Math.round(mins / 60)} hours ago`
          : `${Math.round(mins / 1440)} days ago`;
  return {
    relative,
    exact: new Date(iso).toLocaleString(undefined, {
      day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    }),
    at,
  };
}

/** The whole failure, with room to read it. */
function FailureDialog({
  decision, word, onClose,
}: { decision: QueuedDecision; word: string; onClose: () => void }) {
  const qc = useQueryClient();
  const config = useConfig();
  const [retrying, setRetrying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const tried = when(decision.decidedAt);

  // The app has restarted since this ran, so the code that failed may not
  // be the code that is running. Not proof of a fix — said as what it is,
  // with the button that settles the question next to it.
  const booted = config.data?.bootedAt ? new Date(config.data.bootedAt).getTime() : null;
  const stale = booted !== null && booted > tried.at;

  const again = async () => {
    setRetrying(true);
    setProblem(null);
    try {
      await retryDecision(decision);
      void qc.invalidateQueries({ queryKey: ["decisions"] });
      void qc.invalidateQueries({ queryKey: ["reports"] });
      onClose();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not queue it again.");
      setRetrying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 whitespace-normal sm:p-8"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div
        className="w-full max-w-4xl overflow-hidden rounded-xl border border-border bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{word} — did not go through</p>
            <p className="text-xs break-words text-muted-foreground">
              {decision.matchedRow ?? "no row was matched"}
              {decision.attempts > 1 && ` · tried ${decision.attempts} times`}
              {` · last tried ${tried.relative}, ${tried.exact}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void again()}
            disabled={retrying}
            title="Queue the same decision again"
            className="rounded-md border border-emerald-600/40 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-600/10 disabled:opacity-50 dark:text-emerald-400"
          >
            {retrying ? "Queueing…" : "Try again"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-xs font-semibold hover:bg-muted"
          >
            Close
          </button>
        </div>

        {stale && (
          <p className="mt-3 rounded-lg border border-emerald-600/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
            This is a record of what happened {tried.relative}, not a live check. The app has been
            restarted since — if the cause was fixed in that update, everything below is out of
            date and Try again is all this needs.
          </p>
        )}

        <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs [overflow-wrap:anywhere] text-amber-800 dark:text-amber-300">
          {decision.error?.trim() || "Emburse gave no reason."}
        </p>
        {problem && (
          <p className="mt-2 text-xs [overflow-wrap:anywhere] text-red-700 dark:text-red-400">{problem}</p>
        )}

        <div className="mt-3 text-xs">
          <DecisionSteps steps={decision.steps} />
        </div>
        <div className="mt-1 text-xs">
          <FailureShot shot={decision.shot} />
        </div>
      </div>
    </div>
  );
}

/**
 * The browser run, stage by stage — where it got to and what stopped it.
 *
 * A failed decision used to be one sentence, so "it did not go through" and
 * "it signed in, found the row, and the Approve button was not where we
 * looked" were the same message. The steps are the difference between a
 * wrong password, a device check, an account without the team view, and a
 * renamed button — four causes with four different fixes.
 *
 * Only present when the trace is switched on in Configuration, so nothing
 * here should imply the run had no steps when it is absent.
 */
/**
 * The page at the moment it gave up.
 *
 * The run has always taken this on a failure and then discarded it. For the
 * failure that reads "it sat on a step and then errored out with no
 * message" it is the only thing that actually answers the question: a
 * spinner still turning, a modal nobody expected, a session bounced back to
 * sign-in. All obvious in a picture, none of them visible in a step name.
 *
 * Collapsed behind a link, because it is large and most failures are
 * explained by the sentence above it.
 */
function FailureShot({ shot }: { shot?: string | null }) {
  if (!shot) return null;
  return (
    <div className="mt-2 border-t border-border pt-2">
      <p className="mb-1 font-semibold">The page where it stopped</p>
      <img
        src={`data:image/png;base64,${shot}`}
        alt="The Emburse page at the moment the decision failed"
        className="block w-full rounded border border-border"
      />
    </div>
  );
}

function DecisionSteps({ steps }: { steps: QueuedDecision["steps"] }) {
  if (!steps || steps.length === 0) return null;
  return (
    <span className="mt-2 block border-t border-amber-500/30 pt-1.5">
      {steps.map((st, i) => (
        <span key={i} className="flex items-start gap-1.5 py-0.5">
          <span className={st.ok ? "text-emerald-600" : "text-red-600"}>{st.ok ? "\u2713" : "\u2717"}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <strong className="font-semibold">{st.name}</strong>
            {st.detail && <span className="block opacity-80">{st.detail}</span>}
          </span>
          <span className="ml-auto shrink-0 tabular-nums opacity-60">
            {(st.ms / 1000).toFixed(1)}s
          </span>
        </span>
      ))}
    </span>
  );
}

export function DecisionBadge({
  decision,
  onCancel,
}: {
  decision: QueuedDecision;
  onCancel?: (id: number) => void;
}) {
  const word = decision.decision === "approve" ? "Approved" : "Denied";

  if (decision.state === "pending") {
    // A pending decision that has already been TRIED and could not be
    // applied is not the same as one that is simply queued, and it used to
    // look identical: "sending", for ever, while the reason sat in a server
    // log. If something is stopping it, the row says so.
    const stuck = decision.attempts > 0 ? decision.error?.trim() : "";
    return (
      <span className="inline-flex max-w-full flex-col items-start gap-1 text-xs">
      <span className="inline-flex items-center gap-1.5">
        <span
          title={decision.reason ?? undefined}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold ${
            stuck
              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "border-border bg-muted text-muted-foreground"
          }`}
        >
          <Clock className="h-3 w-3" />
          {word} · {stuck ? `still waiting after ${decision.attempts} ${decision.attempts === 1 ? "try" : "tries"}` : "sending"}
        </span>
        <AutoMark decision={decision} />
        {onCancel && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancel(decision.id);
            }}
            title="Take it back — it has not reached Emburse yet"
            className="inline-flex items-center gap-1 text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            <Undo2 className="h-3 w-3" />
            undo
          </button>
        )}
      </span>
      {stuck && (
        <span className="block max-w-md rounded-lg border border-amber-500/40 bg-amber-500/5 px-2 py-1 break-words text-amber-800 dark:text-amber-300">
          {stuck}
        </span>
      )}
      </span>
    );
  }

  if (decision.state === "failed") {
    // "Not in Emburse's queue" is not a failure, and showing it as one is
    // what turned a stale queue into forty red rows nobody could act on.
    // The expense has already been approved or denied — usually by an
    // earlier pass of this app — so there is nothing to fix, nothing to
    // retry, and it goes when the next import drops the expense.
    if (decision.notInQueue) return <GoneBadge decision={decision} word={word} />;
    // The reason used to live in a `title` tooltip, which meant a reviewer
    // looking at a failed decision was told only that it failed. Whatever
    // Emburse said is the whole value of the row, so it is on screen.
    return <FailedBadge decision={decision} word={word} />;
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span
        title={
          [decision.reason, decision.matchedRow ? `Emburse row: ${decision.matchedRow}` : null]
            .filter(Boolean).join("\n") || undefined
        }
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
          decision.decision === "approve"
            ? "border border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
            : "border border-red-600/40 bg-red-600/10 text-red-700 dark:text-red-400"
        }`}
      >
        <ShieldCheck className="h-3 w-3" />
        {word}
      </span>
      <AutoMark decision={decision} />
    </span>
  );
}

/**
 * Which approvals nobody looked at.
 *
 * An automatic approval is applied under the login of whoever switched the
 * automation on, so it carries a real person's name in Emburse and reads on
 * this page exactly like one they clicked. That is the point of the
 * automation and also the risk in it: a queue of twenty-one green badges
 * cannot answer "which of these did a person actually review", and that is
 * the first thing anybody asks of a machine that approves spending.
 *
 * Deliberately not a colour. It is not a warning — an automatic approval is
 * one the rules had nothing to say about, which is what it was switched on
 * to do — it is a fact about provenance, so it reads as a quiet label.
 */
function AutoMark({ decision }: { decision: QueuedDecision }) {
  if (!decision.automatic) return null;
  return (
    <span
      title={`Approved automatically — no rule flagged it and nobody clicked. Applied in Emburse as ${decision.decidedBy}.`}
      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground"
    >
      <Bot className="h-3 w-3" />
      auto
    </span>
  );
}

/**
 * The expense is not in Emburse's queue any more.
 *
 * Quiet on purpose. Red is for something somebody has to do, and this is the
 * opposite: the decision was made, the expense is no longer awaiting one in
 * Emburse, and the row disappears at the next import. Shown rather than
 * hidden because "where did my approval go" deserves an answer, but shown as
 * a fact rather than an alarm.
 */
function GoneBadge({ decision, word }: { decision: QueuedDecision; word: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="Emburse has nothing matching this in Needs Review — see what the run found"
        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"
      >
        <CircleSlash className="h-3 w-3" />
        Not in Emburse&rsquo;s queue
      </button>
      {open && <FailureDialog decision={decision} word={word} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Denying, with the reason it requires.
 *
 * The reason is not a formality: it is what the employee is told, and a
 * denial without one becomes somebody's afternoon working out why. Required
 * here and required again on the server, because this dialog is not the only
 * way in.
 */
function DenyDialog({
  expense,
  onClose,
  onConfirm,
}: {
  expense: { employee: string; merchant: string; amount: number; date: string | null };
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const enough = reason.trim().length >= 3;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="w-full max-w-md space-y-3 rounded-xl border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-base font-bold">Deny this expense?</h3>
          {/* Spelled out rather than implied: the dialog can be opened from a
              dense table, and denying the row above the one you meant is the
              mistake worth making impossible to make quietly. */}
          <p className="mt-1 text-sm text-muted-foreground">
            <strong className="text-foreground">{expense.employee}</strong> · {expense.merchant} ·{" "}
            <strong className="text-foreground">{moneyExact(expense.amount)}</strong>
            {expense.date ? ` · ${expense.date}` : ""}
          </p>
        </div>

        <label className="block text-sm font-semibold">
          Why?
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
            rows={3}
            placeholder="No itemised receipt attached — please resubmit with one."
            className="mt-1 w-full rounded-lg border border-border bg-transparent px-2.5 py-2 text-sm font-normal outline-none focus:border-sky-500"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          This goes to {expense.employee.split(" ")[0]} in Emburse. A denial with no explanation comes
          back as a question.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!enough}
            onClick={() => {
              onConfirm(reason.trim());
              onClose();
            }}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Prove a queued decision would hit the right row, without making it.
 *
 * The same path, stopped one click short. Worth having in front of somebody
 * rather than in a test file: the matching is the thing being trusted, and
 * seeing it name the row it found is what earns that.
 */
/**
 * Look at Emburse's edit form, and change nothing.
 *
 * Groundwork for fixing a category before approving. Every part of Emburse
 * this app has had to drive blind has cost a round of failures — a grid of
 * divs, hidden measuring rows, a pinned Action column — each invisible
 * until the one before it was fixed. One click reports what the form
 * really contains so the change can be written against it rather than
 * guessed at.
 */
export function InspectEditForm({ id }: { id: number }) {
  const [state, setState] = useState<
    { phase: "idle" } | { phase: "running" } | { phase: "done"; ok: boolean; fields: string[]; detail: string }
  >({ phase: "idle" });

  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        disabled={state.phase === "running"}
        title="Opens Emburse's edit form for this expense and reports what is on it. Saves nothing."
        onClick={() => {
          setState({ phase: "running" });
          void inspectEditForm(id)
            .then((r) => setState({
              phase: "done", ok: r.ok, fields: r.fields,
              detail: r.steps.find((s) => !s.ok)?.detail ?? r.steps.at(-1)?.detail ?? "",
            }))
            .catch((e: Error) => setState({ phase: "done", ok: false, fields: [], detail: e.message }));
        }}
        className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 font-semibold hover:bg-muted disabled:opacity-40"
      >
        {state.phase === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
        {state.phase === "running" ? "Looking…" : "Inspect edit form"}
      </button>
      {state.phase === "running" && (
        <span className="text-muted-foreground">Opening the row's edit form — nothing is saved.</span>
      )}
      {state.phase === "done" && (
        <span className="block w-full">
          <span className={state.ok ? "text-emerald-600" : "text-amber-600"}>{state.detail}</span>
          {state.fields.length > 0 && (
            <span className="mt-1 block rounded-lg border border-border bg-muted/40 p-2 font-mono text-[11px] break-words">
              {state.fields.map((f, i) => <span key={i} className="block">{f}</span>)}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function TestDecision({ id, trace }: { id: number; trace: boolean }) {
  const [state, setState] = useState<
    { phase: "idle" } | { phase: "running" } |
    { phase: "done"; ok: boolean; matchedRow: string | null; detail: string;
      steps: QueuedDecision["steps"] }
  >({ phase: "idle" });

  async function run() {
    setState({ phase: "running" });
    try {
      const r = await testDecision(id);
      setState({
        phase: "done",
        ok: r.ok,
        matchedRow: r.matchedRow,
        detail: r.steps.find((s) => !s.ok)?.detail ?? r.steps.at(-1)?.detail ?? "",
        steps: r.steps,
      });
    } catch (err) {
      setState({
        phase: "done", ok: false, matchedRow: null,
        detail: (err as Error).message, steps: [],
      });
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        disabled={state.phase === "running"}
        onClick={() => void run()}
        className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 font-semibold hover:bg-muted disabled:opacity-40"
      >
        {state.phase === "running" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FlaskConical className="h-3.5 w-3.5" />
        )}
        {state.phase === "running" ? "Checking…" : "Test"}
      </button>

      {state.phase === "running" && (
        <span className="text-muted-foreground">
          Signing in and finding the row — a minute or so, and it queues behind any export.
        </span>
      )}

      {state.phase === "done" && (
        <span className="block w-full">
          <span className={state.ok ? "text-emerald-600" : "text-amber-600"}>
            {state.ok
              ? `Found it: ${state.matchedRow ?? "the row matched"}`
              : state.detail}
          </span>
          {/* Every stage, not just the one that threw. A step can succeed and
              still carry the answer — "signed in, but no team-wide tab matched"
              is the cause of a failure reported three steps later.

              Behind the same Configuration toggle that stores the trace on a
              real decision, because that is what it is for: six stages with
              timings answer "where does it break" while it is being set up,
              and are clutter above a queue once it works. A FAILURE still
               shows them whatever the setting — that is the moment they are
              wanted, and needing to switch something on first, then
              reproduce, is how a one-off failure gets lost. */}
          {(trace || !state.ok) && <DecisionSteps steps={state.steps} />}
        </span>
      )}
    </span>
  );
}
