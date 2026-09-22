/**
 * The decision queue: its rules, and the batch that applies it.
 *
 *   pnpm exec tsx scripts/test-decisions.ts     (needs DATABASE_URL + a browser)
 *
 * What is worth protecting here is different from the matching in
 * test-decide.ts. That proves the right row is found. This proves the right
 * things are asked of the queue: a denial cannot be recorded without a reason,
 * one expense cannot have two decisions in flight, a decision can be taken
 * back before it lands, and a batch that hits one bad expense still applies
 * the good ones.
 */

import { db, ensureSchema } from "../server/db.js";
import { startMock } from "./mock-emburse.js";

const mock = await startMock(5405, "/dev/null");
process.env.EMBURSE_LOGIN_URL = mock.url;
process.env.EMBURSE_LOGIN_EMAIL ||= "bot@example.invalid";
process.env.EMBURSE_LOGIN_PASSWORD ||= "x";
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "12000";
process.env.EMBURSE_SIGN_IN_WAIT_MS ||= "20000";

const {
  queueDecision, pendingDecisions, cancelDecision, settleDecision, decisionsFor, recentDecisions,
} = await import("../server/emburse/decisions.js");
const { saveCredential, deleteCredential, credentialForUser, hasCredential } =
  await import("../server/emburse/credentials.js");
const { runDecisions } = await import("../server/emburse/decide.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();

// Two expenses that exist, matching rows the mock's grid serves.
const BRIANNA = "test-brianna-2640";
const KEVIN = "test-kevin-2640";
// Touch the queue once so its table exists before anything tidies up after
// itself — the schema is created on first use, not at boot.
await pendingDecisions();
await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE 'test-%'");
await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'test-%'");
await db().query(
  `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents)
   VALUES ($1,'Brianna Ruth','2026-09-13','DOORDASH INC.',2640),
          ($2,'Kevin McBride','2026-09-13','DOORDASH INC.',2640)`,
  [BRIANNA, KEVIN]);

const target = (employee: string) => ({
  employee, merchant: "DOORDASH INC.", amount: 26.4, date: "2026-09-13",
});

console.log("\n1. A denial needs a reason");
let r = await queueDecision({
  dedupeKey: BRIANNA, decision: "deny", reason: "  ", decidedBy: "eric@example.invalid",
  target: target("Brianna Ruth"),
});
check("an empty reason is refused", !r.ok, r.ok ? "accepted" : r.error);
check("…and nothing was queued", (await pendingDecisions()).length === 0);

r = await queueDecision({
  dedupeKey: BRIANNA, decision: "deny", reason: "No itemised receipt attached.",
  decidedBy: "eric@example.invalid", target: target("Brianna Ruth"),
});
check("a real reason is accepted", r.ok, r.ok ? "" : r.error);

console.log("\n2. One decision in flight per expense");
const again = await queueDecision({
  dedupeKey: BRIANNA, decision: "approve", reason: "", decidedBy: "eric@example.invalid",
  target: target("Brianna Ruth"),
});
check("a second is refused while the first waits", !again.ok,
  again.ok ? "accepted" : again.error);
check("…and says so in words", !again.ok && /already waiting/.test(again.error), "");

console.log("\n3. Taking one back");
const queued = (await pendingDecisions())[0]!;
check("it can be cancelled before it is applied", await cancelDecision(queued.id, "eric@example.invalid"));
check("…and cancelling twice is refused", !(await cancelDecision(queued.id, "eric@example.invalid")));
check("…and the queue is empty again", (await pendingDecisions()).length === 0);
check("…and a fresh decision is allowed now",
  (await queueDecision({
    dedupeKey: BRIANNA, decision: "approve", reason: "", decidedBy: "eric@example.invalid",
    target: target("Brianna Ruth"),
  })).ok);

console.log("\n4. An approval needs no reason");
check("approving with no reason is fine", (await pendingDecisions()).length === 1);

console.log("\n5. What the queue page is told");
await queueDecision({
  dedupeKey: KEVIN, decision: "deny", reason: "Duplicate of Brianna's.",
  decidedBy: "brian@example.invalid", target: target("Kevin McBride"),
});
const byExpense = await decisionsFor([BRIANNA, KEVIN, "nothing-here"]);
check("each expense finds its own decision", byExpense.size === 2, `${byExpense.size}`);
check("…with who made it", byExpense.get(KEVIN)?.decidedBy === "brian@example.invalid",
  byExpense.get(KEVIN)?.decidedBy ?? "none");
check("…and the reason", byExpense.get(KEVIN)?.reason === "Duplicate of Brianna's.");
check("…and the cancelled one is not shown as current",
  byExpense.get(BRIANNA)?.decision === "approve", byExpense.get(BRIANNA)?.decision ?? "none");

// --------------------------------------------------------------- the batch
console.log("\n6. A batch applies each decision independently");
mock.reset();
const items = [
  { id: 1, decision: "approve" as const, target: target("Brianna Ruth"), reason: null },
  // Nobody by this name is in the grid, so this one must fail on its own.
  { id: 2, decision: "approve" as const, target: { ...target("Nobody Here"), amount: 999.99 }, reason: null },
  { id: 3, decision: "approve" as const, target: target("Kevin McBride"), reason: null },
];
const SEL = {
  loginEmail: 'input[name="username"]', loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"]', loggedIn: 'a:has-text("Transactions")',
  adminTab: 'a:has-text("ADMIN")', grid: "table", gridPath: "/transactions/team",
  resultRow: "table tbody tr", approveButton: 'button:has-text("APPROVE")',
};
const results = await runDecisions(items, SEL, mock.url,
  { userId: null, email: "bot@example.invalid", password: "x" }, { dryRun: true });

check("every item gets an answer", results.size === 3, `${results.size}`);
check("the one that matches succeeds", results.get(1)?.ok === true,
  results.get(1)?.steps.find((s) => !s.ok)?.detail ?? "");
check("the one that does not, fails", results.get(2)?.ok === false);
check("…without stopping the rest", results.get(3)?.ok === true,
  results.get(3)?.steps.find((s) => !s.ok)?.detail ?? "");
check("…and the failure says why",
  /none of the .* rows match/.test(results.get(2)?.steps.find((s) => !s.ok)?.detail ?? ""),
  results.get(2)?.steps.find((s) => !s.ok)?.detail?.slice(0, 80) ?? "");
check("the right row is recorded for the audit",
  /Brianna Ruth/.test(results.get(1)?.matchedRow ?? ""), results.get(1)?.matchedRow ?? "none");
check("…and it is Brianna's, not Kevin's",
  !/Kevin/.test(results.get(1)?.matchedRow ?? ""), results.get(1)?.matchedRow ?? "");

// Signing in once for the batch is the whole reason it exists.
const signIns = results.get(3)?.steps.filter((s) => s.name === "sign in").length ?? 0;
check("the batch signed in once, not once per decision", signIns === 1, `${signIns} sign-in step(s)`);

// ------------------------------------------ whose name ends up on the decision
// Emburse records an approval against whichever account signed in. Applying
// Brian's denial under Eric's login would put Eric's name on a decision he
// did not make — in the finance system, permanently, where nobody would think
// to doubt it. So a decision is carried out as its decider or not at all.
console.log("\n8. A decision is applied as the person who made it");
await deleteCredential("u-brian");
await deleteCredential("u-eric");
await saveCredential("u-brian", "brian@example.invalid", "brian@mojocarwash.com", "brians-password");

check("Brian can decide, because the app can act as him", await hasCredential("brian@example.invalid"));
check("Eric cannot, having stored nothing", !(await hasCredential("eric@example.invalid")));
check("…and case does not decide it", await hasCredential("Brian@Example.Invalid"));

const brian = await credentialForUser("brian@example.invalid");
check("Brian's own Emburse login is what comes back",
  brian?.email === "brian@mojocarwash.com", brian?.email ?? "none");
check("…with his own password", brian?.password === "brians-password");

check("somebody with no login gets nothing rather than somebody else's",
  (await credentialForUser("eric@example.invalid")) === null);

// The failure that would be worst: falling back to whoever happens to have a
// credential stored. There is exactly one stored here, so a fallback would
// silently hand Eric's decisions to Brian's account.
const forEric = await credentialForUser("eric@example.invalid");
check("…and specifically not the only credential that exists",
  forEric === null, forEric ? `fell back to ${(forEric as { email: string }).email}` : "refused");

await deleteCredential("u-brian");

console.log("\n7. Settling writes the record");
const pend = await pendingDecisions();
await settleDecision(pend[0]!.id, { ok: true, matchedRow: "9/13/2026 DOORDASH INC. Brianna Ruth $26.40" });
await settleDecision(pend[1]!.id, { ok: false, error: "none of the 3 rows match this expense" });
const after = await recentDecisions(10);
check("the applied one is marked applied",
  after.find((d) => d.id === pend[0]!.id)?.state === "applied");
check("…with the row it hit", /Brianna Ruth/.test(after.find((d) => d.id === pend[0]!.id)?.matchedRow ?? ""));
check("…and a time", after.find((d) => d.id === pend[0]!.id)?.appliedAt !== null);
check("the failed one is marked failed",
  after.find((d) => d.id === pend[1]!.id)?.state === "failed");
check("…with the reason kept", /none of the 3 rows/.test(after.find((d) => d.id === pend[1]!.id)?.error ?? ""));
check("…and the queue is empty", (await pendingDecisions()).length === 0);

await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE 'test-%'");
await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'test-%'");
await mock.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
