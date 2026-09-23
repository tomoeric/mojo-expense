import { useEffect, useState } from "react";
import { X, ReceiptText, AlertTriangle, ScanSearch, Loader2 } from "lucide-react";
import { auditReport, type AuditResult, type ExpenseLine, type ExpenseReport } from "@/lib/api";
import { moneyExact, shortDate } from "@/lib/format";
import { StatusPill } from "./ui";
import { ReceiptViewer } from "./receipt-viewer";
import { ReceiptItems, useReceiptItems } from "./receipt-items";
import { AuditBadge } from "./audit-badge";

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

  const receipted = report.lines.filter((l) => l.hasReceipt).length;

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
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Date</th>
                      <th className="px-3 py-2 font-semibold">Category</th>
                      <th className="px-3 py-2 font-semibold">Merchant</th>
                      <th className="px-3 py-2 text-center font-semibold">Receipt</th>
                      {audits.size > 0 && <th className="px-3 py-2 text-center font-semibold">Check</th>}
                      <th className="px-3 py-2 text-right font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.lines.map((l) => (
                      <tr
                        key={l.id}
                        className={`border-t border-border ${flaggedLineIds.has(l.id) ? "bg-amber-50/60" : ""}`}
                      >
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{shortDate(l.date)}</td>
                        <td className="px-3 py-2">{l.category}</td>
                        <td className="px-3 py-2 text-muted-foreground">{l.merchant}</td>
                        <td className="px-3 py-2 text-center">
                          {l.hasReceipt ? (
                            <button
                              type="button"
                              onClick={() => setViewing(l)}
                              title="View receipt"
                              className="mx-auto flex items-center gap-1 rounded px-1.5 py-1 text-emerald-700 transition-colors hover:bg-emerald-50"
                            >
                              <ReceiptText className="h-4 w-4" />
                              <span className="text-[11px] font-semibold">View</span>
                            </button>
                          ) : (
                            <span className="text-xs font-semibold text-amber-600">none</span>
                          )}
                        </td>
                        {audits.size > 0 && (
                          <td className="px-3 py-2 text-center">
                            {audits.get(l.id) ? (
                              <AuditBadge result={audits.get(l.id)!} />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                        )}
                        <td className="tnum px-3 py-2 text-right font-semibold">{moneyExact(l.amount)}</td>
                      </tr>
                    ))}
                    {/* The items sit under the line they belong to rather than
                        in the viewer, so a reviewer reads what was bought
                        without opening a picture — which is the whole point of
                        having read it. */}
                    {report.lines.map((l) =>
                      l.hasReceipt ? (
                        <tr key={`${l.id}-items`} className="border-t border-border/60">
                          <td colSpan={audits.size > 0 ? 6 : 5} className="px-3 pt-1 pb-3">
                            <ReceiptItems
                              details={items.data?.byExpense?.[l.id]}
                              loading={items.isLoading}
                              enabled={items.data?.enabled ?? false}
                              claimed={l.amount}
                            />
                          </td>
                        </tr>
                      ) : null,
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </aside>

      {viewing && <ReceiptViewer line={viewing} onClose={() => setViewing(null)} />}
    </div>
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
