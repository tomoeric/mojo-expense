/**
 * Sending a matched receipt back, and the four ways not to.
 *
 *   pnpm exec tsx scripts/test-writeback.ts
 *
 * The owner's instructions, taken 2026-10-27, are the spec:
 * writable is the receipt image, the description and the
 * category; always ask; never submit. These check that the code
 * keeps them, and the three correctness rules underneath:
 *
 *   NOTHING RUNS WITHOUT A CLICK. A strong match does not queue
 *   itself, and proposing is not sending.
 *
 *   A RETRY DOES NOT DUPLICATE. "applied" and "already" are
 *   terminal, so a second pass cannot re-send a write that
 *   landed — including one that landed just as the step timed
 *   out, which is the ordinary case rather than the rare one.
 *
 *   IT WRITES TO THE ACCOUNT THE EXPENSE IS IN. A manager-queue
 *   expense is refused outright, because write-back is for your
 *   own expenses and the primary connection is a different
 *   tenant from a personal one.
 */
import { db, ensureSchema } from "../server/db.js";
import {
  noteFrom, proposeWrites, queueWrite, queuedWrites, settleWrite, writesFor,
} from "../server/emburse/receipt-writeback.js";
import { recordCandidates, decideMatch } from "../server/emburse/receipt-mail.js";
import { ensureDecisionsSchema } from "../server/emburse/decisions.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const TAG = `zz-wb-${Date.now()}`;
const ERIC = "eric.s@mojocarwash.com";
const MOJO = "personal-mojo";
const KEY = `${TAG}-mojo-1`;
const MGR = `${TAG}-mgr-1`;
const MSG = `${TAG}-msg`;

const evidence = (over: Record<string, unknown> = {}) => ({
  messageId: MSG, subject: "Your Starbucks receipt", from: "receipts@sbux-e.com",
  receivedAt: "2026-09-24T12:00:00Z", folder: "Receipts", merchant: "Starbucks",
  date: "2026-09-24", totalCents: 1299, currency: "USD", reference: "ABC-12345",
  hasAttachment: true,
  attachments: [{ id: "att-1", name: "receipt.pdf", contentType: "application/pdf", size: 9 }],
  excerpt: "Order Total $12.99",
  ...over,
}) as never;

const add = (key: string, lane: string, note = "") => db().query(
  `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                         category, department, location, note, method, in_inbox,
                         reviewer, source, lane)
   VALUES ($1,'Eric S','2026-09-24','STARBUCKS #4417',1299,'Meals','Ops','Site',$3,'Card',
           true,$4,'',$2)
   ON CONFLICT (dedupe_key) DO NOTHING`, [key, lane, note, ERIC]);

await ensureSchema();
await ensureDecisionsSchema();

try {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await add(KEY, MOJO);
  await add(MGR, "");

  console.log("1. The description it proposes is dull on purpose");
  check("it names the merchant, the date and the reference",
    noteFrom(evidence()) === "Receipt: Starbucks · 2026-09-24 · ref ABC-12345",
    noteFrom(evidence()));
  check("…and says nothing when the evidence is too thin",
    noteFrom(evidence({ merchant: "", date: null, reference: "" })) === "",
    noteFrom(evidence({ merchant: "", date: null, reference: "" })));
  check("…so no empty description is ever proposed",
    noteFrom(evidence({ merchant: "Starbucks", date: null, reference: "" })) === "");

  console.log("\n2. A receipt nobody chose cannot be proposed");
  const unchosen = await proposeWrites({ dedupeKey: KEY, messageId: MSG, by: ERIC });
  check("it is refused", unchosen.ok === false, unchosen.ok ? "" : unchosen.problem);
  check("…and says to choose it first",
    !unchosen.ok && unchosen.problem.includes("has not been chosen"),
    unchosen.ok ? "" : unchosen.problem);

  console.log("\n3. A chosen receipt proposes a receipt and a description");
  await recordCandidates([{
    dedupeKey: KEY, lane: MOJO, messageId: MSG, confidence: "strong", score: 80,
    reasons: ["ok"], evidence: evidence(),
  }]);
  await decideMatch({ dedupeKey: KEY, messageId: MSG, choose: true, by: ERIC });
  const proposed = await proposeWrites({ dedupeKey: KEY, messageId: MSG, by: ERIC });
  check("it is accepted", proposed.ok === true, proposed.ok ? "" : proposed.problem);
  if (!proposed.ok) throw new Error(proposed.problem);
  const kinds = proposed.writes.map((w) => w.kind).sort();
  check("both are proposed", kinds.join(",") === "note,receipt", kinds.join(","));
  check("…the receipt names the attachment",
    proposed.writes.find((w) => w.kind === "receipt")?.attachmentId === "att-1");
  check("…and the description records what the box reads NOW",
    proposed.writes.find((w) => w.kind === "note")?.was === "");
  check("…tagged with the account the EXPENSE is in",
    proposed.writes.every((w) => w.lane === MOJO));

  console.log("\n4. NOTHING RUNS WITHOUT A CLICK");
  check("proposing queues nothing",
    proposed.writes.every((w) => w.state === "proposed"),
    proposed.writes.map((w) => `${w.kind}:${w.state}`).join(", "));
  check("…and the worker has nothing to do",
    (await queuedWrites()).filter((w) => w.dedupeKey === KEY).length === 0);
  const sent = await queueWrite(KEY, "receipt");
  check("a person saying yes queues it", sent.ok === true, sent.problem ?? "");
  check("…and only that one", (await queuedWrites())
    .filter((w) => w.dedupeKey === KEY).map((w) => w.kind).join(",") === "receipt");

  console.log("\n5. A RETRY DOES NOT DUPLICATE");
  await settleWrite(KEY, "receipt", { state: "applied" });
  const again = await queueWrite(KEY, "receipt");
  check("an applied write cannot be sent again", again.ok === false,
    again.ok ? "it was queued" : again.problem ?? "");
  check("…and the reason says what state it is in",
    !again.ok && (again.problem ?? "").includes("applied"), again.problem ?? "");
  await settleWrite(KEY, "note", { state: "already" });
  check("neither can one Emburse already had",
    (await queueWrite(KEY, "note")).ok === false);
  // Re-proposing must not reopen either of them.
  await proposeWrites({ dedupeKey: KEY, messageId: MSG, by: ERIC });
  const after = await writesFor(KEY);
  check("…and re-proposing does not reopen them",
    after.every((w) => w.state === "applied" || w.state === "already"),
    after.map((w) => `${w.kind}:${w.state}`).join(", "));

  console.log("\n6. A failed or stale write CAN be tried again");
  await settleWrite(KEY, "receipt", { state: "failed", error: "selector" });
  check("a failure can be re-sent", (await queueWrite(KEY, "receipt")).ok === true);
  await settleWrite(KEY, "receipt", { state: "stale", error: "it changed" });
  check("…and so can one that went stale",
    (await queueWrite(KEY, "receipt")).ok === true);
  await settleWrite(KEY, "receipt", { state: "applied" });

  console.log("\n7. IT WRITES TO THE ACCOUNT THE EXPENSE IS IN");
  await recordCandidates([{
    dedupeKey: MGR, lane: "", messageId: MSG, confidence: "strong", score: 80,
    reasons: ["ok"], evidence: evidence(),
  }]);
  await decideMatch({ dedupeKey: MGR, messageId: MSG, choose: true, by: ERIC });
  const manager = await proposeWrites({ dedupeKey: MGR, messageId: MSG, by: ERIC });
  check("A MANAGER-QUEUE EXPENSE IS REFUSED", manager.ok === false,
    manager.ok ? "it was proposed" : "");
  check("…and says write-back is for your own expenses",
    !manager.ok && manager.problem.includes("personal account"),
    manager.ok ? "" : manager.problem);

  console.log("\n8. A description that says no more than the box does is not proposed");
  const same = `${TAG}-mojo-2`;
  await add(same, MOJO, "Receipt: Starbucks · 2026-09-24 · ref ABC-12345");
  await recordCandidates([{
    dedupeKey: same, lane: MOJO, messageId: MSG, confidence: "strong", score: 80,
    reasons: ["ok"], evidence: evidence(),
  }]);
  await decideMatch({ dedupeKey: same, messageId: MSG, choose: true, by: ERIC });
  const only = await proposeWrites({ dedupeKey: same, messageId: MSG, by: ERIC });
  check("only the receipt is proposed",
    only.ok && only.writes.map((w) => w.kind).join(",") === "receipt",
    only.ok ? only.writes.map((w) => w.kind).join(",") : only.problem);

} finally {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`])
    .catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
