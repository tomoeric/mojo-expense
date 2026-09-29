/**
 * A flag beats an approval that is already queued.
 *
 *   pnpm exec tsx scripts/test-flag-wins.ts     (needs DATABASE_URL)
 *
 * The automation only ever queues expenses nothing flagged. But a receipt
 * is often read MINUTES LATER, the rules run again on what it turned out
 * to say, and the expense is flagged after its approval is already in the
 * queue. Nothing re-checked between queueing and applying, so it went to
 * Emburse anyway — and the queue said so plainly: rows sitting in the
 * Flagged tab reading "Approved · sending".
 *
 * The rule this pins: a MACHINE may not approve a flagged expense. A
 * PERSON may, and often should — a flag is a prompt to look, not a
 * prohibition, and somebody who clicks Approve on a flagged row means it.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const store = await import("../server/rules/store.js");
const { runRules } = await import("../server/rules/run.js");
const {
  queueDecision, flaggedNow, cancelBecauseFlagged, decisionsFor,
} = await import("../server/emburse/decisions.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
await store.ensureRules();

const TAG = `zz-fw-${Date.now()}`;
const CLEAN = `${TAG}-clean`;
const DIRTY = `${TAG}-dirty`;

const clean = async () => {
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${TAG}%`]);
};
await clean();

const add = (key: string, category: string) =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-24','MENARDS',1354,$3,'Ops','Site','x','Corporate card',true)`,
    [key, `${TAG} Person`, category]);

const queue = (key: string, automatic: boolean) =>
  queueDecision({
    dedupeKey: key, decision: "approve", reason: "", decidedBy: "tester@example.invalid",
    target: { employee: `${TAG} Person`, merchant: "MENARDS", amount: 13.54, date: "2026-09-24" },
    automatic,
  });

try {
  await add(CLEAN, "Office Supplies");
  await add(DIRTY, "Office Supplies");

  // Queued while BOTH are clean, which is the whole point: the automation
  // did nothing wrong at the time.
  const a = await queue(CLEAN, true);
  const b = await queue(DIRTY, true);
  if (!a.ok || !b.ok) throw new Error("could not queue");

  console.log("\n1. Nothing is flagged yet");
  check("neither is flagged", (await flaggedNow([CLEAN, DIRTY])).size === 0);

  console.log("\n2. A rule flags one of them AFTER the approval is queued");
  const saved = await store.saveRule({
    name: `${TAG} no menards`, enabled: true, match: "all",
    when: [{ field: "merchant", op: "contains", value: "MENARDS" }],
    must: null, action: "flag", message: "Look at this one.",
  }, "tester@example.invalid");
  if (!saved.ok) throw new Error(saved.error);
  // Only the one, so the other stays a control.
  await runRules({ keys: [DIRTY], decide: false });
  const flagged = await flaggedNow([CLEAN, DIRTY]);
  check("the flag is seen", flagged.has(DIRTY));
  check("…and the clean one is not caught up in it", !flagged.has(CLEAN));

  console.log("\n3. The queued approval is taken back");
  const stopped = await cancelBecauseFlagged([b.ok ? b.queued.id : 0]);
  check("one decision is held back", stopped === 1, String(stopped));
  const after = await decisionsFor([CLEAN, DIRTY]);
  check("…cancelled, not failed — nothing went wrong and nothing was tried",
    after.get(DIRTY) === undefined, String(after.get(DIRTY)?.state));
  check("…and the clean one is still on its way",
    after.get(CLEAN)?.state === "pending", after.get(CLEAN)?.state);

  console.log("\n4. A person may still approve a flagged expense");
  // A flag is a prompt to look, not a prohibition. Somebody who clicks
  // Approve on a flagged row means it, and stopping them would make the
  // flag useless for the thing it is for.
  const byHand = await queue(DIRTY, false);
  check("a person's approval is queued despite the flag", byHand.ok,
    byHand.ok ? "" : byHand.error);
  check("…and it is not marked as the machine's",
    byHand.ok && byHand.queued.automatic === false);
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
