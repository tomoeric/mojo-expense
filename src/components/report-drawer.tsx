import { useEffect } from "react";
import { X, ReceiptText, AlertTriangle } from "lucide-react";
import type { ExpenseReport } from "@/lib/api";
import { moneyExact, shortDate } from "@/lib/format";
import { StatusPill } from "./ui";

/** Line-level detail for one report — what a reviewer actually reads before approving. */
export function ReportDrawer({ report, onClose }: { report: ExpenseReport; onClose: () => void }) {
  // Only warn-level flags tint a row. Info flags (large line, weekend date)
  // match most of a report, and tinting those would drown the real signal.
  // Escape closes the drawer — it covers the table behind it, so a reviewer
  // scanning the queue needs to dismiss it without reaching for the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
              {report.employeeName} · {report.department} · {report.id}
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
            <h3 className="mb-2 text-xs font-bold tracking-wide text-muted-foreground uppercase">
              Lines ({report.lines.length})
            </h3>
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
                            <ReceiptText className="mx-auto h-4 w-4 text-emerald-600" aria-label="Receipt attached" />
                          ) : (
                            <span className="text-xs font-semibold text-amber-600">none</span>
                          )}
                        </td>
                        <td className="tnum px-3 py-2 text-right font-semibold">{moneyExact(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </aside>
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
