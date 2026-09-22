/**
 * Letting go of receipts for approved expenses, safely.
 *
 *   pnpm exec tsx scripts/test-receipt-cleanup.ts     (needs DATABASE_URL)
 *
 * Two ways this could quietly destroy something:
 *
 *   - Deleting too early. An approval is only known to have taken once the
 *     expense stops appearing in the export, and by then the image cannot be
 *     fetched again — an expense out of the inbox is out of every future
 *     export too. Delete on the click and a failed approval loses the receipt
 *     for an expense still in the queue.
 *   - Deleting a shared image. Receipts are stored once by content hash, so
 *     one purchase split across sites points several expenses at the same
 *     picture. Dropping it because one owner was approved blanks the others.
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
      USING expense_decisions d, expenses e
      WHERE er.dedupe_key = d.dedupe_key AND e.dedupe_key = d.dedupe_key
        AND d.decision = 'approve' AND d.state = 'applied' AND e.in_inbox = false`);
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

console.log("\n3. Approval queued but not applied — kept");
await clean();
await expense("rc-pending", "Brianna Ruth", false);
await blob("rc-img-3"); await link("rc-pending", "rc-img-3"); await decide("rc-pending", "pending");
swept = await sweep();
check("a decision that has not reached Emburse releases nothing", swept.links === 0, `${swept.links}`);

console.log("\n4. An approval that failed — kept");
await clean();
await expense("rc-failed", "Brianna Ruth", false);
await blob("rc-img-4"); await link("rc-failed", "rc-img-4"); await decide("rc-failed", "failed");
swept = await sweep();
check("a failed approval keeps its receipt", swept.links === 0, `${swept.links}`);

console.log("\n5. Denied and gone — kept, because denials come back");
await clean();
await expense("rc-denied", "Brianna Ruth", false);
await blob("rc-img-5"); await link("rc-denied", "rc-img-5"); await decide("rc-denied", "applied", "deny");
swept = await sweep();
check("a denial does not release its receipt", swept.links === 0, `${swept.links}`);

console.log("\n6. A shared image, one owner approved");
await clean();
await expense("rc-split-a", "Brianna Ruth", false);
await expense("rc-split-b", "Kevin McBride", true);
await blob("rc-shared");
await link("rc-split-a", "rc-shared");
await link("rc-split-b", "rc-shared");
await decide("rc-split-a", "applied");
swept = await sweep();
check("the approved owner's link goes", swept.links === 1, `${swept.links}`);
check("…but the image stays, because the other still needs it",
  swept.blobs === 0 && (await blobsLeft()) === 1, `${swept.blobs} deleted`);
const stillLinked = Number((await db().query(
  "SELECT count(*) c FROM expense_receipts WHERE dedupe_key = 'rc-split-b'")).rows[0].c);
check("…and the other expense can still show its receipt", stillLinked === 1, `${stillLinked}`);

console.log("\n7. Then the other is approved too");
await db().query("UPDATE expenses SET in_inbox = false WHERE dedupe_key = 'rc-split-b'");
await decide("rc-split-b", "applied");
swept = await sweep();
check("the last link goes", swept.links === 1, `${swept.links}`);
check("…and now the image does too", swept.blobs === 1 && (await blobsLeft()) === 0, `${swept.blobs}`);

await clean();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
