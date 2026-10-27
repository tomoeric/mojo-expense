/**
 * One person, two Emburse accounts, two queues that cannot take
 * each other's expenses.
 *
 *   pnpm exec tsx scripts/test-two-accounts.ts
 *
 * The argument is the one the reviewer column settled for two
 * people and the source column settled for two lists, a third time:
 * Needs Review is per ACCOUNT, so Eric's MOJO list and his Mammoth
 * list are as separate as Eric's and Brian's. Three things follow,
 * and all three fail silently if they are wrong:
 *
 *   THE SAME PURCHASE IN BOTH ACCOUNTS IS TWO EXPENSES. Merchant,
 *   date, amount, category, location and department are identical;
 *   only the account differs. Collapsed into one row, one of them
 *   is lost and never reaches a queue — the same loss the duplicate
 *   pair suffered before `occurrence` existed.
 *
 *   ONE ACCOUNT'S IMPORT MUST NOT PURGE THE OTHER'S QUEUE. "Delete
 *   everything this export no longer carries" is a statement about
 *   ONE Needs Review list.
 *
 *   NOTHING ALREADY IN THE TABLE MAY BE RE-IDENTIFIED. The lane is
 *   part of the dedupe key, and the manager queue's lane is the
 *   EMPTY string — so every key that exists today still hashes to
 *   what it hashed to. A changed key is a new expense with no
 *   decision history, for every row at once.
 */
import pg from "pg";
import { db, ensureSchema } from "../server/db.js";
import { purgeFinished } from "../server/import/ingest.js";
import { dedupeKey } from "../server/import/key.js";
import { ensureDecisionsSchema } from "../server/emburse/decisions.js";
import { ensureReceiptItems } from "../server/emburse/receipt-items.js";
import { MANAGER_LANE, laneTag } from "../server/emburse/connections.js";
import { queueDecision } from "../server/emburse/decisions.js";

const ERIC = "eric.s@test.invalid";
const MOJO = "personal-mojo";
const MAMMOTH = "personal-mammoth";
const TAG = `zz-acct-${Date.now()}`;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const key = (who: string, n: number) => `${TAG}-${who}-${n}`;

const add = (k: string, reviewer: string, lane = "") =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox,
                           reviewer, source, lane)
     VALUES ($1,'Someone','2026-09-24','MERCHANT',1000,'Meals','Ops','Site','','Card',true,
             $2,'',$3)`,
    [k, reviewer, lane]);

const live = async (reviewer: string, lane = ""): Promise<string[]> => {
  const { rows } = await db().query<{ dedupe_key: string }>(
    `SELECT dedupe_key FROM expenses
      WHERE reviewer = $1 AND source = '' AND lane = $2 ORDER BY dedupe_key`,
    [reviewer, lane]);
  return rows.map((r) => r.dedupe_key);
};

/*
 * By reviewer as well as by tag. Section 2 inserts rows under real
 * dedupe HASHES rather than readable keys, and a clean that only
 * matched the tag left them behind — where the next section's
 * purge quite correctly deleted them and the test blamed the code.
 */
const clean = () => db().query(
  "DELETE FROM expenses WHERE dedupe_key LIKE $1 OR reviewer = $2", [`${TAG}%`, ERIC]);

await ensureSchema();
await ensureDecisionsSchema();
await ensureReceiptItems();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  console.log("1. The manager queue's lane is the empty string");
  /*
   * The thing that must not move. Every expense and every run in
   * the database has an empty lane; the lane is part of the key;
   * a key that changes is a new expense with no history.
   */
  check("the manager lane tags as empty", laneTag(MANAGER_LANE) === "");
  check("…and so does nothing at all", laneTag("") === "" && laneTag(undefined) === "");
  check("a personal lane keeps its own name", laneTag(MOJO) === MOJO);

  const e = {
    employee: "Someone", date: "2026-09-24", merchant: "MERCHANT", amountCents: 1000,
    category: "Meals", location: "Site", department: "Ops",
  };
  check("AN EXISTING KEY IS UNCHANGED BY THE NEW ARGUMENT",
    dedupeKey(e) === dedupeKey(e, 0, ""), `${dedupeKey(e)} / ${dedupeKey(e, 0, "")}`);
  check("…and by the manager lane going through laneTag",
    dedupeKey(e) === dedupeKey(e, 0, laneTag(MANAGER_LANE)));

  console.log("\n2. The same purchase in two accounts is two expenses");
  const inMojo = dedupeKey(e, 0, MOJO);
  const inMammoth = dedupeKey(e, 0, MAMMOTH);
  check("the two keys differ", inMojo !== inMammoth, `${inMojo} / ${inMammoth}`);
  check("…and neither is the manager one",
    inMojo !== dedupeKey(e) && inMammoth !== dedupeKey(e));
  check("…while each is stable across imports",
    inMojo === dedupeKey(e, 0, MOJO) && inMammoth === dedupeKey(e, 0, MAMMOTH));
  // Identical rows in two accounts really do both land.
  await clean();
  await add(inMojo, ERIC, MOJO);
  await add(inMammoth, ERIC, MAMMOTH);
  const both = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM expenses WHERE dedupe_key = ANY($1::text[])",
    [[inMojo, inMammoth]]);
  check("BOTH SURVIVE in the table", Number(both.rows[0]?.n) === 2, both.rows[0]?.n);

  console.log("\n3. One account's import cannot purge the other's queue");
  await clean();
  for (const n of [1, 2, 3]) await add(key("mojo", n), ERIC, MOJO);
  for (const n of [1, 2]) await add(key("mam", n), ERIC, MAMMOTH);
  for (const n of [1, 2]) await add(key("mgr", n), ERIC, "");

  {
    const freed = await purgeFinished(
      client, [key("mojo", 1), key("mojo", 2)], ERIC, "", MOJO);
    check("the MOJO expense it no longer carries goes", freed.expenses === 1,
      String(freed.expenses));
    check("…leaving its other two", (await live(ERIC, MOJO)).length === 2);
    check("…AND NOT TOUCHING THE MAMMOTH QUEUE", (await live(ERIC, MAMMOTH)).length === 2);
    check("…nor the manager queue", (await live(ERIC, "")).length === 2);
  }

  console.log("\n4. The worst case: one account's export comes back empty");
  {
    const freed = await purgeFinished(client, [], ERIC, "", MAMMOTH);
    check("both Mammoth rows go", freed.expenses === 2, String(freed.expenses));
    check("…and the MOJO queue is still there", (await live(ERIC, MOJO)).length === 2);
    check("…and so is the manager queue", (await live(ERIC, "")).length === 2);
  }

  console.log("\n5. And the manager queue cannot take a personal one");
  {
    const freed = await purgeFinished(client, [], ERIC, "", "");
    check("the manager rows go", freed.expenses === 2, String(freed.expenses));
    check("…AND THE PERSONAL QUEUE IS UNTOUCHED", (await live(ERIC, MOJO)).length === 2);
  }

  console.log("\n6. A queue read shows one account and no other");
  await clean();
  await add(key("mojo", 1), ERIC, MOJO);
  await add(key("mam", 1), ERIC, MAMMOTH);
  await add(key("mgr", 1), ERIC, "");
  const shown = async (lane: string | null): Promise<number> => {
    const { rows } = await db().query<{ n: string }>(
      `SELECT count(*) AS n FROM expenses
        WHERE dedupe_key LIKE $1 AND ($2::text IS NULL OR lane = $2)`,
      [`${TAG}%`, lane]);
    return Number(rows[0]?.n ?? 0);
  };
  check("the manager queue shows only its own", await shown("") === 1);
  check("the MOJO queue shows only its own", await shown(MOJO) === 1);
  check("the Mammoth queue shows only its own", await shown(MAMMOTH) === 1);
  check("asking for everything shows all three", await shown(null) === 3);

  console.log("\n7. A write never lands in the wrong tenant");
  /*
   * Two ways an edit reaches Emburse: an approval, and a category
   * correction. Both sign in and work ONE account's list. An
   * expense in a personal tenant is simply not in the primary
   * connection's Needs Review — so the attempt would either fail
   * after a minute of browsing with an error that reads like
   * broken selectors, or, on a tenant where the same merchant
   * and amount recur, find a DIFFERENT expense and action that
   * one. The second is the reason this is refused rather than
   * merely likely to fail.
   */
  await clean();
  await add(key("mgr", 1), ERIC, "");
  await add(key("mojo", 1), ERIC, MOJO);

  const onManager = await queueDecision({
    dedupeKey: key("mgr", 1), decision: "approve", reason: "fine",
    decidedBy: ERIC,
    target: { employee: "Someone", merchant: "MERCHANT", amount: 10, date: "2026-09-24" },
  });
  check("a manager-queue expense can still be decided", onManager.ok === true,
    onManager.ok ? "" : onManager.error);

  const onPersonal = await queueDecision({
    dedupeKey: key("mojo", 1), decision: "approve", reason: "fine",
    decidedBy: ERIC,
    target: { employee: "Someone", merchant: "MERCHANT", amount: 10, date: "2026-09-24" },
  });
  check("A PERSONAL EXPENSE CANNOT BE DECIDED FROM HERE", onPersonal.ok === false,
    onPersonal.ok ? "it was queued" : "");
  check("…and the reason says which tenant it is in",
    !onPersonal.ok && onPersonal.error.includes("personal Emburse account"),
    onPersonal.ok ? "" : onPersonal.error);
  check("…and says what to do instead",
    !onPersonal.ok && onPersonal.error.includes("Submit it in Emburse"),
    onPersonal.ok ? "" : onPersonal.error);

  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE $1", [`${TAG}%`]);

} finally {
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE $1", [`${TAG}%`])
    .catch(() => undefined);
  await clean().catch(() => undefined);
  client.release();
  await pool.end();
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
