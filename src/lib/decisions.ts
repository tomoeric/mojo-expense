import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/**
 * The reviewer's side of approving and denying.
 *
 * Deciding does not drive Emburse — it records the decision and returns, and a
 * worker applies the queue in one browser session shortly after. So everything
 * here is optimistic about the click and honest about the rest: a row shows
 * "waiting" until Emburse has actually been told, and says so plainly if that
 * fails.
 */

export type DecisionState = "pending" | "applied" | "failed" | "cancelled";

export type QueuedDecision = {
  id: number;
  dedupeKey: string;
  decision: "approve" | "deny";
  reason: string | null;
  decidedBy: string;
  decidedAt: string;
  state: DecisionState;
  attempts: number;
  appliedAt: string | null;
  /** Emburse's own export has carried the new category back. */
  confirmedByImport?: boolean;
  matchedRow: string | null;
  error: string | null;
  /**
   * The browser run stage by stage, when the trace is switched on in
   * Configuration. Null means it was not recorded — never that there were
   * no steps.
   */
  steps: { name: string; ok: boolean; detail: string; ms: number }[] | null;
  /** The page where it stopped, base64 PNG. Only kept when tracing is on. */
  shot?: string | null;
  /** Decided by the automation rather than by a person clicking. */
  automatic?: boolean;
  /**
   * Emburse has nothing matching this in Needs Review — not a fault, and
   * nothing a retry can change. It clears when the next import removes the
   * expense.
   */
  notInQueue?: boolean;
  /** When it last went wrong. Null when it has not, or is too old to say. */
  failedAt?: string | null;
};

export type Challenge = {
  prompt: string;
  screenshot: string | null;
  owner: string;
  /** The Emburse login the code was mailed to — which inbox to open. */
  loginEmail?: string | null;
  attempt: number;
  maxAttempts: number;
  attemptsLeft?: number;
  lastError: string | null;
  startedAt?: string;
  /** When the wait gives up, so the page can show a clock instead of hiding one. */
  expiresAt?: string;
  /** True when the viewer is the one who can answer it. */
  mine: boolean;
};

export type Correction = {
  id: number;
  dedupeKey: string;
  from: string;
  to: string;
  requestedBy: string;
  requestedAt: string;
  state: "pending" | "applied" | "failed" | "cancelled";
  appliedAt: string | null;
  failedAt: string | null;
  attempts: number;
  error: string | null;
};

export type DecisionsResponse = {
  /** Whether this person has an Emburse login, without which they cannot decide. */
  canDecide: boolean;
  pending: QueuedDecision[];
  recent: QueuedDecision[];
  byExpense: Record<string, QueuedDecision>;
  /** Category changes on their way to Emburse, keyed by expense. */
  corrections?: Record<string, Correction>;
  browser: { holder: { label: string; since: number } | null; waiting: string[] };
  /** Whether the stage-by-stage trace is switched on in Configuration. */
  trace?: boolean;
  /** Waiting expenses this app has already approved or denied. */
  applied?: number;
  /** Set when a decision is parked waiting for a device-verification code. */
  challenge: Challenge | null;
  /** Paused by hand — nothing is queued automatically and no batch starts. */
  held?: boolean;
  /** An import is running, which holds automatic approvals by itself. */
  importing?: boolean;
};

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(
      /timeout/i.test(body)
        ? "The request timed out on the way to the server."
        : `The server replied with something unexpected (${res.status}).`,
    );
  }
}

export function useDecisions(keys: string[]) {
  const qc = useQueryClient();

  const q = useQuery({
    // Keyed on the expenses on screen, so switching view refetches their
    // badges rather than showing the previous list's.
    queryKey: ["decisions", keys.join(",")],
    queryFn: async () => {
      const res = await fetch(`/api/decisions?keys=${encodeURIComponent(keys.join(","))}`);
      const body = await readJson<DecisionsResponse & { error?: string }>(res);
      if (!res.ok) throw new Error(body.error ?? "Could not read decisions.");
      return body;
    },
    // Only while something is waiting to reach Emburse. A queue page with
    // nothing pending has no reason to poll — except while a sign-in is parked
    // on a code, which is exactly when the page has to stay live.
    refetchInterval: (query) =>
      (query.state.data?.pending.length ?? 0) > 0
      || query.state.data?.challenge
      // A category change is the slowest thing this page starts, and the
      // row has to stop saying "about a minute" when it lands.
      || Object.values(query.state.data?.corrections ?? {}).some((c) => c.state === "pending")
        ? 3000
        : false,
    refetchIntervalInBackground: true,
  });

  // The queue refreshes ITSELF when a decision settles, without anybody
  // pressing anything.
  //
  // The poll above keeps the badges current, but the row list came from a
  // separate query that nothing told. So an expense the run established
  // had already left Emburse sat there greyed out until the page was
  // reloaded — and "auto remove, don't require a page refresh" is the
  // whole point of watching it land.
  //
  // Keyed on what each decision IS, not on how many there are: a pending
  // that becomes applied is the interesting change and the count does not
  // move. Compared as a string so a poll returning the same thing costs
  // nothing.
  const settled = (q.data?.recent ?? [])
    .map((d) => `${d.id}:${d.state}`).join(",");
  const pendingIds = (q.data?.pending ?? []).map((d) => d.id).join(",");
  const signature = `${settled}|${pendingIds}|${q.data?.applied ?? 0}`;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (seen.current === null) { seen.current = signature; return; }
    if (seen.current === signature) return;
    seen.current = signature;
    void qc.invalidateQueries({ queryKey: ["reports"] });
  }, [signature, qc]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["decisions"] });
    // The queue itself changes once a decision lands, so it is refreshed too.
    void qc.invalidateQueries({ queryKey: ["reports"] });
  };

  const answerCode = useMutation({
    mutationFn: async (code: string) => {
      const res = await fetch("/api/decisions/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await readJson<{ ok?: boolean; error?: string }>(res);
      if (!res.ok) throw new Error(body.error ?? "That code was not accepted.");
      return body;
    },
    onSuccess: invalidate,
  });

  const decide = useMutation({
    mutationFn: async (input: { dedupeKey: string; decision: "approve" | "deny"; reason?: string }) => {
      const res = await fetch("/api/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await readJson<{ error?: string }>(res);
      if (!res.ok) throw new Error(body.error ?? "Could not record that decision.");
      return body;
    },
    onSuccess: invalidate,
  });

  const cancel = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/decisions/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await readJson<{ error?: string }>(res)).error ?? "Could not cancel it.");
    },
    onSuccess: invalidate,
  });

  const applyNow = useMutation({
    mutationFn: async (): Promise<string> => {
      const res = await fetch("/api/decisions/apply", { method: "POST" });
      const body = await readJson<{ error?: string; message?: string }>(res);
      if (!res.ok) throw new Error(body.error ?? "Could not start it.");
      // The server says what it is actually about to do. Swallowing that was
      // why the button looked broken: pressing it produced no visible change
      // whatsoever, so the only reading available was "nothing happened".
      return body.message ?? "Starting now.";
    },
    onSuccess: invalidate,
  });

  return {
    data: q.data,
    canDecide: q.data?.canDecide ?? false,
    /** Whether the stage-by-stage trace is switched on in Configuration. */
    trace: q.data?.trace ?? false,
    /** Already actioned and only waiting for the next sync to disappear. */
    applied: q.data?.applied ?? 0,
    /** Paused by hand, and whether an import is holding things up anyway. */
    held: q.data?.held ?? false,
    importing: q.data?.importing ?? false,
    byExpense: q.data?.byExpense ?? {},
    corrections: q.data?.corrections ?? {},
    pending: q.data?.pending ?? [],
    recent: q.data?.recent ?? [],
    browser: q.data?.browser,
    challenge: q.data?.challenge ?? null,
    decide,
    cancel,
    applyNow,
    answerCode,
  };
}

/**
 * Run a failed decision again, exactly as it was decided.
 *
 * Re-deciding inserts a NEW row (the unique index only covers pending
 * ones) and the queue shows the newest per expense, so this is the same
 * thing as pressing Approve again — just reachable from the failure that
 * prompts it, rather than requiring somebody to close the dialog and find
 * the button behind it.
 */
export async function retryDecision(d: {
  dedupeKey: string; decision: "approve" | "deny"; reason: string | null;
}): Promise<void> {
  const res = await fetch("/api/decisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dedupeKey: d.dedupeKey,
      decision: d.decision,
      // A denial's reason is required and is what the employee reads, so it
      // has to be carried over rather than re-typed.
      reason: d.reason ?? "",
    }),
  });
  if (!res.ok) {
    const body = await readJson<{ error?: string }>(res);
    throw new Error(body.error ?? "Could not queue it again.");
  }
}

export type FailureGroup = { reason: string; n: number; example: string };

/** What the failures are, grouped — a shape rather than a count. */
export async function failureGroups(): Promise<FailureGroup[]> {
  const res = await fetch("/api/decisions/failures");
  const body = await readJson<{ groups?: FailureGroup[]; error?: string }>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not read the failures.");
  return body.groups ?? [];
}

/** Pause everything reaching Emburse, or let it go again. */
export async function holdDecisions(held: boolean): Promise<void> {
  const res = await fetch("/api/decisions/hold", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ held }),
  });
  if (!res.ok) {
    throw new Error((await readJson<{ error?: string }>(res)).error ?? "Could not change it.");
  }
}

/** Re-queue every decision that failed, as the signed-in user. */
export async function retryAllFailed(): Promise<{ queued: number; refused: string[] }> {
  const res = await fetch("/api/decisions/retry-failed", { method: "POST" });
  const body = await readJson<{ queued?: number; refused?: string[]; error?: string }>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not queue them again.");
  return { queued: body.queued ?? 0, refused: body.refused ?? [] };
}

/**
 * Put the failures down.
 *
 * Nothing reaches Emburse — this only clears what our own queue shows, so
 * the next failure to appear is visibly a new one. An expense Emburse no
 * longer has in Needs Review never gets here: it is settled as cancelled on
 * the spot and comes off the list by itself.
 */
export async function clearFailed(): Promise<number> {
  const res = await fetch("/api/decisions/clear-failed", { method: "POST" });
  const body = await readJson<{ cleared?: number; error?: string }>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not clear them.");
  return body.cleared ?? 0;
}

/** Approve everything that was ticked, in one request. */
export async function approveMany(dedupeKeys: string[]): Promise<{ queued: number; refused: string[] }> {
  const res = await fetch("/api/decisions/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dedupeKeys }),
  });
  const body = await readJson<{ error?: string; queued: number; refused: string[] }>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not queue those approvals.");
  return { queued: body.queued, refused: body.refused ?? [] };
}

/** Look at Emburse's edit form for a queued expense, changing nothing. */
/**
 * Look at Emburse's edit form for an expense, without saving anything.
 *
 * Takes a queued decision's id OR an expense's own key: the rows this is
 * most needed for are the ones nobody wants to approve yet, which by
 * definition have no decision queued against them.
 */
export async function inspectEditForm(id: number | string): Promise<{
  ok: boolean;
  steps: { name: string; ok: boolean; detail: string; ms: number }[];
  fields: string[];
  screenshot: string | null;
}> {
  const res = await fetch(`/api/decisions/${id}/edit-form`, { method: "POST" });
  const body = await readJson<{
    error?: string; ok: boolean; fields: string[]; screenshot: string | null;
    steps: { name: string; ok: boolean; detail: string; ms: number }[];
  }>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not look at the form.");
  return body;
}

/** Prove a queued decision finds the right row, without making it. */
export async function testDecision(id: number): Promise<{
  ok: boolean;
  steps: { name: string; ok: boolean; detail: string; ms: number }[];
  matchedRow: string | null;
  screenshot: string | null;
}> {
  const res = await fetch(`/api/decisions/${id}/test`, { method: "POST" });
  const body = await readJson<{
    error?: string;
    ok: boolean;
    steps: { name: string; ok: boolean; detail: string; ms: number }[];
    matchedRow: string | null;
    screenshot: string | null;
  }>(res);
  if (!res.ok) throw new Error(body.error ?? "The test could not run.");
  return body;
}

/**
 * Change an expense's category in Emburse.
 *
 * Synchronous: it signs in, finds the row, edits and checks, which takes
 * about a minute — and the thing the person wants to know is whether it
 * took, which is not worth hiding behind a queue for one deliberate act.
 */
/**
 * Ask for a category change. Returns as soon as it is written down.
 *
 * The run itself takes about a minute — sign in, find the row, edit, save,
 * check — and used to be awaited here, which meant closing the drawer threw
 * away the only thing that knew the answer. It is a record now: the queue
 * shows it on the row until it lands, whoever is looking and whatever is
 * open.
 */
export async function correctCategory(input: {
  dedupeKey: string;
  from: string;
  category: string;
}): Promise<Correction> {
  const res = await fetch("/api/decisions/correct-category", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await readJson<{ error?: string; correction: Correction }>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not ask for the change.");
  return body.correction;
}

/** Put the failed corrections down. Nothing reaches Emburse. */
/** Ask again for every failed correction, exactly as it was asked. */
export async function retryFailedCorrections(): Promise<number> {
  const res = await fetch("/api/corrections/retry-failed", { method: "POST" });
  const body = (await res.json()) as { queued?: number; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Could not ask again.");
  return body.queued ?? 0;
}

export async function clearFailedCorrections(): Promise<number> {
  const res = await fetch("/api/corrections/clear-failed", { method: "POST" });
  const body = await readJson<{ error?: string; cleared?: number }>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not clear them.");
  return body.cleared ?? 0;
}
