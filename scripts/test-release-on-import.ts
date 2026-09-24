/**
 * An import reclaims the receipts of everything that has left the queue.
 *
 *   pnpm exec tsx scripts/test-release-on-import.ts     (needs DATABASE_URL)
 *
 * The release used to fire only for expenses THIS APP had approved. Before
 * anybody was approving here that was none of them, so 300 images a day
 * accumulated for expenses long gone from the queue. The newest export is the
 * truth about what is under review; everything else is storage.
 *
 * What must not happen: an expense still in the inbox losing its picture. By
 * the time one leaves, the image can never be fetched again.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
const TAG = "rel-";
const clean = async () => {
  await db().query("DELETE FROM expense_receipts WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE $1", [`${TAG}%`]);
};
await clean();

/** Exactly the statements ingest runs, in the same order. */
async function release() {
  await db().query(
    `DELETE FROM expense_receipts er USING expenses e
      WHERE er.dedupe_key = e.dedupe_key AND e.in_inbox = false`);
  const { rows } = await db().query<{ bytes: string | null }>(
    `SELECT sum(byte_size) AS bytes FROM receipt_blobs b
      WHERE NOT EXISTS (SELECT 1 FROM expense_receipts er WHERE er.sha256 = b.sha256)
        AND b.sha256 LIKE $1`, [`${TAG}%`]);
  const gone = await db().query(
    `DELETE FROM receipt_blobs b
      WHERE NOT EXISTS (SELECT 1 FROM expense_receipts er WHERE er.sha256 = b.sha256)
        AND b.sha256 LIKE $1`, [`${TAG}%`]);
  return { images: gone.rowCount ?? 0, bytes: Number(rows[0]?.bytes ?? 0) };
}

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
  // What the reader took off the image, which must survive it.
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, total_cents) VALUES ($1,'test',1000)
     ON CONFLICT (sha256) DO NOTHING`, [sha]);
  return { key, sha };
};

try {
  // The shape of a real day: a handful still in the queue, hundreds long gone.
  const waiting = [await add(1, true), await add(2, true)];
  for (let i = 0; i < 20; i++) await add(i, false);

  const before = Number((await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`])).rows[0]!.n);
  check("22 receipts stored to begin with", before === 22, String(before));

  console.log("\nAn import runs");
  const freed = await release();
  check("the 20 that left the queue are released", freed.images === 20, String(freed.images));
  check("…and it reports the space reclaimed", freed.bytes === 20_000_000,
    `${(freed.bytes / 1e6).toFixed(1)} MB`);

  const left = Number((await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`])).rows[0]!.n);
  check("only the two still under review remain", left === 2, String(left));

  for (const w of waiting) {
    const linked = Number((await db().query<{ n: string }>(
      "SELECT count(*) AS n FROM expense_receipts WHERE dedupe_key = $1", [w.key])).rows[0]!.n);
    check(`${w.key} can still show its receipt`, linked === 1, String(linked));
  }

  // The megabytes are the image. What the receipt SAID is a few hundred bytes
  // and is the record of what was bought on an expense somebody approved.
  const readings = Number((await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM receipt_readings WHERE sha256 LIKE $1", [`${TAG}%`])).rows[0]!.n);
  check("what the receipts said outlives the pictures", readings === 22, String(readings));

  console.log("\nRunning it again");
  const twice = await release();
  check("a second import releases nothing more", twice.images === 0, String(twice.images));

  console.log("\nOne of the waiting two is finished");
  await db().query("UPDATE expenses SET in_inbox = false WHERE dedupe_key = $1", [waiting[0]!.key]);
  const after = await release();
  check("its receipt goes on the next import", after.images === 1, String(after.images));
  const stillThere = Number((await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM expense_receipts WHERE dedupe_key = $1", [waiting[1]!.key])).rows[0]!.n);
  check("…and the one still waiting is untouched", stillThere === 1, String(stillThere));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
