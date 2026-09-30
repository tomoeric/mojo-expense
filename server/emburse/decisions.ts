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
  /**
   * Whether a machine decided this, rather than a person.
   *
   * Both carry the same name — an automatic approval is applied under the
   * login of whoever switched the automation on, so `decidedBy` cannot tell
   * them apart. Without this, a queue of approvals gives no way to ask
   * which ones a person actually looked at, which is the first question
   * anybody asks of an automation that approves spending.
   */
  automatic: boolean;
  /**
   * The failure was "Emburse has nothing matching this in Needs Review".
   *
   * A different thing from a failure, and it was drowning the queue as one.
   * An expense that has already been approved or denied LEAVES Needs Review,
   * so once our copy of the queue is a few days stale, every decision on it
   * fails this way — and retrying searches the same empty view, for ever.
   * Nothing here can fix it and nothing should try: the next import deletes
   * the expense, and these go with it.
   */
  notInQueue: boolean;
  /** When it last went wrong. Null on rows that failed before this existed. */
  failedAt: string | null;
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
-- Decided by the automation rather than by a person. Both are applied under
-- a real login and carry that person's name in Emburse, so decided_by does
-- not distinguish them — and "which of these did anybody actually look at"
-- is the question an automation that approves spending has to be able to
-- answer. Defaults false: everything decided before this column existed was
-- decided by somebody clicking.
ALTER TABLE expense_decisions ADD COLUMN IF NOT EXISTS automatic boolean NOT NULL DEFAULT false;
-- The failure that is not a fault: the expense is not in Emburse's Needs
-- Review at all. Kept apart from ordinary failures because the answer to it
-- is different — nothing to fix, nothing to retry, it clears at the next
-- import — and because forty of them in one list buries the handful that do
-- need somebody.
ALTER TABLE expense_decisions ADD COLUMN IF NOT EXISTS not_in_queue boolean NOT NULL DEFAULT false;
-- WHEN it failed, which is not when it was decided.
--
-- A decision queued on Monday and attempted on Thursday carried Monday's
-- date and nothing else, so thirty-five failures spanning several runs were
-- one undifferentiated pile — "hard to tell what is new and what is old",
-- exactly. Null on rows that failed before this column existed, and those
-- read as "at some point", which is the truth about them.
ALTER TABLE expense_decisions ADD COLUMN IF NOT EXISTS failed_at timestamptz;
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
  steps: DecisionStep[] | null; shot: string | null; automatic: boolean;
  not_in_queue: boolean; failed_at: Date | null;
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
  automatic: r.automatic ?? false,
  notInQueue: r.not_in_queue ?? false,
  failedAt: r.failed_at ? r.failed_at.toISOString() : null,
});

const COLUMNS = `id, dedupe_key, decision, reason, decided_by, decided_at, state,
                 attempts, applied_at, matched_row, error, target, steps, shot, automatic,
                 not_in_queue, failed_at`;

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
  /** Set by the automation. Absent means a person clicked it. */
  automatic?: boolean;
}): Promise<{ ok: true; queued: QueuedDecision } | { ok: false; error: string }> {
  await ensure();

  const reason = input.reason.trim();
  if (input.decision === "deny" && reason.length < 3) {
    return { ok: false, error: "A denial needs a reason — the employee is told what it says." };
  }

  try {
    const { rows } = await db().query<Row>(
      `INSERT INTO expense_decisions (dedupe_key, decision, reason, decided_by, target, automatic)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [input.dedupeKey, input.decision, reason || null, input.decidedBy,
       JSON.stringify(input.target), input.automatic === true],
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
  opts: { automatic?: boolean } = {},
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
    automatic: opts.automatic === true,
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
        -- Not these. The run already established that Emburse has nothing
        -- matching them in Needs Review; searching the same empty view again
        -- is the definition of doing the same thing twice.
        AND d.not_in_queue = false
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
      // Carried through, not cleared. Pressing "try again" re-attempts the
      // APPLYING; it is not somebody reviewing the expense. Clearing it here
      // would quietly launder every automatic approval into a reviewed one
      // the first time a batch had to be re-run.
      automatic: d.automatic,
    });
    if (out.ok) queued++;
    else refused.push(`${d.target.merchant} $${d.target.amount.toFixed(2)}: ${out.error}`);
  }
  return { queued, refused };
}

/**
 * Put the failures down.
 *
 * A failed decision is a note to somebody, and a note nobody can put down
 * stops being a note. Thirty-five of them sat on the queue across several
 * runs, some from days ago and some from minutes ago, and the strip counted
 * them as one number — so the honest answer to "what is new here" was to
 * read every row. Clearing is what makes the next failure legible: an empty
 * strip means the next thing to appear in it is new.
 *
 * Cancelled, not deleted. The row stays as the record that it was tried and
 * did not land, with who cleared it and when written on it; everything that
 * reads decisions already ignores `cancelled`, so the expense simply goes
 * back to offering Approve and Deny.
 *
 * It does NOT touch anything pending or applied. Clearing is about the
 * failures on screen, and cancelling a decision that is on its way to
 * Emburse — or one that already landed — is a different and much worse
 * thing to do by accident.
 *
 * `onlyGone` clears just the ones Emburse no longer has in Needs Review:
 * the failures that are not faults, need nobody, and are only in the way.
 */
export async function clearFailedDecisions(
  by: string,
  opts: { onlyGone?: boolean } = {},
): Promise<number> {
  await ensure();
  const { rowCount } = await db().query(
    `UPDATE expense_decisions
        SET state = 'cancelled',
            error = coalesce(error, 'It did not go through.')
                    || ' — cleared by ' || $1 || ' on ' || to_char(now(), 'YYYY-MM-DD HH24:MI')
      WHERE state = 'failed'
        ${opts.onlyGone ? "AND not_in_queue = true" : ""}`,
    [by || "somebody"]);
  return rowCount ?? 0;
}

/**
 * What the failures actually are, grouped.
 *
 * Ninety-nine red rows is a number, not a diagnosis, and reading them one
 * dialog at a time is how three separate causes got mistaken for one. The
 * shape is the thing: sixty "not in Emburse's queue" and four "could not
 * open Emburse" are two completely different jobs, and which is which is
 * invisible until they are counted.
 *
 * Bucketed by PATTERN, not by exact text: every message carries the amount,
 * the search term or the URL, so no two are identical and grouping by string
 * would produce ninety-nine groups of one.
 */
const FAILURE_KINDS: [RegExp, string][] = [
  [/not in this view|no match for/i,
    "The expense is not in Emburse's Needs Review — already approved or denied there"],
  [/rows match this expense equally well/i,
    "Two rows matched equally well, so it refused to guess"],
  // `none of the .* rows match` needed something between "the" and "rows",
  // so the commonest wording of all — "none of the rows match this expense"
  // — matched nothing and fell through to "Something else", along with
  // "Emburse returned nothing … whichever way it was searched for". Eight of
  // twenty-three failures in one report landed in the catch-all while being
  // two perfectly nameable causes. A bucket nothing falls into is a bucket
  // that is lying about the shape of the problem.
  [/none of the (\d+ )?rows match|looked at the first/i,
    "Rows came back, but none matched this expense on employee, merchant, amount and date"],
  [/returned nothing for this expense|whichever way it was searched/i,
    "Emburse returned nothing for it, and the cardholder filter could not check"],
  [/is a users filter holding|users filter opened but nothing/i,
    "The cardholder filter could not be used, so a missing row could not be double-checked"],
  [/did not load within|page\.goto|Timeout \d+ms/i,
    "A page did not load in time"],
  [/still in Needs Review/i,
    "It clicked, but the row did not leave Needs Review, so nothing confirms it landed"],
  [/no .*(APPROVE|Deny|menu).*matched|line up with this row|none of them is visible/i,
    "The control to click could not be found on the row"],
  [/sign in|sign-in|password|code-authentication/i,
    "Signing in to Emburse did not go through"],
  [/no grid|row selector|selectors in Settings/i,
    "The grid or row selector did not match what is on the page"],
  [/no Emburse login/i, "Whoever decided it has no Emburse login stored"],
];

export type FailureGroup = { reason: string; n: number; example: string };

export async function failureSummary(): Promise<FailureGroup[]> {
  await ensure();
  // The newest decision per expense, and only the ones still in the queue:
  // an expense that has left is not somebody's problem any more.
  const { rows } = await db().query<{ error: string | null }>(
    `SELECT d.error
       FROM (SELECT DISTINCT ON (dedupe_key) dedupe_key, state, error
               FROM expense_decisions
              WHERE state <> 'cancelled'
              ORDER BY dedupe_key, decided_at DESC) d
       JOIN expenses e ON e.dedupe_key = d.dedupe_key AND e.in_inbox = true
      WHERE d.state = 'failed'`);

  const groups = new Map<string, FailureGroup>();
  for (const r of rows) {
    const text = r.error ?? "";
    const reason = FAILURE_KINDS.find(([re]) => re.test(text))?.[1] ?? "Something else";
    const g = groups.get(reason) ?? { reason, n: 0, example: text.slice(0, 220) };
    g.n++;
    // Keep the first example, which is enough to recognise the group.
    groups.set(reason, g);
  }
  return [...groups.values()].sort((a, b) => b.n - a.n);
}

/**
 * Every failure, as a markdown file somebody can read or send on.
 *
 * The grouped counts say what SHAPE the problem is; this says which
 * expenses, and carries the two things that actually diagnose a matching
 * failure and are otherwise invisible: the merchant string exactly as our
 * export gave it, and **the search term derived from it** — the first two
 * words, which is what Emburse is actually asked for. A merchant recorded
 * as "DOLLARTREE 8508DOLLAR TREE STORES INC" is searched for as
 * "DOLLARTREE 8508", and no amount of reading the error says so.
 *
 * Grouped by the same buckets as the summary, so the two cannot disagree.
 */
export async function failureReport(): Promise<string> {
  await ensure();
  const { rows } = await db().query<{
    error: string | null; decision: Decision; decided_at: Date; attempts: number;
    target: Target; matched_row: string | null; automatic: boolean; not_in_queue: boolean;
    steps: DecisionStep[] | null;
  }>(
    `SELECT d.error, d.decision, d.decided_at, d.attempts, d.target, d.matched_row,
            d.automatic, d.not_in_queue, d.steps
       FROM (SELECT DISTINCT ON (dedupe_key) *
               FROM expense_decisions
              WHERE state <> 'cancelled'
              ORDER BY dedupe_key, decided_at DESC) d
       JOIN expenses e ON e.dedupe_key = d.dedupe_key AND e.in_inbox = true
      WHERE d.state = 'failed'
      ORDER BY d.decided_at DESC`);

  // A pipe or a newline inside a cell breaks the table it is in.
  const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
  /** What the run actually asks Emburse for first: the first two words. */
  const searchTerm = (merchant: string) => merchant.trim().split(/\s+/).slice(0, 2).join(" ");

  const byReason = new Map<string, typeof rows>();
  for (const r of rows) {
    const reason = FAILURE_KINDS.find(([re]) => re.test(r.error ?? ""))?.[1] ?? "Something else";
    (byReason.get(reason) ?? byReason.set(reason, []).get(reason)!).push(r);
  }
  const groups = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);

  const out: string[] = [
    `# Decision failures`,
    ``,
    `${rows.length} failure${rows.length === 1 ? "" : "s"} on expenses still in the queue, ` +
    `as at ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC.`,
    ``,
    `A failure means the decision never reached Emburse, so Emburse still lists the expense and ` +
    `every import brings it back. **Search term** is what the run actually asks Emburse for — ` +
    `the first two words of the merchant — which is the thing a matching failure usually turns on.`,
    ``,
  ];

  for (const [reason, items] of groups) {
    out.push(`## ${items.length} · ${reason}`, ``);
    out.push(`| Date | Employee | Merchant | Search term | Amount | Step | Tries | Auto | Error |`);
    out.push(`| --- | --- | --- | --- | ---: | --- | ---: | :-: | --- |`);
    for (const r of items) {
      // WHICH step failed, which a timeout badly needs: "page.goto timed
      // out" on the sign-in page and on a grid three navigations later are
      // different faults, and the message alone cannot tell them apart.
      const failed = (r.steps ?? []).find((st) => !st.ok)?.name ?? "—";
      out.push(`| ${cell(r.target.date ?? "—")} | ${cell(r.target.employee)} | ` +
        `${cell(r.target.merchant)} | ${cell(searchTerm(r.target.merchant))} | ` +
        `${money(r.target.amount)} | ${cell(failed)} | ${r.attempts} | ` +
        `${r.automatic ? "yes" : "no"} | ${cell(r.error ?? "(nothing recorded)")} |`);
    }
    out.push(``);
  }
  if (groups.length === 0) out.push(`Nothing is failing.`, ``);
  return out.join("\n");
}

/**
 * Which of these expenses an enabled rule currently fails.
 *
 * Asked at APPLY time, not only at queue time, and that gap is where the
 * fault lived: the automation queues an approval for an expense nothing
 * flagged, the receipt is read minutes later, the rules run again and the
 * expense is flagged — and the approval, already queued, went to Emburse
 * anyway. The queue showed it plainly: rows sitting in the Flagged tab
 * reading "Approved · sending".
 */
export async function flaggedNow(keys: string[]): Promise<Set<string>> {
  await ensure();
  if (keys.length === 0) return new Set();
  const { rows } = await db().query<{ dedupe_key: string }>(
    `SELECT DISTINCT h.dedupe_key
       FROM expense_rule_hits h
       JOIN expense_rules r ON r.id = h.rule_id AND r.enabled
      WHERE h.verdict = 'fail' AND h.dedupe_key = ANY($1::text[])`, [keys]);
  return new Set(rows.map((r) => r.dedupe_key));
}

/**
 * Take back an automatic approval a rule has since flagged.
 *
 * Cancelled rather than failed: nothing went wrong and nothing was tried.
 * The row goes back to offering Approve and Deny, which is the right place
 * for it — a person can still approve a flagged expense, and often should.
 * Only the machine is stopped.
 */
export async function cancelBecauseFlagged(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  await ensure();
  const { rowCount } = await db().query(
    `UPDATE expense_decisions
        SET state = 'cancelled',
            error = 'A rule flagged this expense after the approval was queued, so it was not ' ||
                    'sent. Look at the flag, then approve it yourself if it is fine.'
      WHERE id = ANY($1::bigint[]) AND state = 'pending'`,
    [ids]);
  return rowCount ?? 0;
}

/**
 * How many expenses we hold that are indistinguishable from each of these.
 *
 * Same person, merchant, amount and day — the four fields a row is matched
 * on — and still in Emburse's inbox. One purchase divided across sites
 * gives several: seven shares of a lunch, three shares of a Menards run.
 *
 * The browser needs it to answer a question it cannot answer alone. Six
 * rows in Emburse match the expense equally well; may the automation take
 * one? It may if we hold a decision for every one of them, because then
 * the choice is bookkeeping — each decision takes a row and all six get
 * approved. It may not if we hold fewer, because then it would be picking.
 */
export async function peersFor(keys: string[]): Promise<Map<string, number>> {
  await ensure();
  const out = new Map<string, number>();
  if (keys.length === 0) return out;
  const { rows } = await db().query<{ dedupe_key: string; peers: string }>(
    `SELECT e.dedupe_key,
            (SELECT count(*) FROM expenses p
              WHERE p.in_inbox
                AND lower(btrim(p.employee)) = lower(btrim(e.employee))
                AND lower(btrim(p.merchant)) = lower(btrim(e.merchant))
                AND p.amount_cents = e.amount_cents
                AND p.expense_date IS NOT DISTINCT FROM e.expense_date) AS peers
       FROM expenses e
      WHERE e.dedupe_key = ANY($1::text[])`,
    [keys]);
  for (const r of rows) out.set(r.dedupe_key, Number(r.peers));
  return out;
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

/**
 * Take an expense out of the queue, because Emburse no longer has it.
 *
 * `notInQueue` is not a guess: the run read that cardholder's whole Needs
 * Review and found no row for this amount, which is what an expense that
 * has already been approved or denied looks like. Leaving it on screen
 * afterwards, greyed out with "they drop off at the next import", asks
 * somebody to keep looking at rows that are finished — and the import
 * might be tomorrow.
 *
 * Safe because it is self-correcting in the one direction that matters: if
 * Emburse does still hold the expense, the next import carries it and the
 * row comes straight back. Nothing is deleted, and the decision record
 * stays exactly as it was.
 */
async function dropFromInbox(dedupeKey: string): Promise<void> {
  await db().query(
    "UPDATE expenses SET in_inbox = false WHERE dedupe_key = $1 AND in_inbox = true",
    [dedupeKey]);
}

export async function settleDecision(
  id: number,
  outcome:
    | { ok: true; matchedRow: string | null }
    /**
     * `notInQueue` says the run established the expense is not in Emburse's
     * Needs Review — not that something went wrong. See the column comment.
     */
    | { ok: false; error: string; notInQueue?: boolean },
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
            shot       = CASE WHEN $2 = 'applied' THEN NULL ELSE COALESCE($6, shot) END,
            not_in_queue = $7,
            -- Stamped on every failure, including a repeat one: what the
            -- queue needs is when this row last went wrong, not when it
            -- first did.
            failed_at  = CASE WHEN $2 = 'failed' THEN now() ELSE failed_at END
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
      outcome.ok ? false : outcome.notInQueue === true,
    ],
  );

  // And off the queue it comes, now rather than at the next import.
  if (!outcome.ok && outcome.notInQueue === true) {
    const { rows } = await db().query<{ dedupe_key: string }>(
      "SELECT dedupe_key FROM expense_decisions WHERE id = $1", [id]);
    if (rows[0]) await dropFromInbox(rows[0].dedupe_key);
  }
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
