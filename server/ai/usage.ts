/**
 * What the AI has actually cost, rather than what somebody estimated.
 *
 * Receipt reading is the only thing in this app that spends money per use, and
 * until this existed the only answer to "what does that come to" was arithmetic
 * over assumed token counts — which was wrong by a large factor the one time it
 * mattered. Every call now records what it really used.
 *
 * Two decisions worth keeping:
 *
 *   - **Tokens are stored; money is worked out at display time.** Published
 *     prices change, and a row holding dollars would freeze whatever the table
 *     below said on the day. Storing counts means correcting a price is a
 *     one-line edit rather than a backfill.
 *   - **Recording must never break a call.** This is a meter, not a
 *     dependency. Every write is best-effort and swallowed: a receipt that was
 *     read successfully must not fail because the meter did.
 */

import { db } from "../db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_usage (
  id                 bigserial   PRIMARY KEY,
  at                 timestamptz NOT NULL DEFAULT now(),
  model              text        NOT NULL,
  -- What the call was for, so a future second use of AI is separable from
  -- receipt reading rather than silently added to it.
  purpose            text        NOT NULL DEFAULT 'receipt',
  input_tokens       integer     NOT NULL DEFAULT 0,
  output_tokens      integer     NOT NULL DEFAULT 0,
  cache_read_tokens  integer     NOT NULL DEFAULT 0,
  cache_write_tokens integer     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ai_usage_at_idx ON ai_usage (at DESC);
`;

let ready: Promise<void> | null = null;
export const ensureAiUsage = (): Promise<void> =>
  (ready ??= db().query(SCHEMA).then(() => undefined));

/**
 * Published prices, US dollars per million tokens.
 *
 * Checked in rather than fetched: this is a running total on an admin page,
 * not an invoice, and a page that cannot render because a price lookup failed
 * would be worse than one showing a figure a few percent out. Cache reads are
 * a tenth of input and cache writes a quarter more, which is the standard
 * shape across these models.
 *
 * A model absent from this table still has its tokens recorded — it is only
 * the money that cannot be worked out, and the summary says so rather than
 * quietly reporting zero.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
};

export type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** Record one call. Never throws — a meter must not break what it measures. */
export async function recordAiUsage(
  model: string,
  usage: Usage | null | undefined,
  purpose = "receipt",
): Promise<void> {
  if (!usage) return;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  if (input + output + cacheRead + cacheWrite === 0) return;

  try {
    await ensureAiUsage();
    await db().query(
      `INSERT INTO ai_usage (model, purpose, input_tokens, output_tokens,
                             cache_read_tokens, cache_write_tokens)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [model, purpose, input, output, cacheRead, cacheWrite],
    );
  } catch (err) {
    console.error("ai-usage: could not record a call:", err);
  }
}

/** Dollars for one row's worth of tokens, or null when the model has no price. */
export function costOf(
  model: string,
  t: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const M = 1_000_000;
  return (
    (t.input * p.input) / M +
    (t.output * p.output) / M +
    // A cache read is a tenth of the input price; writing one costs a quarter
    // more than plain input.
    (t.cacheRead * p.input * 0.1) / M +
    (t.cacheWrite * p.input * 1.25) / M
  );
}

export type Window = { calls: number; tokens: number; cost: number | null };
export type PerModel = {
  model: string; calls: number; input: number; output: number;
  cacheRead: number; cacheWrite: number; cost: number | null;
};
export type AiSpend = {
  today: Window;
  month: Window;
  total: Window;
  /** Newest first, all time, so an unexpectedly expensive model is visible. */
  byModel: PerModel[];
  /** Models that ran but are not in the price table, so a null cost is explained. */
  unpriced: string[];
  /** The average cost of one receipt read, which is the number people want. */
  perReceipt: number | null;
};

type Row = {
  model: string; calls: string; input: string; output: string;
  cache_read: string; cache_write: string;
};

const windowOf = (rows: Row[]): Window => {
  let calls = 0, tokens = 0, cost: number | null = 0;
  for (const r of rows) {
    const t = {
      input: Number(r.input), output: Number(r.output),
      cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write),
    };
    calls += Number(r.calls);
    tokens += t.input + t.output + t.cacheRead + t.cacheWrite;
    const c = costOf(r.model, t);
    // One unpriced model makes the whole total unknowable rather than wrong.
    if (c === null) cost = null;
    else if (cost !== null) cost += c;
  }
  return { calls, tokens, cost };
};

export async function aiSpend(): Promise<AiSpend> {
  await ensureAiUsage();
  const grouped = (where: string) =>
    db().query<Row>(
      `SELECT model, count(*) AS calls,
              coalesce(sum(input_tokens),0)       AS input,
              coalesce(sum(output_tokens),0)      AS output,
              coalesce(sum(cache_read_tokens),0)  AS cache_read,
              coalesce(sum(cache_write_tokens),0) AS cache_write
         FROM ai_usage ${where} GROUP BY model ORDER BY sum(input_tokens) DESC`,
    );

  const [today, month, total] = await Promise.all([
    grouped("WHERE at >= date_trunc('day', now())"),
    grouped("WHERE at >= date_trunc('month', now())"),
    grouped(""),
  ]);

  const byModel: PerModel[] = total.rows.map((r) => {
    const t = {
      input: Number(r.input), output: Number(r.output),
      cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write),
    };
    return { model: r.model, calls: Number(r.calls), ...t, cost: costOf(r.model, t) };
  });

  const all = windowOf(total.rows);
  const receipts = total.rows
    .filter((r) => true)
    .reduce((a, r) => a + Number(r.calls), 0);

  return {
    today: windowOf(today.rows),
    month: windowOf(month.rows),
    total: all,
    byModel,
    unpriced: [...new Set(byModel.filter((m) => m.cost === null).map((m) => m.model))],
    perReceipt: all.cost !== null && receipts > 0 ? all.cost / receipts : null,
  };
}
