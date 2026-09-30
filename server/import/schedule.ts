import type { Schedule } from "./settings.js";

/**
 * When the next export is expected to land, and whether one is overdue.
 *
 * Derived from two things: the configured schedule, and when an export last
 * actually arrived. Deliberately not from whether the runner thinks it
 * succeeded — those can disagree, and when they do the arrival is the one that
 * matters. A run that "succeeds" while exporting an empty selection still shows
 * here as nothing having landed, which is what the reviewer actually cares
 * about: is the data current?
 *
 * The schedule is: first run at `firstRun`, another every `retryHours`,
 * `attemptsPerDay` of them. What those slots MEAN depends on `allDay`:
 *
 *   off — they are retries. The first success closes the day; after the last
 *         one fails the day is written off and the next attempt is tomorrow.
 *   on  — they are simply the times the import runs. Every slot fires, and
 *         "is the data current?" stops meaning "did this morning work?" and
 *         starts meaning "has anything arrived since the last slot was due?"
 */

export type ImportSchedule = {
  timezone: string;
  /** Local-time attempt slots for the day being reported on, as ISO instants. */
  slots: string[];
  lastImportAt: string | null;
  /** True when an export has landed since the first slot of today. */
  arrivedToday: boolean;
  nextAttemptAt: string;
  state: "arrived" | "waiting" | "missed";
  note: string;
};

/**
 * `now` is injectable so the boundaries can be tested without waiting for them.
 *
 * The schedule comes from settings rather than env so it can be changed in the
 * app, without a redeploy and without a restart.
 */
export function describeSchedule(
  schedule: Schedule,
  lastImportAt: Date | null,
  now = new Date(),
): ImportSchedule {
  const { timezone, retryHours, attemptsPerDay, graceMinutes, allDay } = schedule;
  const [h = "6", m = "0"] = schedule.firstRun.split(":");
  const firstRun = { hour: Number(h), minute: Number(m) };

  const today = partsIn(now, timezone);
  const slots = slotsFor(today, timezone);
  const tomorrowFirst = slotsFor(addDays(today, 1), timezone)[0]!;

  // "Today" starts at the first attempt, not at midnight: an export that landed
  // at 06:10 belongs to today's run, one that landed at 23:00 yesterday does not.
  const arrivedToday = lastImportAt !== null && lastImportAt >= slots[0]!;

  const grace0 = graceMinutes * 60_000;

  // An all-day schedule is answering a different question, so it answers it
  // separately rather than bending the once-a-day wording around it.
  //
  // "Today's export arrived" is true from 6:05am until midnight and therefore
  // says nothing: what matters on a live queue is whether the LAST slot that
  // was due actually produced an import. That also gets the quiet hours right
  // — at 5am the last due slot is yesterday's 9pm one, and an import at 9:05pm
  // answers it, so the overnight gap is not reported as a failure.
  if (allDay) {
    const nextSlot = slots.find((s) => now < s) ?? tomorrowFirst;
    // The most recent slot whose grace has run out. Nothing having arrived
    // since is the only thing that means the import has stopped working.
    const lastDue = [...slots].reverse().find((s) => now.getTime() >= s.getTime() + grace0);
    const behind = lastDue !== undefined && (lastImportAt === null || lastImportAt < lastDue);

    return {
      timezone,
      slots: slots.map(iso),
      lastImportAt: lastImportAt?.toISOString() ?? null,
      arrivedToday,
      nextAttemptAt: iso(nextSlot),
      // "arrived" is a claim about data being current, so it needs something
      // to have arrived. Before the first run of a fresh day there is nothing
      // wrong and nothing here yet, which is "waiting", not a failure.
      state: behind ? "missed" : lastImportAt === null ? "waiting" : "arrived",
      note: behind
        ? `Nothing has arrived since the ${describe(lastDue, timezone, now).replace(/^at /, "")} ` +
          `import was due. Next one ${describe(nextSlot, timezone, now)}.`
        : lastImportAt === null
          ? `First import of the day ${describe(nextSlot, timezone, now)}.`
          : `Imported ${describe(lastImportAt, timezone, now)}. ` +
            `Next ${describe(nextSlot, timezone, now)} — every ${hours(retryHours)} through the day.`,
    };
  }

  if (arrivedToday) {
    return {
      timezone,
      slots: slots.map(iso),
      lastImportAt: lastImportAt.toISOString(),
      arrivedToday: true,
      nextAttemptAt: iso(tomorrowFirst),
      state: "arrived",
      note: `Today's export arrived. Next expected ${describe(tomorrowFirst, timezone, now)}.`,
    };
  }

  // A slot only counts as missed once the grace has run out: the export is
  // queued by Emburse and then picked up by a folder poll, so an attempt that
  // fired on time still lands well after its slot.
  const grace = grace0;
  const pending = slots.find((s) => now.getTime() < s.getTime() + grace);

  if (pending) {
    const due = now >= pending;
    return {
      timezone,
      slots: slots.map(iso),
      lastImportAt: lastImportAt?.toISOString() ?? null,
      arrivedToday: false,
      nextAttemptAt: iso(pending),
      state: "waiting",
      note: due
        ? `Export ran ${describe(pending, timezone, now)}; allowing up to ${graceMinutes} min for it to arrive.`
        : `Next export ${describe(pending, timezone, now)}.`,
    };
  }

  const attempts = attemptsPerDay === 1 ? "the attempt" : `all ${attemptsPerDay} attempts`;
  return {
    timezone,
    slots: slots.map(iso),
    lastImportAt: lastImportAt?.toISOString() ?? null,
    arrivedToday: false,
    nextAttemptAt: iso(tomorrowFirst),
    state: "missed",
    note:
      `No export today — ${attempts} passed without one arriving. ` +
      `Next attempt ${describe(tomorrowFirst, timezone, now)}.`,
  };

  function slotsFor(day: DateParts, tz: string): Date[] {
    return Array.from({ length: attemptsPerDay }, (_, i) =>
      zonedTimeToUtc({ ...day, hour: firstRun.hour + i * retryHours, minute: firstRun.minute }, tz),
    );
  }
}

const iso = (d: Date) => d.toISOString();

const hours = (n: number) => (n === 1 ? "hour" : `${n} hours`);

type DateParts = { year: number; month: number; day: number };

function addDays(p: DateParts, n: number): DateParts {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function partsIn(date: Date, tz: string): DateParts {
  const p = formatParts(date, tz);
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * The instant at which a given wall-clock time occurs in `tz`.
 *
 * Two passes, because the offset to apply depends on the instant you are trying
 * to find. The first pass lands close enough that the second reads the correct
 * offset even across a DST boundary — where an hour either does not exist or
 * happens twice, this settles on one of them rather than drifting a day.
 */
function zonedTimeToUtc(
  t: DateParts & { hour: number; minute: number },
  tz: string,
): Date {
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute);
  const first = new Date(wall - offsetMs(new Date(wall), tz));
  return new Date(wall - offsetMs(first, tz));
}

/** How far ahead of UTC `tz` is at this instant, in milliseconds. */
function offsetMs(date: Date, tz: string): number {
  const p = formatParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

function formatParts(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // hourCycle h23 still renders midnight as "24" in some ICU builds.
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour") % 24, minute: get("minute"), second: get("second"),
  };
}

/** "at 9:00 AM" for today, "tomorrow at 6:00 AM" otherwise, relative to `now`. */
function describe(when: Date, tz: string, now: Date): string {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit",
  }).format(when);

  const a = partsIn(now, tz);
  const b = partsIn(when, tz);
  const days = Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );

  if (days === 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  // Reachable now that an all-day schedule looks BACK at the last import,
  // which overnight is last night's final run.
  if (days === -1) return `yesterday at ${time}`;
  return `on ${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(when)} at ${time}`;
}
