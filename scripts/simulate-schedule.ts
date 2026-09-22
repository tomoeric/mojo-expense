/**
 * Print what the Import page's schedule strip will say, hour by hour, for the
 * schedule currently configured in the environment.
 *
 * `verify-schedule.ts` asserts the logic is right. This answers a different
 * question — is the *configuration* right? — which matters because EXPORT_* has
 * to agree with a Task Scheduler trigger on a laptop, and the two drifting apart
 * is silent. Seeing the whole day at once catches a wrong timezone or a
 * first-run hour that lands before anyone is awake.
 *
 *   pnpm exec tsx scripts/simulate-schedule.ts
 *   EXPORT_FIRST_RUN=06:00 EXPORT_ATTEMPTS_PER_DAY=3 pnpm exec tsx scripts/simulate-schedule.ts
 *
 * Pass an hour (0-23, local to EXPORT_TIMEZONE) at which an export arrives, to
 * see the strip flip to the arrived state:
 *
 *   pnpm exec tsx scripts/simulate-schedule.ts --arrives-at 9
 */

import { describeSchedule } from "../server/import/schedule.js";
import { env } from "../server/env.js";

const arg = process.argv.indexOf("--arrives-at");
const arrivesAtHour = arg === -1 ? null : Number(process.argv[arg + 1]);

const { timezone, firstRun, retryHours, attemptsPerDay, graceMinutes } = env.schedule;

console.log(
  `\nEXPORT_TIMEZONE=${timezone}  EXPORT_FIRST_RUN=${String(firstRun.hour).padStart(2, "0")}:` +
    `${String(firstRun.minute).padStart(2, "0")}  EXPORT_RETRY_HOURS=${retryHours}  ` +
    `EXPORT_ATTEMPTS_PER_DAY=${attemptsPerDay}  EXPORT_GRACE_MINUTES=${graceMinutes}`,
);
if (arrivesAtHour !== null) console.log(`Simulating an export arriving at ${arrivesAtHour}:15 local.\n`);
else console.log("Simulating a day on which no export ever arrives.\n");

// Anchor to today so the run reflects whichever side of a DST switch we are on.
const midnight = startOfLocalDay(new Date(), timezone);
const arrival =
  arrivesAtHour === null ? null : new Date(midnight.getTime() + (arrivesAtHour * 60 + 15) * 60_000);

const STATE = { arrived: "ARRIVED", waiting: "waiting", missed: "MISSED " } as const;

for (let hour = 0; hour < 24; hour++) {
  const now = new Date(midnight.getTime() + hour * 3_600_000);
  // The strip only knows about exports that have already landed.
  const lastImport = arrival && arrival <= now ? arrival : null;
  const r = describeSchedule(lastImport, now);

  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);

  console.log(`  ${clock}  ${STATE[r.state]}  ${r.note}`);
}

console.log("");

/** Midnight at the start of today, in `tz`, as a UTC instant. */
function startOfLocalDay(now: Date, tz: string): Date {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const get = (d: Date, type: string) =>
    Number(f.formatToParts(d).find((p) => p.type === type)?.value ?? "0");

  const elapsed =
    ((get(now, "hour") % 24) * 3600 + get(now, "minute") * 60 + get(now, "second")) * 1000;
  return new Date(now.getTime() - elapsed);
}
