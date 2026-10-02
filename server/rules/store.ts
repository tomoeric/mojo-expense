import type pg from "pg";
import { db, ensureSchema } from "../db.js";
import { ensureReceiptItems } from "../emburse/receipt-items.js";
import {
  ACTIONS, FIELDS, OPS, centsDiffer, chosenReceiptTotal, comparableTo, isGroupField, opsFor,
  problems, summarise,
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
/**
 * What a shared receipt means for the figures a rule sees.
 *
 * Somebody buys lunch for seven sites on one card, attaches the SAME
 * receipt to seven expenses and divides the cost: six shares of $12.37 and
 * one of $12.38, which is $86.60 — the receipt, to the cent. Three rules
 * fired on every one of the seven, and all three were wrong about it:
 *
 *   "Receipt total $86.60 does not equal Amount $12.37" — of course it
 *   does not; $12.37 is a seventh of it, and the seven add up.
 *
 *   "Matching expenses that day is at most 3 — found 7" — there were not
 *   seven meals, there was one, entered seven times.
 *
 *   "Matching total that day is at most $75 — found $86.60" — true as
 *   arithmetic, and not what the limit is about: this is food bought FOR
 *   sites, not one person's lunch.
 *
 * So when the shares reconcile against the receipt, this expense's receipt
 * total becomes its own SHARE, and the expense stops counting towards the
 * person's own day.
 *
 * Two things hold it honest. The receipt is identified by content hash, so
 * "they share a receipt" is proven rather than inferred from a matching
 * merchant and date. And the shares have to ADD UP: a split that does not
 * reconcile gets none of this and flags exactly as loudly as before, which
 * is the case worth catching.
 *
 * The different-sites test is the third. One purchase divided among
 * several sites is a distribution; the same purchase divided within one
 * site is a split ledger entry, and a person's daily limits should go on
 * applying to it — otherwise a large dinner could be split into shares to
 * walk under the limit.
 */
function splitAware(
  amountCents: number,
  totalsCents: number[],
  /** The same receipts read as subtotal + tax + tip. See `chosenReceiptTotal`. */
  arithmeticCents: number[],
  peers: number,
  shareTotalCents: number | null,
  sites: number,
): {
  receiptTotalCents: number | null;
  receiptSharedWith: number;
  receiptSplitAddsUp: boolean | null;
  countsTowardsDay: boolean;
} {
  const whole = chosenReceiptTotal(amountCents, totalsCents, arithmeticCents);
  const shared = peers > 1;
  if (!shared || whole === null || shareTotalCents === null) {
    return {
      receiptTotalCents: whole,
      receiptSharedWith: peers,
      receiptSplitAddsUp: shared ? null : false,
      countsTowardsDay: true,
    };
  }

  const addsUp = !centsDiffer(shareTotalCents, whole);
  const distributed = addsUp && sites > 1;
  return {
    // The part of the receipt that belongs to THIS expense, once the split
    // is shown to be sound. Left as the whole receipt when it is not, so
    // the mismatch is flagged in the one case that deserves it.
    receiptTotalCents: addsUp ? amountCents : whole,
    receiptSharedWith: peers,
    receiptSplitAddsUp: addsUp,
    countsTowardsDay: !distributed,
  };
}

export async function subjects(
  client: Pick<pg.PoolClient, "query">,
  keys?: string[],
): Promise<Subject[]> {
  const { rows } = await client.query<{
    dedupe_key: string; employee: string; merchant: string; note: string | null;
    category: string | null; location: string | null; department: string | null;
    method: string | null; amount_cents: string; receipts: string; items: string | null;
    in_inbox: boolean; expense_date: string | null; receipt_totals: string[] | null;
    receipt_arithmetic: string[] | null;
    share_peers: string; share_total_cents: string | null; share_sites: string;
    alcohol: boolean | null; readable: boolean | null;
    receipt_date: string | null; receipt_merchant: string | null;
  }>(
    `SELECT e.dedupe_key, e.employee, e.merchant, e.note, e.category, e.location,
            e.department, e.method, e.amount_cents, e.in_inbox,
            to_char(e.expense_date, 'YYYY-MM-DD') AS expense_date,
            (SELECT count(*) FROM expense_receipts r WHERE r.dedupe_key = e.dedupe_key) AS receipts,
            (SELECT string_agg(i.description, ' | ')
               FROM expense_receipts r
               JOIN receipt_items i ON i.sha256 = r.sha256
              WHERE r.dedupe_key = e.dedupe_key) AS items,
            -- Every total the reader took off a receipt on this expense, one
            -- per image. Which of them counts as THE receipt total is decided
            -- in chosenReceiptTotal(), not here: it is the rule that produced
            -- "$937.32 does not equal $312.44" on an expense carrying the same
            -- $312.44 bill three times, so it belongs somewhere it can be read
            -- and tested rather than buried in an aggregate.
            -- A receipt shared with other expenses, and what they add up to.
            --
            -- One purchase split across sites is ordinary: somebody buys
            -- lunch for seven sites, attaches the same receipt to seven
            -- expenses and divides the cost. The evidence is not a guess —
            -- it is the SAME IMAGE, by content hash, on all of them.
            (SELECT count(DISTINCT er2.dedupe_key)
               FROM expense_receipts er
               JOIN expense_receipts er2 ON er2.sha256 = er.sha256
              WHERE er.dedupe_key = e.dedupe_key) AS share_peers,
            (SELECT sum(x.amount_cents) FROM (
               SELECT DISTINCT er2.dedupe_key, e2.amount_cents
                 FROM expense_receipts er
                 JOIN expense_receipts er2 ON er2.sha256 = er.sha256
                 JOIN expenses e2 ON e2.dedupe_key = er2.dedupe_key
                WHERE er.dedupe_key = e.dedupe_key) x) AS share_total_cents,
            -- How many DIFFERENT sites the shares went to. One purchase
            -- divided across several sites is a distribution; the same
            -- purchase divided within one site is just a split ledger
            -- entry, and the limits that apply to a person's own day
            -- should go on applying to it.
            (SELECT count(DISTINCT coalesce(nullif(btrim(e2.location), ''), er2.dedupe_key))
               FROM expense_receipts er
               JOIN expense_receipts er2 ON er2.sha256 = er.sha256
               JOIN expenses e2 ON e2.dedupe_key = er2.dedupe_key
              WHERE er.dedupe_key = e.dedupe_key) AS share_sites,
            -- ONE PER RECEIPT, so a flag saying "this expense carries 3
            -- receipts" is counting receipts and not candidates.
            (SELECT array_agg(rr.total_cents ORDER BY rr.total_cents)
               FROM expense_receipts r
               JOIN receipt_readings rr ON rr.sha256 = r.sha256
              WHERE r.dedupe_key = e.dedupe_key
                AND rr.error IS NULL AND rr.legible
                AND rr.total_cents IS NOT NULL) AS receipt_totals,
            -- The same receipts read a second way, off their own parts.
            -- Never the answer on its own; only ever preferred over the
            -- printed figure when it is the one that answers the charge.
            -- See chosenReceiptTotal for why the charge has to decide.
            -- Two ways, both candidates: the parts added up, and the
            -- printed total with the TIP added on.
            --
            -- The second is the restaurant case and it was missing. A slip
            -- is printed BEFORE the tip is written on it — Couyon's BBQ
            -- prints "Dine In Total 50.15", then a pen line "Tip 6.59",
            -- then "Total 56.74", and 56.74 is what Amex was charged. The
            -- printed total is the pre-authorisation, not the charge, so
            -- every tipped meal was flagged "receipt totals less than
            -- claimed" against a receipt accounting for every cent. The
            -- parts-added-up figure does not rescue it either: a non-cash
            -- fee or any line outside subtotal+tax is missing from it.
            (SELECT array_agg(DISTINCT c) FROM (
               SELECT rr.subtotal_cents
                      + coalesce(rr.tax_cents, 0) + coalesce(rr.tip_cents, 0) AS c
                 FROM expense_receipts r
                 JOIN receipt_readings rr ON rr.sha256 = r.sha256
                WHERE r.dedupe_key = e.dedupe_key
                  AND rr.error IS NULL AND rr.legible
                  AND rr.subtotal_cents IS NOT NULL
               UNION
               SELECT rr.total_cents + rr.tip_cents AS c
                 FROM expense_receipts r
                 JOIN receipt_readings rr ON rr.sha256 = r.sha256
                WHERE r.dedupe_key = e.dedupe_key
                  AND rr.error IS NULL AND rr.legible
                  AND rr.total_cents IS NOT NULL
                  AND coalesce(rr.tip_cents, 0) <> 0
             ) AS candidates) AS receipt_arithmetic,
            -- Alcohol on any line the reader saw. NULL when no reading with
            -- usable lines exists, so "cannot say" stays distinct from "no".
            (SELECT bool_or(i.alcohol)
               FROM expense_receipts r
               JOIN receipt_readings rr ON rr.sha256 = r.sha256
                    AND rr.error IS NULL AND rr.legible
               JOIN receipt_items i ON i.sha256 = r.sha256
              WHERE r.dedupe_key = e.dedupe_key) AS alcohol,
            -- Did the reader get anything usable at all: legible AND listing
            -- items. An order summary reading "1 Item $141.24" is legible and
            -- answers nothing, so it counts as not readable for rule purposes.
            (SELECT bool_or(rr.legible AND coalesce(rr.itemised, false))
               FROM expense_receipts r
               JOIN receipt_readings rr ON rr.sha256 = r.sha256 AND rr.error IS NULL
              WHERE r.dedupe_key = e.dedupe_key) AS readable,
            -- What the receipt itself says, for checking against what was
            -- claimed. min() picks one deterministically when an expense
            -- carries several receipts, rather than whichever the planner
            -- happened to reach first.
            (SELECT min(to_char(rr.purchased_at, 'YYYY-MM-DD'))
               FROM expense_receipts r
               JOIN receipt_readings rr ON rr.sha256 = r.sha256
                    AND rr.error IS NULL AND rr.legible
              WHERE r.dedupe_key = e.dedupe_key
                AND rr.purchased_at IS NOT NULL) AS receipt_date,
            (SELECT min(rr.merchant)
               FROM expense_receipts r
               JOIN receipt_readings rr ON rr.sha256 = r.sha256
                    AND rr.error IS NULL AND rr.legible
              WHERE r.dedupe_key = e.dedupe_key
                AND rr.merchant IS NOT NULL AND rr.merchant <> '') AS receipt_merchant
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
    receiptTotalsCents: (r.receipt_totals ?? []).map(Number),
    ...splitAware(
      Number(r.amount_cents),
      (r.receipt_totals ?? []).map(Number),
      (r.receipt_arithmetic ?? []).map(Number),
      Number(r.share_peers ?? 1),
      r.share_total_cents === null ? null : Number(r.share_total_cents),
      Number(r.share_sites ?? 1),
    ),
    receiptAlcohol: r.alcohol,
    receiptReadable: r.readable,
    receiptDate: r.receipt_date,
    receiptMerchant: r.receipt_merchant ?? "",
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
  /**
   * True when the rule judged the person's whole DAY rather than this one
   * expense — "Matching total that day is more than $75".
   *
   * The queue needs this to show the flag honestly. Such a rule flags every
   * meal on an over-limit day, so an $11 breakfast appears beside a $77
   * dinner with no visible connection between them, and the obvious reading
   * is that the rule is broken. It is not: the $11 is flagged for the $90
   * day it belongs to. Knowing the verdict was about a group is what lets
   * the table draw the group.
   */
  dayGroup: boolean;
};

/** Failing hits for the given expenses — what the queue turns into flags. */
export async function hitsFor(keys: string[]): Promise<Map<string, Hit[]>> {
  await ensureRules();
  const out = new Map<string, Hit[]>();
  if (keys.length === 0) return out;

  const { rows } = await db().query<{
    dedupe_key: string; rule_id: string; name: string; action: string;
    verdict: string; detail: string; first_seen: Date; must_field: string | null;
  }>(
    `SELECT h.dedupe_key, h.rule_id, r.name, r.action, h.verdict, h.detail, h.first_seen,
            r.must ->> 'field' AS must_field
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
      dayGroup: r.must_field !== null && isGroupField(r.must_field as Field),
    };
    const bucket = out.get(r.dedupe_key);
    if (bucket) bucket.push(hit);
    else out.set(r.dedupe_key, [hit]);
  }
  return out;
}

/** One line per rule for the Rules page: how many it is currently catching. */
export async function ruleStats(): Promise<
  Map<number, { fail: number; pass: number; waiting: number; decided: number }>
> {
  await ensureRules();
  // "Waiting" has to mean what the QUEUE means by it, or the two pages
  // disagree in a way nobody can resolve.
  //
  // It used to mean `in_inbox` alone, and an expense stays in the inbox
  // after it has been approved here — Emburse only drops it at the next
  // import. So a new rule could report "2 in queue" while the queue's flag
  // chips showed no such bucket at all, because both of its catches were
  // sitting under Approved. The rule was working perfectly and the page
  // was asking a different question from the one the reader had in mind.
  //
  // Counted apart rather than merged: "caught 2, both already decided" is
  // a useful thing to be told, and hiding it would just move the confusion.
  const { rows } = await db().query<{
    rule_id: string; verdict: string; n: string; waiting: string; decided: string;
  }>(
    `SELECT h.rule_id, h.verdict, count(*) AS n,
            count(*) FILTER (WHERE e.in_inbox AND NOT d.applied) AS waiting,
            count(*) FILTER (WHERE e.in_inbox AND d.applied) AS decided
       FROM expense_rule_hits h
       JOIN expenses e ON e.dedupe_key = h.dedupe_key
       CROSS JOIN LATERAL (
         SELECT EXISTS (
           SELECT 1 FROM expense_decisions x
            WHERE x.dedupe_key = h.dedupe_key AND x.state = 'applied') AS applied) d
      GROUP BY h.rule_id, h.verdict`);
  const out = new Map<number, { fail: number; pass: number; waiting: number; decided: number }>();
  for (const r of rows) {
    const id = Number(r.rule_id);
    const cur = out.get(id) ?? { fail: 0, pass: 0, waiting: 0, decided: 0 };
    if (r.verdict === "fail") {
      cur.fail += Number(r.n);
      cur.waiting += Number(r.waiting);
      cur.decided += Number(r.decided);
    } else {
      cur.pass += Number(r.n);
    }
    out.set(id, cur);
  }
  return out;
}

export { summarise, problems };
