/**
 * An import deletes everything the newest export no longer carries.
 *
 *   pnpm exec tsx scripts/test-release-on-import.ts     (needs DATABASE_URL)
 *
 * Rows used to be kept forever behind an `in_inbox = false` flag, and within
 * a few weeks the app was showing 572 expenses against Emburse's 137. The
 * export IS the queue: an expense that has left it is not waiting on anybody
 * here, and its picture is megabytes nobody will look at again.
 *
 * Three things must hold, and the middle one is the dangerous one:
 *
 *   1. everything absent from the export goes — row, links, image, reading
 *   2. an expense still in the queue keeps its picture. Once one leaves, the
 *      image can never be fetched again, so this is the unrecoverable mistake
 *   3. the record of what this app decided OUTLIVES the expense. It is the
 *      only audit trail on this side of the wire.
 *
 * This drives the real `purgeFinished` rather than a copy of its statements —
 * a test that reimplements the SQL is how `compare` was silently dropped from
 * a rule once while every check stayed green.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const { purgeFinished } = await import("../server/import/ingest.js");
const { pendingDecisions } = await import("../server/emburse/decisions.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
// Creates expense_decisions if this database has never had it.
await pendingDecisions();

const TAG = "rel-";
const clean = async () => {
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE $1", [`${TAG}%`]);
};
await clean();

const count = async (sql: string, args: unknown[] = []) =>
  Number((await db().query<{ n: string }>(sql, args)).rows[0]!.n);

const add = async (n: number, inbox: boolean) => {
  const key = `${TAG}${inbox ? "in" : "out"}-${n}`;
  const sha = `${TAG}sha-${inbox ? "in" : "out"}-${n}`;
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents, in_inbox)
     VALUES ($1,'Test Person','2026-09-20','MERCHANT',1000,$2)`, [key, inbox]);
  await db().query(
    `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
     VALUES ($1,'image/jpeg',1000000,'\\x00') ON CONFLICT DO NOTHING`, [sha]);
  await db().query("INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2)", [key, sha]);
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, total_cents) VALUES ($1,'test',1000)
     ON CONFLICT (sha256) DO NOTHING`, [sha]);
  return { key, sha };
};

const decide = (key: string, state: "applied" | "pending") =>
  db().query(
    `INSERT INTO expense_decisions (dedupe_key, decision, decided_by, state, target)
     VALUES ($1,'approve','tester@example.invalid',$2,
             '{"employee":"Test Person","merchant":"MERCHANT","amount":10,"date":"2026-09-20"}'::jsonb)`,
    [key, state]);

/**
 * What the next export carries.
 *
 * Everything in the database except the keys this scenario says have left.
 * `purgeFinished` is deliberately global — the export is the whole queue, not
 * a slice of it — so a list holding only this test's rows would delete
 * whatever another suite left behind and make the counts unreadable.
 */
const live = async (gone: string[] = []) =>
  (await db().query<{ dedupe_key: string }>(
    "SELECT dedupe_key FROM expenses WHERE dedupe_key <> ALL($1::text[])", [gone]))
    .rows.map((r) => r.dedupe_key);

/** purgeFinished takes a client; the import always runs it inside its transaction. */
async function purge(keys: string[]) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const out = await purgeFinished(client, keys);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

try {
  // Sweep anything another suite orphaned, so the figures below count only
  // what this scenario produced.
  await purge(await live());

  // The shape of a real day: a handful still in the queue, dozens long gone.
  const waiting = [await add(1, true), await add(2, true)];
  const departed: string[] = [];
  for (let i = 0; i < 20; i++) departed.push((await add(i, false)).key);

  // One of the departed was approved here; one was still queued to be.
  await decide(`${TAG}out-0`, "applied");
  await decide(`${TAG}out-1`, "pending");

  check("22 receipts stored to begin with",
    (await count("SELECT count(*) AS n FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`])) === 22);

  console.log("\nAn import runs, and the 20 are no longer in it");
  const freed = await purge(await live(departed));
  check("the 20 that left the queue are deleted", freed.expenses === 20, String(freed.expenses));
  check("…and their pictures with them", freed.images === 20, String(freed.images));
  check("…and it reports the space reclaimed", freed.bytes === 20_000_000,
    `${(freed.bytes / 1e6).toFixed(1)} MB`);

  check("the rows really are gone, not flagged",
    (await count("SELECT count(*) AS n FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`])) === 2,
    "only the two waiting are left");
  check("only the two still under review keep an image",
    (await count("SELECT count(*) AS n FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`])) === 2);
  check("and nothing they said is left hanging",
    (await count("SELECT count(*) AS n FROM receipt_readings WHERE sha256 LIKE $1", [`${TAG}%`])) === 2);

  // The unrecoverable mistake. An expense still waiting must keep its picture.
  for (const w of waiting) {
    check(`${w.key} can still show its receipt`,
      (await count("SELECT count(*) AS n FROM expense_receipts WHERE dedupe_key = $1", [w.key])) === 1);
  }

  console.log("\nWhat this app decided outlives the expense");
  check("the applied approval is still on record",
    (await count(
      "SELECT count(*) AS n FROM expense_decisions WHERE dedupe_key = $1 AND state = 'applied'",
      [`${TAG}out-0`])) === 1);
  // It can never be applied now: an expense only falls out of the export once
  // it has left Emburse's queue. Leaving it pending would have the worker
  // retry it forever against a row that is not there.
  check("and the one still queued was closed out rather than retried forever",
    (await count(
      "SELECT count(*) AS n FROM expense_decisions WHERE dedupe_key = $1 AND state = 'cancelled'",
      [`${TAG}out-1`])) === 1);

  console.log("\nRunning it again");
  const twice = await purge(await live());
  check("a second import with the same export deletes nothing more",
    twice.expenses === 0 && twice.images === 0, `${twice.expenses}/${twice.images}`);

  console.log("\nOne of the waiting two is approved in Emburse, so tomorrow's export drops it");
  const after = await purge(await live([waiting[0]!.key]));
  check("it goes on the next import", after.expenses === 1, String(after.expenses));
  check("…and takes its picture", after.images === 1, String(after.images));
  check("…and the one still waiting is untouched",
    (await count("SELECT count(*) AS n FROM expense_receipts WHERE dedupe_key = $1",
      [waiting[1]!.key])) === 1);
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
