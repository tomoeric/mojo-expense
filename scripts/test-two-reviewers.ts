/**
 * Two reviewers, two queues, and the purge that would have destroyed both.
 *
 * "Needs review is based on the user Emburse account. Therefore Brian's
 * tickets will be different than mine." Correct, and it makes the import's
 * central statement wrong. The purge reads "delete every expense this
 * export no longer carries", which is right while one account's Needs
 * Review is the whole world — and catastrophic the moment there are two.
 * Each reviewer's hourly import would delete the other's entire queue,
 * taking the receipts, the rule hits and the change history with it, and
 * the app would flip between two sets of expenses all day.
 *
 * This is the test that had to exist before a second credential did.
 *
 * Needs DATABASE_URL. Cleans up after itself.
 */

import pg from "pg";
import { db, ensureSchema } from "../server/db.js";
import { purgeFinished } from "../server/import/ingest.js";

const ERIC = "eric.s@test.invalid";
const BRIAN = "brian.c@test.invalid";
const TAG = `zz-two-${Date.now()}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const key = (who: string, n: number) => `${TAG}-${who}-${n}`;

const add = (k: string, reviewer: string) =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox, reviewer)
     VALUES ($1,'Someone','2026-09-24','MERCHANT',1000,'Meals','Ops','Site','','Card',true,$2)`,
    [k, reviewer]);

const live = async (reviewer: string): Promise<string[]> => {
  const { rows } = await db().query<{ dedupe_key: string }>(
    "SELECT dedupe_key FROM expenses WHERE reviewer = $1 ORDER BY dedupe_key", [reviewer]);
  return rows.map((r) => r.dedupe_key);
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
};

await ensureSchema();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  await clean();
  // Eric has three waiting, Brian has two. Different expenses: that is the
  // whole point — Emburse's Needs Review is per account.
  for (const n of [1, 2, 3]) await add(key("eric", n), ERIC);
  for (const n of [1, 2]) await add(key("brian", n), BRIAN);
  // And one from a file somebody uploaded by hand, which belongs to nobody.
  await add(key("hand", 1), "");

  console.log("\nEric's import carries two of his three");
  {
    const freed = await purgeFinished(client, [key("eric", 1), key("eric", 2)], ERIC);
    check("it takes the one he no longer has", freed.expenses === 1, String(freed.expenses));
    check("…leaving his other two", (await live(ERIC)).length === 2);
    // The line this test exists for.
    check("…and does not touch Brian's", (await live(BRIAN)).length === 2);
    check("…nor the hand-uploaded one", (await live("")).length === 1);
  }

  console.log("\nBrian's import carries neither of his");
  // The worst case: his export comes back empty-handed. Under the old rule
  // this single statement emptied the entire table.
  {
    const freed = await purgeFinished(client, [], BRIAN);
    check("both of his go", freed.expenses === 2, String(freed.expenses));
    check("…and Eric's two are still there", (await live(ERIC)).length === 2);
    check("…and so is the hand-uploaded one", (await live("")).length === 1);
  }

  console.log("\nA hand upload cannot take a scheduled reviewer's queue");
  // Somebody drags in a PDF with one row. It must not be able to delete
  // what the scheduled imports brought.
  {
    await purgeFinished(client, [], "");
    check("the hand-uploaded row goes", (await live("")).length === 0);
    check("…and Eric's queue is untouched", (await live(ERIC)).length === 2);
  }
} finally {
  await clean();
  client.release();
  await pool.end();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
