import { useMemo, useState } from "react";
import { Loader2, Send } from "lucide-react";
import type { ExpenseReport, ReportsResponse, ConfigResponse } from "@/lib/api";
import { ExpenseTable, buildRows, type Row } from "@/components/expense-table";
import { DecideButtons, TestDecision } from "@/components/decide-controls";
import { useDecisions } from "@/lib/decisions";

/**
 * The reviewer's landing page: one line per expense still awaiting a decision.
 *
 * The sub-rail is a set of views over one list rather than separate queries,
 * which is what keeps the count beside each label honest — every one is counted
 * from the same rows the table is about to show.
 */

type View = { key: string; label: string; rows: Row[]; hint?: string };

export function QueuePage({
  data,
  config,
  onOpen,
  view,
  onView,
}: {
  data: ReportsResponse;
  config: ConfigResponse | undefined;
  onOpen: (r: ExpenseReport) => void;
  view: string;
  onView: (v: string) => void;
}) {
  const ageingAfterDays = config?.policy.ageingAfterDays ?? 5;

  const waiting = useMemo(
    () => buildRows(data, data.reports.filter((r) => r.status === "submitted")),
    [data],
  );

  const views: View[] = useMemo(() => {
    const out: View[] = [{ key: "all", label: "All waiting", rows: waiting }];

    // Emburse sections, but only those actually present. The export PDF has no
    // per-row status column, so a row's section is only known when an import
    // covered exactly one section. Offering Needs Review / Needs Manager Review
    // / Denied before that is true would be three permanently empty buckets.
    const sections = [...new Set(waiting.map((r) => r.line.section).filter((s): s is string => Boolean(s)))].sort();
    for (const name of sections) {
      out.push({ key: `section:${name}`, label: name, rows: waiting.filter((r) => r.line.section === name) });
    }

    out.push(
      { key: "updated", label: "Updated", rows: waiting.filter((r) => r.line.changes.length > 0),
        hint: "Changed by the most recent import." },
      { key: "flagged", label: "Flagged", rows: waiting.filter((r) => r.flags.length > 0) },
      { key: "ageing", label: `Over ${ageingAfterDays}d`,
        rows: waiting.filter((r) => (r.ageDays ?? 0) >= ageingAfterDays) },
      { key: "no-receipt", label: "No receipt", rows: waiting.filter((r) => !r.line.hasReceipt) },
    );
    return out;
  }, [waiting, ageingAfterDays]);

  const active = views.find((v) => v.key === view) ?? views[0]!;
  const hasSections = views.some((v) => v.key.startsWith("section:"));

  // Only the rows on screen: badging the whole queue would ask about hundreds
  // of expenses to show a handful.
  const keys = useMemo(() => active.rows.map((r) => r.line.id), [active.rows]);
  const { byExpense, pending, browser, canDecide, decide, cancel, applyNow } = useDecisions(keys);
  const [error, setError] = useState("");

  const rowsWithDecisions: Row[] = useMemo(
    () =>
      active.rows.map((r) => {
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
    [active.rows, byExpense, canDecide, decide, cancel],
  );

  return (
    <div className="flex flex-col gap-5 lg:flex-row">
      <nav className="shrink-0 lg:w-52">
        <ul className="flex flex-wrap gap-1 lg:block lg:space-y-0.5">
          {views.map((v) => {
            const on = v.key === active.key;
            return (
              <li key={v.key}>
                <button
                  type="button"
                  onClick={() => onView(v.key)}
                  title={v.hint}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                    on ? "bg-muted font-semibold" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }`}
                >
                  <span className="truncate">{v.label}</span>
                  <span className={`tnum text-xs ${on ? "" : "opacity-70"}`}>{v.rows.length.toLocaleString()}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {!hasSections && (
          <p className="mt-3 hidden text-xs leading-relaxed text-muted-foreground lg:block">
            Needs Review, Needs Manager Review and Denied cannot be split apart yet — the export PDF carries
            no per-row status. Exporting one section at a time would make it knowable.
          </p>
        )}
      </nav>

      {/* The table's own toolbar already counts and totals what is shown, and
          it recounts as you search — a second figure up here would be the same
          number until it silently was not. */}
      <div className="min-w-0 flex-1 space-y-3">
        {error && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-sm">{error}</p>
        )}

        {/* Decisions are recorded on the click and sent to Emburse together,
            so this strip is the only place that says they have not landed
            yet. Without it "Approved" on a row would be a claim about Emburse
            that is not true for another minute. */}
        {!canDecide && (
          <p className="rounded-lg border border-border bg-muted/40 p-2.5 text-sm text-muted-foreground">
            To approve or deny, add your Emburse login under{" "}
            <strong className="text-foreground">Your Emburse login</strong> in the user menu. Decisions
            are made in Emburse as you, so the approval carries your name rather than somebody else&rsquo;s.
          </p>
        )}

        {pending.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600" aria-hidden />
            <span className="font-semibold">
              {pending.length} decision{pending.length === 1 ? "" : "s"} waiting to reach Emburse
            </span>
            <span className="text-muted-foreground">
              {browser?.holder
                ? `${browser.holder.label} has the browser; these go next.`
                : "Sent together in one sign-in, shortly."}
            </span>
            <button
              type="button"
              onClick={() => applyNow.mutate(undefined, { onError: (e) => setError((e as Error).message) })}
              className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 font-semibold hover:bg-muted"
            >
              <Send className="h-3.5 w-3.5" />
              Send now
            </button>
            {/* One test is enough to trust the matching; offering it per row
                would invite twenty browser sessions. */}
            <TestDecision id={pending[0]!.id} />
          </div>
        )}

        <ExpenseTable
          rows={rowsWithDecisions}
          onOpen={(r) => onOpen(r.report)}
          emptyMessage="Nothing waiting on a decision."
        />
      </div>
    </div>
  );
}
