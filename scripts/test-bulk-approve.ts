/**
 * Approving a batch that was ticked off together.
 *
 *   pnpm exec tsx scripts/test-bulk-approve.ts     (needs DATABASE_URL)
 *
 * A reviewer works down the unflagged list, ticks the lot and sends them.
 * The convenience is for the person; it must not be a lighter standard for
 * the decision. So every expense in a batch goes through the same checks a
 * single one does — it exists, the decider has an Emburse login, nothing
 * is already in flight for it — and whatever cannot be queued is NAMED
 * while the rest still go.
 *
 * Approving is the irreversible half of this app. The two things that must
 * hold whatever else changes: one decision per expense, and a ceiling on
 * how many a single click can start.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const { queueApprovalFor, pendingDecisions, decisionsFor } = await import("../server/emburse/decisions.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
const TAG = `zz-bulk-${Date.now()}`;
const WHO = `${TAG}@test`;
const clean = async () => {
  await db().query("DELETE FROM expense_decisions WHERE decided_by = $1", [WHO]);
  await db().query("DELETE FROM expenses WHERE employee = $1", [`${TAG} Person`]);
};
await clean();

const add = async (n: number) => {
  const key = `${TAG}-${n}`;
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-20',$3,$4,'Meals','Ops','Site','x','Corporate card',true)`,
    [key, `${TAG} Person`, `MERCHANT ${n}`, 1000 + n]);
  return key;
};

/**
 * Exactly what the route runs per expense.
 *
 * Calling the SHARED function rather than reimplementing its checks. The
 * first version of this test built its own target and skipped the
 * does-this-expense-exist check, so it queued a decision for an expense
 * that was not there and reported it as fine — a test that agreed with
 * itself while the route did something else.
 */
const queueAll = async (keys: string[]) => {
  let queued = 0;
  const refused: string[] = [];
  for (const dedupeKey of keys) {
    const r = await queueApprovalFor(dedupeKey, WHO);
    if (r.ok) queued++;
    else refused.push(r.error);
  }
  return { queued, refused };
};

try {
  console.log("\nTicking off a batch");
  const keys: string[] = [];
  for (let i = 0; i < 8; i++) keys.push(await add(i));

  const first = await queueAll(keys);
  check("every ticked expense is queued", first.queued === 8, String(first.queued));
  check("…and nothing was refused", first.refused.length === 0, first.refused.join("; "));

  const pending = (await pendingDecisions()).filter((d) => d.decidedBy === WHO);
  check("…as eight separate decisions, not one lump", pending.length === 8, String(pending.length));
  check("…each recorded against the person who ticked them",
    pending.every((d) => d.decidedBy === WHO));
  // They are applied in ONE browser session — that is the whole point of
  // batching — but each stands or falls on its own.
  check("…and each carries its own expense", new Set(pending.map((d) => d.dedupeKey)).size === 8);

  console.log("\nThe guard that must survive being made convenient");
  // Sending the same selection twice — a double click, a stale page — must
  // not drive Emburse twice for one row.
  const again = await queueAll(keys);
  check("a second send queues nothing new", again.queued === 0, String(again.queued));
  check("…and says why, per expense, rather than failing silently",
    again.refused.length === 8 && again.refused.every((r) => /already waiting/i.test(r)),
    again.refused[0] ?? "(none)");
  check("…leaving the original eight untouched",
    (await pendingDecisions()).filter((d) => d.decidedBy === WHO).length === 8);

  console.log("\nOne bad apple does not spoil the batch");
  await clean();
  const mixed = [await add(0), `${TAG}-gone`, await add(2)];
  const partial = await queueAll(mixed);
  check("the expenses that exist are still queued", partial.queued === 2, String(partial.queued));
  check("…and the one that does not is refused, not ignored",
    partial.refused.length === 1, partial.refused.join("; "));

  console.log("\nWhat the queue shows afterwards");
  const shown = await decisionsFor(mixed);
  check("each queued expense carries its own pending badge",
    [...shown.values()].filter((d) => d.state === "pending").length === 2);
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
