/**
 * Fix the category, and the flag goes with it.
 *
 *   pnpm exec tsx scripts/test-fix-category-clears-flag.ts   (needs DATABASE_URL)
 *
 * The whole point of the correction, and it was missing. A fuel purchase
 * filed under "Gas" instead of "Auto Fee & Fuel" is flagged by a rule; the
 * fix is to put the right category on it in Emburse, which the app does.
 * Then nothing on this side knew: our copy still said Gas, the rule still
 * had its hit, the row stayed in Flagged, and automatic approval skipped it
 * — because the automation refuses anything flagged. It cleared at the next
 * import, which is tomorrow.
 *
 * "Once it is edited in Emburse then the receipt moves to unflagged so it
 * can be auto approved." That is this test.
 *
 * No browser: the Emburse half is already covered. What is checked here is
 * what happens on THIS side the moment the edit lands.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret-fix-category";

const { db, ensureSchema } = await import("../server/db.js");
const { saveRule } = await import("../server/rules/store.js");
const { runRules } = await import("../server/rules/run.js");
const { applyCorrection } = await import("../server/emburse/corrections.js");

const KEY = "fixcat-1";
const CLEAN = "fixcat-2";
const RULE = "Gas Category — Fuel Category Is Wrong (test)";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'fixcat-%'");
  await db().query("DELETE FROM expense_rules WHERE name = $1", [RULE]);
};

/** Is this expense flagged right now? */
const flagged = async (key: string): Promise<boolean> => {
  const { rows } = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM expense_rule_hits
      WHERE dedupe_key = $1 AND verdict = 'fail'`, [key]);
  return Number(rows[0]?.n ?? 0) > 0;
};

const categoryOf = async (key: string): Promise<string> => {
  const { rows } = await db().query<{ category: string | null }>(
    "SELECT category FROM expenses WHERE dedupe_key = $1", [key]);
  return rows[0]?.category ?? "";
};

await ensureSchema();

try {
  await clean();

  for (const [key, category] of [[KEY, "Gas"], [CLEAN, "Auto Fee & Fuel"]] as const) {
    await db().query(
      `INSERT INTO expenses (dedupe_key, reviewer, employee, merchant, amount_cents,
                             expense_date, category, note)
       VALUES ($1,'eric.s@test.invalid','Dajana Cicvara','HY-VEE GAS 5624HY-VEE, INC.',
               799,'2026-07-29',$2,'Gas for pressure washer')`,
      [key, category]);
  }

  // The rule as it reads on the real queue: a fuel merchant that is not
  // filed as fuel.
  const saved = await saveRule({
    name: RULE, enabled: true, match: "all",
    when: [{ field: "merchant", op: "contains", value: "GAS" }],
    must: { field: "category", op: "is", value: "Auto Fee & Fuel" },
    action: "flag",
    message: "Fuel Category Is Wrong",
  }, "test");
  check("the rule saved", saved.ok, saved.ok ? "" : saved.error);

  console.log("\n1. Before the correction");
  await runRules({ keys: [KEY, CLEAN], decide: false });
  check("the mis-filed one is flagged", await flagged(KEY));
  check("…and the correctly-filed one is not", !(await flagged(CLEAN)));

  console.log("\n2. The correction lands in Emburse");
  // Exactly what the worker now does on run.ok.
  await applyCorrection(KEY, "Auto Fee & Fuel");

  console.log("\n3. After it");
  check("our copy has the new category",
    (await categoryOf(KEY)) === "Auto Fee & Fuel", await categoryOf(KEY));
  check("…the flag is gone", !(await flagged(KEY)));
  check("…without disturbing the other expense", !(await flagged(CLEAN)));

  console.log("\n4. And it is honest when the category is still wrong");
  // Correcting to another wrong category must NOT clear the flag — the
  // rule is what decides, not the act of having corrected something.
  await db().query("UPDATE expenses SET category = 'Gas' WHERE dedupe_key = $1", [KEY]);
  await runRules({ keys: [KEY], decide: false });
  check("flagged again", await flagged(KEY));
  await applyCorrection(KEY, "Meals");
  check("a correction to the WRONG category leaves it flagged", await flagged(KEY));
  check("…and our copy still records what was actually set",
    (await categoryOf(KEY)) === "Meals", await categoryOf(KEY));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
