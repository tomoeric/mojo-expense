/**
 * The same bill attached twice must not read as double the bill.
 *
 *   pnpm exec tsx scripts/test-same-bill-twice.ts     (needs DATABASE_URL)
 *
 * A FedEx charge of $14.18 with a $14.18 receipt sat in the flagged bucket
 * under "Amounts Off", while the drawer beside it showed the two figures
 * matching with a green tick. Both were reporting honestly: the expense
 * carried the bill twice — the importer splits a multi-page PDF into a page
 * each, and the second page repeats the total — the drawer showed the first
 * receipt, and the rule engine had ADDED the two up and compared $28.36
 * against $14.18.
 *
 * Two things are pinned here. Duplicate receipts count once, so the rule
 * sees the bill and not twice the bill. And a rule with no expectation says
 * what it actually found, so the next flag that looks wrong can be read
 * rather than guessed at.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const store = await import("../server/rules/store.js");
const { runRules } = await import("../server/rules/run.js");
const { ensureReceiptItems } = await import("../server/emburse/receipt-items.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
await store.ensureRules();
await ensureReceiptItems();

const TAG = `zz-dup-${Date.now()}`;
const TWICE = `${TAG}-twice`;   // one bill, two pages, both read $14.18
const SPLIT = `${TAG}-split`;   // two genuinely different receipts
const ONCE  = `${TAG}-once`;    // the ordinary case, one receipt
const OFF   = `${TAG}-off`;     // a real mismatch, which must still be caught

const clean = async () => {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${TAG}%`]);
};
await clean();

const addExpense = (key: string, cents: number) =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-24','FEDEX',$3,'Shipping','Ops','Site','x','Corporate card',true)`,
    [key, `${TAG} Person`, cents]);

/** Attach a read receipt to an expense, with the total the reader got. */
async function addReceipt(key: string, sha: string, cents: number): Promise<void> {
  await db().query(
    `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
     VALUES ($1,'image/jpeg',1,'\\x00'::bytea) ON CONFLICT DO NOTHING`, [sha]);
  await db().query(
    "INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [key, sha]);
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, legible, total_cents, itemised)
     VALUES ($1,'test',true,$2,true)
     ON CONFLICT (sha256) DO UPDATE SET total_cents = EXCLUDED.total_cents`,
    [sha, cents]);
}

const totalFor = async (key: string): Promise<number | null> => {
  const [s] = await store.subjects(db(), [key]);
  return s?.receiptTotalCents ?? null;
};

try {
  await addExpense(TWICE, 1418);
  await addReceipt(TWICE, `${TAG}-a`, 1418);
  await addReceipt(TWICE, `${TAG}-b`, 1418);   // page two, same total

  await addExpense(SPLIT, 4200);
  await addReceipt(SPLIT, `${TAG}-c`, 3000);
  await addReceipt(SPLIT, `${TAG}-d`, 1200);

  await addExpense(ONCE, 1418);
  await addReceipt(ONCE, `${TAG}-e`, 1418);

  await addExpense(OFF, 1000);
  await addReceipt(OFF, `${TAG}-f`, 2500);

  console.log("\n1. What the rules see as the receipt total");
  check("the same bill twice counts once", await totalFor(TWICE) === 1418,
    `${await totalFor(TWICE)}`);
  check("…two different receipts still add up", await totalFor(SPLIT) === 4200,
    `${await totalFor(SPLIT)}`);
  check("…and a mismatch is left alone", await totalFor(OFF) === 2500);
  check("…and one receipt is itself", await totalFor(ONCE) === 1418);

  console.log("\n2. The rule the user wrote: no expectation, just a WHEN");
  const saved = await store.saveRule({
    name: `${TAG} Amounts Off`, enabled: true, match: "all",
    when: [{ field: "receiptTotal", op: "is_not", value: "", compare: "amount" }],
    must: null, action: "flag", message: "",
  }, "tester@example.invalid");
  if (!saved.ok) throw new Error(saved.error);

  await runRules({ keys: [TWICE, SPLIT, ONCE, OFF], decide: false });
  const hits = await store.hitsFor([TWICE, SPLIT, ONCE, OFF]);
  check("the doubled one is no longer flagged", !hits.has(TWICE),
    hits.get(TWICE)?.[0]?.detail ?? "");
  check("…nor the plain one", !hits.has(ONCE));
  check("…nor the split bill that adds up", !hits.has(SPLIT),
    hits.get(SPLIT)?.[0]?.detail ?? "");
  check("…and a real mismatch still is", hits.has(OFF));

  console.log("\n3. A flag with no expectation shows its arithmetic");
  // `Matches “Amounts Off”.` is what it used to say, on both figures being
  // $14.18 on screen. Unreadable, and it cost a day.
  const detail = hits.get(OFF)?.[0]?.detail ?? "";
  check("it names both figures", detail.includes("$25.00") && detail.includes("$10.00"),
    detail);
  check("…and does not just name itself", !/^Matches /.test(detail), detail);

  console.log("\n4. A stale flag goes away once the totals agree");
  // The doubled expense is the case that mattered: it WAS flagged, under the
  // old arithmetic, and a flag that cannot clear itself is a flag nobody can
  // act on.
  await db().query(
    `INSERT INTO expense_rule_hits (dedupe_key, rule_id, verdict, detail)
     VALUES ($1,$2,'fail','left over from before')
     ON CONFLICT (dedupe_key, rule_id) DO UPDATE SET verdict = 'fail'`,
    [TWICE, saved.rule.id]);
  check("the stale flag is there to start with", (await store.hitsFor([TWICE])).has(TWICE));
  await runRules({ keys: [TWICE], decide: false });
  check("…and one run clears it", !(await store.hitsFor([TWICE])).has(TWICE));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
