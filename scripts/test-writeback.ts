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
  noteFrom, noteFromReading, proposeWrites, queueWrite, queuedWrites, settleWrite,
  writesFor,
  mergeNote,
} from "../server/emburse/receipt-writeback.js";
import { recordCandidates, decideMatch } from "../server/emburse/receipt-mail.js";
import { ensureDecisionsSchema } from "../server/emburse/decisions.js";
import { selectorsForLane } from "../server/emburse/decision-worker.js";
import { PERSONAL_GRID, MANAGER_GRID } from "../server/emburse/export-scheduler.js";

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

  console.log("\n9. Once the receipt is READ, the fill comes from it");
  /*
   * The reason the image is pulled in and linked before anything
   * is sent. The email's subject line says "Your receipt from
   * Starbucks"; the receipt says what was bought, when, and for
   * how much — and the reader that extracts all that already
   * exists and runs on every other receipt in the app.
   */
  const fromEmail = noteFromReading(null, evidence());
  check("with no reading, it falls back to the email",
    fromEmail.from === "email"
    && fromEmail.note === "Receipt: Starbucks · 2026-09-24 · ref ABC-12345",
    `${fromEmail.from}: ${fromEmail.note}`);

  const read = noteFromReading({
    legible: true, merchant: "STARBUCKS STORE 4417", purchasedAt: "2026-09-24",
    totalCents: 1299, items: ["Grande Latte", "Turkey Sandwich", "Tax"],
  }, evidence());
  check("with one, it uses the receipt", read.from === "receipt", read.note);
  check("…naming what was bought", read.note.includes("Grande Latte"), read.note);
  check("…and the total the receipt itself states",
    read.note.includes("$12.99"), read.note);

  const many = noteFromReading({
    legible: true, merchant: "KROGER", purchasedAt: "2026-09-24", totalCents: 8400,
    items: ["Milk", "Bread", "Eggs", "Coffee", "Apples", "Cheese"],
  }, evidence());
  check("a long list is summarised, not pasted",
    many.note.includes("+3 more") && !many.note.includes("Cheese"), many.note);

  const illegible = noteFromReading({
    legible: false, merchant: null, purchasedAt: null, totalCents: null, items: [],
  }, evidence());
  check("AN ILLEGIBLE RECEIPT FALLS BACK rather than writing nothing",
    illegible.from === "email" && illegible.note.length > 0, illegible.note);
  const thin = noteFromReading({
    legible: true, merchant: "KROGER", purchasedAt: null, totalCents: null, items: [],
  }, evidence({ merchant: "", date: null, reference: "" }));
  check("…and a reading too thin to say anything proposes nothing",
    thin.note === "", thin.note);

  /*
   * AND IT LOOKS FOR THE ROW IN THE TAB'S OWN GRID.
   *
   * The deployment's `gridPath` is the team-wide list, which is
   * the approver's queue. A write-back signs in to the PERSONAL
   * account and then searched that list: the row is not there, so
   * the send failed with "not in the queue" after signing in and
   * searching — or, on a tenant where the same merchant and
   * amount recur, found a different row and annotated THAT one.
   * The same held for a category correction.
   */
  console.log("\n10. The row is looked for in the tab’s own grid");
  const team = { gridPath: MANAGER_GRID, gridQuery: "" };
  const forMojo = await selectorsForLane(ERIC, MOJO, team);
  check("a personal tab searches its own list",
    forMojo.gridPath === PERSONAL_GRID, String(forMojo.gridPath));
  // The manager queue is the one thing that must not move: it has been
  // reading the team grid since before tabs existed.
  const forManager = await selectorsForLane(ERIC, "", team);
  check("THE MANAGER QUEUE IS UNTOUCHED",
    forManager.gridPath === MANAGER_GRID, String(forManager.gridPath));
  check("…and it is the same object, so nothing else can have changed",
    forManager === team);
  // A lane nobody has configured still must not fall back to the team
  // grid: a non-empty lane is a personal tab by construction.
  const unknown = await selectorsForLane(ERIC, "personal-invented", team);
  check("an unconfigured tab still does NOT get the team grid",
    unknown.gridPath === PERSONAL_GRID, String(unknown.gridPath));

  /*
   * 11. THE DESCRIPTION IS ADDED TO, NOT REPLACED. Owner's call,
   * 2026-10-31.
   *
   * The proposal used to BE the description, so sending it wiped
   * "IT & Compliance Department Spend" off an expense and put the
   * receipt line in its place — across 272 expenses at once, with no
   * copy of the old text anywhere but the `was` column here.
   *
   * Idempotence is the hard half: a proposal is recomputed on every
   * read and improves once the reader has been over the image, so the
   * same expense is offered a note repeatedly. A plain append would
   * stack "… · Receipt: X · Receipt: X" on the second pass.
   */
  console.log("\n11. The receipt line is added to the description, not put in its place");
  const LINE = "Receipt: Replit · 2026-08-11 · ref 1359-4607";
  check("an existing note is kept, with the receipt after it",
    mergeNote("IT & Compliance Department Spend", LINE)
      === `IT & Compliance Department Spend · ${LINE}`,
    mergeNote("IT & Compliance Department Spend", LINE));
  check("an empty description just gets the line", mergeNote("", LINE) === LINE);
  check("…and whitespace counts as empty", mergeNote("   ", LINE) === LINE);
  check("NOTHING IS STACKED when it is already there",
    mergeNote(`IT & Compliance Department Spend · ${LINE}`, LINE)
      === `IT & Compliance Department Spend · ${LINE}`,
    mergeNote(`IT & Compliance Department Spend · ${LINE}`, LINE));
  // The line improves once the AI reader has read the image, and the
  // better one must take the worse one's place rather than sit beside it.
  const BETTER = "Receipt: REPLIT · 2026-08-11 · $84.23 · Core plan";
  check("a better line replaces an earlier receipt line",
    mergeNote(`IT & Compliance Department Spend · ${LINE}`, BETTER)
      === `IT & Compliance Department Spend · ${BETTER}`,
    mergeNote(`IT & Compliance Department Spend · ${LINE}`, BETTER));
  check("…and with no note of their own, it is just the better line",
    mergeNote(LINE, BETTER) === BETTER, mergeNote(LINE, BETTER));
  // Nothing to add is not a reason to touch the description at all.
  check("an empty line leaves the description alone",
    mergeNote("IT & Compliance Department Spend", "")
      === "IT & Compliance Department Spend");

} finally {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`])
    .catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
