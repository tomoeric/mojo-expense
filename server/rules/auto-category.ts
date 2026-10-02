/**
 * Put the right category on a fuel purchase, without anybody clicking.
 *
 * Nine of the ten expenses under the Gas Category flag on one morning were
 * the same thing: fuel, filed as Travel or Meals or Small Tools, with a
 * note saying "gas" in as many words. Each one needed somebody to open a
 * picker, choose the category the rule had already named, and wait a
 * minute for it to reach Emburse. That is a correct instruction being
 * re-stated by hand ten times.
 *
 * THE RULE DECIDES, NOT THIS FILE. A flagging rule whose expectation is
 * "category is X" has already said what the right answer is; this makes
 * that expectation true. There is no table of merchants mapped to
 * categories here and there must not be, because that would be a second
 * opinion about somebody's books kept in a different place from the first.
 *
 * TWO INDEPENDENT WITNESSES, both required:
 *
 *   the receipt — a fuel line on it (UNLEADED, DIESEL, PUMP #, gallons),
 *                 or a merchant that sells fuel;
 *   the note    — the person who submitted it saying what it was for.
 *
 * Either alone is too thin. A Circle K receipt can be a sandwich and a
 * bag of ice; a note reading "gas" against a hotel bill is somebody
 * typing in the wrong box. Together they are two people agreeing — the
 * machine that read the paper and the person who spent the money — and
 * that is the standard for changing a finance record unattended.
 */

import { db } from "../db.js";
import { getFlag, getLimit } from "../flags.js";
import { activeRules, listRules, problems } from "./store.js";
import { listTaxonomy } from "../import/taxonomy.js";
import { queueCorrection } from "../emburse/corrections.js";
import { exportInFlight } from "../emburse/export-scheduler.js";

/** Most to correct in one pass, so a bad morning cannot become a bad day. */
export const DEFAULT_PER_RUN = 10;
export const MOST_PER_RUN = 50;

/**
 * Words that only appear on a fuel purchase.
 *
 * Deliberately about the PUMP rather than the forecourt. "Gas" alone is
 * not here: a receipt saying "gas" could be a gas grill, a gas station
 * sandwich, or a utility bill, and this list has to be the half of the
 * evidence that cannot be argued with.
 */
const FUEL_LINE =
  /\b(unleaded|unlead|diesel|gasoline|premium\s*unl|reg\s*unl|mid\s*grade|midgrade|e85|def\b|pump\s*#?\s*\d|gallons?\b|gal\s*@|price\s*\/\s*g|\$\s*\/\s*gal)\b/i;

/**
 * Merchants that sell fuel, as the names come through on a card feed.
 *
 * The second half of the receipt witness, for a slip too faint to read a
 * line off. Brand names only — no "mart", no "stop", nothing that merely
 * suggests a forecourt — because this is evidence, not a hunch.
 */
const FUEL_MERCHANT =
  /\b(shell|exxon|mobil|chevron|texaco|citgo|sunoco|valero|marathon|phillips\s*66|conoco|bp\b|circle\s*k|quiktrip|quik\s*trip|kwik\s*(trip|star|fill)|casey'?s|speedway|racetrac|race\s*trac|wawa|sheetz|murphy\s*(usa|express)|pilot\s*(travel|flying)|flying\s*j|love'?s\s*(travel|country)|buc-?ee|maverik|holiday\s*stationstore|petro|petroleum|fuel|gas\s*station)\b/i;

/** The note saying, in the submitter's own words, that this was fuel. */
const NOTE_SAYS_FUEL = /\b(gas|fuel|diesel|unleaded|petrol|gasoline)\b/i;

export type FuelFix = {
  dedupeKey: string;
  employee: string;
  merchant: string;
  note: string;
  from: string;
  to: string;
  reviewer: string;
  /** Why it qualified, in words, for the log and the report. */
  because: string;
};

/**
 * Flagging rules that name a category as their expectation.
 *
 * `must: { field: "category", op: "is", value: "Auto Fee & Fuel" }` is a
 * rule saying what the right category is. Only "is", and only "flag":
 * "is not" says what it must NOT be, which names no answer, and a rule
 * that denies or approves is not asking for a correction.
 */
export async function categoryRules(): Promise<{ id: number; name: string; to: string }[]> {
  return (await rulesConsidered())
    .filter((r): r is { id: number; name: string; to: string; why: string } => r.to !== null)
    .map(({ id, name, to }) => ({ id, name, to }));
}

/**
 * Every enabled rule, and what this made of it.
 *
 * The card said "no rule names a category as its expectation" over a Gas
 * Category rule that was flagging nine expenses, and there was no way from
 * the screen to tell WHY it was not counted. A verdict with no reasoning
 * is the same defect as a refusal with no reasoning, and this file has
 * already fixed that twice elsewhere.
 */
export async function rulesConsidered(): Promise<
  { id: number; name: string; to: string | null; why: string }[]
> {
  /*
   * EVERY rule, not only the live ones.
   *
   * This read `activeRules()`, which drops anything switched off or
   * invalid — so a card whose entire job is "here is why no rule
   * matched" would have said nothing at all about a Gas Category rule
   * that was simply turned off. The one case the explanation exists for
   * is the one it could not explain.
   */
  const live = new Set((await activeRules()).map((r) => r.id));
  // The tenant's own category names, to check a derived target against.
  const known = new Set(
    (await listTaxonomy("category").catch(() => ({ entries: [] as { name: string }[] })))
      .entries.map((e) => e.name.trim().toLowerCase()));
  return (await listRules()).map((r) => {
    if (!live.has(r.id)) {
      const bad = problems(r);
      return {
        id: r.id, name: r.name, to: null,
        why: r.enabled
          ? `it cannot run as written — ${bad.join(" ")}`
          : "it is switched off",
      };
    }
    if (r.action !== "flag") {
      return { id: r.id, name: r.name, to: null, why: `it ${r.action}s rather than flags` };
    }
    /*
     * Two ways a rule can name the right category, and both count.
     *
     * "must: category is X" says it outright. But "when: category is_not
     * X" says exactly the same thing from the other side — flag this when
     * the category is not X — and that is how the Gas Category rule here
     * was actually written. Reading only the first form made the feature
     * inert against the very rule it was built for.
     */
    const must = r.must;
    const named = (value: string, why: string) => {
      const want = value.trim();
      /*
       * It has to be a category this tenant actually has.
       *
       * The second form is a NEGATIVE — "does not contain X" — and the
       * value there may be a fragment rather than a whole name. A rule
       * reading "category does not contain Fuel" would otherwise have
       * this setting the category to the literal word "Fuel", which the
       * Emburse form would reject after a minute of browsing. Checking
       * it against the tenant's own list turns that into a sentence on
       * the card instead of a failed run.
       */
      if (!known.has(want.toLowerCase())) {
        return {
          id: r.id, name: r.name, to: null,
          why: `${why}, but “${want}” is not one of your categories — this can only set a `
            + "category that exists, so make the rule name the whole one",
        };
      }
      return { id: r.id, name: r.name, to: want, why };
    };

    if (must && must.field === "category" && must.op === "is"
        && !must.compare && must.value.trim() !== "") {
      return named(must.value, `its must is “category is ${must.value.trim()}”`);
    }
    /*
     * The negative, which is how the real rule is written.
     *
     * "Flag when the category is not X" and "flag when it does not
     * contain X" both name X as the right answer, from the other side.
     * I read only `is not`, and the Gas Category rule here uses `does
     * not contain` — so the card reported "no rule names a category"
     * about the one rule the whole feature was built for. Twice now the
     * gap has been reading one spelling of the same statement.
     */
    const unless = r.when.find((c) =>
      c.field === "category" && (c.op === "is_not" || c.op === "not_contains")
      && !c.compare && c.value.trim() !== "");
    if (unless) {
      return named(unless.value,
        `it flags when the category ${unless.op === "is_not" ? "is not" : "does not contain"} `
        + `“${unless.value.trim()}”`);
    }
    return {
      id: r.id, name: r.name, to: null,
      why: must
        ? `its must is “${must.field} ${must.op} ${must.value}”, which names no category`
        : "it names no category — neither a must of “category is …” nor a when of "
          + "“category is not …” or “does not contain …”",
    };
  });
}

/**
 * Everything a rule flagged that both witnesses agree is fuel.
 *
 * Read-only: this is also what the Configuration card shows, so somebody
 * can see exactly what would be changed before switching it on.
 */
export async function fuelFixes(limit = MOST_PER_RUN): Promise<FuelFix[]> {
  const rules = await categoryRules();
  if (rules.length === 0) return [];

  const { rows } = await db().query<{
    dedupe_key: string; employee: string; merchant: string; note: string | null;
    category: string | null; reviewer: string; rule_id: string;
    receipt_merchant: string | null; lines: string | null;
  }>(
    `SELECT e.dedupe_key, e.employee, e.merchant, e.note, e.category, e.reviewer,
            h.rule_id,
            (SELECT rr.merchant FROM expense_receipts r
               JOIN receipt_readings rr ON rr.sha256 = r.sha256
              WHERE r.dedupe_key = e.dedupe_key AND rr.error IS NULL
              LIMIT 1) AS receipt_merchant,
            (SELECT string_agg(i.description, ' | ') FROM expense_receipts r
               JOIN receipt_items i ON i.sha256 = r.sha256
              WHERE r.dedupe_key = e.dedupe_key) AS lines
       FROM expenses e
       JOIN expense_rule_hits h
         ON h.dedupe_key = e.dedupe_key AND h.verdict = 'fail'
        AND h.rule_id = ANY($1::bigint[])
      WHERE e.in_inbox
        -- Nothing already on its way, and nothing already changed.
        AND NOT EXISTS (SELECT 1 FROM category_corrections c
                         WHERE c.dedupe_key = e.dedupe_key
                           AND c.state IN ('pending', 'applied'))
      ORDER BY e.expense_date NULLS LAST, e.dedupe_key`,
    [rules.map((r) => r.id)]);

  const byId = new Map(rules.map((r) => [String(r.id), r]));
  const out: FuelFix[] = [];
  for (const r of rows) {
    const rule = byId.get(String(r.rule_id));
    if (!rule) continue;
    // Already right. The flag will clear on its own; there is nothing to send.
    if ((r.category ?? "").trim().toLowerCase() === rule.to.toLowerCase()) continue;

    const note = (r.note ?? "").trim();
    if (!NOTE_SAYS_FUEL.test(note)) continue;

    const lines = r.lines ?? "";
    const seller = `${r.merchant} ${r.receipt_merchant ?? ""}`;
    const onPaper = FUEL_LINE.test(lines);
    const fromPump = FUEL_MERCHANT.test(seller);
    if (!onPaper && !fromPump) continue;

    out.push({
      dedupeKey: r.dedupe_key, employee: r.employee, merchant: r.merchant,
      note, from: r.category ?? "", to: rule.to, reviewer: r.reviewer,
      because: [
        onPaper ? "the receipt has a fuel line on it" : null,
        fromPump ? "the merchant sells fuel" : null,
      ].filter(Boolean).join(" and ") + `, and the note says “${note}”`,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export type FuelFixResult = { queued: number; skipped: string | null };

/**
 * Send the ones that qualify, as the reviewer whose queue they are in.
 *
 * Under the QUEUE OWNER's login, never the person who switched this on:
 * Emburse records a category change against the account that makes it, so
 * the wrong login puts the wrong name on somebody's finance record
 * permanently. A reviewer with no stored login is left alone rather than
 * corrected by somebody else.
 */
export async function sweepFuelCategories(): Promise<FuelFixResult> {
  if (!(await getFlag("autoFixGasCategory").catch(() => false))) {
    return { queued: 0, skipped: null };
  }
  if (await getFlag("holdDecisions").catch(() => false)) {
    return { queued: 0, skipped: "everything is paused" };
  }
  // Standing aside for an import, for the same reason the approvals do: it
  // adds and removes expenses underneath the queue this reads, and the
  // rules have not seen the new arrivals yet.
  if (await exportInFlight().catch(() => false)) {
    return { queued: 0, skipped: "an import is running" };
  }

  const cap = Math.min(
    Math.max(1, (await getLimit("autoFixGasCategory")) ?? DEFAULT_PER_RUN), MOST_PER_RUN);
  const fixes = await fuelFixes(cap);
  if (fixes.length === 0) return { queued: 0, skipped: null };

  const { hasCredential } = await import("../emburse/credentials.js");
  let queued = 0;
  let noLogin = 0;
  for (const f of fixes) {
    if (!f.reviewer || !(await hasCredential(f.reviewer).catch(() => false))) {
      noLogin++;
      continue;
    }
    const out = await queueCorrection({
      dedupeKey: f.dedupeKey, from: f.from, to: f.to, requestedBy: f.reviewer,
    });
    if (out.ok) {
      queued++;
      console.log(
        `auto-category: ${f.employee} ${f.merchant} → “${f.to}” as ${f.reviewer} — ${f.because}`);
    }
  }
  return {
    queued,
    skipped: noLogin > 0
      ? `${noLogin} left alone — their reviewer has no Emburse login stored, and a category `
        + "change is recorded against whoever makes it"
      : null,
  };
}
