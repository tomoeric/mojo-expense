import { useQuery } from "@tanstack/react-query";
import { Loader2, ListTree, AlertTriangle } from "lucide-react";
import { money } from "@/lib/format";

/**
 * What the receipt itself says was bought, one item per line.
 *
 * The expense row carries a merchant and a total. This carries the four things
 * inside it — which is what tells a reviewer whether the category fits, whether
 * something personal is mixed in, and why the number is the number.
 *
 * Read once per image and stored, so this is a lookup rather than a model call,
 * and so the detail survives the picture being released after an approval.
 */

export type ReceiptItem = {
  lineNo: number;
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
};

export type ReceiptDetail = {
  sha256: string;
  extractedAt: string;
  legible: boolean;
  merchant: string | null;
  purchasedAt: string | null;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
  notes: string;
  error: string | null;
  items: ReceiptItem[];
};

export function useReceiptItems(keys: string[]) {
  return useQuery({
    queryKey: ["receipt-items", keys.join(",")],
    enabled: keys.length > 0,
    queryFn: async () => {
      const res = await fetch(`/api/receipt-items?keys=${encodeURIComponent(keys.join(","))}`);
      if (!res.ok) throw new Error("Could not read receipt items.");
      return (await res.json()) as { enabled: boolean; byExpense: Record<string, ReceiptDetail[]> };
    },
  });
}

export function ReceiptItems({
  details,
  loading,
  enabled,
  claimed,
}: {
  details: ReceiptDetail[] | undefined;
  loading: boolean;
  /** False when there is no Anthropic key, so nothing will ever be read. */
  enabled: boolean;
  /** What the expense claims, so a total that disagrees can say so. */
  claimed?: number;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the receipt…
      </p>
    );
  }

  const detail = details?.[0];
  if (!detail) {
    // "Not read yet" is a promise, and it would be a false one with no key —
    // this receipt would never be read at all.
    return (
      <p className="text-xs text-muted-foreground">
        {enabled
          ? "Not read yet. New receipts are read shortly after they arrive."
          : "Reading receipts is off — no Anthropic key is set on this deployment."}
      </p>
    );
  }

  if (detail.error || !detail.legible) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-amber-600">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {detail.error ?? "This receipt could not be read — too faded or too dark."}
      </p>
    );
  }

  // Only worth saying when it disagrees. Cents of rounding are not news, and a
  // difference has honest explanations — a split bill, a tip added after
  // printing, personal items left off the claim — so it is a prompt to look
  // rather than an accusation.
  const off =
    claimed !== undefined && detail.total !== null && Math.abs(detail.total - claimed) > 0.02
      ? detail.total - claimed
      : null;

  return (
    <div className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">
        <ListTree className="h-3.5 w-3.5" />
        On the receipt
      </h4>

      {/* What the receipt says it is and when, beside what was claimed. The
          reader has always pulled these; they were stored and never shown, so
          a receipt dated three weeks before the transaction, or printed by a
          different business entirely, looked like every other receipt. */}
      {(detail.merchant || detail.purchasedAt) && (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {detail.merchant && (
            <span>
              Printed by <strong className="text-foreground">{detail.merchant}</strong>
            </span>
          )}
          {detail.purchasedAt && (
            <span>
              dated <strong className="text-foreground">{detail.purchasedAt}</strong>
            </span>
          )}
        </p>
      )}

      <ul className="divide-y divide-border rounded-lg border border-border text-sm">
        {detail.items.map((i) => (
          <li key={i.lineNo} className="flex items-baseline justify-between gap-3 px-2.5 py-1.5">
            <span className="min-w-0">
              <span className="break-words">{i.description}</span>
              {i.quantity !== null && i.quantity !== 1 && (
                <span className="ml-1.5 text-xs text-muted-foreground">×{i.quantity}</span>
              )}
            </span>
            <span className="tnum shrink-0 text-muted-foreground">
              {i.amount === null ? "—" : money(i.amount)}
            </span>
          </li>
        ))}

        {detail.items.length === 0 && (
          <li className="px-2.5 py-1.5 text-xs text-muted-foreground">
            No itemised lines on this receipt — some print only a total.
          </li>
        )}

        {/* Kept out of the item list rather than mixed into it: a subtotal is
            not a thing that was bought, and a list you can add up is the point. */}
        {([
          ["Subtotal", detail.subtotal],
          ["Tax", detail.tax],
          ["Tip", detail.tip],
        ] as const).map(([label, value]) =>
          value === null ? null : (
            <li key={label} className="flex items-baseline justify-between gap-3 px-2.5 py-1 text-xs text-muted-foreground">
              <span>{label}</span>
              <span className="tnum">{money(value)}</span>
            </li>
          ),
        )}

        {detail.total !== null && (
          <li className="flex items-baseline justify-between gap-3 bg-muted/40 px-2.5 py-1.5 font-semibold">
            <span>Receipt total</span>
            <span className="tnum">{money(detail.total)}</span>
          </li>
        )}
      </ul>

      {off !== null && (
        <p className="text-xs text-amber-600">
          The receipt totals {money(detail.total!)}, {off > 0 ? "more" : "less"} than the{" "}
          {money(claimed!)} claimed — worth a look. A split bill or a tip added after printing both
          do this.
        </p>
      )}

      {detail.notes && <p className="text-xs text-muted-foreground">{detail.notes}</p>}
    </div>
  );
}
