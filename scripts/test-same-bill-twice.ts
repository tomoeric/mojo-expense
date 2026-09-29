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
const { chosenReceiptTotal } = await import("../server/rules/engine.js");
const { receiptTotalOf } = await import("../src/lib/receipt-verdict.js");

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
const TRIPLE = `${TAG}-triple`; // the Menards case: the same bill three times
const PENNY  = `${TAG}-penny`;  // copies that did not read to the exact cent

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

  // Three receipts, each the whole $312.44 charge. Summed, this read as
  // $937.32 and flagged three identical expenses apiece.
  await addExpense(TRIPLE, 31244);
  await addReceipt(TRIPLE, `${TAG}-g`, 31244);
  await addReceipt(TRIPLE, `${TAG}-h`, 31244);
  await addReceipt(TRIPLE, `${TAG}-i`, 31244);

  // The same, except the scan of page two came back a penny out. Dropping
  // exact duplicates does nothing here, which is why that was not the fix.
  await addExpense(PENNY, 31244);
  await addReceipt(PENNY, `${TAG}-j`, 31244);
  await addReceipt(PENNY, `${TAG}-k`, 31243);

  console.log("\n1. What the rules see as the receipt total");
  check("the same bill twice counts once", await totalFor(TWICE) === 1418,
    `${await totalFor(TWICE)}`);
  check("…two different receipts still add up", await totalFor(SPLIT) === 4200,
    `${await totalFor(SPLIT)}`);
  check("…and a mismatch is left alone", await totalFor(OFF) === 2500);
  check("the same bill three times counts once", await totalFor(TRIPLE) === 31244,
    `${await totalFor(TRIPLE)}`);
  check("…even when the copies read a penny apart", await totalFor(PENNY) === 31244,
    `${await totalFor(PENNY)}`);
  check("…and one receipt is itself", await totalFor(ONCE) === 1418);

  console.log("\n2. The rule the user wrote: no expectation, just a WHEN");
  const saved = await store.saveRule({
    name: `${TAG} Amounts Off`, enabled: true, match: "all",
    when: [{ field: "receiptTotal", op: "is_not", value: "", compare: "amount" }],
    must: null, action: "flag", message: "",
  }, "tester@example.invalid");
  if (!saved.ok) throw new Error(saved.error);

  const all = [TWICE, SPLIT, ONCE, OFF, TRIPLE, PENNY];
  await runRules({ keys: all, decide: false });
  const hits = await store.hitsFor(all);
  check("the doubled one is no longer flagged", !hits.has(TWICE),
    hits.get(TWICE)?.[0]?.detail ?? "");
  check("…nor the plain one", !hits.has(ONCE));
  check("…nor the split bill that adds up", !hits.has(SPLIT),
    hits.get(SPLIT)?.[0]?.detail ?? "");
  check("…nor the Menards triple", !hits.has(TRIPLE), hits.get(TRIPLE)?.[0]?.detail ?? "");
  check("…nor the penny-apart pair", !hits.has(PENNY), hits.get(PENNY)?.[0]?.detail ?? "");
  check("…and a real mismatch still is", hits.has(OFF));

  console.log("\n3. A flag with no expectation shows its arithmetic");
  // `Matches “Amounts Off”.` is what it used to say, on both figures being
  // $14.18 on screen. Unreadable, and it cost a day.
  const detail = hits.get(OFF)?.[0]?.detail ?? "";
  check("it names both figures", detail.includes("$25.00") && detail.includes("$10.00"),
    detail);
  check("…and does not just name itself", !/^Matches /.test(detail), detail);

  console.log("\n3b. …and says which receipts it added up");
  // $937.32 on a $312.44 charge could not be argued with, because nothing
  // said where it came from. A flag over several receipts now lists them.
  await addExpense(`${TAG}-many`, 19793);
  await addReceipt(`${TAG}-many`, `${TAG}-m`, 6698);
  await addReceipt(`${TAG}-many`, `${TAG}-n`, 3000);
  await runRules({ keys: [`${TAG}-many`], decide: false });
  const many = (await store.hitsFor([`${TAG}-many`])).get(`${TAG}-many`)?.[0]?.detail ?? "";
  check("no single receipt covers it, so they are summed", many.includes("$96.98"), many);
  check("…and both receipts are named", many.includes("$66.98") && many.includes("$30.00"), many);
  check("…and it says how many there are", many.includes("carries 2 receipts"), many);

  console.log("\n3c. The screen and the rules answer with the same number");
  // They did not, and that is the whole complaint: a green tick reading
  // Match beside a flag reading Amounts Off, on one row, at one moment.
  const cases: { claim: number; totals: number[] }[] = [
    { claim: 31244, totals: [31244, 31244, 31244] },
    { claim: 31244, totals: [31244, 31243] },
    { claim: 1418,  totals: [1418, 1418] },
    { claim: 4200,  totals: [3000, 1200] },
    { claim: 19793, totals: [6698, 3000] },
    { claim: 1000,  totals: [2500] },
    { claim: 1000,  totals: [] },
  ];
  const disagreed = cases.filter(({ claim, totals }) => {
    const server = chosenReceiptTotal(claim, totals);
    const client = receiptTotalOf(
      totals.map((c) => ({ total: c / 100, error: null })), claim / 100);
    return (server === null ? null : server / 100) !== client;
  });
  check("every case agrees", disagreed.length === 0, JSON.stringify(disagreed));

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
