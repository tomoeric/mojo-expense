import { useState } from "react";
import {
  Check, X, Loader2, Clock, AlertTriangle, Undo2, FlaskConical, ShieldCheck,
} from "lucide-react";
import { testDecision, type QueuedDecision } from "@/lib/decisions";
import { money } from "@/lib/format";

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
  onApprove,
  onDeny,
  onCancel,
}: {
  expense: { dedupeKey: string; employee: string; merchant: string; amount: number; date: string | null };
  decision: QueuedDecision | undefined;
  busy: boolean;
  onApprove: () => void;
  onDeny: (reason: string) => void;
  onCancel: (id: number) => void;
}) {
  const [denying, setDenying] = useState(false);

  // Already decided: show what happened, not another pair of buttons.
  if (decision && decision.state !== "cancelled") {
    return (
      <>
        <DecisionBadge decision={decision} onCancel={onCancel} />
        {denying && (
          <DenyDialog expense={expense} onClose={() => setDenying(false)} onConfirm={onDeny} />
        )}
      </>
    );
  }

  return (
    <div className="flex items-center gap-1">
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

/** What became of a decision, and the one way back out of it. */
export function DecisionBadge({
  decision,
  onCancel,
}: {
  decision: QueuedDecision;
  onCancel?: (id: number) => void;
}) {
  const word = decision.decision === "approve" ? "Approved" : "Denied";

  if (decision.state === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span
          title={decision.reason ?? undefined}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 font-semibold text-muted-foreground"
        >
          <Clock className="h-3 w-3" />
          {word} · sending
        </span>
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
    );
  }

  if (decision.state === "failed") {
    return (
      <span
        title={decision.error ?? undefined}
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400"
      >
        <AlertTriangle className="h-3 w-3" />
        {word} · did not go through
      </span>
    );
  }

  return (
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
            <strong className="text-foreground">{money(expense.amount)}</strong>
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
export function TestDecision({ id }: { id: number }) {
  const [state, setState] = useState<
    { phase: "idle" } | { phase: "running" } |
    { phase: "done"; ok: boolean; matchedRow: string | null; detail: string }
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
      });
    } catch (err) {
      setState({ phase: "done", ok: false, matchedRow: null, detail: (err as Error).message });
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
        <span className={state.ok ? "text-emerald-600" : "text-amber-600"}>
          {state.ok
            ? `Found it: ${state.matchedRow?.slice(0, 80) ?? "the row matched"}`
            : state.detail.slice(0, 160)}
        </span>
      )}
    </span>
  );
}
