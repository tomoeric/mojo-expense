/**
 * When a reminder goes out.
 *
 *   pnpm exec tsx scripts/test-reminders.ts
 *
 * A scheduler has two ways to be wrong and both are quiet: it never
 * fires, or it fires over and over. The second is worse — a restart
 * loop would mail the same digest every minute — so the slot it last
 * sent is recorded and compared, and that is what most of this checks.
 *
 * Midnight and noon are tested on their own because 12 AM is hour 0
 * and 12 PM is hour 12, and getting that backwards sends the morning
 * reminder at midnight.
 */
import { isDue, wallClock } from "../server/dutch-miller/reminders.js";
import { hour24 } from "../server/dutch-miller/settings.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const at = (dayIndex: number, hour: number, minute: number, stamp = "s") =>
  ({ dayIndex, hour, minute, stamp });

const every = {
  enabled: true, days: [0, 1, 2, 3, 4], hour: 8, minute: 30,
  meridiem: "AM" as const, lastSentAt: null,
};

console.log("1. Twelve-hour clock");
check("8 AM is 8", hour24(8, "AM") === 8);
check("8 PM is 20", hour24(8, "PM") === 20);
check("12 AM is midnight, not noon", hour24(12, "AM") === 0, String(hour24(12, "AM")));
check("12 PM is noon, not midnight", hour24(12, "PM") === 12, String(hour24(12, "PM")));

console.log("\n2. Due, or not");
check("on a chosen day at the time", isDue(every, at(1, 8, 30)));
check("not a minute early", !isDue(every, at(1, 8, 29)));
check("not a minute late", !isDue(every, at(1, 8, 31)));
check("not an hour out", !isDue(every, at(1, 9, 30)));
check("not on a day that was not chosen", !isDue(every, at(5, 8, 30)));
check("not when switched off", !isDue({ ...every, enabled: false }, at(1, 8, 30)));
check("not with no days at all", !isDue({ ...every, days: [] }, at(1, 8, 30)));

console.log("\n3. The same minute, twice");
// The restart case: the slot is recorded, so coming back up inside the
// same minute does not send a second one.
const slot = at(1, 8, 30, "2026-10-26 08:30");
check("the first time, yes", isDue({ ...every, lastSentAt: null }, slot));
check("the second time, no", !isDue({ ...every, lastSentAt: slot.stamp }, slot));
check("…but the next week, yes again",
  isDue({ ...every, lastSentAt: "2026-10-19 08:30" }, slot));

console.log("\n4. Weekly");
const weekly = { ...every, days: [2] };
check("fires on its day", isDue(weekly, at(2, 8, 30)));
check("…and no other", !isDue(weekly, at(3, 8, 30)) && !isDue(weekly, at(1, 8, 30)));

console.log("\n5. Evening and midnight");
check("8 PM", isDue({ ...every, meridiem: "PM" }, at(1, 20, 30)));
check("12 AM is hour 0",
  isDue({ ...every, hour: 12, meridiem: "AM", minute: 0 }, at(1, 0, 0)));
check("…and not hour 12",
  !isDue({ ...every, hour: 12, meridiem: "AM", minute: 0 }, at(1, 12, 0)));

console.log("\n6. The clock itself");
const now = wallClock(new Date("2026-10-26T13:30:00Z"));
check("a Monday reads as Monday", now.dayIndex === 0, String(now.dayIndex));
check("…in Chicago, not UTC", now.hour === 8, String(now.hour));
check("…and the slot is to the minute", now.stamp === "2026-10-26 08:30", now.stamp);
const sunday = wallClock(new Date("2026-11-01T13:30:00Z"));
check("Sunday is last in the week, not first", sunday.dayIndex === 6, String(sunday.dayIndex));

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
