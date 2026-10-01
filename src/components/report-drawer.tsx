import { useEffect, useMemo, useState } from "react";
import { X, ReceiptText, AlertTriangle, ScanSearch, Loader2, Eye } from "lucide-react";
import { type AuditResult, type ExpenseLine, type ExpenseReport } from "@/lib/api";
import { receiptTotalOf, verdictFor } from "@/lib/receipt-verdict";
import { moneyExact, shortDate, daysAgo } from "@/lib/format";
import { useDecisions } from "@/lib/decisions";
import { StatusPill } from "./ui";
import { ReceiptPane, ReceiptViewer } from "./receipt-viewer";
import { ReceiptItems, useReceiptItems, type ReceiptDetail } from "./receipt-items";
import { AuditBadge } from "./audit-badge";
import { DecideButtons, InspectEditForm } from "./decide-controls";
import { FixCategory } from "./fix-category";

/** Line-level detail for one report — what a reviewer actually reads before approving. */
export function ReportDrawer({
  report,
  onClose,
  days,
  auditConfigured,
  focusId,
}: {
  report: ExpenseReport;
  onClose: () => void;
  days: number;
  auditConfigured: boolean;
  /**
   * The expense that was clicked.
   *
   * Reports are grouped one per person per day, so opening a row used to hand
   * over the whole day: a heading reading "3 expenses", totals for the day,
   * and whichever receipt happened to sort first in the pane. The receipt you
   * clicked was in there somewhere. With the line id the drawer opens on that
   * expense and the rest of the day follows underneath, which is the right
   * way round — one receipt against one claim is the unit of review.
   */
  focusId?: string;
}) {
  const [viewing, setViewing] = useState<ExpenseLine | null>(null);
  // Only the lines in this drawer, and only those with a receipt: asking about
  // every expense to show a handful would be the whole queue per open.
  const items = useReceiptItems(report.lines.filter((l) => l.hasReceipt).map((l) => l.id));
  const [decideError, setDecideError] = useState("");

  // Deciding from here rather than only from the queue: this is the window
  // where somebody has actually read the receipt, which is the moment the
  // decision is made. Going back to the table to click Approve puts a step
  // between looking and saying so.
  // The receipt in the left pane. Defaults to the first one there is, which
  // for a single-line report — nearly all of them — means it is simply open.
  const receipted = useMemo(() => report.lines.filter((l) => l.hasReceipt), [report.lines]);
  const [showingId, setShowingId] = useState<string | null>(focusId ?? null);
  // Reopening on a different row must move the pane, or the drawer shows the
  // previous receipt against the new expense — the one mix-up here that could
  // get the wrong thing approved.
  useEffect(() => setShowingId(focusId ?? null), [focusId, report.id]);
  const showing = receipted.find((l) => l.id === showingId) ?? receipted[0] ?? null;

  const focused = report.lines.find((l) => l.id === focusId) ?? null;
  // Only the clicked expense, unless the rest is asked for. One receipt
  // against one claim is the review; the others from that person's day are
  // occasionally useful context and never the subject, and listing them made
  // the drawer read as a bundle no matter what the header said. A day rule
  // needs the whole set, but the queue has a better place for that — the
  // flag count filters to the group.
  const [showDay, setShowDay] = useState(false);
  // The clicked expense first, the rest of that person's day after it.
  const ordered = useMemo(() => {
    if (!focused) return report.lines;
    if (!showDay) return [focused];
    return [focused, ...report.lines.filter((l) => l.id !== focused.id)];
  }, [report.lines, focused, showDay]);
  /** The receipts the button will read: the ones currently listed. */
  const toCheck = useMemo(() => ordered.filter((l) => l.hasReceipt), [ordered]);
  const lineIds = useMemo(() => report.lines.map((l) => l.id), [report.lines]);
  const { byExpense, canDecide, decide, cancel } = useDecisions(lineIds);


  // Escape closes the drawer — it covers the table behind it, so a reviewer
  // scanning the queue needs to dismiss it without reaching for the mouse.
  // `viewing` MUST stay in the dep list: the receipt viewer sits on top and
  // handles its own Escape, so without it this closure keeps the value from
  // first render and one Escape would dismiss both layers at once.
  useEffect(() => {
    if (viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewing]);

  // Only warn-level flags tint a row. Info flags (large line, weekend date)
  // match most of a report, and tinting those would drown the real signal.
  const flaggedLineIds = new Set(
    report.flags.filter((f) => f.severity === "warn").flatMap((f) => f.lineIds),
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      {/* Wide enough for two columns. The receipt is the thing being reviewed,
          so it gets a pane of its own that stays put while the details beside
          it scroll — squeezing it into the flow meant scrolling away from the
          picture to reach the decision. */}
      <aside className="relative flex h-full w-full max-w-[min(97vw,1280px)] flex-col border-l border-border bg-card shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border bg-card px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-bold">
                {focused ? focused.merchant : report.name}
              </h2>
              <StatusPill status={report.status} />
            </div>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {(focused
                ? [
                    moneyExact(focused.amount),
                    shortDate(focused.date),
                    report.employeeName,
                    focused.category,
                  ]
                : [report.employeeName, report.department, report.reference]
              )
                .filter(Boolean)
                .join(" · ")}
            </p>
            {focused && report.lines.length > 1 && (
              <button
                type="button"
                onClick={() => setShowDay((v) => !v)}
                className="mt-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {showDay
                  ? `Hide the other ${report.lines.length - 1} from ${report.employeeName} that day`
                  : `${report.lines.length - 1} more from ${report.employeeName} that day — show`}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {showing && (
          <div className="flex h-80 shrink-0 flex-col border-b border-border lg:h-auto lg:w-[44%] lg:border-r lg:border-b-0">
            <ReceiptPane line={showing} onExpand={() => setViewing(showing)} className="flex-1" />
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact
              label="Total"
              value={moneyExact(focused && !showDay ? focused.amount : report.total)}
            />
            <Fact label="Reimbursable" value={moneyExact(report.reimbursableTotal)} />
            <Fact label="Submitted" value={shortDate(report.submittedDate)} />
            <Fact label="Approved" value={shortDate(report.approvedDate)} />
          </dl>

          {decideError && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">{decideError}</p>
          )}

          {!canDecide && (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              To approve or deny, add your Emburse login under{" "}
              <strong className="text-foreground">Your Emburse login</strong> in the user menu. Decisions
              are made in Emburse as you, so the approval carries your name.
            </p>
          )}

          {report.flags.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-bold tracking-wide text-muted-foreground uppercase">
                Review flags
              </h3>
              <ul className="space-y-1.5">
                {report.flags.map((f) => (
                  <li
                    key={f.code}
                    className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                      f.severity === "warn"
                        ? "border-amber-200 bg-amber-50 text-amber-800"
                        : "border-border bg-muted text-muted-foreground"
                    }`}
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{f.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
                Lines ({report.lines.length})
              </h3>
            </div>

            {toCheck.length > 0 && (
              <p className="mb-2 text-xs text-muted-foreground">
                A difference is a prompt to look, not proof of an error — split bills, later tips and
                excluded personal items all show up here legitimately.
              </p>
            )}
            {report.lines.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                This tenant did not return line detail for the report.
              </p>
            ) : (
              <ul className="space-y-3">
                {ordered.map((l) => (
                  <LineCard
                    key={l.id}
                    line={l}
                    department={report.department}
                    employee={report.employeeName || report.employeeEmail}
                    ageDays={daysAgo(report.submittedDate)}
                    flagged={flaggedLineIds.has(l.id)}
                    audit={verdictFor(l.amount, receiptTotalOf(items.data?.byExpense?.[l.id], l.amount), l.id) ?? undefined}
                    items={items.data?.byExpense?.[l.id]}
                    itemsLoading={items.isLoading}
                    itemsEnabled={items.data?.enabled ?? false}
                    onShow={receipted.length > 1 ? () => setShowingId(l.id) : null}
                    isShowing={showing?.id === l.id}
                    decide={
                      !canDecide ? null : (
                      <>
                      <DecideButtons
                        canDecide={canDecide}
                        expense={{
                          dedupeKey: l.id, employee: report.employeeName,
                          merchant: l.merchant, amount: l.amount, date: l.date,
                        }}
                        decision={byExpense[l.id]}
                        busy={decide.isPending}
                        onApprove={() => {
                          setDecideError("");
                          decide.mutate({ dedupeKey: l.id, decision: "approve" },
                            { onError: (e) => setDecideError((e as Error).message) });
                        }}
                        onDeny={(reason) => {
                          setDecideError("");
                          decide.mutate({ dedupeKey: l.id, decision: "deny", reason },
                            { onError: (e) => setDecideError((e as Error).message) });
                        }}
                        onCancel={(id) =>
                          cancel.mutate(id, { onError: (e) => setDecideError((e as Error).message) })}
                      />
                      {/* The third option, and often the right one. A fuel
                          purchase coded as Travel is not a thing to deny —
                          the spend is fine and the coding is wrong, and
                          denying it tells an employee off for a mistake
                          that is not theirs to fix. */}
                      <FixCategory
                        target={{
                          employee: report.employeeName,
                          merchant: l.merchant, amount: l.amount, date: l.date,
                        }}
                        current={l.category}
                        onDone={() => setDecideError("")}
                      />
                      {/* Reconnaissance for correcting a field in Emburse.
                          It opens this row's edit form, reports every
                          control on it and closes without saving — which
                          is how the next change gets written against what
                          is really there rather than guessed at. Here
                          rather than only on a queued decision, because
                          the rows that need a correction are precisely the
                          ones nobody wants to approve yet. */}
                      <InspectEditForm id={l.id} />
                      </>
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      </aside>

      {viewing && <ReceiptViewer line={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/**
 * One expense, in full.
 *
 * A table row could not carry what a reviewer actually needs — the note, the
 * site, what it was paid with, what the receipt says, and the decision itself.
 * So each line is a card, and the receipt sits IN it rather than behind a
 * click: the picture is the thing being reviewed, and a reviewer who has to
 * ask for it will sometimes not bother.
 */
/**
 * What Emburse said about the receipt, beside what we actually hold.
 *
 * Two different facts that were both invisible: the export's own Receipt
 * column ("Receipt 1 of 2") and the number of images stored against the
 * expense. They usually agree; when they do not, that is the finding.
 */
function receiptFact(line: ExpenseLine): string {
  const label = (line.receiptLabel ?? "").trim();
  const held = line.receiptCount ?? 0;
  if (!label && held === 0) return line.hasReceipt ? "Yes" : "None";
  if (!label) return `${held} stored`;
  return held > 0 ? `${label} · ${held} stored` : `${label} · none stored`;
}

function LineCard({
  line, department, employee, ageDays, flagged, audit, items, itemsLoading, itemsEnabled, onShow,
  isShowing, decide,
}: {
  line: ExpenseLine;
  department: string;
  employee: string;
  /** Days since it was submitted, the same figure the queue's Age column shows. */
  ageDays: number | null;
  flagged: boolean;
  audit: AuditResult | undefined;
  items: ReceiptDetail[] | undefined;
  itemsLoading: boolean;
  itemsEnabled: boolean;
  /** Null when there is only one receipt, so there is nothing to choose. */
  onShow: (() => void) | null;
  isShowing: boolean;
  decide: React.ReactNode;
}) {

  // EVERYTHING the export gave us about this expense, not the four fields
  // that happened to be picked first. The rest were imported, stored, and
  // never shown — so the only way to see what Emburse actually said about a
  // row was to go and open it in Emburse, which is the errand this drawer
  // exists to save.
  //
  // The five columns below are all the export PDF carries. Business
  // Purpose, Card Details, Card Holder, Posted Date, Batch Id, Accounting
  // Export Status and Trip are on Emburse's web grid and NOT in the export,
  // so they are not ours to show; adding them means adding them to the
  // export's column selection, which moves the columns this parser reads by
  // x-position.
  const facts: [string, string][] = [
    // The queue row's own columns first, as LABELLED fields.
    //
    // They were on screen already — date and category in the grey line above,
    // the employee at the top of the panel, the amount on the right — but
    // scattered as decoration rather than stated as record. Somebody checking
    // a row against Emburse is reading down a list of fields, and having four
    // of them live somewhere else in the layout is how "the detail is
    // missing" is both wrong and completely fair.
    ["Date", line.date ? shortDate(line.date) : ""],
    ["Employee", employee],
    ["Merchant", line.merchant],
    ["Amount", moneyExact(line.amount)],
    ["Location / Site", line.location],
    ["Department", department],
    ["Category", line.category],
    ["Paid with", line.method],
    ["Section", line.section ?? ""],
    // Emburse's own count beside ours. "Receipt 1 of 2" against one stored
    // image is a different problem from an expense with no receipt at all,
    // and neither was visible.
    ["Receipt", receiptFact(line)],
    ["First imported", line.firstSeenAt ? shortDate(line.firstSeenAt) : ""],
    ["Currency", line.currency && line.currency !== "USD" ? line.currency : ""],
    ["Reimbursable", line.reimbursable ? "Yes" : ""],
    ["Billable", line.billable ? "Yes" : ""],
    ["GL code", line.glCode],
    // The last two columns the queue can show and this panel could not.
    // "The line view and pop view are different for receipt detail" — they
    // were, and the queue was the fuller of the two, which is backwards for
    // a panel whose job is the detail.
    // Measured off the submitted date, exactly as the queue's Age column
    // is. Two numbers under one word is worse than no number.
    ["Age", ageDays === null ? "" : `${ageDays}d waiting for review`],
    ["Updated by the last import", line.changes.length === 0
      ? ""
      : line.changes.map((c) => `${c.field}: ${c.before || "—"} → ${c.after || "—"}`).join("; ")],
    ["Shared receipt", line.sharedWith && line.sharedWith > 1
      ? `${line.sharedWith} expenses` +
        (typeof line.shareTotal === "number" ? ` · ${moneyExact(line.shareTotal)} together` : "")
      : ""],
    ["Note", line.note],
  ];

  /**
   * Shown even when empty, and that is the point of the change.
   *
   * Hiding a blank field makes "Emburse holds nothing here" look identical
   * to "the app never pulled this", and the whole reason to open this panel
   * rather than Emburse is to settle exactly that question. A row of
   * dashes is an answer; an absent row is a second trip.
   *
   * Only the two that are about our own bookkeeping rather than Emburse's
   * record still disappear when there is nothing to say.
   */
  const OURS = new Set(["First imported", "Shared receipt", "Updated by the last import"]);
  const shown = facts.filter(([label, v]) => (v && v.trim()) || !OURS.has(label));

  return (
    <li className={`rounded-xl border ${flagged ? "border-amber-300 bg-amber-50/40" : "border-border"}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border/70 px-4 py-3">
        <span className="text-sm font-bold">{line.merchant}</span>
        <span className="text-xs text-muted-foreground">
          {shortDate(line.date)} · {line.category}
        </span>
        <span className="tnum ml-auto text-base font-extrabold">{moneyExact(line.amount)}</span>
      </div>

      {shown.length > 0 && (
        <dl className="grid gap-x-4 gap-y-1.5 border-b border-border/70 px-4 py-3 text-sm sm:grid-cols-2">
          {shown.map(([label, value]) => (
            <div key={label} className="flex gap-2">
              <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
              {/* Wrapped, not truncated. This is the DETAIL view: the note
                  is the field most likely to be long and most likely to
                  matter — "Refund- drb suggested i…" is exactly the thing
                  somebody opened the drawer to read — and it was being cut
                  off here as well as in the table. */}
              <dd className={`ml-auto min-w-0 text-right [overflow-wrap:anywhere] ${
                value && value.trim() ? "" : "text-muted-foreground/50"
              }`}>
                {value && value.trim() ? value : "—"}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="px-4 py-3">
        {line.hasReceipt ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Receipt</span>
              {audit && <AuditBadge result={audit} />}
              {/* The picture itself is in the left pane. With one receipt it is
                  already the one on screen, so the control only appears when
                  there is a choice to make. */}
              {onShow && (
                <button
                  type="button"
                  onClick={onShow}
                  disabled={isShowing}
                  className={`ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                    isShowing
                      ? "border-sky-500/50 bg-sky-500/10 font-semibold text-sky-700"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  <Eye className="h-3.5 w-3.5" /> {isShowing ? "Showing" : "Show this one"}
                </button>
              )}
            </div>

            <div className="mt-2">
              <ReceiptItems
                details={items}
                loading={itemsLoading}
                enabled={itemsEnabled}
                claimed={line.amount}
              />
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-xs font-semibold text-amber-600">
            <ReceiptText className="h-4 w-4" /> No receipt attached.
          </p>
        )}
      </div>

      {/* Dropped entirely rather than showing an empty footer: with no stored
          Emburse login there is nothing to put here, and the notice at the top
          of the drawer has already said why. */}
      {decide && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-4 py-3">{decide}</div>
      )}
    </li>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tnum mt-0.5 font-bold">{value}</dd>
    </div>
  );
}
