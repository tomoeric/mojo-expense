/**
 * Rules: what they match, and the fences around the ones that decide.
 *
 *   pnpm exec tsx scripts/test-rules.ts        (the DB half needs DATABASE_URL)
 *
 * The example this was built for is the one to keep working: "when the note
 * mentions gas, the category must be Auto Fee & Fuel — otherwise flag it as a
 * mismatch". Everything else here exists because of what a rule can do when it
 * is slightly wrong. A flag that fires too often is noise. An approve rule
 * that fires too often reaches Emburse under somebody's name and spends real
 * money, and by the time anybody reads the warning it has already happened.
 */

// Before anything imports env.ts, which snapshots the environment once.
process.env.SESSION_SECRET ||= "test-secret-for-sealing-credentials";

import {
  applies, evaluate, fires, explain, opLabel, problems, summarise, test,
  type RuleBody, type Subject,
} from "../server/rules/engine.js";
import type { Hit } from "../server/rules/store.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const expense = (over: Partial<Subject> = {}): Subject => ({
  dedupeKey: "k", employee: "Christopher Allen", merchant: "RW6708RACETRAC INC",
  note: "Gas for truck", category: "Auto Fee & Fuel", location: "Richland",
  department: "Operations and Field", method: "Corporate card", amountCents: 4512,
  hasReceipt: true, receiptItems: "UNLEADED REGULAR | MONSTER ENERGY", inInbox: true,
  receiptTotalCents: 4512, date: "2026-09-18", ...over,
});

const rule = (over: Partial<RuleBody> = {}): RuleBody => ({
  name: "Gas must be Fuel", enabled: true, match: "all",
  when: [{ field: "note", op: "contains", value: "gas" }],
  must: { field: "category", op: "is", value: "Auto Fee & Fuel" },
  action: "flag", message: "", ...over,
});

console.log("\nThe rule this was built for");
check("a gas note in the right category passes",
  evaluate(expense(), rule()) === "pass");
check("a gas note in the wrong category fails",
  evaluate(expense({ category: "Training & Professional" }), rule()) === "fail");
check("a non-gas note is none of the rule's business",
  evaluate(expense({ note: "dounuts for the crew" }), rule()) === "not-applicable");
check("matching is case-insensitive both ways",
  evaluate(expense({ note: "GAS", category: "auto fee & fuel" }), rule()) === "pass");
check("the mismatch says what was expected and what was found",
  /Auto Fee & Fuel/.test(explain(expense({ category: "Meals" }), rule()))
    && /Meals/.test(explain(expense({ category: "Meals" }), rule())),
  explain(expense({ category: "Meals" }), rule()));
check("a blank category reads as blank, not as absent",
  /\(blank\)/.test(explain(expense({ category: "" }), rule())));

console.log("\nWhich expenses an action touches");
check("a flag rule fires on the failures",
  fires("fail", "flag") && !fires("pass", "flag"));
check("a deny rule fires on the failures",
  fires("fail", "deny") && !fires("pass", "deny"));
check("an approve rule fires on the ones that PASS",
  fires("pass", "approve") && !fires("fail", "approve"));
check("nothing fires on an expense the rule does not match",
  !fires("not-applicable", "flag") && !fires("not-applicable", "approve")
    && !fires("not-applicable", "deny"));

console.log("\nConditions");
check("and-matching needs every condition", !applies(expense({ merchant: "Kwik Star" }), rule({
  match: "all",
  when: [{ field: "note", op: "contains", value: "gas" },
         { field: "merchant", op: "contains", value: "racetrac" }],
})));
check("or-matching needs only one", applies(expense({ merchant: "Kwik Star" }), rule({
  match: "any",
  when: [{ field: "note", op: "contains", value: "gas" },
         { field: "merchant", op: "contains", value: "racetrac" }],
})));
check("amounts compare as numbers, not strings",
  true === test(expense({ amountCents: 900_00 }), { field: "amount", op: "gt", value: "100" })
    && !test(expense({ amountCents: 90_00 }), { field: "amount", op: "gt", value: "100" }));
check("a missing receipt is testable",
  test(expense({ hasReceipt: false }), { field: "receipt", op: "is_blank", value: "" }) === true
    && test(expense(), { field: "receipt", op: "is_not_blank", value: "" }) === true);
check("receipt line items are searchable",
  test(expense(), { field: "receiptItems", op: "contains", value: "monster" }) === true);

// The one that turns a half-written rule into a disaster: an empty value on a
// `contains` would make every expense match, and on an approve rule that is
// the whole queue.
check("a blank value never matches everything",
  !test(expense(), { field: "note", op: "contains", value: "" })
    && !test(expense(), { field: "note", op: "starts_with", value: "" }));
check("…and `does not contain` with a blank value is not universally true",
  !test(expense(), { field: "note", op: "not_contains", value: "" }));
check("a rule with no conditions matches nothing",
  !applies(expense(), rule({ when: [] })));

console.log("\nThe receipt's own total against the amount claimed");

// The check an expense queue most needs, and the one a field-against-a-constant
// rule cannot state. "WHEN there is a receipt, the total read off it MUST equal
// the amount claimed."
const matchRule = rule({
  name: "Receipt must match the claim",
  when: [{ field: "receipt", op: "is_not_blank", value: "" }],
  must: { field: "receiptTotal", op: "is", value: "", compare: "amount" },
  message: "The receipt does not show the amount claimed.",
});

check("the example rule is valid", problems(matchRule).length === 0,
  problems(matchRule).join(" "));
check("it reads as the sentence it is",
  summarise(matchRule) ===
    "When Receipt is not blank, Receipt total (read off the image) equals Amount — otherwise flag it.",
  summarise(matchRule));
// "is" is fine for a category and ambiguous for money — nobody asks whether one
// amount "is" another. The wording is per-field, and it is the server's answer
// so the rule reads the same in the editor, the list and the flag.
check("money says equals, not is",
  opLabel("amount", "is") === "equals" && opLabel("receiptTotal", "is_not") === "does not equal",
  `${opLabel("amount", "is")} / ${opLabel("receiptTotal", "is_not")}`);
check("…and a text column still says is",
  opLabel("category", "is") === "is" && opLabel("note", "contains") === "contains");
check("a receipt nobody has read reads as such, not as blank",
  opLabel("receiptTotal", "is_blank") === "was not read",
  opLabel("receiptTotal", "is_blank"));

check("a receipt showing the claimed amount passes",
  evaluate(expense({ amountCents: 4512, receiptTotalCents: 4512 }), matchRule) === "pass");
check("a receipt showing something else fails",
  evaluate(expense({ amountCents: 4512, receiptTotalCents: 8899 }), matchRule) === "fail");
check("the mismatch shows both figures",
  /\$45\.12/.test(explain(expense({ amountCents: 4512, receiptTotalCents: 8899 }),
    { ...matchRule, message: "" }))
    && /\$88\.99/.test(explain(expense({ amountCents: 4512, receiptTotalCents: 8899 }),
      { ...matchRule, message: "" })),
  explain(expense({ amountCents: 4512, receiptTotalCents: 8899 }), { ...matchRule, message: "" }));

// Two figures for the same purchase differ by a cent for reasons nobody wants
// to be told about. A rule that flags those is a rule people switch off.
check("a one-cent difference is not a mismatch",
  evaluate(expense({ amountCents: 4512, receiptTotalCents: 4511 }), matchRule) === "pass");
check("…but a real difference still is",
  evaluate(expense({ amountCents: 4512, receiptTotalCents: 4600 }), matchRule) === "fail");
check("the slack scales with the amount, so big claims are not held to a cent",
  evaluate(expense({ amountCents: 500_000, receiptTotalCents: 500_300 }), matchRule) === "pass");

// THE ONE THAT MATTERS. Receipts are read by a background pass that needs an
// Anthropic key. Until one is working, every receipt total is null — and
// treating null as "does not match" would flag the entire queue the moment
// somebody saved this rule, while the rule looked perfectly correct.
check("an UNREAD receipt is not a mismatch",
  evaluate(expense({ receiptTotalCents: null }), matchRule) === "not-applicable");
check("…nor is it a pass, which would be just as wrong",
  evaluate(expense({ receiptTotalCents: null }), matchRule) !== "pass");
check("so nothing fires on it, for any action",
  !fires(evaluate(expense({ receiptTotalCents: null }), matchRule), "flag")
    && !fires(evaluate(expense({ receiptTotalCents: null }), matchRule), "deny")
    && !fires(evaluate(expense({ receiptTotalCents: null }), matchRule), "approve"));
check("an unjudgeable condition in WHEN does not drag the expense into scope",
  !applies(expense({ receiptTotalCents: null }),
    rule({ when: [{ field: "receiptTotal", op: "gt", value: "100" }] })));

// Finding the ones nobody could read is its own useful rule.
check("an unread receipt is findable on purpose",
  test(expense({ receiptTotalCents: null }), { field: "receiptTotal", op: "is_blank", value: "" }) === true
    && test(expense({ receiptTotalCents: 4512 }), { field: "receiptTotal", op: "is_blank", value: "" }) === false);

check("a column cannot be compared with one of a different kind",
  problems(rule({ must: { field: "merchant", op: "is", value: "", compare: "amount" } }))
    .some((p) => /cannot be compared/.test(p)));
check("“is blank” takes no column to compare with",
  problems(rule({ must: { field: "receiptTotal", op: "is_blank", value: "", compare: "amount" } }))
    .some((p) => /does not take another column/.test(p)));
check("a comparison needs no typed value",
  problems(rule({ must: { field: "receiptTotal", op: "is", value: "", compare: "amount" } })).length === 0);

// The request parser, not just the engine. A rule arrives as JSON and is
// rebuilt field by field rather than trusted — and a field the parser forgets
// to carry is invisible to every test above, because they construct the rule
// in memory. That is exactly how `compare` was dropped once.
console.log("\nA rule survives the round trip through the request parser");
const { readBody } = await import("../server/rules/routes.js");
const parsed = readBody({
  name: "Receipt must match the claim",
  enabled: true,
  match: "all",
  when: [{ field: "receipt", op: "is_not_blank", value: "" }],
  must: { field: "receiptTotal", op: "is", value: "", compare: "amount" },
  action: "flag",
  message: "",
});
check("the request is accepted", !("error" in parsed),
  "error" in parsed ? parsed.error : "");
if (!("error" in parsed)) {
  check("the comparison survives the parse", parsed.must?.compare === "amount",
    JSON.stringify(parsed.must));
  check("and the parsed rule is valid", problems(parsed).length === 0,
    problems(parsed).join(" "));
  check("it evaluates the same as the one built in memory",
    evaluate(expense({ amountCents: 4512, receiptTotalCents: 8899 }), parsed) === "fail"
      && evaluate(expense({ amountCents: 4512, receiptTotalCents: 4512 }), parsed) === "pass"
      && evaluate(expense({ receiptTotalCents: null }), parsed) === "not-applicable");
}
const refused = readBody({
  name: "Nonsense", enabled: true, match: "all",
  when: [{ field: "merchant", op: "is", value: "", compare: "amount" }],
  action: "flag", message: "",
});
check("a comparison between different kinds of column is refused at the door",
  "error" in refused && /cannot be compared/.test(refused.error),
  "error" in refused ? refused.error : "accepted");

// "More than three meals in a day" and "more than $75 of meals in a day" are
// the two most useful things to ask of an expense queue, and neither can be
// answered by looking at one expense. They are computed over the expenses the
// WHEN matched, for one person on one day.
console.log("\nCounting and totalling a person's day");

const { runRules: runAll } = await import("../server/rules/run.js");
void runAll;
const { applies: appliesTo } = await import("../server/rules/engine.js");

const mealRule = rule({
  name: "No more than three meals a day",
  when: [{ field: "category", op: "contains", value: "meals" }],
  must: { field: "dayCount", op: "lte", value: "3" },
  message: "More than three meals claimed on one day.",
});
const spendRule = rule({
  name: "Meals under $75 a day",
  when: [{ field: "category", op: "contains", value: "meals" }],
  must: { field: "dayTotal", op: "lte", value: "75" },
  message: "More than $75 of meals on one day.",
});

check("both rules are valid", problems(mealRule).length === 0 && problems(spendRule).length === 0,
  [...problems(mealRule), ...problems(spendRule)].join(" "));
check("the count rule reads as a limit, not an off-by-one",
  summarise(mealRule) === "When Category contains “meals”, Matching expenses that day is at most “3” — otherwise flag it.",
  summarise(mealRule));

const meal = (over: Partial<Subject> = {}) =>
  expense({ category: "Meals & Entertainment", note: "lunch", ...over });

// The group the runner builds: everything the WHEN matched, same person, same day.
const group = (subjects: Subject[]) => ({
  count: subjects.length,
  totalCents: subjects.reduce((a, s) => a + s.amountCents, 0),
});

const three = [meal(), meal(), meal()];
const four = [meal(), meal(), meal(), meal()];

check("three meals is within the limit",
  evaluate(three[0]!, mealRule, group(three)) === "pass");
check("the fourth puts the day over it",
  evaluate(four[0]!, mealRule, group(four)) === "fail");
check("…and every meal that day is flagged, not just the last one",
  four.every((m) => evaluate(m, mealRule, group(four)) === "fail"));
check("the flag says how many there were",
  /four|4/i.test(explain(four[0]!, { ...mealRule, message: "" }, group(four))),
  explain(four[0]!, { ...mealRule, message: "" }, group(four)));

const under = [meal({ amountCents: 2000 }), meal({ amountCents: 3000 })];
const over = [meal({ amountCents: 4000 }), meal({ amountCents: 4000 })];
check("$50 of meals is under the $75 limit",
  evaluate(under[0]!, spendRule, group(under)) === "pass");
check("$80 is over it", evaluate(over[0]!, spendRule, group(over)) === "fail");
check("the flag shows the day's total, not one receipt",
  /80\.00/.test(explain(over[0]!, { ...spendRule, message: "" }, group(over))),
  explain(over[0]!, { ...spendRule, message: "" }, group(over)));

// Only the matching expenses count. A fuel receipt on the same day is not a meal.
check("the count covers what the WHEN matched, not everything that day",
  !appliesTo(expense({ category: "Auto Fee & Fuel", note: "gas" }), mealRule));

// Without a group there is nothing to count, and a guess would flag the queue.
check("no group means no verdict, rather than a wrong one",
  evaluate(meal(), mealRule) === "not-applicable");

check("a group field in the WHEN is refused as circular",
  problems(rule({ when: [{ field: "dayCount", op: "lte", value: "3" }] }))
    .some((p) => /only be used in MUST/.test(p)));

console.log("\nWhat a rule is not allowed to be");
check("a rule needs a name", problems(rule({ name: "  " })).some((p) => /needs a name/.test(p)));
check("a rule needs a condition", problems(rule({ when: [] })).some((p) => /at least one condition/.test(p)));
check("a condition needs a value",
  problems(rule({ when: [{ field: "note", op: "contains", value: "" }] }))
    .some((p) => /needs a value/.test(p)));
check("an amount condition needs a number",
  problems(rule({ when: [{ field: "amount", op: "gt", value: "lots" }] }))
    .some((p) => /not an amount/.test(p)));
check("a deny rule must carry the reason the employee will be shown",
  problems(rule({ action: "deny", message: "" })).some((p) => /needs a message/.test(p)));
check("a deny rule with a reason is allowed",
  problems(rule({ action: "deny", message: "Gas must be booked to Fuel." })).length === 0);
check("an approve rule with no expectation must say why",
  problems(rule({ action: "approve", must: null, message: "" }))
    .some((p) => /approves every expense/.test(p)));
check("a field cannot be tested with an operator that makes no sense for it",
  problems(rule({ when: [{ field: "amount", op: "contains", value: "5" }] }))
    .some((p) => /cannot be tested/.test(p)));
check("the example rule itself is valid", problems(rule()).length === 0);

console.log("\nHow a rule reads back");
check("an expectation rule reads as one",
  summarise(rule()) === "When Note contains “gas”, Category is “Auto Fee & Fuel” — otherwise flag it.",
  summarise(rule()));
check("an approve rule reads as a reward, not a punishment",
  summarise(rule({ action: "approve" }))
    === "When Note contains “gas” and Category is “Auto Fee & Fuel” — approve it.",
  summarise(rule({ action: "approve" })));
check("a rule with no expectation reads plainly",
  summarise(rule({ must: null, action: "deny" })) === "When Note contains “gas” — deny it.",
  summarise(rule({ must: null, action: "deny" })));

if (!process.env.DATABASE_URL) {
  console.log("\nDATABASE_URL not set — skipping the stored half.");
  console.log(failures === 0 ? "\nPASS (engine only)" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

const { db, ensureSchema } = await import("../server/db.js");
const store = await import("../server/rules/store.js");
const { runRules, MAX_DECISIONS_PER_RUN } = await import("../server/rules/run.js");

await ensureSchema();
await store.ensureRules();

const TAG = `zz-rule-${Date.now()}`;
const keys: string[] = [];

async function addExpense(n: number, over: { note?: string; category?: string; inbox?: boolean } = {}) {
  const key = `${TAG}-${n}`;
  keys.push(key);
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-18',$3,$4,$5,'Operations and Field','Richland',$6,'Corporate card',$7)`,
    [key, `${TAG} Person`, `${TAG} Merchant`, 4512,
     over.category ?? "Auto Fee & Fuel", over.note ?? "Gas for truck", over.inbox ?? true]);
  return key;
}

console.log("\nStored rules");
try {
  const saved = await store.saveRule(
    { ...rule(), name: `${TAG} gas` }, "tester@example.invalid");
  check("a valid rule saves", saved.ok, saved.ok ? "" : saved.error);
  if (!saved.ok) throw new Error(saved.error);
  const ruleId = saved.rule.id;

  const dupe = await store.saveRule({ ...rule(), name: `${TAG} GAS` }, "tester@example.invalid");
  check("two rules cannot share a name, whatever the case",
    !dupe.ok && /already a rule/.test(dupe.ok ? "" : dupe.error));

  const bad = await store.saveRule({ ...rule(), name: `${TAG} bad`, when: [] }, "tester@example.invalid");
  check("an invalid rule is refused rather than stored", !bad.ok);

  // Three expenses: one right, one wrong, one the rule should ignore.
  const good = await addExpense(1);
  const wrong = await addExpense(2, { category: "Training & Professional" });
  await addExpense(3, { note: "dounuts for the crew" });

  const ran = await runRules({ keys });
  check("the run reports what it looked at", ran.rulesRun >= 1 && ran.expenses === 3,
    `rules=${ran.rulesRun} expenses=${ran.expenses}`);

  // Only this suite's own rules. Run against a database that already has real
  // rules in it, anything else would be reading their verdicts as ours.
  const allOurHits = async (): Promise<Map<string, Hit[]>> => {
    const all = await store.hitsFor(keys);
    return new Map(
      [...all.entries()]
        .map(([k, hs]) => [k, hs.filter((h) => h.ruleName.startsWith(TAG))] as const)
        .filter(([, hs]) => hs.length > 0),
    );
  };
  const ourHits = async (key: string): Promise<Hit[]> => (await allOurHits()).get(key) ?? [];

  check("only the mismatch is flagged",
    (await ourHits(wrong)).length === 1 && (await ourHits(good)).length === 0,
    `wrong=${(await ourHits(wrong)).length} good=${(await ourHits(good)).length}`);
  check("the flag names the rule", (await ourHits(wrong))[0]?.ruleName === `${TAG} gas`);
  check("and carries the explanation",
    /Auto Fee & Fuel/.test((await ourHits(wrong))[0]?.detail ?? ""), (await ourHits(wrong))[0]?.detail);

  const stats = await store.ruleStats();
  check("the rule's own tally matches", stats.get(ruleId)?.fail === 1 && stats.get(ruleId)?.pass === 1,
    JSON.stringify(stats.get(ruleId)));

  // Fixing the expense must clear the flag, not leave a stale one behind.
  await db().query("UPDATE expenses SET category = $2 WHERE dedupe_key = $1",
    [wrong, "Auto Fee & Fuel"]);
  await runRules({ keys });
  check("correcting the expense clears the flag", (await ourHits(wrong)).length === 0);

  // Editing a rule must not leave verdicts reached under the old definition.
  await db().query("UPDATE expenses SET category = $2 WHERE dedupe_key = $1",
    [wrong, "Training & Professional"]);
  await runRules({ keys });
  check("the flag comes back when the expense does", (await ourHits(wrong)).length === 1);
  await store.saveRule(
    { ...rule(), name: `${TAG} gas`, must: { field: "category", op: "is", value: "Training & Professional" } },
    "tester@example.invalid", ruleId);
  check("editing a rule drops the verdicts it reached before",
    (await allOurHits()).size === 0);

  // A disabled rule must stop appearing, without losing its definition.
  await runRules({ keys });
  await store.setEnabled(ruleId, false, "tester@example.invalid");
  check("a disabled rule stops flagging", (await allOurHits()).size === 0);
  check("…but is still there", (await store.getRule(ruleId))?.enabled === false);

  console.log("\nThe fences around deciding");
  const denier = await store.saveRule({
    ...rule(), name: `${TAG} deny`, action: "deny",
    message: "Gas must be booked to Fuel.",
    must: { field: "category", op: "is", value: "Auto Fee & Fuel" },
  }, "nobody@example.invalid");
  check("a deny rule saves with its reason", denier.ok, denier.ok ? "" : denier.error);

  const denyRun = await runRules({ keys });
  check("a rule whose owner has no Emburse login decides nothing",
    denyRun.denied === 0, `denied=${denyRun.denied}`);
  check("…and says why, naming the owner",
    denyRun.warnings.some((w) => /no stored Emburse login/.test(w) && /nobody@example.invalid/.test(w)),
    denyRun.warnings.join(" | "));

  const { rows: queued } = await db().query(
    "SELECT count(*)::int AS n FROM expense_decisions WHERE dedupe_key = ANY($1::text[])", [keys]);
  check("nothing reached the decision queue", queued[0].n === 0, `queued=${queued[0].n}`);

  check("the cap is low enough to catch a typo before it costs a morning",
    MAX_DECISIONS_PER_RUN <= 25, String(MAX_DECISIONS_PER_RUN));

  console.log("\nA deciding rule whose owner CAN decide");
  // The dangerous path: the fences are off, and the rule reaches the queue.
  // Everything below is about it reaching the queue exactly once, only for
  // what is still in the inbox, and never past the cap.
  const { saveCredential, deleteCredential } = await import("../server/emburse/credentials.js");
  const OWNER = `${TAG}@example.invalid`;
  await saveCredential(OWNER, OWNER, OWNER, "not-a-real-password");

  const live = await store.saveRule({
    ...rule(), name: `${TAG} live deny`, action: "deny",
    message: "Gas must be booked to Fuel.",
    must: { field: "category", op: "is", value: "Auto Fee & Fuel" },
  }, OWNER);
  if (!live.ok) throw new Error(live.error);

  await db().query("DELETE FROM expense_decisions WHERE dedupe_key = ANY($1::text[])", [keys]);
  const liveRun = await runRules({ keys });
  check("it queues a denial for the mismatch", liveRun.denied === 1, `denied=${liveRun.denied}`);

  const { rows: queuedRows } = await db().query<{ dedupe_key: string; reason: string; decided_by: string }>(
    "SELECT dedupe_key, reason, decided_by FROM expense_decisions WHERE dedupe_key = ANY($1::text[])", [keys]);
  check("exactly one expense was decided", queuedRows.length === 1, `rows=${queuedRows.length}`);
  check("under the rule owner's own login, not a shared one",
    queuedRows[0]?.decided_by === OWNER, queuedRows[0]?.decided_by);
  check("the reason carries both the message and the rule's name",
    /Gas must be booked to Fuel/.test(queuedRows[0]?.reason ?? "")
      && new RegExp(`rule: ${TAG} live deny`).test(queuedRows[0]?.reason ?? ""),
    queuedRows[0]?.reason);

  // Running again must not stack a second decision on the same expense.
  const again = await runRules({ keys });
  check("a second run does not decide it twice", again.denied === 0, `denied=${again.denied}`);
  const { rows: stillOne } = await db().query<{ n: string }>(
    "SELECT count(*)::int AS n FROM expense_decisions WHERE dedupe_key = ANY($1::text[])", [keys]);
  check("…and the queue still holds one", Number(stillOne[0]!.n) === 1, `n=${stillOne[0]!.n}`);

  // An expense that has left the inbox has already been actioned; a rule must
  // never reach back for it.
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key = ANY($1::text[])", [keys]);
  await db().query("UPDATE expenses SET in_inbox = false WHERE dedupe_key = ANY($1::text[])", [keys]);
  const goneRun = await runRules({ keys });
  check("nothing that has left the inbox is decided", goneRun.denied === 0, `denied=${goneRun.denied}`);
  await db().query("UPDATE expenses SET in_inbox = true WHERE dedupe_key = ANY($1::text[])", [keys]);

  // The cap. A rule matching far more than intended must stop and say so
  // rather than work its way through the queue.
  console.log("\nThe cap on a runaway rule");
  for (let i = 10; i < 10 + MAX_DECISIONS_PER_RUN + 5; i++) {
    await addExpense(i, { category: "Training & Professional" });
  }
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key = ANY($1::text[])", [keys]);
  const capped = await runRules({ keys });
  check("it stops at the cap", capped.denied === MAX_DECISIONS_PER_RUN, `denied=${capped.denied}`);
  check("and says why, so the run is not silently partial",
    capped.warnings.some((w) => /over the \d+ a rule may deny/.test(w)),
    capped.warnings.join(" | "));
  const { rows: cappedRows } = await db().query<{ n: string }>(
    "SELECT count(*)::int AS n FROM expense_decisions WHERE dedupe_key = ANY($1::text[])", [keys]);
  check("no more than the cap reached the queue",
    Number(cappedRows[0]!.n) === MAX_DECISIONS_PER_RUN, `n=${cappedRows[0]!.n}`);

  await deleteCredential(OWNER);

  console.log("\nPreviewing before switching on");
  const preview = await store.getRule(denier.ok ? denier.rule.id : 0);
  if (preview) {
    const { previewRule } = await import("../server/rules/run.js");
    // Against the live count, not against zero: the cap test above deliberately
    // left decisions in the queue, and "still zero" would pass for the wrong reason.
    const before = await db().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM expense_decisions WHERE dedupe_key = ANY($1::text[])", [keys]);
    const seen = await previewRule(preview);
    check("a preview counts what the rule would touch", seen.matched >= 2, JSON.stringify({
      matched: seen.matched, failing: seen.failing, passing: seen.passing, wouldAct: seen.wouldAct }));
    check("a preview shows the failures first",
      seen.sample[0]?.verdict === "fail" || seen.failing === 0);
    const after = await db().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM expense_decisions WHERE dedupe_key = ANY($1::text[])", [keys]);
    check("and a preview never queues anything", after.rows[0]!.n === before.rows[0]!.n,
      `${before.rows[0]!.n} → ${after.rows[0]!.n}`);
  }
} finally {
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expense_taxonomy WHERE name LIKE $1", [`%${TAG}%`]);
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
