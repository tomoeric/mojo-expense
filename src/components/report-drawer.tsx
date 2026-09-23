import { useEffect, useMemo, useState } from "react";
import { X, ReceiptText, AlertTriangle, ScanSearch, Loader2, Maximize2, ImageOff } from "lucide-react";
import { auditReport, type AuditResult, type ExpenseLine, type ExpenseReport } from "@/lib/api";
import { moneyExact, shortDate } from "@/lib/format";
import { useDecisions } from "@/lib/decisions";
import { StatusPill } from "./ui";
import { ReceiptViewer } from "./receipt-viewer";
import { ReceiptItems, useReceiptItems, type ReceiptDetail } from "./receipt-items";
import { AuditBadge } from "./audit-badge";
import { DecideButtons } from "./decide-controls";

/** Line-level detail for one report — what a reviewer actually reads before approving. */
export function ReportDrawer({
  report,
  onClose,
  days,
  auditConfigured,
}: {
  report: ExpenseReport;
  onClose: () => void;
  days: number;
  auditConfigured: boolean;
}) {
  const [viewing, setViewing] = useState<ExpenseLine | null>(null);
  // Only the lines in this drawer, and only those with a receipt: asking about
  // every expense to show a handful would be the whole queue per open.
  const items = useReceiptItems(report.lines.filter((l) => l.hasReceipt).map((l) => l.id));
  const [audits, setAudits] = useState<Map<string, AuditResult>>(new Map());
  const [checking, setChecking] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [decideError, setDecideError] = useState("");

  const receipted = report.lines.filter((l) => l.hasReceipt).length;

  // Deciding from here rather than only from the queue: this is the window
  // where somebody has actually read the receipt, which is the moment the
  // decision is made. Going back to the table to click Approve puts a step
  // between looking and saying so.
  const lineIds = useMemo(() => report.lines.map((l) => l.id), [report.lines]);
  const { byExpense, canDecide, decide, cancel } = useDecisions(lineIds);

  async function runCheck() {
    setChecking(true);
    setAuditError("");
    try {
      const results = await auditReport(report.id, days);
      setAudits(new Map(results.map((r) => [r.lineId, r])));
    } catch (err) {
      setAuditError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

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
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-border bg-card shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-card px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-bold">{report.name}</h2>
              <StatusPill status={report.status} />
            </div>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {[report.employeeName, report.department, report.reference].filter(Boolean).join(" · ")}
            </p>
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

        <div className="space-y-5 px-5 py-5">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact label="Total" value={moneyExact(report.total)} />
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
              {receipted > 0 && (
                <button
                  type="button"
                  onClick={runCheck}
                  disabled={checking}
                  title={
                    auditConfigured
                      ? `Read each receipt and compare its total to the claim (${receipted} receipts)`
                      : "Receipt checking needs ANTHROPIC_API_KEY"
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-muted disabled:opacity-60"
                >
                  {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
                  {checking ? "Reading receipts…" : `Check ${receipted} receipt${receipted === 1 ? "" : "s"}`}
                </button>
              )}
            </div>

            {auditError && (
              <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {auditError}
              </p>
            )}

            {audits.size > 0 && (
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
                {report.lines.map((l) => (
                  <LineCard
                    key={l.id}
                    line={l}
                    department={report.department}
                    flagged={flaggedLineIds.has(l.id)}
                    audit={audits.get(l.id)}
                    items={items.data?.byExpense?.[l.id]}
                    itemsLoading={items.isLoading}
                    itemsEnabled={items.data?.enabled ?? false}
                    onEnlarge={() => setViewing(l)}
                    decide={
                      !canDecide ? null : (
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
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </section>
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
function LineCard({
  line, department, flagged, audit, items, itemsLoading, itemsEnabled, onEnlarge, decide,
}: {
  line: ExpenseLine;
  department: string;
  flagged: boolean;
  audit: AuditResult | undefined;
  items: ReceiptDetail[] | undefined;
  itemsLoading: boolean;
  itemsEnabled: boolean;
  onEnlarge: () => void;
  decide: React.ReactNode;
}) {
  const [broken, setBroken] = useState(false);

  const facts: [string, string][] = [
    ["Location / Site", line.location],
    ["Department", department],
    ["Paid with", line.method],
    ["Note", line.note],
  ];
  const shown = facts.filter(([, v]) => v && v.trim());

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
              <dd className="ml-auto min-w-0 truncate text-right" title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="px-4 py-3">
        {line.hasReceipt ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Receipt</span>
              {audit && <AuditBadge result={audit} />}
              <button
                type="button"
                onClick={onEnlarge}
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
              >
                <Maximize2 className="h-3.5 w-3.5" /> Enlarge
              </button>
            </div>

            {broken ? (
              <p className="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-6 text-xs text-muted-foreground">
                <ImageOff className="h-4 w-4" />
                The receipt image could not be loaded.
              </p>
            ) : (
              <button
                type="button"
                onClick={onEnlarge}
                title="Enlarge"
                className="mt-2 block w-full overflow-hidden rounded-lg border border-border bg-muted/40"
              >
                {/* Capped rather than full height: the picture is here to be
                    read at a glance, and a full-length receipt would push the
                    decision off the bottom of the drawer. */}
                <img
                  src={`/api/receipts/${encodeURIComponent(line.id)}`}
                  alt={`Receipt for ${line.merchant}`}
                  loading="lazy"
                  onError={() => setBroken(true)}
                  className="max-h-80 w-full object-contain"
                />
              </button>
            )}

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
