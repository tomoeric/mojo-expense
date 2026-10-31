/**
 * A re-scan takes candidates AWAY, not only adds them.
 *
 *   pnpm exec tsx scripts/test-match-prune.ts
 *
 * The bug this is here for: the matcher was tightened, the owner
 * pressed Search again, and the number on the page did not move.
 * Nothing was wrong with the new answer — it was written on top
 * of the old one, and `recordCandidates` has no way to remove a
 * pairing it no longer believes in. Four hundred and seventeen
 * cards, all of them still there.
 *
 * And the line that must NOT be crossed: a decision somebody made
 * is not a candidate and a re-scan is not an argument against it.
 */
import { db } from "../server/db.js";
import {
  decideMatch, matchesFor, pruneCandidates, recordCandidates,
  type Candidate, type Evidence,
} from "../server/emburse/receipt-mail.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const LANE = "zz-prune-lane";
const evidence = (id: string): Evidence => ({
  messageId: id, subject: "Your Replit receipt", from: "invoice@mail.replit.com",
  receivedAt: "2026-10-24T12:00:00Z", folder: "Receipts", merchant: "Replit",
  date: "2026-10-24", totalCents: 10660, currency: "USD", reference: "",
  hasAttachment: false, attachments: [], excerpt: "Amount due $106.60",
});
const cand = (key: string, msg: string): Candidate => ({
  dedupeKey: key, lane: LANE, messageId: msg, confidence: "strong", score: 80,
  reasons: ["Same date."], evidence: evidence(msg),
});

const clean = async () => {
  await db().query("DELETE FROM receipt_mail_matches WHERE lane = $1", [LANE]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-p-%'");
};

/** The matches table points at real expenses, so they have to exist. */
const expense = (key: string) => db().query(
  `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                         category, department, location, note, method, in_inbox,
                         reviewer, source, lane)
   VALUES ($1,'Eric S','2026-10-24','REPLIT',10660,'Software','IT','','','Card',true,
           'eric.s@mojocarwash.com','',$2)
   ON CONFLICT (dedupe_key) DO NOTHING`, [key, LANE]);

try {
  await clean();
  for (const k of ["zz-p-1", "zz-p-2", "zz-p-3", "zz-p-other"]) await expense(k);

  console.log("1. The loose answer, as a first scan would leave it");
  await recordCandidates([
    cand("zz-p-1", "m1"), cand("zz-p-1", "m2"), cand("zz-p-1", "m3"),
    cand("zz-p-2", "m1"), cand("zz-p-2", "m2"),
  ]);
  check("five pairings are stored",
    (await matchesFor(LANE)).length === 5,
    String((await matchesFor(LANE)).length));

  console.log("\n2. The tighter answer replaces it, rather than joining it");
  const kept = [cand("zz-p-1", "m1"), cand("zz-p-2", "m2")];
  const removed = await pruneCandidates([LANE], kept);
  await recordCandidates(kept);
  check("the three it no longer stands behind are gone", removed === 3, String(removed));
  const after = await matchesFor(LANE);
  check("TWO ARE LEFT, which is what the page would show", after.length === 2,
    after.map((m) => `${m.dedupeKey}:${m.messageId}`).join(", "));
  check("…and they are the right two",
    after.some((m) => m.dedupeKey === "zz-p-1" && m.messageId === "m1")
    && after.some((m) => m.dedupeKey === "zz-p-2" && m.messageId === "m2"),
    after.map((m) => `${m.dedupeKey}:${m.messageId}`).join(", "));

  console.log("\n3. A DECISION IS NOT A CANDIDATE and survives a re-scan");
  await recordCandidates([cand("zz-p-3", "m9")]);
  await decideMatch({
    dedupeKey: "zz-p-3", messageId: "m9", choose: true, by: "eric.s@mojocarwash.com",
  });
  const gone = await pruneCandidates([LANE], []);
  const left = await matchesFor(LANE);
  check("every remaining candidate goes", gone === 2, String(gone));
  check("…and the chosen one stays", left.length === 1 && left[0]!.state === "chosen",
    left.map((m) => `${m.dedupeKey}:${m.state}`).join(", "));

  console.log("\n4. Another account's candidates are not touched");
  await db().query(
    `INSERT INTO receipt_mail_matches (dedupe_key, message_id, lane, confidence, score,
                                       reasons, evidence)
     VALUES ('zz-p-other','m1','zz-other-lane','strong',80,'[]'::jsonb,'{}'::jsonb)
     ON CONFLICT DO NOTHING`);
  await pruneCandidates([LANE], []);
  const { rows } = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM receipt_mail_matches WHERE lane = 'zz-other-lane'");
  check("it is still there", rows[0]!.n === "1", rows[0]!.n);
} finally {
  await clean().catch(() => undefined);
  await db().query("DELETE FROM receipt_mail_matches WHERE lane = 'zz-other-lane'")
    .catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
}
