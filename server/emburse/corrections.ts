/**
 * Category corrections, as records rather than as a button press.
 *
 * The first version ran the whole thing inside the request: sign in, find
 * the row, edit, save, check — about a minute — and reported back to the
 * component that started it. Close the drawer and the work carried on with
 * nobody to tell, so the one thing worth knowing, did it take, was lost.
 *
 * So a correction is written down before anything is attempted, exactly as
 * a decision is. The queue can then show it on the row whether or not the
 * panel that asked for it is still open, the expense can show the category
 * it is being changed TO rather than the one the last import brought, and a
 * failure survives long enough to be read, understood and sent on.
 */

import { db, ensureSchema } from "../db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS category_corrections (
  id            bigserial PRIMARY KEY,
  dedupe_key    text        NOT NULL,
  from_category text        NOT NULL DEFAULT '',
  to_category   text        NOT NULL,
  -- Whose name Emburse will record against the change. Never a shared
  -- login, for the same reason a decision never is.
  requested_by  text        NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  state         text        NOT NULL DEFAULT 'pending',
  applied_at    timestamptz,
  failed_at     timestamptz,
  attempts      integer     NOT NULL DEFAULT 0,
  error         text,
  steps         jsonb
);
-- The newest correction per expense is the one that matters, and the queue
-- asks for it by key on every poll.
CREATE INDEX IF NOT EXISTS category_corrections_key
  ON category_corrections (dedupe_key, id DESC);
CREATE INDEX IF NOT EXISTS category_corrections_pending
  ON category_corrections (state) WHERE state = 'pending';
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

export type CorrectionState = "pending" | "applied" | "failed" | "cancelled";

export type Correction = {
  id: number;
  dedupeKey: string;
  from: string;
  to: string;
  requestedBy: string;
  requestedAt: string;
  state: CorrectionState;
  appliedAt: string | null;
  failedAt: string | null;
  attempts: number;
  error: string | null;
};

const shape = (r: Record<string, unknown>): Correction => ({
  id: Number(r.id),
  dedupeKey: r.dedupe_key as string,
  from: (r.from_category as string) ?? "",
  to: r.to_category as string,
  requestedBy: r.requested_by as string,
  requestedAt: (r.requested_at as Date).toISOString(),
  state: r.state as CorrectionState,
  appliedAt: r.applied_at ? (r.applied_at as Date).toISOString() : null,
  failedAt: r.failed_at ? (r.failed_at as Date).toISOString() : null,
  attempts: Number(r.attempts ?? 0),
  error: (r.error as string | null) ?? null,
});

const COLUMNS = `id, dedupe_key, from_category, to_category, requested_by, requested_at,
                 state, applied_at, failed_at, attempts, error`;

/**
 * Ask for a correction.
 *
 * Refuses a second one while the first is still in flight: two runs editing
 * the same row in the same minute is a race over somebody's finance record,
 * and the honest answer is "the one you already asked for has not finished".
 */
export async function queueCorrection(input: {
  dedupeKey: string;
  from: string;
  to: string;
  requestedBy: string;
}): Promise<{ ok: true; correction: Correction } | { ok: false; error: string }> {
  await ensure();
  const open = await db().query(
    `SELECT ${COLUMNS} FROM category_corrections
      WHERE dedupe_key = $1 AND state = 'pending' ORDER BY id DESC LIMIT 1`,
    [input.dedupeKey]);
  if (open.rows[0]) {
    const c = shape(open.rows[0]);
    return {
      ok: false,
      error:
        `A change to “${c.to}” is already on its way to Emburse for this expense, asked for by ` +
        `${c.requestedBy}. Wait for it to land before asking for another.`,
    };
  }
  const { rows } = await db().query(
    `INSERT INTO category_corrections (dedupe_key, from_category, to_category, requested_by)
     VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [input.dedupeKey, input.from, input.to, input.requestedBy]);
  return { ok: true, correction: shape(rows[0]!) };
}

/** Everything still waiting to reach Emburse, oldest first. */
export async function pendingCorrections(): Promise<Correction[]> {
  await ensure();
  const { rows } = await db().query(
    `SELECT ${COLUMNS} FROM category_corrections WHERE state = 'pending' ORDER BY id`);
  return rows.map(shape);
}

/** The newest correction per expense, for the rows the queue is showing. */
export async function correctionsFor(keys: string[]): Promise<Map<string, Correction>> {
  await ensure();
  const out = new Map<string, Correction>();
  if (keys.length === 0) return out;
  const { rows } = await db().query(
    `SELECT DISTINCT ON (dedupe_key) ${COLUMNS}
       FROM category_corrections
      WHERE dedupe_key = ANY($1::text[]) AND state <> 'cancelled'
      ORDER BY dedupe_key, id DESC`,
    [keys]);
  for (const r of rows) {
    const c = shape(r);
    out.set(c.dedupeKey, c);
  }
  return out;
}


/**
 * Take a correction that landed in Emburse back into our own copy.
 *
 * The whole point of the correction, and it was missing. A fuel purchase
 * filed under the wrong category is flagged by a rule; the fix is to put
 * the right category on it in Emburse. That worked — and then nothing on
 * this side knew. Our copy still said "Gas", the rule still had its hit,
 * the row stayed in Flagged, and automatic approval skipped it, because
 * the automation refuses anything flagged. It cleared at the NEXT IMPORT,
 * which is tomorrow.
 *
 * So the change comes back: our copy takes the new category, the rules are
 * re-run for that one expense — which deletes the hit that no longer
 * applies — and the sweep is asked to look again rather than waiting out
 * its quarter of an hour.
 *
 * The rules decide, not the act of having corrected something: setting a
 * category that is ALSO wrong leaves the expense flagged, as it should.
 *
 * Returns how many approvals the sweep queued as a result, which is 0 in
 * the ordinary case where the automation is off.
 */
export async function applyCorrection(dedupeKey: string, to: string): Promise<number> {
  await ensure();
  await db().query(
    "UPDATE expenses SET category = $2 WHERE dedupe_key = $1", [dedupeKey, to]);
  const { runRules } = await import("../rules/run.js");
  await runRules({ keys: [dedupeKey] });
  const { autoQueueApprovals } = await import("../rules/auto-approve.js");
  return (await autoQueueApprovals()).queued;
}

export async function settleCorrection(
  id: number,
  outcome: { ok: true } | { ok: false; error: string },
  steps?: unknown,
): Promise<void> {
  await ensure();
  await db().query(
    `UPDATE category_corrections
        SET state      = $2,
            attempts   = attempts + 1,
            applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END,
            failed_at  = CASE WHEN $2 = 'failed'  THEN now() ELSE failed_at END,
            error      = $3,
            steps      = COALESCE($4::jsonb, steps)
      WHERE id = $1`,
    [id, outcome.ok ? "applied" : "failed", outcome.ok ? null : outcome.error.slice(0, 2000),
     steps ? JSON.stringify(steps) : null]);
}

/**
 * Put a failed correction down.
 *
 * Cancelled, not deleted: the record that it was tried and did not land is
 * the only trace on this side, and everything that reads corrections
 * already ignores cancelled.
 */
export async function clearFailedCorrections(by: string): Promise<number> {
  await ensure();
  const { rowCount } = await db().query(
    `UPDATE category_corrections
        SET state = 'cancelled',
            error = coalesce(error, 'It did not go through.')
                    || ' — cleared by ' || $1 || ' on ' || to_char(now(), 'YYYY-MM-DD HH24:MI')
      WHERE state = 'failed'`,
    [by || "somebody"]);
  return rowCount ?? 0;
}

/**
 * Every failed correction, as a markdown file somebody can read or send on.
 *
 * The same shape as the decision-failure report, and for the same reason:
 * a correction that will not go through is almost always a selector that
 * no longer matches Emburse's edit form, and the thing needed to fix it is
 * the sentence the run produced — which is otherwise a tooltip on a screen
 * nobody has open any more.
 */
export async function correctionReport(): Promise<string> {
  await ensure();
  const { rows } = await db().query(
    `SELECT c.${COLUMNS.split(", ").join(", c.")}, c.steps,
            e.employee, e.merchant, e.amount_cents,
            to_char(e.expense_date, 'YYYY-MM-DD') AS expense_date
       FROM category_corrections c
       LEFT JOIN expenses e ON e.dedupe_key = c.dedupe_key
      WHERE c.state = 'failed'
      ORDER BY c.failed_at DESC NULLS LAST, c.id DESC`);

  const when = new Date().toISOString().replace("T", " ").slice(0, 16);
  if (rows.length === 0) {
    return `# Category corrections\n\nNo failed corrections as at ${when} UTC.\n`;
  }

  const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
  const money = (c: unknown) => (c === null || c === undefined ? "" : `$${(Number(c) / 100).toFixed(2)}`);

  const lines = [
    "# Category corrections",
    "",
    `${rows.length} correction${rows.length === 1 ? "" : "s"} did not reach Emburse, as at ${when} UTC.`,
    "",
    "A correction changes the category on an expense in Emburse. When one fails it is almost",
    "always because a control on Emburse's edit form no longer matches the stored selector —",
    "the error below usually lists what IS on the form, which is what the selector should be",
    "set to under **Export settings**.",
    "",
    "| Asked | By | Employee | Merchant | Amount | From | To | Tries | Error |",
    "| --- | --- | --- | --- | ---: | --- | --- | ---: | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${cell((r.requested_at as Date)?.toISOString().slice(0, 16).replace("T", " "))} ` +
      `| ${cell(r.requested_by)} | ${cell(r.employee)} | ${cell(r.merchant)} ` +
      `| ${money(r.amount_cents)} | ${cell(r.from_category) || "—"} | ${cell(r.to_category)} ` +
      `| ${cell(r.attempts)} | ${cell(r.error)} |`);
  }

  // The steps, for the one failure most likely to be read. A transcript per
  // row would bury the table; the newest is the one somebody is looking at.
  const newest = rows[0];
  const steps = newest?.steps as { name: string; ok: boolean; detail: string }[] | null;
  if (steps && steps.length > 0) {
    lines.push("", "## The most recent one, step by step", "");
    for (const s of steps) {
      lines.push(`- **${s.ok ? "ok" : "FAILED"} · ${s.name}** — ${s.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
