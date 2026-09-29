/**
 * Reading a receipt has to re-judge the expense it belongs to.
 *
 *   pnpm exec tsx scripts/test-reread-rules.ts     (needs DATABASE_URL)
 *
 * Rule verdicts are STORED, computed when the rules last ran. A rule about
 * a receipt returns UNKNOWN while the receipt is unread and records no hit,
 * so reading the receipt afterwards changes nothing on its own: the flag
 * from before stays, and the flag that should now exist never appears.
 *
 * Two faults came out of that, and the second is the serious one:
 *
 *   - "amounts match but they are stuck in the flag bucket" — a corrected
 *     receipt total leaving its old flag behind.
 *   - automatic approval's central promise quietly untrue. It refuses to
 *     approve until every enabled rule has run since the expense arrived,
 *     but `last_run_at` is per RULE, so a rule that ran at import time
 *     counts as run for a receipt read hours later — and the expense is
 *     approved without its receipt rules ever having been applied to it.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const store = await import("../server/rules/store.js");
const { runRules } = await import("../server/rules/run.js");
const { expensesForReceipts, ensureReceiptItems } = await import("../server/emburse/receipt-items.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
await store.ensureRules();
await ensureReceiptItems();

const TAG = `zz-rr-${Date.now()}`;
const KEY = `${TAG}-1`;
const SHA = "c".repeat(64);

const clean = async () => {
  await db().query("DELETE FROM expense_receipts WHERE sha256 = $1", [SHA]);
  await db().query("DELETE FROM receipt_readings WHERE sha256 = $1", [SHA]);
  await db().query("DELETE FROM receipt_blobs WHERE sha256 = $1", [SHA]);
  await db().query("DELETE FROM expenses WHERE dedupe_key = $1", [KEY]);
  await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${TAG}%`]);
};
await clean();

const flagged = async (): Promise<boolean> => {
  const { rows } = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM expense_rule_hits h
       JOIN expense_rules r ON r.id = h.rule_id AND r.enabled
      WHERE h.dedupe_key = $1 AND h.verdict = 'fail'`, [KEY]);
  return Number(rows[0]!.n) > 0;
};
const setTotal = (cents: number | null) =>
  db().query(
    `INSERT INTO receipt_readings (sha256, model, legible, subtotal_cents, tax_cents, total_cents)
     VALUES ($1,'test',true,null,null,$2)
     ON CONFLICT (sha256) DO UPDATE SET total_cents = EXCLUDED.total_cents, error = NULL`,
    [SHA, cents]);

try {
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-25','TEXAS ROADHOUSE',4589,'Meals','Ops','Site','x','Corporate card',true)`,
    [KEY, `${TAG} Person`]);
  await db().query(
    `INSERT INTO receipt_blobs (sha256, bytes, content_type, byte_size)
     VALUES ($1,'\\x00'::bytea,'image/png',1) ON CONFLICT DO NOTHING`, [SHA]);
  await db().query("INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2)", [KEY, SHA]);

  const saved = await store.saveRule({
    name: `${TAG} amounts off`, enabled: true, match: "all",
    when: [{ field: "receiptTotal", op: "is_not", compare: "amount", value: "" }],
    must: null, action: "flag", message: "The receipt total and the charge disagree.",
  }, "tester@example.invalid");
  if (!saved.ok) throw new Error(saved.error);

  console.log("\n1. The receipt image knows which expenses it belongs to");
  check("the expense is found from the image", (await expensesForReceipts([SHA])).includes(KEY));
  check("…and an image nobody attached finds nothing",
    (await expensesForReceipts(["d".repeat(64)])).length === 0);

  console.log("\n2. A wrong total flags it");
  await setTotal(3824);
  await runRules({ keys: [KEY], decide: false });
  check("38.24 against a 45.89 charge is flagged", await flagged());

  console.log("\n3. Correcting the reading is not enough on its own");
  await setTotal(4589);
  check("the stored flag is still there, because verdicts are stored",
    await flagged(), "this is the bug, not the fix");

  console.log("\n4. Re-judging the expense is what clears it");
  await runRules({ keys: [KEY], decide: false });
  check("the flag is gone once the rules see the corrected total", !(await flagged()));

  console.log("\n5. And it works the other way, which is the dangerous one");
  // Unread receipt: the rule returns UNKNOWN and records no hit, so the
  // expense looks clean — which is precisely when automatic approval is
  // willing to approve it.
  await db().query("DELETE FROM receipt_readings WHERE sha256 = $1", [SHA]);
  await runRules({ keys: [KEY], decide: false });
  check("an unread receipt leaves the expense unflagged", !(await flagged()));
  await setTotal(3824);
  check("…and reading it does not flag it by itself", !(await flagged()));
  await runRules({ keys: [KEY], decide: false });
  check("…until the expense is judged again", await flagged());
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
