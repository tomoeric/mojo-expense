import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Pause, Play } from "lucide-react";
import type { ExpenseReport, ReportsResponse } from "@/lib/api";
import { ExpenseTable, buildRows, type Row } from "@/components/expense-table";
import { DecideButtons } from "@/components/decide-controls";
import { approveMany, clearFailed, holdDecisions, retryAllFailed } from "@/lib/decisions";
import { useDecisions } from "@/lib/decisions";
import { CodePrompt } from "@/components/code-prompt";
import { WhileAway } from "@/components/while-away";

/**
 * The reviewer's landing page: one line per expense still awaiting a decision.
 *
 * One list, no views. The rail that used to sit here offered All waiting,
 * Updated, Flagged, Over 5d and No receipt — and in practice two of them were
 * permanently zero (nothing arrives without a receipt when the export is
 * filtered to Receipts: true) and two were the same 233 rows under different
 * names, because everything flagged was flagged for ageing. Five labels for
 * two lists is not navigation, it is a decision to make before any work can
 * start. The table already searches, sorts and totals what it shows.
 */

export function QueuePage({
  data,
  onOpen,
}: {
  data: ReportsResponse;
  onOpen: (r: ExpenseReport, lineId: string) => void;
}) {
  const waiting = useMemo(
    () => buildRows(data, data.reports.filter((r) => r.status === "submitted")),
    [data],
  );

  const keys = useMemo(() => waiting.map((r) => r.line.id), [waiting]);
  const {
    byExpense, pending, browser, canDecide, challenge, decide, cancel, answerCode,
    held, importing,
  } = useDecisions(keys);
  const [error, setError] = useState("");
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [holdBusy, setHoldBusy] = useState(false);
  const qc = useQueryClient();
  /**
   * The batch is OURS when the browser's holder is the decision run rather
   * than the export. The export also holds it, and "applying 2 of 3" while
   * the export has it would be a lie about whose minute this is.
   */
  const running = /applying \d+ decision/.test(browser?.holder?.label ?? "");
  /**
   * How many were in the batch, remembered across polls: the pending count
   * falls as they land, so on its own it can only say what is left, never
   * how far through. Reset whenever a run is not in progress.
   */
  const [sent, setSent] = useState(0);
  useEffect(() => {
    const n = Number(/applying (\d+) decision/.exec(browser?.holder?.label ?? "")?.[1] ?? 0);
    if (n > 0) setSent(n);
    else if (pending.length === 0) setSent(0);
  }, [browser?.holder?.label, pending.length]);

  /**
   * The most that has been queued at once during this run.
   *
   * `sent` is the size of the batch the worker picked up; `pending` is
   * everything queued, which GROWS when the automation adds more mid-run.
   * Counting one against the other produced "Applying -23 of 8 — 32 to go":
   * eight in flight, thirty-two queued, and arithmetic that assumed the two
   * were the same set. Landed-so-far is measured against the high-water
   * mark instead, which cannot go backwards.
   */
  const [peak, setPeak] = useState(0);
  useEffect(() => {
    if (pending.length === 0) setPeak(0);
    else setPeak((p) => Math.max(p, pending.length));
  }, [pending.length]);

  const rows: Row[] = useMemo(
    () =>
      waiting.map((r) => {
        const decision = byExpense[r.line.id];
        const send = (input: { decision: "approve" | "deny"; reason?: string }) => {
          setError("");
          decide.mutate(
            { dedupeKey: r.line.id, ...input },
            { onError: (e) => setError((e as Error).message) },
          );
        };
        return {
          ...r,
          decision,
          // Tickable only when this person could decide it one at a time.
          // A bulk action must not be a way round a check the single path
          // makes — and a row already decided or in flight is not a
          // candidate for either.
          selectKey: canDecide && !decision ? r.line.id : undefined,
          decide: (
            <DecideButtons
              canDecide={canDecide}
              expense={{
                dedupeKey: r.line.id, employee: r.employee, merchant: r.line.merchant,
                amount: r.line.amount, date: r.line.date,
              }}
              decision={decision}
              busy={decide.isPending}
              onApprove={() => send({ decision: "approve" })}
              onDeny={(reason) => send({ decision: "deny", reason })}
              onCancel={(id) => cancel.mutate(id, { onError: (e) => setError((e as Error).message) })}
            />
          ),
        };
      }),
    [waiting, byExpense, canDecide, decide, cancel],
  );

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-sm">{error}</p>
      )}

      {/* Above everything: a decision is held until this is answered, and the
          person who can answer it is the one reading this. */}
      {challenge && (
        <CodePrompt
          challenge={challenge}
          busy={answerCode.isPending}
          error={answerCode.error ? (answerCode.error as Error).message : ""}
          onAnswer={(code) => answerCode.mutate(code)}
        />
      )}

      {/* Before the queue itself: the first question on coming back to a
          shorter list is what happened to it. */}
      <WhileAway />

      {!canDecide && (
        <p className="rounded-lg border border-border bg-muted/40 p-2.5 text-sm text-muted-foreground">
          To approve or deny, add your Emburse login under{" "}
          <strong className="text-foreground">Your Emburse login</strong> in the user menu. Decisions
          are made in Emburse as you, so the approval carries your name rather than somebody else&rsquo;s.
        </p>
      )}

      {/* Decisions are recorded on the click and sent to Emburse together, so
          this strip is the only place that says they have not landed yet.
          Without it "Approved" on a row would be a claim about Emburse that is
          not true for another minute. */}
      {(pending.length > 0 || held) && (
        <div className={`flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-xs ${
          held ? "border-amber-500/40 bg-amber-500/5" : "border-sky-500/30 bg-sky-500/5"
        }`}>
          {held
            ? <Pause className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
            : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-600" aria-hidden />}
          {/* Progress, not just a count. A batch of three takes about three
              minutes and the only thing on screen was "3 decisions waiting"
              — which reads the same at the start, in the middle and when it
              has stalled. Decisions now settle one at a time as they land,
              so counting what is left against what was sent says how far
              along it is. */}
          <span className="font-semibold">
            {held
              ? `Paused — ${pending.length.toLocaleString()} decision${pending.length === 1 ? "" : "s"} held back`
              : running
                ? `Applying ${Math.min(sent, pending.length).toLocaleString()} of ${pending.length.toLocaleString()} queued` +
                  (peak > pending.length ? ` — ${(peak - pending.length).toLocaleString()} landed so far` : "")
                : `${pending.length} decision${pending.length === 1 ? "" : "s"} waiting to reach Emburse`}
          </span>
          <span className="text-muted-foreground">
            {held
              ? "Nothing is queued automatically and no new batch starts. Nothing is lost — these go when you resume."
              : running
                ? `signing in and clicking takes about a minute each (${Math.round((Date.now() - (browser?.holder?.since ?? Date.now())) / 1000)}s so far).`
                : browser?.holder
                  ? `${browser.holder.label} has the browser; these go next.`
                  : "Sent together in one sign-in, shortly."}
            {!held && importing && " An import is running, so automatic approvals are waiting for it."}
          </span>
          {/* Stop, without losing anything. The automatic-approvals switch
              stops new ones being QUEUED and says nothing about the hundred
              already waiting — and those are what stands between the
              morning import and the browser it needs. */}
          <button
            type="button"
            disabled={holdBusy}
            onClick={() => {
              setError("");
              setHoldBusy(true);
              holdDecisions(!held)
                .then(() => qc.invalidateQueries({ queryKey: ["decisions"] }))
                .catch((e: Error) => setError(e.message))
                .finally(() => setHoldBusy(false));
            }}
            title={held
              ? "Let queued decisions reach Emburse again, and let the automation queue more"
              : "Hold everything back: queue nothing automatically, start no new batch. A batch already at the browser finishes."}
            className={`ml-auto inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 font-semibold disabled:opacity-40 ${
              held
                ? "border-emerald-600/40 text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400"
                : "border-border hover:bg-muted"
            }`}
          >
            {holdBusy
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : held ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {held ? "Resume" : "Pause"}
          </button>
        </div>
      )}

      <ExpenseTable
        rows={rows}
        onOpen={(r) => onOpen(r.report, r.line.id)}
        emptyMessage="Nothing waiting on a decision."
        bulk={{
          label: (n) => `Approve ${n.toLocaleString()}`,
          busy: bulkBusy,
          note: bulkNote,
          onRun: (keys) => {
            setError("");
            setBulkNote(null);
            setBulkBusy(true);
            approveMany(keys)
              .then((r) => {
                // What was queued and, by name, what was not. "3 could not
                // be queued" sends somebody hunting through 200 rows.
                setBulkNote(
                  `${r.queued.toLocaleString()} queued\u2009—\u2009they go to Emburse together in one sign-in.` +
                  (r.refused.length > 0 ? ` Not queued: ${r.refused.join("; ")}` : ""),
                );
                // The badges are what tell somebody it worked.
                void qc.invalidateQueries({ queryKey: ["decisions"] });
              })
              .catch((e: Error) => setError(e.message))
              .finally(() => setBulkBusy(false));
          },
        }}
        clearFailed={{
          busy: clearBusy,
          onRun: () => {
            setError("");
            setRetryNote(null);
            setClearBusy(true);
            clearFailed()
              .then((n) => {
                setRetryNote(
                  n === 0
                    ? "There was nothing to clear."
                    : `Cleared ${n.toLocaleString()} — nothing was sent to Emburse. ` +
                      "Anything that turns up here now is new.",
                );
                void qc.invalidateQueries({ queryKey: ["decisions"] });
                void qc.invalidateQueries({ queryKey: ["failure-groups"] });
              })
              .catch((e: Error) => setError(e.message))
              .finally(() => setClearBusy(false));
          },
        }}
        retryFailed={{
          busy: retryBusy,
          note: retryNote,
          onRun: () => {
            setError("");
            setRetryNote(null);
            setRetryBusy(true);
            retryAllFailed()
              .then((r) => {
                setRetryNote(
                  `${r.queued.toLocaleString()} queued again — they go to Emburse together in one sign-in.` +
                  (r.refused.length > 0 ? ` Not queued: ${r.refused.join("; ")}` : ""),
                );
                void qc.invalidateQueries({ queryKey: ["decisions"] });
              })
              .catch((e: Error) => setError(e.message))
              .finally(() => setRetryBusy(false));
          },
        }}
      />
    </div>
  );
}
