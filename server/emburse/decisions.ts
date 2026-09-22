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
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS expense_decisions (
  id          bigserial PRIMARY KEY,
  dedupe_key  text        NOT NULL REFERENCES expenses (dedupe_key) ON DELETE CASCADE,
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
});

const COLUMNS = `id, dedupe_key, decision, reason, decided_by, decided_at, state,
                 attempts, applied_at, matched_row, error, target`;

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
export async function settleDecision(
  id: number,
  outcome: { ok: true; matchedRow: string | null } | { ok: false; error: string },
): Promise<void> {
  await ensure();
  await db().query(
    `UPDATE expense_decisions
        SET state      = $2,
            attempts   = attempts + 1,
            applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END,
            matched_row = COALESCE($3, matched_row),
            error      = $4
      WHERE id = $1`,
    [
      id,
      outcome.ok ? "applied" : "failed",
      outcome.ok ? outcome.matchedRow : null,
      outcome.ok ? null : outcome.error.slice(0, 1000),
    ],
  );
}

/**
 * Expenses approved here whose approval Emburse has since confirmed.
 *
 * "Confirmed" means the expense has left the inbox — it stopped appearing in
 * the export, which only happens once the approval really took. That is the
 * moment a receipt image is safe to delete: before it, a failed approval would
 * lose a picture that can never be fetched again, because an expense out of
 * the inbox is out of every future export too.
 */
export async function confirmedApprovals(): Promise<string[]> {
  await ensure();
  const { rows } = await db().query<{ dedupe_key: string }>(
    `SELECT d.dedupe_key
       FROM expense_decisions d
       JOIN expenses e ON e.dedupe_key = d.dedupe_key
      WHERE d.decision = 'approve' AND d.state = 'applied' AND e.in_inbox = false`,
  );
  return rows.map((r) => r.dedupe_key);
}
