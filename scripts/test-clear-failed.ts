/**
 * Putting the failures down.
 *
 *   pnpm exec tsx scripts/test-clear-failed.ts     (needs DATABASE_URL)
 *
 * Thirty-five "did not go through" sat on the queue across several runs,
 * counted as one number, with no way to put any of them down — so the only
 * answer to "what is new here" was to read every row. An empty strip is
 * what makes the next failure legible.
 *
 * What clearing must NOT do is the important half. It does not touch a
 * decision that is pending — one on its way to Emburse under somebody's
 * login — and it does not touch one that already landed. Cancelling either
 * by accident is a much worse outcome than a cluttered strip, and both are
 * one careless WHERE clause away.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const {
  queueDecision, settleDecision, decisionsFor, clearFailedDecisions, failureSummary,
} = await import("../server/emburse/decisions.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();

const TAG = `zz-cf-${Date.now()}`;
const BROKE = `${TAG}-broke`;    // failed for a real reason
const GONE  = `${TAG}-gone`;     // failed because Emburse no longer has it
const SENT  = `${TAG}-sent`;     // still on its way
const DONE  = `${TAG}-done`;     // already applied

const clean = async () => {
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
};
await clean();

const add = (key: string) =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-25','DOLLARTREE 8508',700,'Office Supplies','Operations',
             'Site','Pink celebration day','Corporate card',true)`,
    [key, `${TAG} Person`]);

const queue = (key: string) =>
  queueDecision({
    dedupeKey: key, decision: "approve", reason: "", decidedBy: "tester@example.invalid",
    target: { employee: `${TAG} Person`, merchant: "DOLLARTREE 8508", amount: 7, date: "2026-09-25" },
  });

const stateOf = async (key: string): Promise<string> => {
  const { rows } = await db().query<{ state: string }>(
    "SELECT state FROM expense_decisions WHERE dedupe_key = $1 ORDER BY id DESC LIMIT 1", [key]);
  return rows[0]?.state ?? "none";
};

try {
  for (const k of [BROKE, GONE, SENT, DONE]) await add(k);
  const ids = new Map<string, number>();
  for (const k of [BROKE, GONE, SENT, DONE]) {
    const q = await queue(k);
    if (!q.ok) throw new Error(q.error);
    ids.set(k, q.queued.id);
  }

  await settleDecision(ids.get(BROKE)!, { ok: false, error: "no APPROVE control matched the row" });
  await settleDecision(ids.get(GONE)!, {
    ok: false, error: 'not in this view: no match for "DOLLARTREE 8508"', notInQueue: true });
  await settleDecision(ids.get(DONE)!, { ok: true, matchedRow: "row 3" });

  console.log("\n1. Before clearing");
  check("the broken one is failed", await stateOf(BROKE) === "failed");
  check("the missing one is failed too", await stateOf(GONE) === "failed");
  check("…and marked as not in the queue",
    (await decisionsFor([GONE])).get(GONE)?.notInQueue === true);
  check("one is still on its way", await stateOf(SENT) === "pending");
  check("one already landed", await stateOf(DONE) === "applied");
  // ONE, not two. The failure summary counts only expenses still in the
  // queue — "an expense that has left is not somebody's problem any more"
  // — and settling `notInQueue` takes it off the queue there and then.
  // Before that it counted both and the second was noise: nothing to fix,
  // nothing to retry, and a row somebody had to learn to ignore.
  check("the real failure is counted", (await failureSummary())
    .reduce((n, g) => n + g.n, 0) === 1,
    JSON.stringify(await failureSummary()));

  console.log("\n2. A failure now says WHEN it failed");
  // A decision queued on Monday and attempted on Thursday carried Monday's
  // date and nothing else, which is why old and new looked alike.
  const broke = (await decisionsFor([BROKE])).get(BROKE);
  check("the failure is stamped", typeof broke?.failedAt === "string", String(broke?.failedAt));
  check("…and it is recent", broke?.failedAt !== undefined && broke.failedAt !== null &&
    Date.now() - new Date(broke.failedAt).getTime() < 60_000);
  check("…while one that landed is not stamped",
    (await decisionsFor([DONE])).get(DONE)?.failedAt == null);

  console.log("\n2b. An expense Emburse no longer has comes off the queue at once");
  // "On something like this remove it from the app list — auto remove,
  // don't require a page refresh." It used to sit there greyed out until
  // the next import, which might be tomorrow, asking somebody to keep
  // looking at a row that is finished.
  //
  // Warranted because notInQueue is not a guess: the run read that
  // cardholder's whole Needs Review and found no row for this amount. And
  // self-correcting in the direction that matters — if Emburse does still
  // hold it, the next import carries it and the row comes back.
  const inbox = async (key: string): Promise<boolean | null> => {
    const { rows } = await db().query<{ in_inbox: boolean }>(
      "SELECT in_inbox FROM expenses WHERE dedupe_key = $1", [key]);
    return rows[0]?.in_inbox ?? null;
  };
  check("the one Emburse no longer has is off the queue", await inbox(GONE) === false);
  check("…while an ordinary failure stays on it, to be retried",
    await inbox(BROKE) === true);
  check("…and so does one still on its way", await inbox(SENT) === true);
  // An applied decision is a different path: Emburse confirmed the row
  // left, and the import purge handles it. Not this one's business.
  check("…and one that landed is left to the import as before",
    await inbox(DONE) === true);

  console.log("\n3. Clearing only the ones Emburse no longer has");
  const goneOnly = await clearFailedDecisions("eric@example.invalid", { onlyGone: true });
  check("one is cleared", goneOnly === 1, String(goneOnly));
  check("…it is cancelled, not deleted", await stateOf(GONE) === "cancelled");
  check("…and the real failure is untouched", await stateOf(BROKE) === "failed");

  console.log("\n4. Clearing the rest");
  const all = await clearFailedDecisions("eric@example.invalid");
  check("the real failure clears too", all === 1, String(all));
  check("…and is cancelled", await stateOf(BROKE) === "cancelled");
  check("…the record says who put it down",
    /cleared by eric@example\.invalid/.test(
      (await db().query<{ error: string }>(
        "SELECT error FROM expense_decisions WHERE dedupe_key = $1", [BROKE])).rows[0]?.error ?? ""));

  console.log("\n5. What clearing must never touch");
  check("a decision on its way to Emburse is left alone", await stateOf(SENT) === "pending");
  check("…and one that already landed is left alone", await stateOf(DONE) === "applied");

  console.log("\n6. Afterwards");
  check("nothing is failing any more",
    (await failureSummary()).reduce((n, g) => n + g.n, 0) === 0);
  check("…the cleared expense offers Approve and Deny again",
    (await decisionsFor([BROKE])).get(BROKE) === undefined);
  check("…and clearing again does nothing", await clearFailedDecisions("x") === 0);
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
