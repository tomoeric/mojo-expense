/**
 * The Rules page and the queue must mean the same thing by "in queue".
 *
 *   pnpm exec tsx scripts/test-rule-counts.ts     (needs DATABASE_URL)
 *
 * A new rule, "$1000+", reported "2 caught · 2 in queue" on the Rules page
 * while the queue's flag chips had no $1000+ bucket at all. The rule was
 * working perfectly. The two pages were answering different questions:
 *
 *   Rules page — in Emburse's inbox.
 *   Queue      — not yet decided here.
 *
 * An expense STAYS in the inbox after it is approved here; Emburse only
 * drops it at the next import. So both of that rule's catches were sitting
 * under Approved, counted by one page and invisible on the other, with
 * nothing on either to say why.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const store = await import("../server/rules/store.js");
const { runRules } = await import("../server/rules/run.js");
const { queueDecision, settleDecision } = await import("../server/emburse/decisions.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
await store.ensureRules();

const TAG = `zz-rc-${Date.now()}`;
const WAITING = `${TAG}-waiting`;
const APPROVED = `${TAG}-approved`;
const GONE = `${TAG}-gone`;

const clean = async () => {
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${TAG}%`]);
};
await clean();

const add = (key: string, cents: number, inInbox = true) =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-26','SOMEWHERE EXPENSIVE',$3,'Repairs','Maintenance','Site',
             'x','Corporate Card',$4)`,
    [key, `${TAG} Person`, cents, inInbox]);

try {
  await add(WAITING, 150000);
  await add(APPROVED, 220000);
  await add(GONE, 180000, false);

  const saved = await store.saveRule({
    name: `${TAG} $1000+`, enabled: true, match: "all",
    when: [{ field: "amount", op: "gt", value: "999" }],
    must: null, action: "flag", message: "",
  }, "tester@example.invalid");
  if (!saved.ok) throw new Error(saved.error);
  await runRules({ decide: false });

  // One of them is approved HERE. Emburse still lists it — the inbox flag
  // only clears at the next import — which is the whole trap.
  const q = await queueDecision({
    dedupeKey: APPROVED, decision: "approve", reason: "", decidedBy: "tester@example.invalid",
    target: { employee: `${TAG} Person`, merchant: "SOMEWHERE EXPENSIVE", amount: 2200, date: "2026-09-26" },
  });
  if (!q.ok) throw new Error(q.error);
  await settleDecision(q.queued.id, { ok: true, matchedRow: "row 1" });

  const stats = (await store.ruleStats()).get(saved.rule.id)!;

  console.log("\n1. What the rule caught, and where each one is");
  check("all three are caught", stats.fail === 3, String(stats.fail));
  check("…one is actually waiting for somebody", stats.waiting === 1, String(stats.waiting));
  check("…one is caught but already decided here", stats.decided === 1, String(stats.decided));
  // The third has left Emburse's inbox entirely, so it is neither.
  check("…and one has left the inbox, so it is neither",
    stats.waiting + stats.decided === 2, `${stats.waiting}+${stats.decided}`);

  console.log("\n2. The queue's own idea of waiting agrees");
  // hitsFor is what the queue turns into flags; the queue then drops any
  // row whose decision has been APPLIED. So the count a reviewer sees is
  // the hits minus the applied ones — which is exactly `waiting`.
  const hits = await store.hitsFor([WAITING, APPROVED, GONE]);
  check("all three still carry the flag", hits.size === 3, String(hits.size));
  const applied = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM expenses e
       JOIN expense_decisions d ON d.dedupe_key = e.dedupe_key AND d.state = 'applied'
      WHERE e.dedupe_key = ANY($1::text[]) AND e.in_inbox`,
    [[WAITING, APPROVED, GONE]]);
  const inInbox = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM expenses WHERE dedupe_key = ANY($1::text[]) AND in_inbox",
    [[WAITING, APPROVED, GONE]]);
  check("…and the queue would show inbox minus applied",
    Number(inInbox.rows[0]!.n) - Number(applied.rows[0]!.n) === stats.waiting,
    `${inInbox.rows[0]!.n} - ${applied.rows[0]!.n} vs ${stats.waiting}`);
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
