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
import { gridPathFor, nextDue, reviewerImports, setReviewerImport } from "../server/emburse/export-scheduler.js";

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
  // NOT the same first run, deliberately — see 1b. Two scopes cannot share
  // import times, because one browser runs them one at a time.
  check("…but not the same minute",
    (await mine(ERIC))?.schedule.firstRun !== (await mine(BRIAN))?.schedule.firstRun,
    `${(await mine(ERIC))?.schedule.firstRun} vs ${(await mine(BRIAN))?.schedule.firstRun}`);

  console.log("\n1b. Two reviewers on the shared schedule never share a slot");
  // One browser runs them one at a time, so a shared minute means the
  // second waits out the first — and on an export Emburse takes fifteen
  // minutes to build, that can push it past its own grace window and be
  // recorded as a miss it never had a chance at.
  {
    const all = await reviewerImports();
    const times = all.map((r) => r.schedule.firstRun);
    check("their first runs differ", new Set(times).size === times.length, times.join(" vs "));
    check("…and one of them is still the shared time",
      times.includes((await mine(ERIC))!.schedule.firstRun));
    check("…both still count as on the shared schedule",
      all.every((r) => r.shared), all.map((r) => r.shared).join(","));
    // Stable, or a reviewer whose slot moved whenever somebody else signed
    // in would miss every one of them.
    const again = (await reviewerImports()).map((r) => r.schedule.firstRun);
    check("…and the offsets do not move between ticks",
      again.join() === times.join(), `${times.join()} then ${again.join()}`);
  }

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
  console.log("\n6. Stages belong to a reviewer, not to the deployment");
  // The last shared thing on the import page. Unticking a stage while
  // reading one person's tab changed every person's import — a shared
  // setting wearing a per-reviewer tab's clothes.
  check("Brian inherits until he sets his own", (await mine(BRIAN))?.sections === null);
  await setReviewerImport(BRIAN, { sections: ["Needs Review"] }, "test");
  await setReviewerImport(ERIC, { sections: ["Needs Review", "Denied"] }, "test");
  {
    const b = await mine(BRIAN);
    const e = await mine(ERIC);
    check("Brian's are his", JSON.stringify(b?.sections) === JSON.stringify(["Needs Review"]),
      JSON.stringify(b?.sections));
    check("…and Eric's are untouched by them",
      JSON.stringify(e?.sections) === JSON.stringify(["Needs Review", "Denied"]),
      JSON.stringify(e?.sections));
    check("…and setting them kept his list", b?.gridPath === "/transactions");
  }
  // And the same no-clobber rule, in the other direction.
  await setReviewerImport(BRIAN, { autoApprove: false }, "test");
  check("a switch save leaves his stages alone",
    JSON.stringify((await mine(BRIAN))?.sections) === JSON.stringify(["Needs Review"]));
  await setReviewerImport(BRIAN, { sections: [] }, "test");
  check("…and an empty list puts him back on the defaults",
    (await mine(BRIAN))?.sections === null);
  console.log("\n7. The list a reviewer picked is the list the run opens");
  // It was not. The Transactions source has the EMPTY key, the scheduler
  // passes source:"" for it, the lookup matched every time, and the guard
  // that was meant to let a reviewer's own path through never fired — so
  // picking a tab did nothing and the import kept reading the old list.
  {
    const def = { path: "/transactions/team" };
    const other = { path: "/reimbursements" };
    check("their own list wins over the default",
      gridPathFor("", def, { gridPath: "/transactions" }) === "/transactions",
      String(gridPathFor("", def, { gridPath: "/transactions" })));
    check("…and over the default when the source is simply absent",
      gridPathFor(undefined, def, { gridPath: "/transactions" }) === "/transactions");
    check("…but never over a list that was actually asked for",
      gridPathFor("reimbursements", other, { gridPath: "/transactions" }) === "/reimbursements");
    check("a reviewer with none still gets the default",
      gridPathFor("", def, { gridPath: null }) === "/transactions/team");
  }
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
