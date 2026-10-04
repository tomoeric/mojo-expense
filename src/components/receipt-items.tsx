import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, ListTree, AlertTriangle, RotateCcw } from "lucide-react";
// Exact, to the cent. These figures exist to be compared with a card charge,
// and rounding "38.24" to "$38" against "$45.89" hides both the real total
// and the fact that the difference is exactly the printed tip.
import { moneyExact } from "@/lib/format";

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
  /** Whether the reader judged this line an alcoholic drink. */
  alcohol?: boolean;
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
  autoRereadAt: string | null;
  /** The amount printed against the payment card. */
  paid: number | null;
  /** The currency the receipt named, when it named one. */
  currency: string | null;
  /** Every money line at the foot of the receipt, labelled as printed. */
  totals: { label: string; amount: number }[];
  /** Which generation of the reader produced this. */
  readerVersion: number;
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

/** How long ago the reading was made, in words. */
function readWhen(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(mins)) return "at an unknown time";
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 60 * 36) return `${Math.round(mins / 60)} hours ago`;
  return `${Math.round(mins / 1440)} days ago`;
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
  const qc = useQueryClient();
  const [rereading, setRereading] = useState(false);
  const [rereadError, setRereadError] = useState<string | null>(null);
  const [rereadNote, setRereadNote] = useState<string | null>(null);
  const sha = details?.[0]?.sha256;

  /**
   * Read this one again, ignoring what was stored.
   *
   * `force` is what makes it mean anything: without it the server hands
   * back the cached reading, which is the very thing being disputed.
   */
  const reread = async () => {
    if (!sha) return;
    setRereading(true);
    setRereadError(null);
    setRereadNote(null);
    try {
      const res = await fetch(`/api/receipt-items/${sha}?force=1`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; total?: number | null }
        | null;
      if (!res.ok) throw new Error(body?.error ?? "The receipt could not be read again.");
      await qc.invalidateQueries({ queryKey: ["receipt-items"] });
      // AND the flags, which are computed from the reading that just
      // changed. The server re-judges the expense on a re-read, so the
      // stale one was only ever in this browser — but on screen there is no
      // difference between a flag the server still believes and a flag
      // React Query has not thrown away. A corrected total showed "Match"
      // beside "Amounts Off — Receipt total $12.49 does not equal Amount
      // $13.54" for exactly that reason.
      await qc.invalidateQueries({ queryKey: ["reports"] });
      // Say what came of it, ALWAYS — including when nothing changed.
      // Pressing it and seeing the same figure is the one outcome that
      // looks identical to the button being broken, and that is exactly
      // what happened: "Read again didn't work" about a re-read that had
      // simply agreed with itself.
      const before = details?.[0]?.total ?? null;
      const now = body?.total ?? null;
      setRereadNote(
        now === null
          ? "Read again — no total could be made out this time."
          : before !== null && Math.abs(now - before) < 0.005
            ? `Read again — the total is the same, ${moneyExact(now)}.`
            : `Read again — the total is now ${moneyExact(now)}.`,
      );
    } catch (err) {
      setRereadError(err instanceof Error ? err.message : "The receipt could not be read again.");
    } finally {
      setRereading(false);
    }
  };

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
        {/* Readings are cached by image hash and never read twice, which is
            right — the vision call is the expensive part — but it also means
            a receipt read wrongly STAYS wrong until something forces it.
            Waiting for a background sweep to come round is no answer when
            the wrong figure is on screen in front of somebody. */}
        <button
          type="button"
          disabled={rereading}
          onClick={() => void reread()}
          title="Read this receipt again, ignoring what was stored"
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-semibold normal-case hover:bg-muted disabled:opacity-50"
        >
          {rereading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
          {rereading ? "Reading…" : "Read again"}
        </button>
      </h4>
      {rereadError && <p className="text-xs text-red-700">{rereadError}</p>}
      {rereadNote && <p className="text-xs text-emerald-700">{rereadNote}</p>}

      {/* WHEN this was read, which turns "the figure is wrong" into "the
          figure is old" at a glance.
          A reading is cached by image hash and never read twice, so a fix to
          the reader does not reach anything already read until a sweep comes
          round. Without a date on it, a stale reading and a broken one look
          identical — and both were being argued about as if they were the
          same thing. */}
      <p className="text-xs text-muted-foreground">
        Read {readWhen(detail.extractedAt)}.
        {/* A mismatch that survived a SECOND reading is worth more than a
            first reading, and the reviewer has no way to know one happened
            otherwise. It is also the promise that the app is not going to
            keep spending on this image: once is once. */}
        {detail.autoRereadAt && (
          <>
            {" "}
            Re-read automatically {readWhen(detail.autoRereadAt)} because the total did not
            match the charge{off !== null ? ", and it still does not" : ""}.
          </>
        )}
      </p>

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
        {/* THE line, marked.
            The flag says "Receipt shows alcohol yes is yes" above a list
            of a dozen items with nothing saying which one — so the
            reviewer reads the receipt themselves to find the drink,
            which is the work the reader had already done and stored.
            It was stored per line from the start and simply never sent. */}
        {detail.items.map((i) => (
          <li
            key={i.lineNo}
            className={`flex items-baseline justify-between gap-3 px-2.5 py-1.5 ${
              i.alcohol ? "bg-amber-300/35 dark:bg-amber-400/20" : ""
            }`}
          >
            <span className="min-w-0">
              <span className={`break-words ${i.alcohol ? "font-semibold" : ""}`}>
                {i.description}
              </span>
              {i.quantity !== null && i.quantity !== 1 && (
                <span className="ml-1.5 text-xs text-muted-foreground">×{i.quantity}</span>
              )}
              {i.alcohol && (
                // Named as well as coloured: a highlight alone says
                // "look here" and leaves why to be guessed, and this one
                // is the difference between a flagged expense and a
                // clean one.
                <span className="ml-1.5 rounded-full bg-amber-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 dark:text-amber-100">
                  alcohol
                </span>
              )}
            </span>
            <span className="tnum shrink-0 text-muted-foreground">
              {i.amount === null ? "—" : moneyExact(i.amount)}
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
              <span className="tnum">{moneyExact(value)}</span>
            </li>
          ),
        )}

        {/* The card line. The receipt states what was charged — "AMERICAN
            EXPRESS ****1003  $8.12  Approved" — and that figure was being
            stored and never shown, which is half the value of having it:
            it settles what arithmetic can only infer. Only when it differs
            from the total, or it is the same number twice. */}
        {detail.paid !== null && detail.total !== null
          && Math.abs(detail.paid - detail.total) > 0.005 && (
          <li className="flex items-baseline justify-between gap-3 px-2.5 py-1 text-xs text-muted-foreground">
            <span>Charged to the card</span>
            <span className="tnum">{moneyExact(detail.paid)}</span>
          </li>
        )}

        {detail.total !== null && (
          <li className="flex items-baseline justify-between gap-3 bg-muted/40 px-2.5 py-1.5 font-semibold">
            <span>Receipt total</span>
            <span className="tnum">{moneyExact(detail.total)}</span>
          </li>
        )}
      </ul>

      {/* The summary block exactly as printed, which is the answer to the
          one question a wrong total always raises: where did it get that
          figure from. The reader has always transcribed this — choosing the
          charged total happens in code, off these lines — and it was used
          once and thrown away, so the only way to check was to open the
          image and squint. */}
      {detail.totals.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            The money lines as printed ({detail.totals.length})
          </summary>
          <ul className="mt-1 divide-y divide-border rounded-lg border border-border">
            {detail.totals.map((t, i) => (
              <li key={`${t.label}-${i}`} className="flex items-baseline justify-between gap-3 px-2.5 py-1">
                <span className="min-w-0 break-words text-muted-foreground">{t.label}</span>
                <span className="tnum shrink-0">{moneyExact(t.amount)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {off !== null && (
        <p className="text-xs text-amber-600">
          The receipt totals {moneyExact(detail.total!)}, {off > 0 ? "more" : "less"} than the{" "}
          {moneyExact(claimed!)} claimed — worth a look. A split bill or a tip added after printing both
          do this.
        </p>
      )}

      {detail.notes && <p className="text-xs text-muted-foreground">{detail.notes}</p>}

      {/* Which reader produced this, and whether it could make the image
          out at all. Small, and at the bottom, because it only matters when
          a reading looks wrong — at which point "reader 3" versus "reader
          4" is the first thing worth knowing. */}
      <p className="text-[11px] text-muted-foreground/70">
        Reader v{detail.readerVersion}
        {detail.legible ? "" : " · the image could not be made out clearly"}
        {detail.currency && detail.currency !== "USD" ? ` · ${detail.currency}` : ""}
      </p>
    </div>
  );
}
