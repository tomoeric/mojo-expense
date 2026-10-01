/**
 * Eric approves, and it goes to Brian. The same expense, twice.
 *
 *   pnpm exec tsx scripts/test-approval-chain.ts     (needs DATABASE_URL)
 *
 * "Receipt goes to Eric's Need Review > Eric Approves > Goes to Brian's
 * Need Review."
 *
 * Which means the same expense legitimately passes through two queues, and
 * it is the same expense: same employee, date, merchant, amount, category,
 * location and department, so the same `dedupe_key`. And
 * `expense_decisions` has NO foreign key, on purpose — the record of who
 * approved what outlives the purge, because it is the only audit trail on
 * this side of the wire.
 *
 * Put those two facts together and the second stage cannot work: Eric's
 * approval is still in the table under that key when Brian's import brings
 * the expense in as his, so every check that asks "has this been decided"
 * says yes. Brian's queue badges it Approved, the sweep skips it, and
 * nothing in the second half of the chain can ever be approved through this
 * app. One stage's decision does not discharge the next one's.
 */

process.env.SESSION_SECRET ||= "test-secret-for-chain";

import { db, ensureSchema } from "../server/db.js";
import { decisionsFor, queueDecision, settleDecision } from "../server/emburse/decisions.js";

const ERIC = "eric.s@test.invalid";
const BRIAN = "brian.c@test.invalid";
const TAG = `zz-chain-${Date.now()}`;
const KEY = `${TAG}-expense`;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
};

/** The expense, in whoever's queue it is at this stage of the chain. */
const place = (reviewer: string) =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox, reviewer)
     VALUES ($1,'Horace Mitchell','2026-09-28','ExxonMobil',8307,'Travel','Ops','Site','','Card',
             true,$2)
     ON CONFLICT (dedupe_key) DO UPDATE SET reviewer = EXCLUDED.reviewer, in_inbox = true`,
    [KEY, reviewer]);

/** Exactly the test the sweep uses to skip an expense it has already acted on. */
const looksDecided = async (): Promise<boolean> => {
  const { rows } = await db().query<{ yes: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM expense_decisions d
        WHERE d.dedupe_key = e.dedupe_key AND d.state IN ('pending','applied','failed')
          AND (e.reviewer = '' OR lower(d.decided_by) = lower(e.reviewer))) AS yes
       FROM expenses e WHERE e.dedupe_key = $1`, [KEY]);
  return rows[0]?.yes ?? false;
};

await ensureSchema();

try {
  await clean();

  console.log("\n1. It lands in Eric's Needs Review");
  await place(ERIC);
  check("nothing has decided it", (await looksDecided()) === false);

  console.log("\n2. Eric approves it");
  const first = await queueDecision({
    dedupeKey: KEY, decision: "approve", reason: "", decidedBy: ERIC,
    target: { employee: "Horace Mitchell", merchant: "ExxonMobil", amount: 83.07,
              date: "2026-09-28" },
  });
  check("the decision is recorded", first.ok === true,
    first.ok ? "" : (first as { error: string }).error);
  if (first.ok) await settleDecision(first.queued.id, { ok: true, matchedRow: "row" });
  check("…and his queue now shows it decided", (await looksDecided()) === true);
  check("…badged to him", (await decisionsFor([KEY], ERIC)).has(KEY));

  console.log("\n3. Emburse passes it to Brian's Needs Review");
  // His import brings it in as his. Same expense, same key — and Eric's
  // approval is still in the table, because decisions outlive the purge.
  await place(BRIAN);
  {
    // The line this test exists for.
    check("it is NOT already decided for Brian", (await looksDecided()) === false);
    check("…and his queue does not badge it with Eric's approval",
      (await decisionsFor([KEY], BRIAN)).has(KEY) === false);
    check("…while Eric's own record is untouched",
      (await decisionsFor([KEY], ERIC)).get(KEY)?.state === "applied");
  }

  console.log("\n4. Brian approves it as the second stage");
  const second = await queueDecision({
    dedupeKey: KEY, decision: "approve", reason: "", decidedBy: BRIAN,
    target: { employee: "Horace Mitchell", merchant: "ExxonMobil", amount: 83.07,
              date: "2026-09-28" },
  });
  check("his approval is accepted, not refused as a duplicate", second.ok === true,
    second.ok ? "" : (second as { error: string }).error);
  check("…and now his stage is decided too", (await looksDecided()) === true);

  console.log("\n5. Both approvals stand, as two separate records");
  {
    const { rows } = await db().query<{ decided_by: string }>(
      "SELECT decided_by FROM expense_decisions WHERE dedupe_key = $1 ORDER BY decided_at", [KEY]);
    check("there are two", rows.length === 2, String(rows.length));
    check("…one each", rows[0]?.decided_by === ERIC && rows[1]?.decided_by === BRIAN,
      rows.map((r) => r.decided_by).join(" → "));
  }
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
