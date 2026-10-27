/**
 * A rule judges the Emburse accounts it was given, and no others.
 *
 *   pnpm exec tsx scripts/test-rule-scope.ts
 *
 * One person now has a manager queue and two personal Emburse
 * accounts, and a rule has to be able to say which of them it is
 * about. Four things follow, and three of them fail silently:
 *
 *   EVERY RULE WRITTEN BEFORE THIS IS MANAGER-ONLY. They were all
 *   written about the manager queue; extending them to somebody's
 *   personal accounts would be a rule nobody wrote, acting on
 *   expenses nobody meant — with approve and deny among the
 *   actions available.
 *
 *   AN ACCOUNT-SPECIFIC RULE ACTS ON THAT ACCOUNT ONLY.
 *
 *   A RULE SCOPED TO BOTH IS EVALUATED INDEPENDENTLY FOR EACH.
 *   Defined once, but a daily total counted across two companies
 *   is a threshold nobody set: three MOJO meals and two Mammoth
 *   meals is not five meals in a day.
 *
 *   AND IT DOES NOT DECIDE IN A PERSONAL ACCOUNT. A decision is
 *   applied under the primary connection, which is a different
 *   tenant; it flags instead and says so.
 */
import { db, ensureSchema } from "../server/db.js";
import { ensureRules, listRules, saveRule, subjects } from "../server/rules/store.js";
import { runRules } from "../server/rules/run.js";
import { ensureTaxonomy } from "../server/import/taxonomy.js";
import { saveCredential, deleteCredential } from "../server/emburse/credentials.js";
import type { RuleBody } from "../server/rules/engine.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const TAG = `zz-scope-${Date.now()}`;
const OWNER = "scope-owner@test.invalid";
const MOJO = "personal-mojo";
const MAMMOTH = "personal-mammoth";
const MADE: number[] = [];

await ensureSchema();
await ensureRules();
await ensureTaxonomy();

const add = (n: number, lane: string, cents = 4000, merchant = "SCOPEMERCHANT") =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox,
                           reviewer, source, lane)
     VALUES ($1,'Scope Tester','2026-09-24',$2,$3,'Meals','Ops','Site','','Card',true,
             $4,'',$5)`,
    [`${TAG}-${lane || "mgr"}-${n}`, merchant, cents, OWNER, lane]);

const rule = (over: Partial<RuleBody>): RuleBody => ({
  name: `${TAG} rule`, enabled: true, match: "all",
  when: [{ field: "merchant", op: "contains", value: "SCOPEMERCHANT", compare: null }],
  must: null, action: "flag", message: "Scoped",
  ...over,
});

const verdicts = async (ruleId: number): Promise<string[]> => {
  const { rows } = await db().query<{ dedupe_key: string }>(
    "SELECT dedupe_key FROM expense_rule_hits WHERE rule_id = $1 ORDER BY dedupe_key",
    [ruleId]);
  return rows.map((r) => r.dedupe_key);
};

try {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await saveCredential("scope-owner-id", OWNER, "scope@example.com", "pw");

  await add(1, "");
  await add(2, MOJO);
  await add(3, MAMMOTH);

  console.log("1. A rule with no scope stored is manager-only");
  const plain = await saveRule(rule({ name: `${TAG} plain` }), OWNER);
  check("it saves", plain.ok === true, plain.ok ? "" : plain.error);
  if (!plain.ok) throw new Error(plain.error);
  MADE.push(plain.rule.id);
  check("…and reads back as the manager queue",
    JSON.stringify(plain.rule.scope) === JSON.stringify([""]),
    JSON.stringify(plain.rule.scope));
  await runRules({ keys: [`${TAG}-mgr-1`, `${TAG}-${MOJO}-2`, `${TAG}-${MAMMOTH}-3`],
    decide: false });
  const plainHits = await verdicts(plain.rule.id);
  check("IT JUDGED THE MANAGER EXPENSE", plainHits.includes(`${TAG}-mgr-1`));
  check("…AND NEITHER PERSONAL ONE",
    !plainHits.includes(`${TAG}-${MOJO}-2`) && !plainHits.includes(`${TAG}-${MAMMOTH}-3`),
    plainHits.join(", "));

  console.log("\n2. A rule scoped to one account acts on that account only");
  const onlyMojo = await saveRule(
    rule({ name: `${TAG} mojo`, scope: [MOJO] }), OWNER);
  if (!onlyMojo.ok) throw new Error(onlyMojo.error);
  MADE.push(onlyMojo.rule.id);
  check("the scope is stored", JSON.stringify(onlyMojo.rule.scope) === JSON.stringify([MOJO]),
    JSON.stringify(onlyMojo.rule.scope));
  await runRules({ keys: [`${TAG}-mgr-1`, `${TAG}-${MOJO}-2`, `${TAG}-${MAMMOTH}-3`],
    decide: false });
  const mojoHits = await verdicts(onlyMojo.rule.id);
  check("IT JUDGED THE MOJO EXPENSE", mojoHits.includes(`${TAG}-${MOJO}-2`));
  check("…AND NOT THE MAMMOTH ONE", !mojoHits.includes(`${TAG}-${MAMMOTH}-3`));
  check("…AND NOT THE MANAGER ONE", !mojoHits.includes(`${TAG}-mgr-1`),
    mojoHits.join(", "));

  console.log("\n3. A rule scoped to both is evaluated for each");
  const bothAccounts = await saveRule(
    rule({ name: `${TAG} both`, scope: [MOJO, MAMMOTH] }), OWNER);
  if (!bothAccounts.ok) throw new Error(bothAccounts.error);
  MADE.push(bothAccounts.rule.id);
  await runRules({ keys: [`${TAG}-mgr-1`, `${TAG}-${MOJO}-2`, `${TAG}-${MAMMOTH}-3`],
    decide: false });
  const bothHits = await verdicts(bothAccounts.rule.id);
  check("it judged both personal expenses",
    bothHits.includes(`${TAG}-${MOJO}-2`) && bothHits.includes(`${TAG}-${MAMMOTH}-3`));
  check("…and still not the manager one", !bothHits.includes(`${TAG}-mgr-1`));

  console.log("\n4. A daily total does not cross accounts");
  /*
   * Two MOJO meals and two Mammoth meals on one day. A rule that
   * fires over three in a day must fire on NEITHER account: four
   * expenses added together is a threshold nobody set.
   */
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  for (const n of [1, 2]) await add(n, MOJO);
  for (const n of [3, 4]) await add(n, MAMMOTH);
  const perDay = await saveRule(rule({
    name: `${TAG} day`, scope: [MOJO, MAMMOTH],
    must: { field: "dayCount", op: "lte", value: "3", compare: null },
  }), OWNER);
  if (!perDay.ok) throw new Error(perDay.error);
  MADE.push(perDay.rule.id);
  await runRules({ decide: false });
  const { rows: fails } = await db().query<{ dedupe_key: string }>(
    "SELECT dedupe_key FROM expense_rule_hits WHERE rule_id = $1 AND verdict = 'fail'",
    [perDay.rule.id]);
  check("NOTHING FAILS — two a day in each, not four in one",
    fails.length === 0, fails.map((r) => r.dedupe_key).join(", "));
  // And it DOES fire when one account alone goes over.
  for (const n of [5, 6]) await add(n, MOJO);
  await runRules({ decide: false });
  const { rows: now } = await db().query<{ dedupe_key: string }>(
    "SELECT dedupe_key FROM expense_rule_hits WHERE rule_id = $1 AND verdict = 'fail'",
    [perDay.rule.id]);
  check("…and it does fire once ONE account goes over", now.length === 4,
    `${now.length} failed`);
  check("…only in that account",
    now.every((r) => r.dedupe_key.includes(MOJO)),
    now.map((r) => r.dedupe_key).join(", "));

  console.log("\n5. It flags a personal expense rather than deciding it");
  // An approve rule fires on the expenses that PASS, so it needs a
  // `must` they satisfy — with `must: null` every match is an
  // offender and an approve rule fires on nothing.
  const decider = await saveRule(rule({
    name: `${TAG} approve`, scope: [MOJO], action: "approve",
    must: { field: "amount", op: "lte", value: "1000", compare: null },
  }), OWNER);
  if (!decider.ok) throw new Error(decider.error);
  MADE.push(decider.rule.id);
  const run = await runRules({ decide: true });
  check("nothing was approved", run.approved === 0, String(run.approved));
  check("…and the run says why",
    run.warnings.some((w) => w.includes("personal Emburse account")),
    run.warnings.join(" | "));
  check("…while the expenses are still judged",
    (await verdicts(decider.rule.id)).length > 0);

  console.log("\n6. A scope naming no account is refused");
  const empty = await saveRule(rule({ name: `${TAG} empty`, scope: [] }), OWNER);
  // An empty array reaches the store as "nothing chosen", which it
  // reads as manager-only rather than as a rule that judges
  // nothing. The route is where an explicit empty list is refused.
  check("the store reads it as the manager queue",
    empty.ok && JSON.stringify(empty.rule.scope) === JSON.stringify([""]),
    empty.ok ? JSON.stringify(empty.rule.scope) : empty.error);
  if (empty.ok) MADE.push(empty.rule.id);

} finally {
  for (const id of MADE) {
    await db().query("DELETE FROM expense_rules WHERE id = $1", [id]).catch(() => undefined);
  }
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`])
    .catch(() => undefined);
  await deleteCredential("scope-owner-id").catch(() => undefined);
  void listRules;
  void subjects;
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
