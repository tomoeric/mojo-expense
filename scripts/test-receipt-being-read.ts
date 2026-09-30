/**
 * "Receipt being read" is its own state, and the queue can now say so.
 *
 *   pnpm exec tsx scripts/test-receipt-being-read.ts     (needs DATABASE_URL)
 *
 * A newly imported expense whose receipt has not been read yet is neither
 * flagged nor cleared — every rule about what the receipt says returns
 * UNKNOWN until the reader has been. The queue showed it as an ordinary
 * Unflagged row, which reads as "nothing wrong with this one" when the
 * truth is "nobody has looked yet", and an approval could go out on that
 * reading.
 *
 * Three things are pinned here. A receipt awaiting its first read marks
 * the expense. A receipt already read does not, however many times the
 * reader is later improved — otherwise every READER_VERSION bump would
 * drop the whole queue into the waiting bucket. And a receipt the reader
 * has given up on does not either: three failed attempts is finished and
 * unreadable, not in progress, and parking those in a waiting bucket for
 * ever is how a status stops meaning anything.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const { ensureReceiptItems } = await import("../server/emburse/receipt-items.js");
const { NeonProvider } = await import("../server/emburse/neon.js");
const { runRules } = await import("../server/rules/run.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
await ensureReceiptItems();

const TAG = `zz-rbr-${Date.now()}`;
const WAITING = `${TAG}-waiting`;   // a receipt, never read
const READ    = `${TAG}-read`;      // a receipt, read successfully
const GAVEUP  = `${TAG}-gaveup`;    // a receipt the reader gave up on
const TRYING  = `${TAG}-trying`;    // failed once, retries left
const NONE    = `${TAG}-none`;      // no receipt at all

const clean = async () => {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`]);
};
await clean();

const addExpense = (key: string) =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-25','DOLLARTREE 8508',700,'Office Supplies','Operations',
             'Site','Dolly day decor','Corporate card',true)`,
    [key, `${TAG} Person`]);

async function attach(key: string, sha: string): Promise<void> {
  await db().query(
    `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
     VALUES ($1,'image/jpeg',1,'\\x00'::bytea) ON CONFLICT DO NOTHING`, [sha]);
  await db().query(
    "INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [key, sha]);
}

const reading = (sha: string, over: { error?: string; attempts?: number; version?: number }) =>
  db().query(
    `INSERT INTO receipt_readings (sha256, model, legible, total_cents, error, attempts, reader_version)
     VALUES ($1,'test',true,700,$2,$3,$4)
     ON CONFLICT (sha256) DO UPDATE SET error = EXCLUDED.error, attempts = EXCLUDED.attempts`,
    [sha, over.error ?? null, over.attempts ?? 0, over.version ?? 1]);

const unreadFor = async (key: string): Promise<boolean | undefined> => {
  const { reports } = await new NeonProvider().fetchReports(
    { startDate: "2026-09-01", endDate: "2026-10-31" });
  for (const r of reports) {
    const line = r.lines.find((l) => l.id === key);
    if (line) return line.receiptUnread;
  }
  return undefined;
};

try {
  for (const k of [WAITING, READ, GAVEUP, TRYING, NONE]) await addExpense(k);
  await attach(WAITING, `${TAG}-a`);
  await attach(READ, `${TAG}-b`);
  await attach(GAVEUP, `${TAG}-c`);
  await attach(TRYING, `${TAG}-d`);

  await reading(`${TAG}-b`, {});
  await reading(`${TAG}-c`, { error: "the model was unreachable", attempts: 3 });
  await reading(`${TAG}-d`, { error: "a timeout", attempts: 1 });

  // Judged, so the "read but not yet judged" half of the test below is not
  // firing on everything. A real queue reaches this state on every rules
  // run, which the server does on boot and after every read batch.
  await runRules({ decide: false });

  console.log("\n1. Which expenses are waiting on a reader");
  check("a receipt nobody has read yet marks the expense", await unreadFor(WAITING) === true);
  check("…one already read does not", await unreadFor(READ) === false);
  check("…one still being retried does", await unreadFor(TRYING) === true);
  check("…one the reader gave up on does NOT — that is finished, not waiting",
    await unreadFor(GAVEUP) === false);
  check("…and an expense with no receipt at all is not waiting for one",
    await unreadFor(NONE) === false);

  console.log("\n2. Improving the reader does not empty the queue into the waiting tab");
  // READER_VERSION bumps re-queue everything already read, which is right
  // for the reader and would be catastrophic here: "Receipt being read"
  // would show the entire queue every time the prompt improved.
  await db().query(
    "UPDATE receipt_readings SET reader_version = 1 WHERE sha256 = $1", [`${TAG}-b`]);
  check("a receipt read by an older reader still counts as read",
    await unreadFor(READ) === false);

  console.log("\n3. Read is not enough — it has to have been JUDGED");
  // The window this closes: the reader works through a batch one receipt at
  // a time and re-runs the rules for the whole batch at the end, half a
  // minute later for twenty-five. An expense read early had a total and no
  // verdict, and showed as Unflagged — which is supposed to mean judged and
  // clean, and is the whole reason this state exists.
  await reading(`${TAG}-a`, {});
  check("reading it is not on its own enough to leave the bucket",
    await unreadFor(WAITING) === true);
  await runRules({ keys: [WAITING], decide: false });
  check("…and once the rules have judged it, it leaves",
    await unreadFor(WAITING) === false);
  check("…without disturbing the ones that were already settled",
    await unreadFor(READ) === false && await unreadFor(GAVEUP) === false);
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
