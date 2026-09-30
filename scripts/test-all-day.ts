/**
 * The all-day import schedule.
 *
 * The once-a-day shape is covered by verify-schedule.ts and test-scheduler.ts,
 * which pin `allDay: false` on purpose. This is the other shape: every slot
 * runs, and "is the data current?" stops meaning "did this morning work?" and
 * starts meaning "has anything arrived since the last slot that was due?"
 *
 * That second question is the whole point. On a once-a-day schedule the app
 * said "Today's export arrived" from 6:05am until midnight, which is true and
 * useless — it says nothing about whether the queue still matches Emburse.
 */

import { describeSchedule } from "../server/import/schedule.js";
import { slotsFor } from "../server/emburse/export-scheduler.js";
import type { Schedule } from "../server/import/settings.js";

const SCHEDULE: Schedule = {
  timezone: "America/Chicago",
  firstRun: "06:00",
  retryHours: 1,
  attemptsPerDay: 16, // 6am through 9pm
  graceMinutes: 90,
  allDay: true,
};

let failures = 0;
function check(label: string, got: unknown, want: unknown): void {
  const ok = got === want;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n        got  ${String(got)}\n        want ${String(want)}`}`);
  if (!ok) failures++;
}
function ok(label: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

const at = (s: string) => new Date(s);

// September, so America/Chicago is UTC-5: 06:00 local is 11:00Z.
console.log("\nthe slots are the times the import runs");
{
  const slots = slotsFor(SCHEDULE, "2026-09-22");
  check("sixteen of them", slots.length, 16);
  check("first at 6am CT", slots[0]!.toISOString(), "2026-09-22T11:00:00.000Z");
  check("last at 9pm CT", slots[15]!.toISOString(), "2026-09-23T02:00:00.000Z");
}

console.log("\nbefore the first run of the day, nothing is wrong and nothing is here");
{
  const r = describeSchedule(SCHEDULE, null, at("2026-09-22T09:00:00Z")); // 4am CT
  check("state", r.state, "waiting");
  check("next", r.nextAttemptAt, "2026-09-22T11:00:00.000Z");
  ok("says so", /First import of the day at 6:00 AM|First import of the day at 6:00 AM/.test(r.note), r.note);
}

console.log("\nan import that landed on the last due slot is current");
{
  // 6:20am CT arrival, asked at 7:30am CT — the 6am slot's grace has expired
  // and it delivered, the 7am slot has not been given its grace yet.
  const r = describeSchedule(SCHEDULE, at("2026-09-22T11:20:00Z"), at("2026-09-22T12:30:00Z"));
  check("state", r.state, "arrived");
  check("next is the 8am run", r.nextAttemptAt, "2026-09-22T13:00:00.000Z");
  ok("names the cadence", /every hour through the day/.test(r.note), r.note);
}

console.log("\nnothing since the last due slot means the import has stopped working");
{
  // Same 6:20am arrival, asked at 9am CT: the 7am slot is 90 minutes past due
  // and nothing has arrived since. On a once-a-day schedule this same moment
  // reported "Today's export arrived", which is how a dead import stayed
  // invisible until somebody noticed the queue was stale.
  const r = describeSchedule(SCHEDULE, at("2026-09-22T11:20:00Z"), at("2026-09-22T14:00:00Z"));
  check("state", r.state, "missed");
  ok("names what should have delivered", /Nothing has arrived since the /.test(r.note), r.note);
}

console.log("\novernight is quiet, not broken");
{
  // Last night's 9pm run delivered; it is now 5am and the first slot of the
  // new day has not come round. Nothing is due, so nothing is wrong.
  const r = describeSchedule(SCHEDULE, at("2026-09-23T02:05:00Z"), at("2026-09-23T10:00:00Z"));
  check("state", r.state, "arrived");
  check("next is this morning", r.nextAttemptAt, "2026-09-23T11:00:00.000Z");
  ok("dates the last import", /yesterday at 9:05/.test(r.note), r.note);
}

// The "a success no longer closes the day" half of this lives in
// test-scheduler.ts, against a real export_runs table — `nextDue` reads the
// database, and a rule re-implemented in the test is a rule that can drift
// away from the one that ships.

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
