import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, ChevronRight, Inbox, Loader2, Mail, Search, Settings2,
  ShieldAlert, X,
} from "lucide-react";
import { ReceiptFrame } from "../components/receipt-frame";

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
 *
 * ──────────────────────────────────────────────────────────────
 * WHY THIS IS A LIST AND A PANEL, AND NOT A COLUMN OF CARDS.
 *
 * It was a column of cards: every (expense × receipt) pair, full
 * height, one after another. At 417 pairs that is a page you
 * scroll rather than a page you work, the same receipt appears
 * under a dozen expenses, and the detail that decides the
 * question — the receipt itself — is the one thing you have to
 * open each card to see.
 *
 * So the unit on screen is the EXPENSE, because that is the unit
 * of the decision. The left column is the queue of expenses; the
 * panel is one expense with its receipt showing, its competing
 * receipts a click apart, and the two buttons in the same place
 * every time. Deciding one does not move the ground under you:
 * the panel stays on it and shows what would now be written.
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
  /* "receipt" and "note" come from the matched email; the four
     field kinds come from a vendor rule and are named for the
     boxes on Emburse's own edit form. */
  kind: "receipt" | "note" | "category" | "purpose" | "location" | "department"
    | "comment";
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
  /** What the browser did on the last attempt, step by step. */
  steps?: { name: string; ok: boolean; detail: string }[];
};
/** The expense itself, so a card names one instead of a hash. */
type ExpenseFact = {
  dedupeKey: string; lane: string; merchant: string; date: string | null;
  amountCents: number; currency: string; category: string; note: string;
  hasReceipt: boolean;
  /** The vendor rule filling this expense's fields, or "" for none. */
  ruleVendor?: string;
  ruleFills?: string[];
};
type Answer = {
  settings: Settings;
  accounts: Account[];
  graphConfigured: boolean;
  graphProblem: string;
  matches: Match[];
  writes: Write[];
  expenses: ExpenseFact[];
};
type ScanResult = {
  mailbox: string; searched: string[]; missingFolders: string[];
  messages: number; expenses: number; candidates: number; recorded: number;
  needsReview: number; matches: Match[];
  /** Pairs scored, before one-to-one resolution dropped the settled ones' others. */
  scored?: number;
  ruledOut?: number;
  /** Candidates a previous, looser scan left behind and this one removed. */
  removed?: number;
  /** Photographed receipts the reader was spent on. */
  photosRead?: number;
  photosSkipped?: number;
};

const money = (c: number | null) =>
  c === null ? "—" : `$${(c / 100).toFixed(2)}`;

/** 2026-09-24 → Sep 24. The year is noise in a 90-day window. */
const shortDate = (d: string | null): string => {
  if (!d) return "no date";
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t)) return d;
  return new Date(t).toLocaleDateString("en-US",
    { month: "short", day: "numeric", timeZone: "UTC" });
};

/** What a group of rows about one expense is waiting for. */
type Stage = "decide" | "send" | "done";

type Group = {
  key: string;
  fact: ExpenseFact | null;
  /** Still waiting on a person, best first. */
  candidates: Match[];
  /** Already chosen, so the panel can show which receipt won. */
  chosen: Match | null;
  writes: Write[];
  stage: Stage;
};

export function ReceiptMailPage() {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [lane, setLane] = useState("");
  const [stage, setStage] = useState<Stage | "all">("decide");
  const [find, setFind] = useState("");
  const [picked, setPicked] = useState("");
  const [which, setWhich] = useState(0);
  const [setup, setSetup] = useState(false);

  const q = useQuery({
    queryKey: ["receipt-mail"],
    queryFn: async () => {
      const res = await fetch("/api/receipt-mail");
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      return (await res.json()) as Answer;
    },
    /*
     * WHILE SOMETHING IS IN FLIGHT, WATCH IT.
     *
     * Sending puts a write in `queued` and hands it to the worker,
     * which signs into Emburse in its own time — up to about five
     * minutes. The page then said "queued" and never changed
     * again, because nothing refetched: the work finished, the
     * screen did not, and the only way to find out was to reload.
     * Polling only while there IS something queued, so an idle
     * page is still idle.
     */
    refetchInterval: (query) =>
      (query.state.data?.writes ?? []).some((w) => w.state === "queued") ? 10_000 : false,
  });

  const settings = q.data?.settings;
  const accounts = q.data?.accounts ?? [];
  const chosenLane = lane || accounts[0]?.lane || "";
  /*
   * "all" is every personal account, not a lane called "all".
   *
   * The filter was `m.lane === chosen`, so picking Both accounts asked
   * for rows whose lane is the string "all" — of which there are none,
   * and the page went blank the moment the thing meant to show more was
   * chosen.
   */
  const inLane = (laneOf: string, want: string): boolean =>
    !want || want === "all" || laneOf === want;

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
    mutationFn: () => post<ScanResult>("/api/receipt-mail/scan", { lane: chosenLane }),
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
    onSuccess: () => { setWhich(0); void qc.invalidateQueries({ queryKey: ["receipt-mail"] }); },
    onError: (e) => setError((e as Error).message),
  });
  /*
   * ONE PRESS, BECAUSE IT IS ONE EXPENSE.
   *
   * There were two Send buttons, one per write, and the owner
   * asked twice what the second one was for. The answer — "the
   * image and the description are separate edits that fail
   * separately" — is true about the plumbing and is not a
   * question the person pressing should have to hold. Two buttons
   * labelled "Send to Emburse" on one expense read as sending it
   * twice.
   *
   * So: one press sends everything outstanding on that expense,
   * in order, and the lines underneath say what it will change. A
   * per-line "Try again" comes back only when one half FAILS,
   * which is the one moment the split matters.
   */
  const send = useMutation({
    mutationFn: async (v: { dedupeKey: string; kinds: Write["kind"][] }) => {
      for (const kind of v.kinds) {
        await post<{ writes: Write[] }>("/api/receipt-mail/send",
          { dedupeKey: v.dedupeKey, kind });
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["receipt-mail"] }),
    onError: (e) => setError((e as Error).message),
  });

  /*
   * THE LIVE LIST, not the snapshot the scan returned.
   *
   * `scan` is frozen at the moment Search was pressed and this read it
   * FIRST, so choosing a receipt — which invalidates the query and
   * updates `q.data` — changed nothing on screen. The chosen one stayed
   * in "candidates waiting on you" and the count never moved, while the
   * "Ready to send" block above it, which reads `q.data.writes`, updated
   * correctly. Half the page live and half of it frozen, which reads as
   * the button having done nothing.
   *
   * The snapshot is still the fallback: it covers the moment between the
   * scan returning and its refetch landing. The scan's own summary —
   * folders searched, messages seen — still comes from it, because that
   * is a report about one press and not a live figure.
   */
  const matches = useMemo(
    () => (q.data?.matches ?? scan?.matches ?? []).filter((m) => inLane(m.lane, chosenLane)),
    [q.data?.matches, scan?.matches, chosenLane]);
  const writes = useMemo(
    () => (q.data?.writes ?? []).filter((w) => inLane(w.lane, chosenLane)),
    [q.data?.writes, chosenLane]);
  const facts = q.data?.expenses ?? [];

  /** One receipt wanted by several expenses, or the other way round. */
  const { byMessage, byExpense } = useMemo(() => {
    const m1 = new Map<string, number>();
    const m2 = new Map<string, number>();
    for (const m of matches) {
      if (m.state !== "candidate" || m.confidence === "weak") continue;
      m1.set(m.messageId, (m1.get(m.messageId) ?? 0) + 1);
      m2.set(m.dedupeKey, (m2.get(m.dedupeKey) ?? 0) + 1);
    }
    return { byMessage: m1, byExpense: m2 };
  }, [matches]);

  /** One row per EXPENSE, which is the unit of the decision. */
  const groups = useMemo<Group[]>(() => {
    const factOf = new Map(facts.map((f) => [f.dedupeKey, f] as const));
    const keys = new Set<string>([
      ...matches.map((m) => m.dedupeKey), ...writes.map((w) => w.dedupeKey),
    ]);
    const out: Group[] = [];
    for (const key of keys) {
      const mine = matches.filter((m) => m.dedupeKey === key);
      const candidates = mine.filter((m) => m.state === "candidate")
        .sort((a, b) => b.score - a.score);
      const settled = mine.find((m) => m.state === "chosen" || m.state === "attached") ?? null;
      const ours = writes.filter((w) => w.dedupeKey === key);
      const unsent = ours.some((w) => ["proposed", "failed", "stale"].includes(w.state));
      out.push({
        key,
        fact: factOf.get(key) ?? null,
        candidates,
        chosen: settled,
        writes: ours,
        stage: candidates.length > 0 ? "decide" : unsent ? "send" : "done",
      });
    }
    // Oldest expense first: the one closest to being chased.
    return out.sort((a, b) =>
      (a.fact?.date ?? "9999").localeCompare(b.fact?.date ?? "9999")
      || a.key.localeCompare(b.key));
  }, [matches, writes, facts]);

  const counts = {
    decide: groups.filter((g) => g.stage === "decide").length,
    send: groups.filter((g) => g.stage === "send").length,
    done: groups.filter((g) => g.stage === "done").length,
  };

  const needle = find.trim().toLowerCase();
  const shown = groups.filter((g) => {
    if (stage !== "all" && g.stage !== stage) return false;
    if (!needle) return true;
    const hay = [g.fact?.merchant, g.fact?.category, g.fact?.note,
      ...g.candidates.map((c) => c.evidence.subject),
      ...g.candidates.map((c) => c.evidence.merchant)].join(" ").toLowerCase();
    return hay.includes(needle);
  });

  /*
   * The panel never empties itself. A chosen expense leaves the
   * "to decide" filter the moment it is decided, and dropping the
   * panel with it would answer the press with a blank column —
   * exactly when the person wants to see what their press did.
   */
  const current = groups.find((g) => g.key === picked) ?? shown[0] ?? null;
  const place = shown.findIndex((g) => g.key === current?.key);
  const next = place >= 0 ? shown[place + 1] ?? null : shown[0] ?? null;

  if (q.isLoading) {
    return <Loader2 className="mx-auto mt-10 h-6 w-6 animate-spin text-muted-foreground" />;
  }

  return (
    <div className="space-y-4">
      {/* The section shell already prints the page's title, so this
          says the thing the title cannot: what the scan does to the
          mailbox, which is nothing. Two identical headings stacked was
          the first version of this row. */}
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-64 flex-1 flex items-start gap-2 text-sm text-muted-foreground">
          <Mail className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Searches a mailbox for receipts and offers them against your personal expenses.
            It reads only — nothing is moved, deleted, marked as read or replied to — and it
            attaches nothing to Emburse on its own.
          </span>
        </p>
        <button
          type="button"
          onClick={() => setSetup((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3
                     py-1.5 text-xs font-semibold hover:bg-muted"
        >
          <Settings2 className="h-3.5 w-3.5" />
          {setup ? "Hide the mailbox settings" : "Mailbox settings"}
        </button>
      </div>

      {!q.data?.graphConfigured && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40
                      bg-amber-500/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>The Microsoft app credentials are not set</strong>, so no mailbox can be
            read.{" "}
            {/* Only when it adds something. `mailProblem()` opens with the
                same sentence, so printing both said it twice in a row. */}
            {(q.data?.graphProblem ?? "").replace(
              /^The Microsoft app credentials are not set\.?\s*/i, "")}
          </span>
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">{error}</p>
      )}

      {/* THE SETTINGS ARE NOT THE WORK. They were the first screenful
          every time, above a list somebody opens this page to work
          through; they are set once and changed twice a year. Folded,
          but with the mailbox still named on the line that opens them,
          so "which mailbox is this reading" never needs a click. */}
      {setup && (
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
          <p className="text-xs text-muted-foreground">
            A receipt belongs to an account because it matches an expense in it — never
            because it arrived in this mailbox. One mailbox holds receipts for both, so
            <strong> Both accounts</strong> reads it once and offers each receipt to
            whichever account it actually fits.
          </p>
        </div>
      )}

      {accounts.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm
                      text-muted-foreground">
          No personal Emburse account is linked yet, so there is nothing to match receipts
          against. Add one under <strong>Your Emburse login</strong>.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border
                        p-2.5">
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
              onClick={() => { setLane("all"); setScan(null); setPicked(""); }}
              title="Search once and match against every personal account"
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                chosenLane === "all"
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
              onClick={() => { setLane(a.lane); setScan(null); setPicked(""); }}
              title={a.connected
                ? `Expenses imported from ${a.loginEmail}`
                : "No Emburse account is linked to this tab yet"}
              className={`rounded-full border px-3 py-1 text-xs font-semibold
                          disabled:opacity-40 ${
                a.lane === chosenLane
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {a.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">
            {settings?.mailbox || "no mailbox set"} · {settings?.days ?? 90} days
            {settings?.folders?.length ? ` · ${settings.folders.join(", ")}` : ""}
          </span>
          <button
            type="button"
            disabled={run.isPending || !settings?.mailbox || !q.data?.graphConfigured}
            onClick={() => { setError(""); run.mutate(); }}
            className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-1.5
                       text-sm font-semibold text-white disabled:opacity-40"
          >
            {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Search className="h-4 w-4" />}
            Search for receipts
          </button>
        </div>
      )}

      {scan && (
        <div className="space-y-1 rounded-xl border border-border bg-muted/30 p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">What was searched:</span>{" "}
            {scan.mailbox} · {scan.searched.join(", ") || "nothing"} ·{" "}
            {scan.messages} message{scan.messages === 1 ? "" : "s"} read ·{" "}
            {scan.expenses} expense{scan.expenses === 1 ? "" : "s"} compared ·{" "}
            {scan.candidates} candidate{scan.candidates === 1 ? "" : "s"}
            {typeof scan.ruledOut === "number" && scan.ruledOut > 0 && (
              <> · {scan.ruledOut} pairing{scan.ruledOut === 1 ? "" : "s"} ruled out because
                price, date and merchant already settled those receipts</>
            )}
            {typeof scan.photosRead === "number" && scan.photosRead > 0 && (
              <> · {scan.photosRead} photographed receipt
                {scan.photosRead === 1 ? "" : "s"} read out of their pictures</>
            )}
            {typeof scan.photosSkipped === "number" && scan.photosSkipped > 0 && (
              <> · {scan.photosSkipped} more left unread, because one search only reads so
                many — search again to take the next batch</>
            )}
            {typeof scan.removed === "number" && scan.removed > 0 && (
              <> · {scan.removed} left over from an earlier search removed</>
            )}
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

      {groups.length === 0 ? (
        <p className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm
                      text-muted-foreground">
          <Inbox className="h-4 w-4" />
          Nothing waiting on a decision.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
          {/* THE QUEUE: one line per expense, not per pairing. */}
          <aside className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {([
                ["decide", "To decide", counts.decide],
                ["send", "Ready to send", counts.send],
                ["done", "Done", counts.done],
                ["all", "All", groups.length],
              ] as const).map(([key, label, n]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setStage(key)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                    stage === key
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:text-foreground"}`}
                >
                  {label} {n}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2
                                 text-muted-foreground" />
              <input
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="Merchant, note, subject…"
                className="w-full rounded-lg border border-border bg-transparent py-1.5 pr-2
                           pl-7 text-xs outline-none focus:border-sky-500"
              />
            </div>
            <div className="max-h-[36rem] space-y-1 overflow-y-auto pr-1">
              {shown.length === 0 && (
                <p className="rounded-lg border border-border p-3 text-xs
                              text-muted-foreground">
                  Nothing in this list.
                </p>
              )}
              {shown.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => { setPicked(g.key); setWhich(0); }}
                  className={`w-full rounded-lg border px-2.5 py-2 text-left text-xs ${
                    g.key === current?.key
                      ? "border-sky-500 bg-sky-500/5"
                      : "border-border hover:bg-muted/50"}`}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-semibold">
                      {g.fact?.merchant ?? "Unknown expense"}
                    </span>
                    <span className="ml-auto shrink-0 tabular-nums">
                      {money(g.fact?.amountCents ?? null)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px]
                                   text-muted-foreground">
                    {shortDate(g.fact?.date ?? null)}
                    <StageDot g={g} />
                  </span>
                </button>
              ))}
            </div>
          </aside>

          {/* THE PANEL: one expense, its receipt, and the decision. */}
          <section className="min-w-0">
            {current === null ? (
              <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
                Pick an expense on the left.
              </p>
            ) : (
              <ExpensePanel
                group={current}
                byMessage={byMessage}
                byExpense={byExpense}
                which={which}
                onWhich={setWhich}
                deciding={decide.isPending}
                onDecide={(messageId, choose) => {
                  /*
                   * PIN THE PANEL TO WHAT IS BEING DECIDED, first.
                   *
                   * Without this the selection was implicit — "the
                   * first row of whatever is showing" — so the
                   * moment an expense was decided it left the
                   * filter, the first row became a different
                   * expense, and the panel jumped to it. The press
                   * answered by changing the subject.
                   */
                  setPicked(current.key);
                  decide.mutate({ dedupeKey: current.key, messageId, choose });
                }}
                sending={send.isPending}
                onSend={(kinds) => {
                  setPicked(current.key);
                  send.mutate({ dedupeKey: current.key, kinds });
                }}
                onNext={next ? () => { setPicked(next.key); setWhich(0); } : null}
                nextLabel={next?.fact?.merchant ?? ""}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * What each kind of change is called where a person reads it.
 *
 * Named for the boxes on Emburse's Edit Expense Details form, so
 * the list reads as the form somebody is about to check it
 * against rather than as this codebase's internal words.
 */
const WRITE_LABEL: Record<Write["kind"], string> = {
  receipt: "Attach",
  note: "Description",
  category: "Category",
  purpose: "Business Purpose",
  location: "Location / Site",
  department: "Department",
  comment: "Comment",
};

/** Where a row has got to, in four words and a colour. */
function StageDot({ g }: { g: Group }) {
  const [label, tone] =
    g.stage === "decide"
      ? [`${g.candidates.length} receipt${g.candidates.length === 1 ? "" : "s"} to check`,
        "text-amber-700 dark:text-amber-400"]
      : g.stage === "send"
        ? ["ready to send", "text-sky-700 dark:text-sky-400"]
        : ["done", "text-emerald-700 dark:text-emerald-400"];
  return <span className={`font-semibold ${tone}`}>· {label}</span>;
}

/**
 * One expense, with the receipt on screen rather than behind a press.
 *
 * Only one of these is mounted at a time, which is what makes an
 * eager preview affordable: the old page offered 417 "Show the
 * receipt" buttons because showing them all would have been 417
 * Graph calls. One is one.
 */
function ExpensePanel({
  group, byMessage, byExpense, which, onWhich, deciding, onDecide, sending, onSend,
  onNext, nextLabel,
}: {
  group: Group;
  byMessage: Map<string, number>;
  byExpense: Map<string, number>;
  which: number;
  onWhich: (n: number) => void;
  deciding: boolean;
  onDecide: (messageId: string, choose: boolean) => void;
  sending: boolean;
  onSend: (kinds: Write["kind"][]) => void;
  onNext: (() => void) | null;
  nextLabel: string;
}) {
  const f = group.fact;
  const open = group.candidates;
  const shownMatch = open[Math.min(which, Math.max(open.length - 1, 0))] ?? group.chosen;
  const alsoThisReceipt = shownMatch ? (byMessage.get(shownMatch.messageId) ?? 0) - 1 : 0;
  const otherReceipts = (byExpense.get(group.key) ?? 0) - 1;

  return (
    <div className="space-y-3 rounded-xl border border-border p-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-bold">{f?.merchant ?? "Unknown expense"}</h3>
        <span className="text-sm tabular-nums">{money(f?.amountCents ?? null)}</span>
        <span className="text-xs text-muted-foreground">
          {shortDate(f?.date ?? null)}
          {f?.category ? ` · ${f.category}` : ""}
          {f?.hasReceipt ? " · a receipt is already held for this one" : ""}
        </span>
        {onNext && (
          <button
            type="button"
            onClick={onNext}
            title={nextLabel ? `Next: ${nextLabel}` : "Next"}
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border
                       px-2.5 py-1 text-xs font-semibold hover:bg-muted"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {f?.note && (
        <p className="truncate text-xs text-muted-foreground">Note: {f.note}</p>
      )}

      {/* Several receipts want this expense: one row of buttons, not
          one card each. The question is "which of these", and that is
          a choice between options rather than a sequence of pages. */}
      {open.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            {open.length} possible receipts:
          </span>
          {open.map((m, i) => (
            <button
              key={m.messageId}
              type="button"
              onClick={() => onWhich(i)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                i === Math.min(which, open.length - 1)
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {m.evidence.merchant || "receipt"} · {money(m.evidence.totalCents)} ·{" "}
              {m.confidence}
            </button>
          ))}
        </div>
      )}

      {shownMatch === null || shownMatch === undefined ? (
        <p className="text-sm text-muted-foreground">
          No receipt was matched to this expense.
        </p>
      ) : (
        <div className="grid items-start gap-3 md:grid-cols-2">
          {/* THE RECEIPT ITSELF, not a description of it. "The total
              matches exactly" is a good reason and it is not the same
              as seeing the thing. These are the same bytes the upload
              would send, so what is on screen is the file that would
              be attached. */}
          <ReceiptFrame
            src={`/api/receipt-mail/preview?message=${encodeURIComponent(shownMatch.messageId)}`}
            alt="The receipt this match is about"
            height="h-[26rem]"
            loading="Fetching the receipt. One that is only in the message body is rendered
                     first, which takes a moment."
          />

          <div className="min-w-0 space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-semibold">
                {shownMatch.evidence.subject || "(no subject)"}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                shownMatch.confidence === "strong"
                  ? "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400"
                  : shownMatch.confidence === "likely"
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    : "bg-muted text-muted-foreground"}`}
              >
                {shownMatch.confidence}
              </span>
              {shownMatch.evidence.hasAttachment && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
                  {shownMatch.evidence.attachments.length} attachment
                  {shownMatch.evidence.attachments.length === 1 ? "" : "s"}
                </span>
              )}
              {group.chosen?.messageId === shownMatch.messageId && (
                <span className="rounded-full bg-emerald-600/15 px-2 py-0.5 text-[10px]
                                 font-semibold text-emerald-700 dark:text-emerald-400">
                  chosen
                </span>
              )}
            </div>

            <p className="text-xs break-words text-muted-foreground">
              {shownMatch.evidence.from} · {shownMatch.evidence.merchant || "unknown merchant"}
              {" · "}{shownMatch.evidence.date ?? "no date"} ·{" "}
              {money(shownMatch.evidence.totalCents)} {shownMatch.evidence.currency}
              {shownMatch.evidence.reference && ` · ref ${shownMatch.evidence.reference}`}
            </p>

            {/* Both conflict shapes, as pills. They were two
                paragraphs of amber on every card — a wall that said
                the same two things 417 times and so stopped being
                read at all. The sentence is in the title. */}
            {(alsoThisReceipt > 0 || otherReceipts > 0) && (
              <div className="flex flex-wrap gap-1.5">
                {alsoThisReceipt > 0 && (
                  <span
                    title="One receipt covering several expenses is real when a purchase was
                           split, and wrong otherwise. Choosing it here does not rule the
                           others out — check them rather than leaving them."
                    className="inline-flex items-center gap-1 rounded-full border
                               border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px]"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    Also matches {alsoThisReceipt} other expense
                    {alsoThisReceipt === 1 ? "" : "s"}
                  </span>
                )}
                {otherReceipts > 0 && (
                  <span
                    title="Choosing one rejects the others for this expense."
                    className="inline-flex items-center gap-1 rounded-full border
                               border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px]"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    {otherReceipts + 1} receipts want this expense
                  </span>
                )}
              </div>
            )}

            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {shownMatch.reasons.map((r) => <li key={r}>· {r}</li>)}
            </ul>

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                What the message says
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted/50 p-2
                              text-[11px] whitespace-pre-wrap">
                {shownMatch.evidence.excerpt}
              </pre>
            </details>

            {shownMatch.state === "candidate" && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={deciding}
                  onClick={() => onDecide(shownMatch.messageId, true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border
                             border-emerald-600/50 px-3 py-1 text-xs font-semibold
                             disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />
                  This is the receipt
                </button>
                <button
                  type="button"
                  disabled={deciding}
                  onClick={() => onDecide(shownMatch.messageId, false)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border
                             px-3 py-1 text-xs disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                  Not this one
                </button>
                <span className="text-[11px] text-muted-foreground">
                  Nothing reaches Emburse until you press Send.
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/*
        * WHAT WOULD BE WRITTEN, before it is.
        *
        * Current value, proposed value, and the state of each. It
        * sits under the expense it is about rather than in a
        * separate list keyed by hash, which is where it used to be:
        * the thing being sent and the thing it is being sent about
        * were two different screens.
        */}
      {group.writes.length > 0 && (() => {
        const unsent = group.writes
          .filter((w) => w.state === "proposed")
          .map((w) => w.kind);
        const broken = group.writes.filter(
          (w) => w.state === "failed" || w.state === "stale");
        const done = group.writes.every(
          (w) => w.state === "applied" || w.state === "already");
        return (
          <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">
                {done
                  ? "Sent to Emburse"
                  : "This is what will change on the expense in Emburse"}
              </p>
              {/* WHICH RULE, OR THAT THERE IS NONE.
                  A panel listing a receipt and a description looks
                  exactly the same whether no rule matched this
                  merchant or the whole rules feature is missing —
                  which is what "where are my rules?" was asking. */}
              {f?.ruleVendor ? (
                <span className="rounded-full bg-emerald-600/15 px-2 py-0.5 text-[11px]
                                 font-semibold text-emerald-700 dark:text-emerald-400">
                  Vendor rule “{f.ruleVendor}”
                  {(f.ruleFills ?? []).length > 0
                    && ` · ${(f.ruleFills ?? []).join(", ")}`}
                </span>
              ) : (
                <a
                  href="#/fill-rules"
                  className="rounded-full border border-border px-2 py-0.5 text-[11px]
                             text-muted-foreground hover:text-foreground"
                >
                  No vendor rule for “{f?.merchant ?? "this merchant"}” — add one
                </a>
              )}
              {/* ONE button for the whole expense. */}
              {unsent.length > 0 && (
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => onSend(unsent)}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg
                             bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white
                             disabled:opacity-50"
                >
                  {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Send to Emburse
                </button>
              )}
            </div>

            <ul className="space-y-1.5 text-xs">
              {group.writes.map((w) => (
                <li key={w.kind} className="flex flex-wrap items-start gap-x-2 gap-y-1">
                  <span className="font-semibold">{WRITE_LABEL[w.kind]}</span>
                  <span className="min-w-40 flex-1 break-words text-muted-foreground">
                    {w.kind !== "receipt" ? (
                      <>
                        <span className="font-mono">{w.was || "(empty)"}</span>
                        {" → "}
                        <span className="font-mono">{w.proposed}</span>
                      </>
                    ) : (
                      <>
                        <span className="font-mono">{w.proposed}</span>
                        {!w.attachmentId && " — rendered from the message body"}
                      </>
                    )}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    w.state === "applied" || w.state === "already"
                      ? "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400"
                      : w.state === "failed" || w.state === "stale"
                        ? "bg-red-500/15 text-red-700 dark:text-red-400"
                        : "bg-muted text-muted-foreground"}`}
                  >
                    {w.state === "already" ? "already there"
                      : w.state === "proposed" ? "not sent yet"
                        : w.state === "queued" ? "sending…" : w.state}
                  </span>
                  {w.error && (
                    <span className="w-full text-red-700 dark:text-red-400">{w.error}</span>
                  )}
                  {/* WHAT THE ATTEMPT ACTUALLY DID.
                      The browser has written a step-by-step log of
                      every attempt — opened Emburse, signed in,
                      found the row, opened the edit form, typed,
                      saved — into the table since the write-back
                      existed, and nothing ever read it back out.
                      One word on screen, the whole story in a
                      column nobody looked at. */}
                  {(w.steps ?? []).length > 0 && (
                    <details className="w-full">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">
                        What it did {w.attempts > 1 ? `· attempt ${w.attempts}` : ""}
                        {w.settledAt
                          ? ` · ${new Date(w.settledAt).toLocaleString()}`
                          : ""}
                      </summary>
                      <ol className="mt-1 space-y-0.5">
                        {(w.steps ?? []).map((st, i) => (
                          <li key={`${st.name}-${i}`} className="flex items-start gap-1.5">
                            <span className={st.ok
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-red-700 dark:text-red-400"}>
                              {st.ok ? "✓" : "✗"}
                            </span>
                            <span className="font-semibold">{st.name}</span>
                            <span className="min-w-0 flex-1 break-words text-muted-foreground">
                              {st.detail}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </li>
              ))}
            </ul>

            {/* The split only matters when half of it fails: the
                attach can land while the field edit hits a changed
                form, and a blanket retry would redo the half that
                already worked. */}
            {broken.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border
                              pt-2 text-xs">
                <span className="text-red-700 dark:text-red-400">
                  {broken.length === group.writes.length
                    ? "None of those reached Emburse."
                    : `${broken.map((w) => WRITE_LABEL[w.kind]).join(" and ")} did not `
                      + "reach Emburse; the rest did."}
                </span>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => onSend(broken.map((w) => w.kind))}
                  className="rounded-lg border border-sky-600/50 px-3 py-1 font-semibold
                             disabled:opacity-50"
                >
                  Try that part again
                </button>
              </div>
            )}

            {group.writes.some((w) => w.state === "queued") && (
              <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
                Sending happens on the server, not in this tab: it signs into Emburse
                with its own browser, which takes a few minutes. This page is watching
                and will say what happened — you can close it and come back.
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              Sent under {group.writes[0]!.lane.replace(/^personal-/, "")}&rsquo;s own
              Emburse login — every line above is one edit to this one expense, done in
              one visit by the one press. It attaches and edits; it never submits,
              approves or denies.
            </p>
          </div>
        );
      })()}
    </div>
  );
}
