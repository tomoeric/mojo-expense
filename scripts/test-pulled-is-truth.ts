/**
 * An export this app just pulled is always imported.
 *
 *   pnpm exec tsx scripts/test-pulled-is-truth.ts
 *
 * "Pulling the export from Emburse is always the source of truth and always
 * updated." Emburse's Needs Review is what it is at the moment it is read,
 * so a file this run downloaded seconds ago cannot be out of date.
 *
 * The staleness guard refused them anyway, because it compares the export's
 * newest expense date against `max(expense_date)` over every row stored for
 * that reviewer and source — INCLUDING rows that have long since left the
 * inbox. It assumes the newest date never goes backwards, and the newest
 * expense being approved is the app working. The queue held something dated
 * 2026-10-10, it was approved, the next export's newest was 2026-10-09, and
 * nothing could lower that stored maximum again: imports stopped for good
 * while the runs went on reporting "Succeeded · 36 items, $8,153.35".
 *
 * The guard still earns its place on a file somebody CHOSE. Picking
 * yesterday's PDF out of a downloads folder resurrects decided expenses and
 * evicts the ones actually waiting, and once approvals release receipts the
 * resurrected ones come back with images that cannot be fetched again.
 */
import { db } from "../server/db.js";
const { ingestExport } = await import("../server/import/ingest.js");

const TAG = `pulled-${Date.now()}`;
const WHO = `${TAG} Person`;
const REVIEWER = `${TAG}@example.invalid`;

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const parseOf = (date: string) => ({
  pageCount: 1,
  statedTotalCents: 1000,
  header: null,
  receipts: [],
  expenses: [{
    date, employee: WHO, merchant: "ACME", amountCents: 1000, category: "Meals",
    department: "Ops", location: "Site", note: "", method: "Corporate Card",
    reimbursable: false, billable: false, currency: "USD",
  }],
});

let serial = 0;
const importOne = (date: string, opts: { downloadedNow?: boolean } = {}) =>
  ingestExport(Buffer.from(""), `${TAG}-${date}.pdf`, "test", {
    parsed: parseOf(date) as never,
    fileHash: `${TAG}-${++serial}`,
    sectionsVerified: true,
    reviewer: REVIEWER,
    source: "",
    ...opts,
  });

const stored = async () =>
  Number((await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM expenses WHERE reviewer = $1", [REVIEWER])).rows[0]!.n);

try {
  console.log("1. The queue's newest expense is approved and leaves");
  await importOne("2026-10-10", { downloadedNow: true });
  check("the first export imports", (await stored()) === 1);
  // It leaves Needs Review, as the whole app exists to make happen. The row
  // stays behind with in_inbox false, so max(expense_date) still reads
  // 2026-10-10 and will for ever.
  await db().query(
    "UPDATE expenses SET in_inbox = false, left_inbox_at = now() WHERE reviewer = $1", [REVIEWER]);

  console.log("\n2. Today's export is older-dated, and is STILL the truth");
  const pulled = await importOne("2026-10-09", { downloadedNow: true });
  check("a freshly pulled export is imported", Number(pulled.importId ?? 0) > 0);
  check("…with no stale warning", !pulled.warnings.some((w) => /older than/i.test(w)),
    pulled.warnings.join(" · "));
  // One, not two: importing also PURGES what the export no longer carries,
  // which is the same mechanism the guard was protecting. That is correct
  // here — Emburse says this is the queue, so the 10-10 row is gone.
  check("…and the queue now matches the export", (await stored()) === 1);

  console.log("\n3. A file somebody CHOSE is still refused");
  // The guard's real job, unchanged: yesterday's PDF out of a folder.
  const byHand = await importOne("2026-10-08");
  check("a hand-picked older export is refused", !byHand.importId,
    `importId ${byHand.importId}`);
  check("…and says why", byHand.warnings.some((w) => /older than/i.test(w)),
    byHand.warnings.join(" · "));
  check("…and changed nothing", (await stored()) === 1);

  console.log("\n4. force still overrides, as it always did");
  const forced = await importOne("2026-10-07", { force: true } as never);
  check("forcing a hand-picked older export imports it", Number(forced.importId ?? 0) > 0);
} finally {
  await db().query("DELETE FROM expenses WHERE reviewer = $1", [REVIEWER]).catch(() => {});
  await db().query("DELETE FROM expense_imports WHERE reviewer = $1", [REVIEWER]).catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
