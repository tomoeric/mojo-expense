/**
 * A day rule's flags, drawn as the day they judged.
 *
 *   pnpm exec tsx scripts/test-day-groups.ts       (needs DATABASE_URL)
 *
 * "Matching total that day is more than $75" flags EVERY meal on an
 * over-limit day. In a flat queue that put an $11 McDonald's next to a $77
 * Jimmy John's with nothing connecting them, and the honest reading of that
 * screen was that the rule was broken. It was not — the $11 belonged to a
 * $90 day — but nothing said so, and a flag a reviewer reads as noise is a
 * flag that gets ignored.
 *
 * So three things are pinned here:
 *
 *   1. a hit knows whether its rule judged the DAY or the expense
 *   2. a day rule produces one flag PER DAY, carrying that day
 *   3. the table bands by person AND day — never pooling two people, two
 *      dates, or a non-meal sharing the date
 */

process.env.SESSION_SECRET ||= "test-secret-for-sealing-credentials";

import { bandsFor, type Row } from "../src/components/expense-table.js";
import type { ExpenseLine, ExpenseReport } from "../src/lib/api.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const RULE = "Meal Amount Exceeds Day Limit";

const row = (employee: string, day: string, amount: number, inGroup = true): Row => ({
  line: { id: `${employee}-${day}-${amount}`, date: day, amount } as ExpenseLine,
  report: {} as ExpenseReport,
  employee,
  department: "",
  flags: [`${RULE} — Matching total that day is at most “$75.00” was expected — found “$90.00”.`],
  flagGroups: [RULE],
  dayGroups: inGroup ? [{ rule: RULE, day }] : [],
  ageDays: null,
});

console.log("\n1. One person's over-limit day");
{
  const bands = bandsFor(
    [row("Brad", "2026-09-21", 11), row("Brad", "2026-09-21", 34), row("Brad", "2026-09-21", 45)],
    RULE);
  check("the three receipts are one band", bands.length === 1, `${bands.length} band(s)`);
  check("…headed by the person and the day",
    bands[0]!.employee === "Brad" && bands[0]!.day === "2026-09-21");
  check("…showing the total that actually broke the limit",
    bands[0]!.total === 90, String(bands[0]!.total));
  check("…and every receipt in it, including the $11",
    bands[0]!.rows.length === 3 && bands[0]!.rows.some((r) => r.line.amount === 11));
}

console.log("\n2. A single receipt over the limit on its own");
{
  const bands = bandsFor([row("Erika", "2026-09-21", 77)], RULE);
  // Deliberately NOT a special case. One shape to learn, and a band of one
  // still says what was judged: Erika, that day, $77.
  check("gets the same band, not a bare row", bands.length === 1 && bands[0]!.rows.length === 1);
  check("…with its own total", bands[0]!.total === 77);
}

console.log("\n3. What must never be pooled");
{
  const twoPeople = bandsFor(
    [row("Brad", "2026-09-21", 50), row("Erika", "2026-09-21", 50)], RULE);
  check("two people on the same day are two bands", twoPeople.length === 2,
    `${twoPeople.length}`);
  check("…and neither total is the other's $100",
    twoPeople.every((b) => b.total === 50), twoPeople.map((b) => b.total).join("/"));

  const twoDays = bandsFor(
    [row("Brad", "2026-09-21", 50), row("Brad", "2026-09-22", 50)], RULE);
  check("one person across two dates is two bands", twoDays.length === 2);
}

console.log("\n4. Rows the rule caught but could not place");
{
  // An expense with no date cannot belong to a day. Dropping it would hide
  // work from the reviewer, which is worse than showing it unbanded.
  const bands = bandsFor(
    [row("Brad", "2026-09-21", 40), row("Brad", "2026-09-21", 45),
     row("Nobody", "", 20, false)], RULE);
  check("the undatable one is kept, not dropped",
    bands.flatMap((b) => b.rows).length === 3);
  check("…in a band of its own rather than in somebody's day",
    bands.find((b) => b.employee === "Brad")!.rows.length === 2);
}

console.log("\n5. A rule that is NOT a day rule");
{
  const plain = { ...row("Brad", "2026-09-21", 40), dayGroups: [] };
  const bands = bandsFor([plain, { ...row("Brad", "2026-09-21", 45), dayGroups: [] }], "Gas Category");
  check("everything lands unbanded, so the flat list is untouched",
    bands.length === 1 && bands[0]!.key === "\u0000loose", `${bands.length} band(s)`);
}

console.log("\n6. What the server marks, against a real database");
if (!process.env.DATABASE_URL) {
  console.log("  DATABASE_URL not set — skipping the stored half.");
} else {
  const { db, ensureSchema } = await import("../server/db.js");
  const store = await import("../server/rules/store.js");
  const { runRules } = await import("../server/rules/run.js");
  await ensureSchema();
  await store.ensureRules();

  const TAG = `zz-day-${Date.now()}`;
  const keys: string[] = [];
  const add = async (n: number, day: string, cents: number, category = "Meals") => {
    const key = `${TAG}-${n}`;
    keys.push(key);
    await db().query(
      `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                             category, department, location, note, method, in_inbox)
       VALUES ($1,$2,$3,$4,$5,$6,'Ops','Richland','lunch','Corporate card',true)`,
      [key, `${TAG} Person`, day, `${TAG} Merchant`, cents, category]);
    return key;
  };

  try {
    const day = await store.saveRule({
      name: `${TAG} day limit`, enabled: true, match: "all",
      when: [{ field: "category", op: "is", value: "Meals" }],
      must: { field: "dayTotal", op: "lte", value: "$75.00" },
      action: "flag", message: "",
    }, "tester@example.invalid");
    check("a day rule saves with a dollar sign in it", day.ok, day.ok ? "" : day.error);

    const plain = await store.saveRule({
      name: `${TAG} per expense`, enabled: true, match: "all",
      when: [{ field: "category", op: "is", value: "Meals" }],
      must: { field: "amount", op: "lte", value: "100" },
      action: "flag", message: "",
    }, "tester@example.invalid");
    check("and so does a per-expense one", plain.ok, plain.ok ? "" : plain.error);

    // One over-limit day, one under, plus a big single meal so the
    // per-expense rule has something of its own to catch.
    await add(1, "2026-09-21", 1100);
    await add(2, "2026-09-21", 3400);
    await add(3, "2026-09-21", 4500);
    await add(4, "2026-09-22", 2000);
    await add(5, "2026-09-23", 12000);

    await runRules({ keys, decide: false });
    const hits = await store.hitsFor(keys);
    const ours = (name: string) =>
      [...hits.entries()].flatMap(([k, hs]) =>
        hs.filter((h) => h.ruleName === name).map((h) => ({ key: k, hit: h })));

    const dayHits = ours(`${TAG} day limit`);
    // Three from the $90 day, plus the $120 meal — which is its own day, and
    // over the limit on its own. A day of one is still a day.
    check("the day rule caught the whole $90 day",
      dayHits.filter((h) => !h.key.endsWith("-5")).length === 3,
      `${dayHits.length} hit(s) in all`);
    check("…and every one is marked as judging a day",
      dayHits.every((h) => h.hit.dayGroup === true));
    check("…while the $20 day is left alone",
      !dayHits.some((h) => h.key.endsWith("-4")));

    const plainHits = ours(`${TAG} per expense`);
    check("the per-expense rule caught the $120 meal", plainHits.length === 1,
      `${plainHits.length} hit(s)`);
    // The distinction the whole feature rests on. Marking a per-expense rule
    // as a day rule would band unrelated receipts together and claim a total
    // nobody was judged against.
    check("…and is NOT marked as a day rule",
      plainHits.every((h) => h.hit.dayGroup === false));
  } finally {
    await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
    await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${TAG}%`]);
    await db().end();
  }
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
