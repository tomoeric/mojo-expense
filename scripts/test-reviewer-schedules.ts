/**
 * Eric and Brian on two different import timetables.
 *
 *   pnpm exec tsx scripts/test-reviewer-schedules.ts   (needs DATABASE_URL)
 *
 * The scheduler has always been able to do this — it asks "is an import
 * due" once per person and counts their attempts separately — and nothing
 * on any screen could say so, so both ran the shared schedule and the
 * capability may as well not have existed.
 *
 * It also checks the thing that broke it in passing: one row holds a
 * reviewer's schedule, their import list AND the switch that approves
 * spending unattended, and three different screens write to it. A save
 * that wrote every column meant flipping the automation switch silently
 * cleared the grid path that had just been set to separate two queues —
 * the fix for one problem undoing the fix for the other.
 */

process.env.SESSION_SECRET ||= "test-secret-schedules";

import { db, ensureSchema } from "../server/db.js";
import { deleteCredential, saveCredential } from "../server/emburse/credentials.js";
import { nextDue, reviewerImports, setReviewerImport } from "../server/emburse/export-scheduler.js";

const ERIC = "eric.s@test.invalid";
const BRIAN = "brian.c@test.invalid";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM export_runs WHERE reviewer IN ($1,$2)", [ERIC, BRIAN]);
  await db().query("DELETE FROM reviewer_imports WHERE user_email IN ($1,$2)", [ERIC, BRIAN]);
  await deleteCredential(ERIC).catch(() => false);
  await deleteCredential(BRIAN).catch(() => false);
};

const mine = async (who: string) =>
  (await reviewerImports()).find((r) => r.userEmail.toLowerCase() === who);

await ensureSchema();

try {
  await clean();
  await saveCredential(ERIC, ERIC, ERIC, "pw-eric");
  await saveCredential(BRIAN, BRIAN, BRIAN, "pw-brian");

  console.log("\n1. Both start on the shared schedule");
  check("Eric is shared", (await mine(ERIC))?.shared === true);
  check("Brian is shared", (await mine(BRIAN))?.shared === true);
  check("…and they have the same first run",
    (await mine(ERIC))?.schedule.firstRun === (await mine(BRIAN))?.schedule.firstRun);

  console.log("\n2. Brian gets his own times without touching Eric's");
  // The second stage of an approval chain is behind the first by
  // definition, so an afternoon start is the point of this.
  await setReviewerImport(BRIAN, {
    schedule: { timezone: "America/Chicago", firstRun: "13:00", retryHours: 2,
                attemptsPerDay: 3, graceMinutes: 30, allDay: true },
  }, "test");
  {
    const b = await mine(BRIAN);
    const e = await mine(ERIC);
    check("Brian's first run is his own", b?.schedule.firstRun === "13:00", b?.schedule.firstRun);
    check("…and he is no longer on the shared one", b?.shared === false);
    check("…three runs, two hours apart", b?.schedule.attemptsPerDay === 3 && b?.schedule.retryHours === 2);
    // The line this test exists for.
    check("Eric is untouched", e?.shared === true && e?.schedule.firstRun !== "13:00",
      e?.schedule.firstRun);
  }

  console.log("\n3. Their timelines are counted apart");
  // Each reviewer's attempts are their own, or the first one to run spends
  // everybody's and the rest never update.
  {
    const day = "2026-10-01";
    await db().query(
      `INSERT INTO export_runs (local_date, attempt, trigger, reviewer, source, ok)
       VALUES ($1,1,'scheduled',$2,'',true)`, [day, ERIC]);
    const sc = (await mine(BRIAN))!.schedule;
    const after = new Date("2026-10-01T23:00:00Z");
    const his = await nextDue(sc, after, BRIAN, "");
    const hers = await nextDue(sc, after, ERIC, "");
    check("Eric's run counted against Eric", hers.attempt >= 1);
    check("…and Brian still has all of his", his.attempt === 1,
      `${his.attempt}: ${his.reason}`);
  }

  console.log("\n4. One screen's save does not wipe another's setting");
  await setReviewerImport(BRIAN, { gridPath: "/transactions", gridSection: "inbox" }, "test");
  check("the path is set", (await mine(BRIAN))?.gridPath === "/transactions");
  check("…and his times survived it", (await mine(BRIAN))?.schedule.firstRun === "13:00");

  // The one that was actually broken: the approval switch and the grid path
  // are written by two different screens.
  await setReviewerImport(BRIAN, { autoApprove: true }, "test");
  {
    const b = await mine(BRIAN);
    check("the switch is on", b?.autoApprove === true);
    check("…and the path is still there", b?.gridPath === "/transactions", String(b?.gridPath));
    check("…and so are his times", b?.schedule.firstRun === "13:00", b?.schedule.firstRun);
  }

  console.log("\n5. And he can be put back on the shared schedule");
  await setReviewerImport(BRIAN, { schedule: null }, "test");
  {
    const b = await mine(BRIAN);
    check("he is shared again", b?.shared === true);
    check("…without losing his list", b?.gridPath === "/transactions");
    check("…or his switch", b?.autoApprove === true);
  }
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
