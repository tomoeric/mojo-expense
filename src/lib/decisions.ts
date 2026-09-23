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
  /** Set when a decision is parked waiting for a device-verification code. */
  challenge: Challenge | null;
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
    mutationFn: async () => {
      const res = await fetch("/api/decisions/apply", { method: "POST" });
      if (!res.ok) throw new Error((await readJson<{ error?: string }>(res)).error ?? "Could not start it.");
    },
    onSuccess: invalidate,
  });

  return {
    data: q.data,
    canDecide: q.data?.canDecide ?? false,
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
