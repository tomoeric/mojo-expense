import type pg from "pg";
import { db, ensureSchema } from "../db.js";
import { ensureReceiptItems } from "../emburse/receipt-items.js";
import {
  ACTIONS, FIELDS, OPS, comparableTo, opsFor, problems, summarise,
  type Action, type Condition, type Field, type Op, type RuleBody, type Subject,
} from "./engine.js";

/**
 * Storing rules, and the expenses each one has judged.
 *
 * Conditions live in a jsonb column rather than their own rows. They are only
 * ever read as a whole rule, never queried across, and a rule is edited by
 * replacing it — so a child table would buy nothing and cost a join and a
 * transaction on every save.
 *
 * `expense_rule_hits` holds one row per (expense, rule) that the rule had
 * something to say about. Verdicts are stored rather than recomputed on read
 * because the queue reads them on every page load, and because a stored hit is
 * what lets "when did this start failing" be answerable at all.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS expense_rules (
  id          bigserial PRIMARY KEY,
  name        text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT true,
  match_mode  text        NOT NULL DEFAULT 'all',
  conditions  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  must        jsonb,
  action      text        NOT NULL DEFAULT 'flag',
  message     text        NOT NULL DEFAULT '',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz
);
-- Names are how a rule is referred to in a flag, so two rules called
-- "Gas must be Fuel" would make a flag ambiguous. Case-insensitive, because
-- two names differing only in case are the same name to a person.
CREATE UNIQUE INDEX IF NOT EXISTS expense_rules_name_idx ON expense_rules (lower(name));

CREATE TABLE IF NOT EXISTS expense_rule_hits (
  dedupe_key text   NOT NULL REFERENCES expenses (dedupe_key) ON DELETE CASCADE,
  rule_id    bigint NOT NULL REFERENCES expense_rules (id) ON DELETE CASCADE,
  verdict    text   NOT NULL,
  detail     text   NOT NULL DEFAULT '',
  /** Set when the rule's action actually did something, so it is not redone. */
  acted      boolean NOT NULL DEFAULT false,
  first_seen timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dedupe_key, rule_id)
);
CREATE INDEX IF NOT EXISTS expense_rule_hits_key_idx  ON expense_rule_hits (dedupe_key);
CREATE INDEX IF NOT EXISTS expense_rule_hits_rule_idx ON expense_rule_hits (rule_id);
`;

let ready: Promise<void> | null = null;
export const ensureRules = (): Promise<void> =>
  (ready ??= ensureSchema()
    .then(async () => {
      await db().query(SCHEMA);
      // Rules can test receipt line items, so that table has to exist before
      // one is evaluated — see ensureReceiptItems for why it might not.
      await ensureReceiptItems();
    })
    .catch((err) => {
      ready = null;
      throw err;
    }));

export type Rule = RuleBody & {
  id: number;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  lastRunAt: string | null;
};

type Row = {
  id: string; name: string; enabled: boolean; match_mode: string;
  conditions: unknown; must: unknown; action: string; message: string;
  created_by: string | null; created_at: Date;
  updated_by: string | null; updated_at: Date; last_run_at: Date | null;
};

const COLUMNS = `id, name, enabled, match_mode, conditions, must, action, message,
                 created_by, created_at, updated_by, updated_at, last_run_at`;

/**
 * Read a rule back out of the database defensively.
 *
 * Rules are user-authored JSON, and a field or operator that was valid when it
 * was written may not be one this build knows about. An unknown value is
 * dropped rather than trusted, because `test()` would silently answer false
 * for it — and a condition that is always false turns an approve rule into
 * one that approves nothing, or a deny rule into one that denies everything.
 */
function condition(raw: unknown): Condition | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const field = String(r.field ?? "") as Field;
  const op = String(r.op ?? "") as Op;
  if (!(FIELDS as readonly string[]).includes(field)) return null;
  if (!(OPS as readonly string[]).includes(op)) return null;
  if (!opsFor(field).includes(op)) return null;
  const compare = typeof r.compare === "string" ? (r.compare as Field) : null;
  return {
    field,
    op,
    value: typeof r.value === "string" ? r.value : String(r.value ?? ""),
    // A comparison this build no longer allows is dropped, not kept: it would
    // read as a literal against an empty string and quietly match nothing.
    compare: compare && comparableTo(field).includes(compare) ? compare : null,
  };
}

function shape(row: Row): Rule {
  const when = Array.isArray(row.conditions)
    ? row.conditions.map(condition).filter((c): c is Condition => c !== null)
    : [];
  const action = (ACTIONS as readonly string[]).includes(row.action) ? (row.action as Action) : "flag";
  return {
    id: Number(row.id),
    name: row.name,
    enabled: row.enabled,
    match: row.match_mode === "any" ? "any" : "all",
    when,
    must: condition(row.must),
    action,
    message: row.message ?? "",
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
    lastRunAt: row.last_run_at?.toISOString() ?? null,
  };
}

export async function listRules(): Promise<Rule[]> {
  await ensureRules();
  const { rows } = await db().query<Row>(
    `SELECT ${COLUMNS} FROM expense_rules ORDER BY lower(name)`);
  return rows.map(shape);
}

export async function activeRules(): Promise<Rule[]> {
  return (await listRules()).filter((r) => r.enabled && problems(r).length === 0);
}

export async function getRule(id: number): Promise<Rule | null> {
  await ensureRules();
  const { rows } = await db().query<Row>(
    `SELECT ${COLUMNS} FROM expense_rules WHERE id = $1`, [id]);
  return rows[0] ? shape(rows[0]) : null;
}

export type SaveResult = { ok: true; rule: Rule } | { ok: false; error: string };

export async function saveRule(
  body: RuleBody,
  by: string,
  id?: number,
): Promise<SaveResult> {
  await ensureRules();

  const bad = problems(body);
  if (bad.length > 0) return { ok: false, error: bad.join(" ") };

  const args = [
    body.name.trim(), body.enabled, body.match,
    JSON.stringify(body.when), body.must ? JSON.stringify(body.must) : null,
    body.action, body.message.trim(), by,
  ];

  try {
    const { rows } = id
      ? await db().query<Row>(
          `UPDATE expense_rules
              SET name=$1, enabled=$2, match_mode=$3, conditions=$4, must=$5,
                  action=$6, message=$7, updated_by=$8, updated_at=now()
            WHERE id=$9 RETURNING ${COLUMNS}`,
          [...args, id])
      : await db().query<Row>(
          `INSERT INTO expense_rules (name, enabled, match_mode, conditions, must,
                                      action, message, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING ${COLUMNS}`,
          args);
    if (!rows[0]) return { ok: false, error: "That rule no longer exists." };

    // Its verdicts were reached under the old definition, so they are not
    // evidence of anything now. Dropped rather than left to be overwritten:
    // an expense the edited rule no longer matches would otherwise keep a
    // flag from a rule that has stopped saying it.
    await db().query("DELETE FROM expense_rule_hits WHERE rule_id = $1", [Number(rows[0].id)]);
    return { ok: true, rule: shape(rows[0]) };
  } catch (err) {
    if (err instanceof Error && /expense_rules_name_idx/.test(err.message)) {
      return { ok: false, error: `There is already a rule called “${body.name.trim()}”.` };
    }
    throw err;
  }
}

export async function deleteRule(id: number): Promise<boolean> {
  await ensureRules();
  const res = await db().query("DELETE FROM expense_rules WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

export async function setEnabled(id: number, enabled: boolean, by: string): Promise<Rule | null> {
  await ensureRules();
  const { rows } = await db().query<Row>(
    `UPDATE expense_rules SET enabled=$2, updated_by=$3, updated_at=now()
      WHERE id=$1 RETURNING ${COLUMNS}`, [id, enabled, by]);
  return rows[0] ? shape(rows[0]) : null;
}

/**
 * Every expense a rule could look at, in the shape a rule sees it.
 *
 * `note` is the raw note column, NOT the composite the queue displays — that
 * one has "· Site: Richland" appended for the screen, and a rule written
 * against what is on screen would match the site by accident.
 */
export async function subjects(
  client: Pick<pg.PoolClient, "query">,
  keys?: string[],
): Promise<Subject[]> {
  const { rows } = await client.query<{
    dedupe_key: string; employee: string; merchant: string; note: string | null;
    category: string | null; location: string | null; department: string | null;
    method: string | null; amount_cents: string; receipts: string; items: string | null;
    in_inbox: boolean; expense_date: string | null; receipt_total_cents: string | null;
    alcohol: boolean | null; readable: boolean | null;
  }>(
    `SELECT e.dedupe_key, e.employee, e.merchant, e.note, e.category, e.location,
            e.department, e.method, e.amount_cents, e.in_inbox,
            to_char(e.expense_date, 'YYYY-MM-DD') AS expense_date,
            (SELECT count(*) FROM expense_receipts r WHERE r.dedupe_key = e.dedupe_key) AS receipts,
            (SELECT string_agg(i.description, ' | ')
               FROM expense_receipts r
               JOIN receipt_items i ON i.sha256 = r.sha256
              WHERE r.dedupe_key = e.dedupe_key) AS items,
            -- The total the reader took off the receipt image. Summed because
            -- an expense can carry more than one receipt, and NULL when none
            -- has been read — which is not zero and must not compare as one.
            (SELECT sum(rr.total_cents)
               FROM expense_receipts r
               JOIN receipt_readings rr ON rr.sha256 = r.sha256
              WHERE r.dedupe_key = e.dedupe_key
                AND rr.error IS NULL
                AND rr.total_cents IS NOT NULL) AS receipt_total_cents,
            -- Alcohol on any line the reader saw. NULL when no reading with
            -- usable lines exists, so "cannot say" stays distinct from "no".
            (SELECT bool_or(i.alcohol)
               FROM expense_receipts r
               JOIN receipt_readings rr ON rr.sha256 = r.sha256 AND rr.error IS NULL
               JOIN receipt_items i ON i.sha256 = r.sha256
              WHERE r.dedupe_key = e.dedupe_key) AS alcohol,
            -- Did the reader get anything usable at all: legible AND listing
            -- items. An order summary reading "1 Item $141.24" is legible and
            -- answers nothing, so it counts as not readable for rule purposes.
            (SELECT bool_or(rr.legible AND coalesce(rr.itemised, false))
               FROM expense_receipts r
               JOIN receipt_readings rr ON rr.sha256 = r.sha256 AND rr.error IS NULL
              WHERE r.dedupe_key = e.dedupe_key) AS readable
       FROM expenses e
      ${keys ? "WHERE e.dedupe_key = ANY($1::text[])" : ""}`,
    keys ? [keys] : [],
  );

  return rows.map((r) => ({
    dedupeKey: r.dedupe_key,
    employee: r.employee ?? "",
    merchant: r.merchant ?? "",
    note: r.note ?? "",
    category: r.category ?? "",
    location: r.location ?? "",
    department: r.department ?? "",
    method: r.method ?? "",
    amountCents: Number(r.amount_cents),
    hasReceipt: Number(r.receipts) > 0,
    receiptItems: r.items ?? "",
    receiptTotalCents: r.receipt_total_cents === null ? null : Number(r.receipt_total_cents),
    receiptAlcohol: r.alcohol,
    receiptReadable: r.readable,
    inInbox: r.in_inbox,
    date: r.expense_date,
  }));
}

export type Hit = {
  dedupeKey: string;
  ruleId: number;
  ruleName: string;
  action: Action;
  verdict: "pass" | "fail";
  detail: string;
  firstSeen: string;
};

/** Failing hits for the given expenses — what the queue turns into flags. */
export async function hitsFor(keys: string[]): Promise<Map<string, Hit[]>> {
  await ensureRules();
  const out = new Map<string, Hit[]>();
  if (keys.length === 0) return out;

  const { rows } = await db().query<{
    dedupe_key: string; rule_id: string; name: string; action: string;
    verdict: string; detail: string; first_seen: Date;
  }>(
    `SELECT h.dedupe_key, h.rule_id, r.name, r.action, h.verdict, h.detail, h.first_seen
       FROM expense_rule_hits h
       JOIN expense_rules r ON r.id = h.rule_id
      WHERE h.dedupe_key = ANY($1::text[]) AND h.verdict = 'fail' AND r.enabled
      ORDER BY r.name`,
    [keys],
  );

  for (const r of rows) {
    const hit: Hit = {
      dedupeKey: r.dedupe_key,
      ruleId: Number(r.rule_id),
      ruleName: r.name,
      action: (ACTIONS as readonly string[]).includes(r.action) ? (r.action as Action) : "flag",
      verdict: "fail",
      detail: r.detail,
      firstSeen: r.first_seen.toISOString(),
    };
    const bucket = out.get(r.dedupe_key);
    if (bucket) bucket.push(hit);
    else out.set(r.dedupe_key, [hit]);
  }
  return out;
}

/** One line per rule for the Rules page: how many it is currently catching. */
export async function ruleStats(): Promise<Map<number, { fail: number; pass: number; waiting: number }>> {
  await ensureRules();
  const { rows } = await db().query<{ rule_id: string; verdict: string; n: string; waiting: string }>(
    `SELECT h.rule_id, h.verdict, count(*) AS n,
            count(*) FILTER (WHERE e.in_inbox) AS waiting
       FROM expense_rule_hits h
       JOIN expenses e ON e.dedupe_key = h.dedupe_key
      GROUP BY h.rule_id, h.verdict`);
  const out = new Map<number, { fail: number; pass: number; waiting: number }>();
  for (const r of rows) {
    const id = Number(r.rule_id);
    const cur = out.get(id) ?? { fail: 0, pass: 0, waiting: 0 };
    if (r.verdict === "fail") {
      cur.fail += Number(r.n);
      cur.waiting += Number(r.waiting);
    } else {
      cur.pass += Number(r.n);
    }
    out.set(id, cur);
  }
  return out;
}

export { summarise, problems };
