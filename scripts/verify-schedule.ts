/**
 * Boundary checks for the export schedule that drives "next upload".
 *
 * Worth having as a script rather than a comment: the interesting cases are all
 * ones you cannot reach by running the app today — the grace window expiring, a
 * day being written off, and the two US DST switches, where 6am local is a
 * different UTC instant either side.
 *
 *   pnpm exec tsx scripts/verify-schedule.ts
 */

import { describeSchedule } from "../server/import/schedule.js";

const CT = (s: string) => new Date(s);
let pass = 0, fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

// America/Chicago, first run 06:00, retry 3h, 2 attempts, 90 min grace.
// Slots on a CDT day (UTC-5): 11:00Z and 14:00Z.

// 1. Before the first slot, nothing yet today.
let r = describeSchedule(null, CT("2026-09-22T09:00:00Z"));
check("pre-first-slot state", r.state, "waiting");
check("pre-first-slot next", r.nextAttemptAt, "2026-09-22T11:00:00.000Z");
check("pre-first-slot note", r.note, "Next export at 6:00 AM.");

// 2. Just after the first slot, still inside grace.
r = describeSchedule(null, CT("2026-09-22T11:30:00Z"));
check("in-grace state", r.state, "waiting");
check("in-grace next", r.nextAttemptAt, "2026-09-22T11:00:00.000Z");
check("in-grace note", r.note, "Export ran at 6:00 AM; allowing up to 90 min for it to arrive.");

// 3. First slot grace expired (11:00 + 90m = 12:30) -> rolls to the retry.
r = describeSchedule(null, CT("2026-09-22T12:31:00Z"));
check("after-first-grace state", r.state, "waiting");
check("after-first-grace next", r.nextAttemptAt, "2026-09-22T14:00:00.000Z");
check("after-first-grace note", r.note, "Next export at 9:00 AM.");

// 4. Both slots' grace expired (14:00 + 90m = 15:30) -> written off, tomorrow.
r = describeSchedule(null, CT("2026-09-22T15:31:00Z"));
check("both-failed state", r.state, "missed");
check("both-failed next", r.nextAttemptAt, "2026-09-23T11:00:00.000Z");
check("both-failed note", r.note,
  "No export today — all 2 attempts passed without one arriving. Next attempt tomorrow at 6:00 AM.");

// 5. An export landed after the first slot.
r = describeSchedule(CT("2026-09-22T11:20:00Z"), CT("2026-09-22T15:31:00Z"));
check("arrived state", r.state, "arrived");
check("arrived next", r.nextAttemptAt, "2026-09-23T11:00:00.000Z");
check("arrived note", r.note, "Today's export arrived. Next expected tomorrow at 6:00 AM.");

// 6. Yesterday's export does not count as today's.
r = describeSchedule(CT("2026-09-21T11:20:00Z"), CT("2026-09-22T09:00:00Z"));
check("stale import not counted", r.state, "waiting");
check("stale import preserved", r.lastImportAt, "2026-09-21T11:20:00.000Z");

// 7. DST: 2026-11-01 is the CDT->CST switch. Nov 2 is CST (UTC-6) => 12:00Z.
r = describeSchedule(null, CT("2026-11-02T10:00:00Z"));
check("CST slot is 12:00Z", r.slots[0], "2026-11-02T12:00:00.000Z");
check("CST retry is 15:00Z", r.slots[1], "2026-11-02T15:00:00.000Z");

// 8. The switch day itself: 06:00 local on 2026-11-01 is after the 2am fallback.
r = describeSchedule(null, CT("2026-11-01T05:00:00Z"));
check("DST-day slot is 12:00Z", r.slots[0], "2026-11-01T12:00:00.000Z");

// 9. Spring forward 2026-03-08. 05:00Z is still Mar 7 locally (23:00 CST),
//     so that instant must yield Mar 7's slot at 12:00Z...
r = describeSchedule(null, CT("2026-03-08T05:00:00Z"));
check("pre-switch local day is the 7th", r.slots[0], "2026-03-07T12:00:00.000Z");
//     ...while mid-morning on the 8th is CDT, putting 06:00 local at 11:00Z.
r = describeSchedule(null, CT("2026-03-08T15:00:00Z"));
check("spring-forward slot", r.slots[0], "2026-03-08T11:00:00.000Z");
check("spring-forward retry", r.slots[1], "2026-03-08T14:00:00.000Z");

// 10. UTC has rolled over but the local day has not: 04:30Z on the 23rd is
//     23:30 on the 22nd in CT, so the slots reported are still the 22nd's and
//     the next attempt is the 23rd's first.
r = describeSchedule(null, CT("2026-09-23T04:30:00Z"));
check("late-evening local day", r.slots[0], "2026-09-22T11:00:00.000Z");
check("late-evening state", r.state, "missed");
check("late-evening next", r.nextAttemptAt, "2026-09-23T11:00:00.000Z");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
