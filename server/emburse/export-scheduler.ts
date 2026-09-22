import { db, ensureSchema, isDbConfigured } from "../db.js";
import { ingestExport } from "../import/ingest.js";
import { readSettings, type Schedule } from "../import/settings.js";
import { envLogin, runAutoExport, type ExportRun, type Selectors } from "./auto-export.js";
import { waitForCode } from "./challenge.js";
import { credentialForExport, noteResult } from "./credentials.js";

/**
 * Run the export on the configured schedule.
 *
 * Attempts are recorded in the database rather than held in memory, which is
 * what makes the retry policy mean anything: a restart between 06:00 and 09:00
 * must not hand the day a fresh set of attempts, and two processes must not
 * each decide it is their turn. The stored row is the decision.
 *
 * A day is identified by its local date in the schedule's timezone, not by UTC.
 * Otherwise a 6am Central run belongs to one UTC day in summer and another in
 * winter, and the attempt count resets in the middle of a morning.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS export_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  local_date  text        NOT NULL,
  attempt     integer     NOT NULL,
  trigger     text        NOT NULL,
  ok          boolean,
  steps       jsonb,
  item_line   text,
  error       text,
  import_id   bigint,
  screenshot  bytea
);
CREATE INDEX IF NOT EXISTS export_runs_day_idx ON export_runs (local_date, id DESC);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
  }));

export type RunRow = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  localDate: string;
  attempt: number;
  trigger: string;
  ok: boolean | null;
  steps: { name: string; ok: boolean; detail: string; ms: number }[];
  itemLine: string | null;
  error: string | null;
  importId: number | null;
  hasScreenshot: boolean;
};

/** Today's date in the schedule's timezone, as YYYY-MM-DD. */
export function localDate(schedule: Schedule, now = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return p;
}

/** The instants at which each attempt is due, for the given local day. */
export function slotsFor(schedule: Schedule, day: string): Date[] {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [hh, mm] = schedule.firstRun.split(":").map(Number) as [number, number];

  return Array.from({ length: schedule.attemptsPerDay }, (_, i) => {
    const wall = Date.UTC(y, m - 1, d, hh + i * schedule.retryHours, mm);
    // Two passes: the offset to apply depends on the instant being found, and
    // one pass lands close enough for the second to read the right one.
    const first = new Date(wall - offset(new Date(wall), schedule.timezone));
    return new Date(wall - offset(first, schedule.timezone));
  });
}

function offset(date: Date, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(f.find((p) => p.type === t)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) - date.getTime();
}

/** Attempts already made today, and whether any of them worked. */
async function todaysAttempts(day: string): Promise<{ count: number; succeeded: boolean }> {
  const { rows } = await db().query<{ count: string; succeeded: boolean }>(
    `SELECT count(*)::text AS count, coalesce(bool_or(ok), false) AS succeeded
       FROM export_runs WHERE local_date = $1 AND trigger = 'scheduled'`,
    [day],
  );
  return { count: Number(rows[0]?.count ?? 0), succeeded: rows[0]?.succeeded ?? false };
}

/**
 * Whether an attempt is due right now, and which number it would be.
 *
 * Exported so the same reasoning can be shown in the UI: a page that explains
 * why nothing is running should not be a second implementation of this.
 */
export async function nextDue(
  schedule: Schedule,
  now = new Date(),
): Promise<{ due: boolean; attempt: number; reason: string }> {
  const day = localDate(schedule, now);
  const { count, succeeded } = await todaysAttempts(day);

  if (succeeded) return { due: false, attempt: count, reason: "today's export already succeeded" };
  if (count >= schedule.attemptsPerDay) {
    return { due: false, attempt: count, reason: `all ${schedule.attemptsPerDay} attempts used today` };
  }

  const slot = slotsFor(schedule, day)[count]!;
  if (now < slot) {
    return { due: false, attempt: count + 1, reason: `attempt ${count + 1} is due at ${slot.toISOString()}` };
  }
  return { due: true, attempt: count + 1, reason: `attempt ${count + 1} is due` };
}

export async function recentRuns(limit = 20): Promise<RunRow[]> {
  await ensure();
  const { rows } = await db().query(
    `SELECT id, started_at, finished_at, local_date, attempt, trigger, ok, steps,
            item_line, error, import_id, (screenshot IS NOT NULL) AS has_screenshot
       FROM export_runs ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    startedAt: (r.started_at as Date).toISOString(),
    finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null,
    localDate: r.local_date as string,
    attempt: r.attempt as number,
    trigger: r.trigger as string,
    ok: r.ok as boolean | null,
    steps: (r.steps ?? []) as RunRow["steps"],
    itemLine: r.item_line as string | null,
    error: r.error as string | null,
    importId: r.import_id ? Number(r.import_id) : null,
    hasScreenshot: Boolean(r.has_screenshot),
  }));
}

export async function runScreenshot(id: number): Promise<Buffer | null> {
  await ensure();
  const { rows } = await db().query<{ screenshot: Buffer | null }>(
    "SELECT screenshot FROM export_runs WHERE id = $1", [id]);
  return rows[0]?.screenshot ?? null;
}

/**
 * Do one export attempt and record it.
 *
 * Records the attempt even when it throws before the browser starts, because a
 * failure that leaves no row would be retried immediately and forever.
 */
export async function attemptExport(
  trigger: "scheduled" | "manual" | "dry-run",
  by: string,
  opts: {
    dryRun?: boolean;
    /**
     * Called with the run's id the moment it is recorded, before any browser
     * starts.
     *
     * A run takes minutes, and the proxy in front of the app gives up on a
     * request long before that — returning `upstream request timeout` as plain
     * text to a page expecting JSON. So the request that starts a run must not
     * be the request that waits for it. This is how the caller gets an id to
     * hand back immediately, while the run carries on in the background and
     * reports its progress through the run list.
     */
    onStarted?: (id: number) => void;
  } = {},
): Promise<{ id: number; run: ExportRun; importId: number | null }> {
  await ensure();
  const settings = await readSettings();
  const day = localDate(settings.schedule);

  const { rows } = await db().query<{ id: string; attempt: number }>(
    `INSERT INTO export_runs (local_date, attempt, trigger)
     VALUES ($1, (SELECT count(*) + 1 FROM export_runs WHERE local_date = $1 AND trigger = $2), $2)
     RETURNING id, attempt`,
    [day, trigger],
  );
  const id = Number(rows[0]!.id);
  opts.onStarted?.(id);

  let run: ExportRun = {
    ok: false, signInFailed: false, credentialFault: false,
    steps: [], screenshot: null, pdf: null, itemLine: null,
  };
  let importId: number | null = null;
  let error: string | null = null;

  try {
    // A credential someone entered in the app, else the env fallback. Neither
    // existing is a configuration problem, not a run that failed silently.
    const login = (await credentialForExport()) ?? envLogin();
    if (!login) {
      throw new Error(
        "No Emburse login is stored. Whoever will own the export can add one under " +
          "their user menu, or set EMBURSE_LOGIN_EMAIL and EMBURSE_LOGIN_PASSWORD.",
      );
    }

    // A verification code can only be asked of somebody who is there to be
    // asked. Derived from the trigger rather than passed in, so there is no
    // way for a caller to hand a 6am scheduled run a prompt nobody will see —
    // it would park a browser for five minutes and then fail anyway, holding
    // the profile lock the whole time.
    const onChallenge =
      trigger === "scheduled"
        ? undefined
        : (ctx: { prompt: string; screenshot: string | null; attempt: number; lastError: string | null }) =>
            waitForCode({ ...ctx, owner: by });

    run = await runAutoExport(settings, settings.selectors as Selectors, login, { ...opts, onChallenge });

    // Only the sign-in step says anything about the credential, and even then
    // only some of what it says. A later failure means Emburse moved a button;
    // a device check means Emburse does not know this browser. Neither is
    // answered by re-typing a password, so only `credentialFault` sends its
    // owner back to the field.
    if (login.userId) {
      const signIn = run.steps.find((s) => s.name === "sign in");
      if (signIn) {
        await noteResult(login.userId, signIn.ok, signIn.ok ? null : signIn.detail, run.credentialFault);
      }
    }

    if (run.ok && run.pdf) {
      const imported = await ingestExport(run.pdf, `emburse-${day}.pdf`, by);
      importId = imported.importId;
      // A duplicate file is not a failed run: it means Emburse produced the
      // same export twice, which is normal on a day nothing changed.
      if (imported.warnings.length) {
        error = imported.warnings.join(" · ");
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    run = { ...run, ok: false };
  }

  await db().query(
    `UPDATE export_runs SET finished_at = now(), ok = $2, steps = $3, item_line = $4,
                            error = $5, import_id = $6, screenshot = $7
      WHERE id = $1`,
    [id, run.ok, JSON.stringify(run.steps), run.itemLine, error, importId,
     run.screenshot ? Buffer.from(run.screenshot, "base64") : null],
  );

  return { id, run, importId };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Check every few minutes whether an attempt is due.
 *
 * Polling rather than a timer per slot: the schedule is editable at runtime, so
 * a timer set at boot would fire at whatever the times used to be. The check is
 * two cheap queries, and being a few minutes late to a daily export costs
 * nothing.
 */
/**
 * Close out runs the process was in the middle of when it stopped.
 *
 * A run records itself before it starts and updates itself when it finishes,
 * so a restart in between leaves a row that says "Running" and never stops —
 * which also blocks the buttons on a page that waits for the current run to
 * end. Nothing else can finish those rows, because the browser they were
 * driving died with the process.
 */
export async function closeOrphanedRuns(): Promise<number> {
  await ensure();
  const { rowCount } = await db().query(
    `UPDATE export_runs
        SET finished_at = now(), ok = false,
            error = 'The server restarted while this run was going, so it was stopped.'
      WHERE finished_at IS NULL`,
  );
  return rowCount ?? 0;
}

export function startExportScheduler(): void {
  if (timer) return;
  // No credential check at boot: one can be added in the app at any time, and a
  // scheduler that only starts when the env happens to be set would need a
  // restart to notice. `attemptExport` reports the absence instead.
  if (!isDbConfigured()) return;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await ensure();
      const { schedule } = await readSettings();
      const { due, attempt } = await nextDue(schedule);
      if (!due) return;

      console.log(`export: starting scheduled attempt ${attempt}`);
      const { run } = await attemptExport("scheduled", "scheduler");
      const failed = run.steps.find((s) => !s.ok);
      console.log(
        run.ok
          ? `export: attempt ${attempt} succeeded (${run.itemLine ?? "no item count"})`
          : `export: attempt ${attempt} failed at "${failed?.name ?? "start"}" — ${failed?.detail ?? "unknown"}`,
      );
    } catch (err) {
      console.error("export scheduler:", err);
    } finally {
      running = false;
    }
  };

  // Before anything else: a run interrupted by the restart that just happened
  // is not running, and saying otherwise blocks the page that shows it.
  void closeOrphanedRuns()
    .then((n) => n > 0 && console.log(`export: closed ${n} run(s) interrupted by a restart`))
    .catch((err) => console.error("export: could not close interrupted runs:", err));

  // A minute after boot, so a restart during a due window picks it up without
  // waiting for the next tick.
  setTimeout(() => void tick(), 60_000);
  timer = setInterval(() => void tick(), 5 * 60_000);
  console.log("Export scheduler running (checks every 5 min)");
}
