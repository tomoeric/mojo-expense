import { db, ensureSchema } from "../db.js";
import type { Decision, Target } from "./decide.js";

/**
 * Decisions a reviewer has made, and whether they reached Emburse yet.
 *
 * Clicking Approve does not drive a browser. It records the decision here and
 * returns — because a decision that drives Emburse on the click takes about
 * ninety seconds, and twenty of them is half an hour during which the export
 * cannot run. Queued, a whole morning's review is a minute of clicking and one
 * browser session that signs in once.
 *
 * The queue is also the audit record. Who decided, when, why, what row it was
 * applied to in Emburse, and what went wrong if it did not — all kept, because
 * "somebody approved this" is a question that gets asked months later.
 */

export type DecisionState = "pending" | "applied" | "failed" | "cancelled";

/** One stage of the browser run, as the export log already reports them. */
export type DecisionStep = { name: string; ok: boolean; detail: string; ms: number };

export type QueuedDecision = {
  id: number;
  dedupeKey: string;
  decision: Decision;
  reason: string | null;
  decidedBy: string;
  decidedAt: string;
  state: DecisionState;
  attempts: number;
  appliedAt: string | null;
  /** The Emburse row it was applied to, proving which one it hit. */
  matchedRow: string | null;
  error: string | null;
  /** What the expense looked like when it was decided, for the record. */
  target: Target;
  /**
   * Every stage of the run, when tracing is on. Null when it is off, which is
   * the default — so a missing trace means "not recorded", never "no steps".
   */
  steps: DecisionStep[] | null;
  /** A screenshot of the page where it failed, when tracing was on. */
  shot: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS expense_decisions (
  id          bigserial PRIMARY KEY,
  -- No foreign key, on purpose. An import deletes every expense the newest
  -- export no longer carries, and the record of who approved or denied one has
  -- to outlive that: it is the only audit trail on this side of the wire, and
  -- the target column below froze everything it needs to stand on its own.
  dedupe_key  text        NOT NULL,
  decision    text        NOT NULL CHECK (decision IN ('approve','deny')),
  reason      text,
  decided_by  text        NOT NULL,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  state       text        NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending','applied','failed','cancelled')),
  attempts    integer     NOT NULL DEFAULT 0,
  applied_at  timestamptz,
  matched_row text,
  error       text,
  -- What the reviewer was looking at, frozen. The expense row can change
  -- between deciding and applying, and the decision was made about these
  -- figures, not whatever they became.
  target      jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS expense_decisions_state_idx ON expense_decisions (state, decided_at);
CREATE INDEX IF NOT EXISTS expense_decisions_key_idx   ON expense_decisions (dedupe_key);
-- One decision in flight per expense. Deciding twice while the first is still
-- queued would drive Emburse twice for one row, and the second would find
-- nothing and report a failure that was never real.
CREATE UNIQUE INDEX IF NOT EXISTS expense_decisions_one_pending
  ON expense_decisions (dedupe_key) WHERE state = 'pending';
-- Databases created before the purge have the cascade above. Dropped rather
-- than left in place: with it, purging an expense silently takes the record of
-- its decision along too.
ALTER TABLE expense_decisions DROP CONSTRAINT IF EXISTS expense_decisions_dedupe_key_fkey;
-- The step-by-step trace of the browser run, kept only when the trace flag is
-- on. Before this, a failure was one line of text and the question "where did
-- it stop" could only be answered by approving a real expense and watching.
ALTER TABLE expense_decisions ADD COLUMN IF NOT EXISTS steps jsonb;
-- The page at the moment it gave up, base64 PNG.
--
-- The run has always taken this on a failure and then thrown it away. For
-- "it sits on a step and then errors out with no message" it is the single
-- most informative thing there is: a spinner, a modal nobody expected, a
-- session bounced back to sign-in, all of them obvious in a picture and
-- invisible in a step name. Kept only when the trace toggle is on, and only
-- for failures.
ALTER TABLE expense_decisions ADD COLUMN IF NOT EXISTS shot text;
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
  }));

type Row = {
  id: string; dedupe_key: string; decision: Decision; reason: string | null;
  decided_by: string; decided_at: Date; state: DecisionState; attempts: number;
  applied_at: Date | null; matched_row: string | null; error: string | null; target: Target;
  steps: DecisionStep[] | null; shot: string | null;
};

const shape = (r: Row): QueuedDecision => ({
  id: Number(r.id),
  dedupeKey: r.dedupe_key,
  decision: r.decision,
  reason: r.reason,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at.toISOString(),
  state: r.state,
  attempts: r.attempts,
  appliedAt: r.applied_at ? r.applied_at.toISOString() : null,
  matchedRow: r.matched_row,
  error: r.error,
  target: r.target,
  steps: r.steps ?? null,
  shot: r.shot ?? null,
});

const COLUMNS = `id, dedupe_key, decision, reason, decided_by, decided_at, state,
                 attempts, applied_at, matched_row, error, target, steps, shot`;

/**
 * Record a decision, to be applied on the next pass.
 *
 * A denial without a reason is refused here rather than in the UI, because the
 * UI is not the only way in and the reason is the whole point: the employee
 * has to be told something, and "denied" on its own becomes somebody's
 * afternoon chasing why.
 */
export async function queueDecision(input: {
  dedupeKey: string;
  decision: Decision;
  reason: string;
  decidedBy: string;
  target: Target;
}): Promise<{ ok: true; queued: QueuedDecision } | { ok: false; error: string }> {
  await ensure();

  const reason = input.reason.trim();
  if (input.decision === "deny" && reason.length < 3) {
    return { ok: false, error: "A denial needs a reason — the employee is told what it says." };
  }

  try {
    const { rows } = await db().query<Row>(
      `INSERT INTO expense_decisions (dedupe_key, decision, reason, decided_by, target)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
      [input.dedupeKey, input.decision, reason || null, input.decidedBy, JSON.stringify(input.target)],
    );
    return { ok: true, queued: shape(rows[0]!) };
  } catch (err) {
    // The partial unique index, most likely: something is already queued for
    // this expense. That is a sentence, not a stack trace.
    if (err instanceof Error && /expense_decisions_one_pending/.test(err.message)) {
      return { ok: false, error: "A decision for this expense is already waiting to be applied." };
    }
    if (err instanceof Error && /expense_decisions_dedupe_key_fkey/.test(err.message)) {
      return { ok: false, error: "That expense is no longer in the queue." };
    }
    throw err;
  }
}

/** Everything still waiting, oldest first — the order they will be applied in. */
export async function pendingDecisions(): Promise<QueuedDecision[]> {
  await ensure();
  const { rows } = await db().query<Row>(
    `SELECT ${COLUMNS} FROM expense_decisions WHERE state = 'pending' ORDER BY decided_at`,
  );
  return rows.map(shape);
}

/** The decision history for the expenses on screen, keyed by expense. */
export async function decisionsFor(keys: string[]): Promise<Map<string, QueuedDecision>> {
  await ensure();
  if (keys.length === 0) return new Map();
  // The newest per expense: an expense that failed and was decided again
  // should show the current attempt, not the abandoned one.
  const { rows } = await db().query<Row>(
    `SELECT DISTINCT ON (dedupe_key) ${COLUMNS}
       FROM expense_decisions
      WHERE dedupe_key = ANY($1) AND state <> 'cancelled'
      ORDER BY dedupe_key, decided_at DESC`,
    [keys],
  );
  return new Map(rows.map((r) => [r.dedupe_key, shape(r)]));
}

/** The last few decisions, whatever became of them. */
export async function recentDecisions(limit = 50): Promise<QueuedDecision[]> {
  await ensure();
  const { rows } = await db().query<Row>(
    `SELECT ${COLUMNS} FROM expense_decisions ORDER BY decided_at DESC LIMIT $1`, [limit]);
  return rows.map(shape);
}

/** Take back a decision that has not reached Emburse yet. */
export async function cancelDecision(id: number, by: string): Promise<boolean> {
  await ensure();
  const { rowCount } = await db().query(
    `UPDATE expense_decisions
        SET state = 'cancelled', error = $2
      WHERE id = $1 AND state = 'pending'`,
    [id, `Cancelled by ${by}`],
  );
  return (rowCount ?? 0) > 0;
}

/** Record how applying one went. */
/**
 * Record that a pass tried and could not, WITHOUT settling the decision.
 *
 * The difference from settling matters. A decision that failed is finished
 * and the reviewer has to decide again; one that could not be attempted —
 * the browser would not launch, the settings would not load, the stored
 * password would not decrypt — is still perfectly good and should be
 * retried. It just must not sit there saying "shortly" for ever with the
 * reason only in a server log nobody is reading.
 *
 * That was the whole failure mode: the worker's catch logged and swallowed,
 * every decision stayed pending, and the queue answered "why did nothing
 * happen" with silence.
 */
export async function noteAttemptFailed(ids: number[], error: string): Promise<void> {
  if (ids.length === 0) return;
  await ensure();
  await db().query(
    `UPDATE expense_decisions
        SET attempts = attempts + 1, error = $2
      WHERE id = ANY($1::bigint[]) AND state = 'pending'`,
    [ids, error.slice(0, 1000)],
  );
}

/**
 * Queue one approval, with every check the single-expense path makes.
 *
 * Shared by the one-at-a-time route and the bulk one, on purpose. A batch
 * is a convenience for the person, never a lighter standard for the
 * decision — and the surest way for it to become one is two code paths
 * that were the same on the day they were written. A test of the bulk
 * path that reimplemented these checks would agree with itself while the
 * route drifted.
 */
export async function queueApprovalFor(
  dedupeKey: string,
  decidedBy: string,
): Promise<{ ok: true; queued: QueuedDecision } | { ok: false; error: string }> {
  await ensure();
  const { rows } = await db().query<{
    employee: string; merchant: string; amount_cents: string; expense_date: Date | null;
  }>(
    `SELECT employee, merchant, amount_cents, expense_date FROM expenses WHERE dedupe_key = $1`,
    [dedupeKey],
  );
  const r = rows[0];
  if (!r) return { ok: false, error: "that expense is no longer in the queue" };
  return queueDecision({
    dedupeKey,
    decision: "approve",
    reason: "",
    decidedBy,
    target: {
      employee: r.employee,
      merchant: r.merchant,
      amount: Number(r.amount_cents) / 100,
      date: r.expense_date ? r.expense_date.toISOString().slice(0, 10) : null,
    },
  });
}

/**
 * Re-queue every failure, as the person pressing the button.
 *
 * A whole batch can fail on one cause — a slow morning where the first
 * navigation timed out, a session Emburse bounced — and then eighteen rows
 * each need a click to try again. Pressing Approve eighteen times to
 * recover from one outage is not a decision anybody is making; it is
 * typing.
 *
 * The decision is recorded against whoever presses this, not against whoever
 * decided originally. That is not a detail: Emburse records an approval
 * against the login it is applied under, and this re-queues them to be
 * applied under the presser's. Anyone who would not be willing to approve
 * these under their own name should not press it.
 *
 * Only the newest decision per expense, and only when it is the failed one:
 * an expense that failed and was then approved successfully is finished.
 */
export async function retryFailedDecisions(
  by: string,
): Promise<{ queued: number; refused: string[] }> {
  await ensure();
  // The newest decision per expense, then only the ones that failed. An
  // expense that failed and was decided again successfully is finished, and
  // re-queuing it would approve it twice.
  const { rows } = await db().query<Row>(
    `SELECT ${COLUMNS}
       FROM (SELECT DISTINCT ON (dedupe_key) *
               FROM expense_decisions
              WHERE state <> 'cancelled'
              ORDER BY dedupe_key, decided_at DESC) d
      WHERE d.state = 'failed'
        AND EXISTS (SELECT 1 FROM expenses e
                     WHERE e.dedupe_key = d.dedupe_key AND e.in_inbox = true)
      ORDER BY d.decided_at`,
  );
  const refused: string[] = [];
  let queued = 0;
  for (const r of rows) {
    const d = shape(r);
    const out = await queueDecision({
      dedupeKey: d.dedupeKey,
      decision: d.decision,
      // A denial's reason is required and is what the employee reads.
      reason: d.reason ?? "",
      decidedBy: by,
      target: d.target,
    });
    if (out.ok) queued++;
    else refused.push(`${d.target.merchant} $${d.target.amount.toFixed(2)}: ${out.error}`);
  }
  return { queued, refused };
}

/** How many expenses still held locally have already been actioned. */
export async function appliedCount(): Promise<number> {
  await ensure();
  const { rows } = await db().query<{ n: string }>(
    `SELECT count(*) AS n
       FROM expense_decisions d
       JOIN expenses e ON e.dedupe_key = d.dedupe_key
      WHERE d.state = 'applied' AND e.in_inbox = true`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function settleDecision(
  id: number,
  outcome: { ok: true; matchedRow: string | null } | { ok: false; error: string },
  /**
   * The browser run, step by step. Stored only when the trace flag is on, and
   * on a SUCCESS as well as a failure — "it worked, here is how" is what makes
   * a later failure readable by comparison.
   */
  steps?: DecisionStep[] | null,
  /** Base64 PNG of where it stopped. Stored only with the trace, and only on a failure. */
  shot?: string | null,
): Promise<void> {
  await ensure();
  await db().query(
    `UPDATE expense_decisions
        SET state      = $2,
            attempts   = attempts + 1,
            applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END,
            matched_row = COALESCE($3, matched_row),
            error      = $4,
            steps      = COALESCE($5::jsonb, steps),
            shot       = CASE WHEN $2 = 'applied' THEN NULL ELSE COALESCE($6, shot) END
      WHERE id = $1`,
    [
      id,
      outcome.ok ? "applied" : "failed",
      outcome.ok ? outcome.matchedRow : null,
      outcome.ok ? null : outcome.error.slice(0, 1000),
      steps && steps.length > 0 ? JSON.stringify(steps) : null,
      // Capped rather than trusted: a full-page PNG of a long grid can run
      // to megabytes, and a row in this table is read on every queue poll.
      shot && shot.length < 2_000_000 ? shot : null,
    ],
  );
}

/**
 * Expenses approved here whose approval Emburse has since confirmed.
 *
 * "Confirmed" means the expense stopped appearing in the export, which only
 * happens once the approval really took — and with the purge, that is also
 * the moment its row is deleted. So the confirmed ones are exactly the
 * decisions with no expense left to join to.
 */
export async function confirmedApprovals(): Promise<string[]> {
  await ensure();
  const { rows } = await db().query<{ dedupe_key: string }>(
    `SELECT d.dedupe_key
       FROM expense_decisions d
      WHERE d.decision = 'approve' AND d.state = 'applied'
        AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.dedupe_key = d.dedupe_key)`,
  );
  return rows.map((r) => r.dedupe_key);
}
