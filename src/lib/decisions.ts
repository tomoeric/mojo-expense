import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  /** True when the viewer is the one who can answer it. */
  mine: boolean;
};

export type DecisionsResponse = {
  /** Whether this person has an Emburse login, without which they cannot decide. */
  canDecide: boolean;
  pending: QueuedDecision[];
  recent: QueuedDecision[];
  byExpense: Record<string, QueuedDecision>;
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
      (query.state.data?.pending.length ?? 0) > 0 || query.state.data?.challenge ? 3000 : false,
    refetchIntervalInBackground: true,
  });

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
 * the next failure to appear is visibly a new one. `onlyGone` clears just
 * the ones Emburse no longer has in Needs Review.
 */
export async function clearFailed(onlyGone = false): Promise<number> {
  const res = await fetch(`/api/decisions/clear-failed${onlyGone ? "?gone=1" : ""}`,
    { method: "POST" });
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
export async function inspectEditForm(id: number): Promise<{
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
