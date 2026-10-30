import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, Inbox, Loader2, Mail, Search, ShieldAlert, X,
} from "lucide-react";

/**
 * Receipts that arrived as email, and the expenses they belong to.
 *
 * Three things this page has to keep saying, because each one is
 * an assumption somebody would otherwise make:
 *
 *   THE MAILBOX IS NOT THE EMBURSE LOGIN. They are different
 *   concepts and on this deployment they are different addresses
 *   — the person signs into the app as MOJO, their saved Emburse
 *   connection signs in as Mammoth, and the mailbox is a third
 *   thing again. So it is configured on its own, with its own
 *   field, and the page says what it is for.
 *
 *   WHICH ACCOUNT A RECEIPT BELONGS TO COMES FROM THE EXPENSE.
 *   One MOJO mailbox holds receipts for both personal Emburse
 *   accounts; a receipt is this account's because it matches an
 *   expense in it, never because it arrived in this mailbox.
 *
 *   NOTHING IS CONFIRMED BY THE APP. Every candidate carries its
 *   reasons and a person chooses. A receipt wanted by two
 *   expenses, or an expense wanted by two receipts, is shown as a
 *   conflict rather than settled by whichever scored higher.
 *
 * And the scan is READ ONLY on both sides: it does not move,
 * delete, mark, flag or reply to a message, and it does not touch
 * Emburse.
 */

type Settings = {
  mailbox: string; folders: string[]; days: number; enabled: boolean;
  updatedAt: string | null; updatedBy: string;
};
type Account = { lane: string; label: string; loginEmail: string; connected: boolean };
type Evidence = {
  messageId: string; subject: string; from: string; receivedAt: string; folder: string;
  merchant: string; date: string | null; totalCents: number | null; currency: string;
  reference: string; hasAttachment: boolean;
  attachments: { id: string; name: string; contentType: string; size: number }[];
  excerpt: string;
};
type Match = {
  dedupeKey: string; lane: string; messageId: string;
  confidence: "strong" | "likely" | "weak";
  score: number; reasons: string[]; evidence: Evidence;
  state: "candidate" | "chosen" | "rejected" | "attached" | "failed";
  decidedBy: string; decidedAt: string | null; foundAt: string;
};
type Write = {
  dedupeKey: string;
  kind: "receipt" | "note";
  lane: string;
  proposed: string;
  was: string;
  messageId: string;
  attachmentId: string;
  state: "proposed" | "queued" | "applied" | "already" | "stale" | "failed";
  attempts: number;
  error: string;
  proposedBy: string;
  proposedAt: string;
  settledAt: string | null;
};
type Answer = {
  settings: Settings;
  accounts: Account[];
  graphConfigured: boolean;
  graphProblem: string;
  matches: Match[];
  writes: Write[];
};
type ScanResult = {
  mailbox: string; searched: string[]; missingFolders: string[];
  messages: number; expenses: number; candidates: number; recorded: number;
  needsReview: number; matches: Match[];
};

const money = (c: number | null) =>
  c === null ? "—" : `$${(c / 100).toFixed(2)}`;

export function ReceiptMailPage() {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [lane, setLane] = useState("");

  const q = useQuery({
    queryKey: ["receipt-mail"],
    queryFn: async () => {
      const res = await fetch("/api/receipt-mail");
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      return (await res.json()) as Answer;
    },
  });

  const settings = q.data?.settings;
  const accounts = q.data?.accounts ?? [];
  const chosen = lane || accounts[0]?.lane || "";

  const post = async <T,>(url: string, body: unknown): Promise<T> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) throw new Error((out as { error?: string }).error ?? "That did not work.");
    return out as T;
  };

  const save = useMutation({
    mutationFn: (input: Partial<Settings>) =>
      post<{ settings: Settings }>("/api/receipt-mail/settings", input),
    onSuccess: () => { setError(""); void qc.invalidateQueries({ queryKey: ["receipt-mail"] }); },
    onError: (e) => setError((e as Error).message),
  });
  const run = useMutation({
    mutationFn: () => post<ScanResult>("/api/receipt-mail/scan", { lane: chosen }),
    onSuccess: (out) => {
      setError(""); setScan(out);
      void qc.invalidateQueries({ queryKey: ["receipt-mail"] });
    },
    onError: (e) => setError((e as Error).message),
  });
  const decide = useMutation({
    mutationFn: async (v: { dedupeKey: string; messageId: string; choose: boolean }) => {
      await post<{ matches: Match[] }>("/api/receipt-mail/decide", v);
      // Choosing proposes what WOULD be sent. It writes nothing
      // to Emburse — the person still has to press Send — and
      // showing the proposal straight away is what makes "always
      // ask" an informed question rather than a yes/no on trust.
      if (v.choose) {
        await post<{ writes: Write[] }>("/api/receipt-mail/propose", {
          dedupeKey: v.dedupeKey, messageId: v.messageId,
        }).catch(() => undefined);
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["receipt-mail"] }),
    onError: (e) => setError((e as Error).message),
  });
  const send = useMutation({
    mutationFn: (v: { dedupeKey: string; kind: "receipt" | "note" }) =>
      post<{ writes: Write[] }>("/api/receipt-mail/send", v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["receipt-mail"] }),
    onError: (e) => setError((e as Error).message),
  });

  if (q.isLoading) {
    return <Loader2 className="mx-auto mt-10 h-6 w-6 animate-spin text-muted-foreground" />;
  }

  const matches = (scan?.matches ?? q.data?.matches ?? [])
    .filter((m) => !chosen || m.lane === chosen);
  const waiting = matches.filter((m) => m.state === "candidate");
  const writes = (q.data?.writes ?? []).filter((w) => !chosen || w.lane === chosen);
  /** Grouped by expense: a receipt and a description are one edit. */
  const byKey = new Map<string, Write[]>();
  for (const w of writes) byKey.set(w.dedupeKey, [...(byKey.get(w.dedupeKey) ?? []), w]);
  /** One receipt wanted by several expenses, or the other way round. */
  const byMessage = new Map<string, number>();
  const byExpense = new Map<string, number>();
  for (const m of waiting) {
    if (m.confidence === "weak") continue;
    byMessage.set(m.messageId, (byMessage.get(m.messageId) ?? 0) + 1);
    byExpense.set(m.dedupeKey, (byExpense.get(m.dedupeKey) ?? 0) + 1);
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Mail className="h-4 w-4" />
          Receipts in email
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Searches a mailbox for receipts and offers them against your personal expenses.
          It reads only — nothing is moved, deleted, marked as read or replied to — and it
          attaches nothing to Emburse on its own.
        </p>
      </div>

      {!q.data?.graphConfigured && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40
                      bg-amber-500/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>The Microsoft app credentials are not set</strong>, so no mailbox can be
            read. {q.data?.graphProblem}
          </span>
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">{error}</p>
      )}

      <div className="space-y-3 rounded-xl border border-border p-3.5">
        <p className="text-sm font-semibold">The mailbox to search</p>
        <p className="text-xs text-muted-foreground">
          This is <strong>not</strong> your Emburse login and not the address you sign into
          this app with. All three are different things, and on this deployment they are
          different addresses.
        </p>
        <label className="block">
          <span className="text-sm font-semibold">Mailbox</span>
          <input
            type="email"
            defaultValue={settings?.mailbox ?? ""}
            onBlur={(e) => {
              if (e.target.value.trim().toLowerCase() !== (settings?.mailbox ?? "")) {
                save.mutate({ mailbox: e.target.value });
              }
            }}
            placeholder="you@mojocarwash.com"
            className="mt-1 w-full rounded-lg border border-border bg-transparent px-2 py-1.5
                       text-sm outline-none focus:border-sky-500"
          />
        </label>
        <label className="block">
          <span className="text-sm font-semibold">
            Folders <span className="font-normal text-muted-foreground">(optional)</span>
          </span>
          <input
            defaultValue={(settings?.folders ?? []).join(", ")}
            onBlur={(e) => save.mutate({
              folders: e.target.value.split(",").map((f) => f.trim()).filter(Boolean),
            })}
            placeholder="Receipts, Inbox"
            className="mt-1 w-full rounded-lg border border-border bg-transparent px-2 py-1.5
                       text-sm outline-none focus:border-sky-500"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            By name, comma separated. Empty searches the whole mailbox. A folder named here
            that the mailbox does not have is reported rather than skipped quietly.
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-semibold">How far back</span>
          <input
            type="number"
            min={1}
            max={730}
            defaultValue={settings?.days ?? 90}
            onBlur={(e) => save.mutate({ days: Number(e.target.value) })}
            className="mt-1 w-32 rounded-lg border border-border bg-transparent px-2 py-1.5
                       text-sm outline-none focus:border-sky-500"
          />
          <span className="ml-2 text-xs text-muted-foreground">days</span>
        </label>
      </div>

      {accounts.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm
                      text-muted-foreground">
          No personal Emburse account is linked yet, so there is nothing to match receipts
          against. Add one under <strong>Your Emburse login</strong>.
        </p>
      ) : (
        <div className="space-y-3 rounded-xl border border-border p-3.5">
          <p className="text-sm font-semibold">Match against</p>
          <div className="flex flex-wrap gap-2">
            {/* ONE SCAN FOR BOTH, because one mailbox feeds both. A
                receipt belongs to an account because it matches an
                expense in it, never because of where it arrived — so
                picking an account before scanning meant reading the
                same mailbox twice and deciding in advance which half of
                the answer to look at. Offered only when there are two
                to combine. */}
            {accounts.filter((a) => a.connected).length > 1 && (
              <button
                type="button"
                onClick={() => { setLane("all"); setScan(null); }}
                title="Search once and match against every personal account"
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                  chosen === "all"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                Both accounts
              </button>
            )}
            {accounts.map((a) => (
              <button
                key={a.lane}
                type="button"
                disabled={!a.connected}
                onClick={() => { setLane(a.lane); setScan(null); }}
                title={a.connected
                  ? `Expenses imported from ${a.loginEmail}`
                  : "No Emburse account is linked to this tab yet"}
                className={`rounded-full border px-3 py-1 text-xs font-semibold
                            disabled:opacity-40 ${
                  a.lane === chosen
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                {a.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            A receipt belongs to an account because it matches an expense in it — never
            because it arrived in this mailbox. One mailbox holds receipts for both, so
            <strong> Both accounts</strong> reads it once and offers each receipt to
            whichever account it actually fits.
          </p>
          <button
            type="button"
            disabled={run.isPending || !settings?.mailbox || !q.data?.graphConfigured}
            onClick={() => { setError(""); run.mutate(); }}
            className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2
                       text-sm font-semibold text-white disabled:opacity-40"
          >
            {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Search className="h-4 w-4" />}
            Search for receipts
          </button>
        </div>
      )}

      {scan && (
        <div className="space-y-1 rounded-xl border border-border bg-muted/30 p-3.5 text-sm">
          <p className="font-semibold">What was searched</p>
          <p className="text-xs text-muted-foreground">
            {scan.mailbox} · {scan.searched.join(", ") || "nothing"} ·{" "}
            {scan.messages} message{scan.messages === 1 ? "" : "s"} read ·{" "}
            {scan.expenses} expense{scan.expenses === 1 ? "" : "s"} compared ·{" "}
            {scan.candidates} candidate{scan.candidates === 1 ? "" : "s"}
          </p>
          {scan.missingFolders.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {scan.missingFolders.join(", ")} — no such folder in this mailbox, so it was
              not searched.
            </p>
          )}
        </div>
      )}

      {/*
        * WHAT WOULD BE WRITTEN, before it is.
        *
        * Current value, proposed value, and the state of each.
        * Nothing here has reached Emburse until it says
        * "applied" — and nothing reaches it without the button
        * below being pressed, which is the owner's standing
        * instruction rather than a setting.
        */}
      {byKey.size > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-semibold">Ready to send to Emburse</p>
          {[...byKey.entries()].map(([key, group]) => (
            <div key={key} className="space-y-2 rounded-xl border border-border p-3.5 text-sm">
              <p className="font-mono text-xs text-muted-foreground">{key.slice(0, 16)}…</p>
              {group.map((w) => (
                <div key={w.kind} className="flex flex-wrap items-center gap-2 border-t
                                             border-border pt-2">
                  <span className="font-semibold">
                    {w.kind === "receipt" ? "Receipt image" : "Description"}
                  </span>
                  <span className="flex-1 text-xs text-muted-foreground">
                    {w.kind === "note" ? (
                      <>
                        now <span className="font-mono">{w.was || "(empty)"}</span> →{" "}
                        <span className="font-mono">{w.proposed}</span>
                      </>
                    ) : (
                      <>attach <span className="font-mono">{w.proposed}</span>
                        {!w.attachmentId && " — rendered from the message body"}</>
                    )}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    w.state === "applied" || w.state === "already"
                      ? "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400"
                      : w.state === "failed" || w.state === "stale"
                        ? "bg-red-500/15 text-red-700 dark:text-red-400"
                        : "bg-muted text-muted-foreground"}`}
                  >
                    {w.state === "already" ? "already there" : w.state}
                  </span>
                  {(w.state === "proposed" || w.state === "failed" || w.state === "stale") && (
                    <button
                      type="button"
                      disabled={send.isPending}
                      onClick={() => send.mutate({ dedupeKey: w.dedupeKey, kind: w.kind })}
                      className="rounded-lg border border-sky-600/50 px-3 py-1 text-xs
                                 font-semibold disabled:opacity-50"
                    >
                      {w.state === "proposed" ? "Send to Emburse" : "Try again"}
                    </button>
                  )}
                  {w.error && (
                    <span className="w-full text-xs text-red-700 dark:text-red-400">
                      {w.error}
                    </span>
                  )}
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                Sent under {group[0]!.lane.replace(/^personal-/, "")}&rsquo;s own Emburse
                login. It attaches and edits; it never submits, approves or denies.
              </p>
            </div>
          ))}
        </div>
      )}

      {waiting.length === 0 ? (
        <p className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm
                      text-muted-foreground">
          <Inbox className="h-4 w-4" />
          Nothing waiting on a decision.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-semibold">
            {waiting.length} candidate{waiting.length === 1 ? "" : "s"} waiting on you
          </p>
          {waiting.map((m) => (
            <div
              key={`${m.dedupeKey}:${m.messageId}`}
              className="space-y-2 rounded-xl border border-border p-3.5 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{m.evidence.subject || "(no subject)"}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  m.confidence === "strong"
                    ? "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400"
                    : m.confidence === "likely"
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : "bg-muted text-muted-foreground"}`}
                >
                  {m.confidence}
                </span>
                {m.evidence.hasAttachment && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
                    {m.evidence.attachments.length} attachment
                    {m.evidence.attachments.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {m.evidence.from} · {m.evidence.merchant || "unknown merchant"} ·{" "}
                {m.evidence.date ?? "no date"} · {money(m.evidence.totalCents)}{" "}
                {m.evidence.currency}
                {m.evidence.reference && ` · ref ${m.evidence.reference}`}
              </p>

              {/* Both conflict shapes, said plainly. A row that
                  looks settled while two others claim the same
                  receipt is the failure this page exists to
                  prevent. */}
              {(byMessage.get(m.messageId) ?? 0) > 1 && (
                <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40
                              bg-amber-500/10 px-2 py-1 text-xs">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  This receipt also matches {(byMessage.get(m.messageId) ?? 1) - 1} other
                  expense{(byMessage.get(m.messageId) ?? 1) - 1 === 1 ? "" : "s"}. Choosing
                  it here does not rule those out — one receipt covering several expenses
                  is real when a purchase was split, and wrong otherwise. Check the others
                  rather than leaving them.
                </p>
              )}
              {(byExpense.get(m.dedupeKey) ?? 0) > 1 && (
                <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40
                              bg-amber-500/10 px-2 py-1 text-xs">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  This expense has {(byExpense.get(m.dedupeKey) ?? 1)} plausible receipts.
                  Choosing one rejects the others.
                </p>
              )}

              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {m.reasons.map((r) => <li key={r}>· {r}</li>)}
              </ul>

              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  What the message says
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted/50 p-2
                                text-[11px] whitespace-pre-wrap">{m.evidence.excerpt}</pre>
              </details>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({
                    dedupeKey: m.dedupeKey, messageId: m.messageId, choose: true,
                  })}
                  className="inline-flex items-center gap-1.5 rounded-lg border
                             border-emerald-600/50 px-3 py-1 text-xs font-semibold
                             disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />
                  This is the receipt
                </button>
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({
                    dedupeKey: m.dedupeKey, messageId: m.messageId, choose: false,
                  })}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border
                             px-3 py-1 text-xs disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                  Not this one
                </button>
                <span className="text-[11px] text-muted-foreground">
                  Choosing shows you what would be written. Nothing reaches Emburse until
                  you press Send below.
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
