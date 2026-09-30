/**
 * "The automation submitted n approvals since your last login."
 *
 * Two things have to be right for that sentence to be true, and they pull
 * against each other:
 *
 *   - The window must ROLL when somebody comes back after a gap, or the
 *     count is about some arbitrary earlier moment.
 *   - It must NOT roll while they are here, or the count resets every few
 *     seconds as the queue polls and the sentence never appears at all.
 *
 * Needs DATABASE_URL. Cleans up after itself.
 */

import { db } from "../server/db.js";
import { ensureVisits, noteVisit, whileAway } from "../server/visits.js";
import { decisionsFor } from "../server/emburse/decisions.js";

const WHO = "away-test@example.invalid";
const OWNER = "robot@example.invalid";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Force the stored last-seen back, standing in for time passing. */
async function seenMinutesAgo(minutes: number): Promise<void> {
  await db().query(
    `UPDATE user_visits SET last_seen_at = now() - ($2 || ' minutes')::interval WHERE email = $1`,
    [WHO, String(minutes)]);
}

/**
 * A visit, past the once-a-minute throttle.
 *
 * The same `noteVisit` the app calls, with its throttle waived — not a copy
 * of its statement. A test that reimplements the rule is a test that can
 * agree with itself while disagreeing with the app.
 */
const forceVisit = (): Promise<void> => noteVisit(WHO, { force: true });

const decision = async (appliedMinutesAgo: number, opts: {
  automatic?: boolean; state?: string; by?: string;
} = {}): Promise<void> => {
  await db().query(
    `INSERT INTO expense_decisions
       (dedupe_key, decision, decided_by, target, state, automatic, applied_at)
     VALUES ($1, 'approve', $2, '{}'::jsonb, $3, $4, now() - ($5 || ' minutes')::interval)`,
    [`away-${Math.random().toString(36).slice(2)}`, opts.by ?? OWNER,
     opts.state ?? "applied", opts.automatic ?? true, String(appliedMinutesAgo)]);
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM user_visits WHERE email = $1", [WHO]);
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE 'away-%'");
};

try {
  // Both tables, before anything tries to tidy them.
  await ensureVisits();
  await decisionsFor([]);
  await clean();

  console.log("\n1. A first-ever visit reports nothing");
  await forceVisit();
  let w = await whileAway(WHO);
  check("no window", w.from === null && w.to === null);
  check("…and no count", w.approved === 0);

  console.log("\n2. Coming back after a gap freezes the window that was missed");
  // Last here two hours ago; the automation worked through the night.
  await seenMinutesAgo(120);
  await decision(90);                       // inside the window
  await decision(60);                       // inside
  await decision(200);                      // before they left — not theirs to hear about
  await decision(90, { automatic: false }); // a person's own click
  await decision(90, { state: "failed" });  // queued, never landed
  await decision(90, { state: "cancelled" });
  await forceVisit();
  w = await whileAway(WHO);
  check("the window opened", w.from !== null && w.to !== null, `${w.from} → ${w.to}`);
  check("only the two that landed while away are counted", w.approved === 2, String(w.approved));
  check("…and none of them is theirs", w.mine === 0, String(w.mine));

  console.log("\n3. It does not roll while they are here");
  // This is the one that makes the feature usable rather than annoying: the
  // queue polls every few seconds, and a window that reopened on each poll
  // would report zero forever.
  const before = w.from;
  await forceVisit();
  await forceVisit();
  w = await whileAway(WHO);
  check("the window is the same one", w.from === before, `${w.from}`);
  check("…and the count has not reset", w.approved === 2, String(w.approved));

  console.log("\n4. An approval made under THEIR login is named as theirs");
  await clean();
  await forceVisit();
  await seenMinutesAgo(120);
  await decision(90, { by: WHO });
  await decision(90);
  await forceVisit();
  w = await whileAway(WHO);
  check("both counted", w.approved === 2, String(w.approved));
  check("…one of them theirs", w.mine === 1, String(w.mine));

  console.log("\n5. A short absence is not an absence");
  await clean();
  await forceVisit();
  await seenMinutesAgo(5);
  await decision(3);
  await forceVisit();
  w = await whileAway(WHO);
  check("no window opened for five minutes away", w.from === null);
  check("…so nothing is reported", w.approved === 0, String(w.approved));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
