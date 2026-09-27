/**
 * Approving unflagged expenses with nobody watching.
 *
 *   pnpm exec tsx scripts/test-auto-approve.ts     (needs DATABASE_URL)
 *
 * This is the only path in the app that approves somebody's spending with
 * no human in the loop, so what it must REFUSE to touch matters more than
 * what it approves.
 *
 * The trap that shaped it: an expense whose receipt has not been read yet
 * is unflagged because nothing has been checked, not because everything
 * passed. Rules about alcohol, receipt totals and business names all
 * return UNKNOWN with no reading — correctly — so the newest expenses, the
 * ones the reader has not reached, look cleanest of all. An automation
 * built on "flags is empty" would systematically approve exactly the
 * expenses nothing had examined, and would look like it was working.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const { autoQueueApprovals, autoApproveReport } = await import("../server/rules/auto-approve.js");
const { setFlag, setLimit } = await import("../server/flags.js");
const store = await import("../server/rules/store.js");
const { runRules } = await import("../server/rules/run.js");
const { pendingDecisions, queueDecision } = await import("../server/emburse/decisions.js");
const { saveCredential, deleteCredential } = await import("../server/emburse/credentials.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
await store.ensureRules();

const TAG = `zz-auto-${Date.now()}`;
const OWNER = `${TAG}@test`;
const clean = async () => {
  await db().query("DELETE FROM expense_decisions WHERE decided_by = $1", [OWNER]);
  await db().query("DELETE FROM expenses WHERE employee = $1", [`${TAG} Person`]);
  await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM app_flags WHERE key = 'autoApprove'");
};
await clean();

const add = async (n: number, category: string) => {
  const key = `${TAG}-${n}`;
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-20',$3,$4,$5,'Ops','Site','x','Corporate card',true)`,
    [key, `${TAG} Person`, `MERCHANT ${n}`, 1000 + n, category]);
  return key;
};

const mine = async () => (await pendingDecisions()).filter((d) => d.decidedBy === OWNER);

try {
  await saveCredential(OWNER, OWNER, OWNER, "not-a-real-password");

  // One rule that catches Meals, so Office rows are genuinely unflagged.
  const saved = await store.saveRule({
    name: `${TAG} no meals`, enabled: true, match: "all",
    when: [{ field: "category", op: "is", value: "Meals" }],
    must: null, action: "flag", message: "",
  }, OWNER);
  if (!saved.ok) throw new Error(saved.error);

  const clean1 = await add(1, "Office Supplies");
  const clean2 = await add(2, "Office Supplies");
  const clean3 = await add(3, "Office Supplies");
  await add(4, "Meals");
  await runRules({ decide: false });

  console.log("\n1. Switched off");
  check("does nothing at all", (await autoQueueApprovals()).queued === 0);
  check("…and queues nothing", (await mine()).length === 0);

  console.log("\n2. Switched on");
  await setFlag("autoApprove", true, OWNER);
  await setLimit("autoApprove", 2, OWNER);
  const first = await autoQueueApprovals();
  check("queues up to the number it was given, not everything",
    first.queued === 2, String(first.queued));
  check("…and the flagged expense is not among them",
    !(await mine()).some((d) => d.dedupeKey.endsWith("-4")),
    (await mine()).map((d) => d.dedupeKey.slice(-2)).join(","));
  check("…each recorded against the person who switched it on",
    (await mine()).every((d) => d.decidedBy === OWNER));
  // The name on an automatic approval is a real person's — that is the whole
  // design — so decidedBy cannot tell a machine's decision from a click.
  // Without a mark of its own, a queue of green badges cannot answer "which
  // of these did anybody actually look at".
  check("…and marked as the machine's, not as somebody's click",
    (await mine()).every((d) => d.automatic === true),
    (await mine()).map((d) => String(d.automatic)).join(","));

  console.log("\n3. It does not decide the same expense twice");
  const second = await autoQueueApprovals();
  check("the third clean one goes, the first two do not go again",
    second.queued === 1, String(second.queued));
  check("…leaving three in all", (await mine()).length === 3);
  const third = await autoQueueApprovals();
  check("and then there is nothing left to do", third.queued === 0, String(third.queued));
  check("…with the flagged expense still untouched",
    !(await mine()).some((d) => d.dedupeKey.endsWith("-4")));
  void clean1; void clean2; void clean3;

  console.log("\n4. Nobody to approve as");
  await db().query("DELETE FROM expense_decisions WHERE decided_by = $1", [OWNER]);
  await deleteCredential(OWNER);
  const noLogin = await autoQueueApprovals();
  check("refuses when the owner has no Emburse login", noLogin.queued === 0);
  check("…and says so rather than failing silently",
    /no Emburse login/.test(noLogin.skipped ?? ""), noLogin.skipped ?? "(nothing)");
  await saveCredential(OWNER, OWNER, OWNER, "not-a-real-password");

  console.log("\n5. Nothing is actually checking");
  await db().query("DELETE FROM expense_decisions WHERE decided_by = $1", [OWNER]);
  await store.setEnabled(saved.rule.id, false, OWNER);
  const noRules = await autoQueueApprovals();
  // "No rule flagged it" is vacuously true of everything when no rule runs.
  check("refuses to approve anything when no rule is enabled", noRules.queued === 0);
  check("…and says why", /no rules are enabled/.test(noRules.skipped ?? ""),
    noRules.skipped ?? "(nothing)");
  await store.setEnabled(saved.rule.id, true, OWNER);

  console.log("\n6. The trap: an unread receipt is not a clean receipt");
  await db().query("DELETE FROM expense_decisions WHERE decided_by = $1", [OWNER]);
  // A rule that reads receipts. Now an expense with no reading cannot be
  // called clean, because nothing has looked at its receipt.
  const rd = await store.saveRule({
    name: `${TAG} no alcohol`, enabled: true, match: "all",
    when: [{ field: "receiptAlcohol", op: "is", value: "yes" }],
    must: null, action: "flag", message: "",
  }, OWNER);
  if (!rd.ok) throw new Error(rd.error);
  await runRules({ decide: false });
  const guarded = await autoQueueApprovals();
  check("an expense whose receipt was never read is left alone",
    guarded.queued === 0, `${guarded.queued} queued`);

  // Give one of them a receipt that HAS been read, and it qualifies again.
  const sha = "a".repeat(64);
  await db().query(
    `INSERT INTO receipt_blobs (sha256, bytes, content_type, byte_size)
     VALUES ($1, '\\x00'::bytea, 'image/png', 1) ON CONFLICT DO NOTHING`, [sha]);
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, legible) VALUES ($1,'test',true)
     ON CONFLICT (sha256) DO UPDATE SET error = NULL`, [sha]);
  await db().query(
    `INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`, [`${TAG}-1`, sha]);
  const withReading = await autoQueueApprovals();
  check("…but one whose receipt WAS read is approved",
    withReading.queued === 1, `${withReading.queued} queued`);
  check("…and it is that expense, not another",
    (await mine()).every((d) => d.dedupeKey === `${TAG}-1`),
    (await mine()).map((d) => d.dedupeKey).join(","));
  console.log("\n7. One receipt read, another not");
  // An expense can carry several images, and a rule about alcohol is
  // answered by whichever one has the bar tab on it. Passing on the
  // strength of one readable receipt while another sat unread would
  // approve the expense on the evidence of the page that happened to be
  // legible.
  await db().query("DELETE FROM expense_decisions WHERE decided_by = $1", [OWNER]);
  const otherSha = "b".repeat(64);
  await db().query(
    `INSERT INTO receipt_blobs (sha256, bytes, content_type, byte_size)
     VALUES ($1, '\\x00'::bytea, 'image/png', 1) ON CONFLICT DO NOTHING`, [otherSha]);
  await db().query(
    `INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`, [`${TAG}-1`, otherSha]);
  const halfRead = await autoQueueApprovals();
  check("an expense with an unread SECOND receipt is left alone",
    halfRead.queued === 0, `${halfRead.queued} queued`);

  // A receipt the reader gave up on counts as unread, on purpose: three
  // failures is a reason for a person to look, not to wave it through.
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, legible, error, attempts)
     VALUES ($1,'test',false,'could not read it',3)
     ON CONFLICT (sha256) DO UPDATE SET error = 'could not read it', attempts = 3`, [otherSha]);
  const gaveUp = await autoQueueApprovals();
  check("…and one the reader gave up on still counts as unread",
    gaveUp.queued === 0, `${gaveUp.queued} queued`);

  // Read it properly and the expense qualifies.
  await db().query("UPDATE receipt_readings SET error = NULL WHERE sha256 = $1", [otherSha]);
  const bothRead = await autoQueueApprovals();
  check("…but once BOTH are read it goes through", bothRead.queued === 1,
    `${bothRead.queued} queued`);

  console.log("\n7b. A person's click is not marked automatic");
  {
    const byHand = await queueDecision({
      dedupeKey: `${TAG}-4`, decision: "approve", reason: "",
      decidedBy: OWNER,
      target: { employee: `${TAG} Person`, merchant: "MERCHANT 4", amount: 10.04, date: "2026-09-20" },
    });
    check("a decision queued by a person carries no automatic mark",
      byHand.ok && byHand.queued.automatic === false,
      byHand.ok ? String(byHand.queued.automatic) : byHand.error);
    if (byHand.ok) await db().query("DELETE FROM expense_decisions WHERE id = $1", [byHand.queued.id]);
  }

  console.log("\n8. Saying why nothing moved");
  // The report is the answer to "it is on and nothing is happening", which
  // before it existed had no answer anywhere in the app. It has to classify
  // by the SAME tests the pass uses — a report naming a different reason than
  // the one the pass acted on would be worse than no report at all.
  const clean5 = await add(5, "Office Supplies");
  const clean6 = await add(6, "Office Supplies");
  for (const key of [clean5, clean6]) {
    await db().query(
      `INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`, [key, sha]);
  }
  await runRules({ decide: false });

  const before = await autoApproveReport();
  const c = before.counts;
  check("every expense in the queue lands in exactly one bucket",
    c.flagged + c.decided + c.awaitingRules + c.awaitingReceipt + c.eligible === c.inbox,
    JSON.stringify(c));
  check("the rule-flagged one is counted as flagged", c.flagged >= 1, String(c.flagged));
  check("the ones already approved are counted as decided", c.decided >= 1, String(c.decided));
  check("the one with a second, unread receipt is counted as waiting on it",
    c.awaitingReceipt >= 1, String(c.awaitingReceipt));
  check("and the two genuinely clean ones are what it calls eligible",
    c.eligible === 2, String(c.eligible));

  // The number on the card has to be the number the pass acts on. perRun is
  // 2 here, so two eligible is exactly what a pass should take.
  const took = await autoQueueApprovals();
  check("…which is what a pass then queues", took.queued === 2, String(took.queued));
  const after = await autoApproveReport();
  check("…and they move from eligible to decided, not out of the count",
    after.counts.eligible === 0 && after.counts.decided === c.decided + 2,
    JSON.stringify(after.counts));
  check("…with the total unchanged", after.counts.inbox === c.inbox);

  console.log("\n9. The report explains a refusal too, without running one");
  await setFlag("autoApprove", false, OWNER);
  const offReport = await autoApproveReport();
  check("says it is switched off rather than showing nothing",
    /switched off/.test(offReport.blocked ?? ""), offReport.blocked ?? "(nothing)");
  check("…and still counts what would qualify if it were on",
    offReport.counts.inbox === c.inbox, `${offReport.counts.inbox} vs ${c.inbox}`);
  await setFlag("autoApprove", true, OWNER);

} finally {
  await db().query("DELETE FROM receipt_readings WHERE sha256 IN ($1,$2)",
    ["a".repeat(64), "b".repeat(64)]).catch(() => {});
  await db().query("DELETE FROM receipt_blobs WHERE sha256 IN ($1,$2)",
    ["a".repeat(64), "b".repeat(64)]).catch(() => {});
  await deleteCredential(OWNER).catch(() => {});
  await db().query("DELETE FROM expense_receipts WHERE dedupe_key LIKE $1", [`${TAG}%`]).catch(() => {});
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
