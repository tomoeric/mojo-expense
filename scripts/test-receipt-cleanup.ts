/**
 * Letting go of receipts once their expense has left the queue.
 *
 *   pnpm exec tsx scripts/test-receipt-cleanup.ts     (needs DATABASE_URL)
 *
 * The newest export is the truth about what is under review, so an image
 * belongs to the app only while its expense is still in the inbox. Approved,
 * denied, or decided directly in Emburse all end the same way.
 *
 * It used to release only what THIS APP had approved, which — before anybody
 * was approving here — was nothing, while 300 receipts a day accumulated.
 *
 * Two ways it could quietly destroy something, and both still hold:
 *
 *   - Deleting too early. An expense still in the inbox is still being
 *     reviewed, and by the time it leaves, the image can never be fetched
 *     again. Nothing in the queue may lose its picture.
 *   - Deleting a shared image. Receipts are stored once by content hash, so
 *     one purchase split across sites points several expenses at the same
 *     picture. Dropping it because one owner is finished blanks the others.
 */

import { db, ensureSchema } from "../server/db.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
const { pendingDecisions } = await import("../server/emburse/decisions.js");
await pendingDecisions(); // creates the decisions table

const clean = async () => {
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE 'rc-%'");
  await db().query("DELETE FROM expense_receipts WHERE dedupe_key LIKE 'rc-%'");
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'rc-%'");
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE 'rc-%'");
};
await clean();

/** The deletion exactly as ingest runs it, in the same order. */
async function sweep(): Promise<{ links: number; blobs: number }> {
  const links = await db().query(
    `DELETE FROM expense_receipts er
      USING expenses e
      WHERE er.dedupe_key = e.dedupe_key AND e.in_inbox = false`);
  const blobs = await db().query(
    `DELETE FROM receipt_blobs b
      WHERE NOT EXISTS (SELECT 1 FROM expense_receipts er WHERE er.sha256 = b.sha256)
        AND b.sha256 LIKE 'rc-%'`);
  return { links: links.rowCount ?? 0, blobs: blobs.rowCount ?? 0 };
}

const expense = (key: string, employee: string, inbox: boolean) =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents, in_inbox)
     VALUES ($1,$2,'2026-09-13','DOORDASH INC.',2640,$3)`, [key, employee, inbox]);

const blob = (hash: string) =>
  db().query(
    `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
     VALUES ($1,'image/jpeg',3,'\\x001122') ON CONFLICT DO NOTHING`, [hash]);

const link = (key: string, hash: string) =>
  db().query(`INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2)`, [key, hash]);

const decide = (key: string, state: string, decision = "approve") =>
  db().query(
    `INSERT INTO expense_decisions (dedupe_key, decision, reason, decided_by, state, target)
     VALUES ($1,$2,'because','eric@example.invalid',$3,'{}'::jsonb)`, [key, decision, state]);

const blobsLeft = async () =>
  Number((await db().query("SELECT count(*) c FROM receipt_blobs WHERE sha256 LIKE 'rc-%'")).rows[0].c);

console.log("\n1. Approved and confirmed gone — released");
await expense("rc-done", "Brianna Ruth", false);
await blob("rc-img-1"); await link("rc-done", "rc-img-1"); await decide("rc-done", "applied");
let swept = await sweep();
check("the link is removed", swept.links === 1, `${swept.links}`);
check("and the image with it, since nothing else wanted it", swept.blobs === 1, `${swept.blobs}`);

console.log("\n2. Approved but still in the inbox — kept");
await clean();
await expense("rc-waiting", "Brianna Ruth", true);
await blob("rc-img-2"); await link("rc-waiting", "rc-img-2"); await decide("rc-waiting", "applied");
swept = await sweep();
check("nothing is released while Emburse still lists it", swept.links === 0, `${swept.links}`);
check("…and the image is still there", (await blobsLeft()) === 1);

console.log("\n3. Denied and gone — released too");
await clean();
await expense("rc-denied", "Brianna Ruth", false);
await blob("rc-img-5"); await link("rc-denied", "rc-img-5"); await decide("rc-denied", "applied", "deny");
swept = await sweep();
check("a denial releases its receipt as well as an approval", swept.links === 1, `${swept.links}`);

console.log("\n4. Gone without this app deciding it — released");
await clean();
// The common case by far: somebody actioned it in Emburse directly, so there
// is no decision row here at all. These were being kept forever.
await expense("rc-elsewhere", "Brianna Ruth", false);
await blob("rc-img-6"); await link("rc-elsewhere", "rc-img-6");
swept = await sweep();
check("an expense decided outside this app still lets its receipt go",
  swept.links === 1 && swept.blobs === 1, `${swept.links} links, ${swept.blobs} images`);

console.log("\n5. Queued but not yet applied, and still in the inbox — kept");
await clean();
await expense("rc-pending", "Brianna Ruth", true);
await blob("rc-img-3"); await link("rc-pending", "rc-img-3"); await decide("rc-pending", "pending");
swept = await sweep();
check("a decision still in flight keeps its receipt while the expense waits",
  swept.links === 0, `${swept.links}`);

console.log("\n6. An approval that failed, expense back in the queue — kept");
await clean();
await expense("rc-failed", "Brianna Ruth", true);
await blob("rc-img-4"); await link("rc-failed", "rc-img-4"); await decide("rc-failed", "failed");
swept = await sweep();
check("a failure that left the expense in the queue keeps the picture to retry with",
  swept.links === 0, `${swept.links}`);

console.log("\n7. A shared image, one owner finished");
await clean();
await expense("rc-split-a", "Brianna Ruth", false);
await expense("rc-split-b", "Kevin McBride", true);
await blob("rc-shared");
await link("rc-split-a", "rc-shared");
await link("rc-split-b", "rc-shared");
await decide("rc-split-a", "applied");
swept = await sweep();
check("the finished owner's link goes", swept.links === 1, `${swept.links}`);
check("…but the image stays, because the other still needs it",
  swept.blobs === 0 && (await blobsLeft()) === 1, `${swept.blobs} deleted`);
const stillLinked = Number((await db().query(
  "SELECT count(*) c FROM expense_receipts WHERE dedupe_key = 'rc-split-b'")).rows[0].c);
check("…and the other expense can still show its receipt", stillLinked === 1, `${stillLinked}`);

console.log("\n8. Then the other leaves too");
await db().query("UPDATE expenses SET in_inbox = false WHERE dedupe_key = 'rc-split-b'");
await decide("rc-split-b", "applied");
swept = await sweep();
check("the last link goes", swept.links === 1, `${swept.links}`);
check("…and now the image does too", swept.blobs === 1 && (await blobsLeft()) === 0, `${swept.blobs}`);

await clean();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
