/**
 * Check the rule that decides whether an export attempt is due.
 *
 *   NEON_DATABASE_URL=... pnpm exec tsx scripts/test-scheduler.ts
 *
 * This is the part that cannot be observed by watching: getting it wrong means
 * either an export that silently never runs, or one that hammers Emburse. The
 * cases below are all ones you would otherwise only meet in production —
 * a restart mid-morning, a day already spent, and the DST boundary where 6am
 * local is a different instant on either side.
 *
 * It writes to export_runs and cleans up after itself.
 */

import { db, ensureSchema } from "../server/db.js";
import { nextDue, slotsFor, localDate } from "../server/emburse/export-scheduler.js";
import { readSettings, writeSettings, type Schedule } from "../server/import/settings.js";

const SCHEDULE: Schedule = {
  timezone: "America/Chicago",
  firstRun: "06:00",
  retryHours: 3,
  attemptsPerDay: 2,
  graceMinutes: 90,
};

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
const current = await readSettings();
await writeSettings(
  current.sections, current.receiptsOnly, SCHEDULE, current.selectors, current.emburseUrl, "test");
await db().query(`CREATE TABLE IF NOT EXISTS export_runs (
  id bigserial PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  local_date text NOT NULL, attempt integer NOT NULL, trigger text NOT NULL, ok boolean,
  steps jsonb, item_line text, error text, import_id bigint, screenshot bytea)`);

const day = localDate(SCHEDULE, new Date("2026-09-22T18:00:00Z"));
const clear = () => db().query("DELETE FROM export_runs WHERE local_date = $1", [day]);
const record = (attempt: number, ok: boolean) =>
  db().query(
    `INSERT INTO export_runs (local_date, attempt, trigger, ok, finished_at)
     VALUES ($1, $2, 'scheduled', $3, now())`, [day, attempt, ok]);

// CDT is UTC-5, so 06:00 local is 11:00Z and the retry is 14:00Z.
console.log("\n1. Slot arithmetic");
const slots = slotsFor(SCHEDULE, "2026-09-22");
check("first attempt at 11:00Z", slots[0]?.toISOString() === "2026-09-22T11:00:00.000Z", slots[0]?.toISOString());
check("retry at 14:00Z", slots[1]?.toISOString() === "2026-09-22T14:00:00.000Z", slots[1]?.toISOString());

// In CST (UTC-6) the same wall-clock time is an hour later in UTC.
const winter = slotsFor(SCHEDULE, "2026-12-15");
check("still 06:00 local after the DST change", winter[0]?.toISOString() === "2026-12-15T12:00:00.000Z",
  winter[0]?.toISOString());

console.log("\n2. Nothing recorded yet");
await clear();
let d = await nextDue(SCHEDULE, new Date("2026-09-22T09:00:00Z"));
check("not due before the first slot", !d.due, d.reason);
d = await nextDue(SCHEDULE, new Date("2026-09-22T11:01:00Z"));
check("due once the first slot passes", d.due && d.attempt === 1, d.reason);

console.log("\n3. One attempt made and failed");
await clear();
await record(1, false);
d = await nextDue(SCHEDULE, new Date("2026-09-22T11:30:00Z"));
check("not due again before the retry slot", !d.due, d.reason);
d = await nextDue(SCHEDULE, new Date("2026-09-22T14:30:00Z"));
check("due at the retry, as attempt 2", d.due && d.attempt === 2, d.reason);

console.log("\n4. Both attempts spent");
await clear();
await record(1, false);
await record(2, false);
d = await nextDue(SCHEDULE, new Date("2026-09-22T20:00:00Z"));
check("day is written off, not retried all evening", !d.due, d.reason);

console.log("\n5. An attempt succeeded");
await clear();
await record(1, true);
d = await nextDue(SCHEDULE, new Date("2026-09-22T14:30:00Z"));
check("no second run after a success", !d.due, d.reason);

console.log("\n6. A restart mid-morning does not hand back fresh attempts");
// Same state as case 3, re-read from the database rather than memory.
await clear();
await record(1, false);
d = await nextDue(SCHEDULE, new Date("2026-09-22T14:30:00Z"));
check("still attempt 2, not attempt 1", d.attempt === 2, `attempt ${d.attempt}`);

console.log("\n7. A manual run does not consume a scheduled attempt");
await clear();
await record(1, false);
await db().query(
  `INSERT INTO export_runs (local_date, attempt, trigger, ok, finished_at)
   VALUES ($1, 1, 'manual', false, now())`, [day]);
d = await nextDue(SCHEDULE, new Date("2026-09-22T14:30:00Z"));
check("still due as scheduled attempt 2", d.due && d.attempt === 2, d.reason);

await clear();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
