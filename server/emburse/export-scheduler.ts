import { db, ensureSchema, isDbConfigured } from "../db.js";
import { ingestExport } from "../import/ingest.js";
import { readSettings, type Schedule } from "../import/settings.js";
import { envLogin, runAutoExport, type ExportRun, type Selectors } from "./auto-export.js";
import { waitForCode } from "./challenge.js";
import { credentialForExport, credentialForUser, noteResult } from "./credentials.js";

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

-- WHOSE Needs Review this run read.
--
-- Emburse's Needs Review is per account, so two reviewers are two imports
-- with two timelines. "How many attempts have been made today" is a
-- question about one of them: counted across both, Eric's morning run
-- spends Brian's attempts and Brian's queue never updates.
ALTER TABLE export_runs ADD COLUMN IF NOT EXISTS reviewer text NOT NULL DEFAULT '';
-- And which list it read. Two lists are two timelines for the same reason
-- two reviewers are: "how many attempts today" is a question about one of
-- them, and counted together the first spends the other's.
ALTER TABLE export_runs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS export_runs_reviewer_idx
  ON export_runs (reviewer, local_date, id DESC);

-- A reviewer's own import schedule.
--
-- Null means "use the shared one", which is what everybody gets until
-- somebody deliberately wants different times — a reviewer whose expenses
-- arrive in the afternoon has no use for a 2am run.
CREATE TABLE IF NOT EXISTS reviewer_imports (
  user_email       text PRIMARY KEY,
  enabled          boolean NOT NULL DEFAULT true,
  timezone         text,
  first_run        text,
  retry_hours      integer,
  attempts_per_day integer,
  grace_minutes    integer,
  all_day          boolean,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text
);
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
  /** Whose Needs Review this run read. Blank is the shared import. */
  reviewer: string;
  /** Which Emburse list. Blank is Transactions. */
  source: string;
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
async function todaysAttempts(
  day: string, reviewer = "", source = "",
): Promise<{ count: number; succeeded: boolean }> {
  const { rows } = await db().query<{ count: string; succeeded: boolean }>(
    `SELECT count(*)::text AS count, coalesce(bool_or(ok), false) AS succeeded
       FROM export_runs
      WHERE local_date = $1 AND trigger = 'scheduled' AND reviewer = $2 AND source = $3`,
    [day, reviewer, source],
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
  /** Whose timeline this is. Each reviewer's runs are counted separately. */
  reviewer = "",
  /** And which list. Transactions and Reimbursements each have their own. */
  source = "",
): Promise<{ due: boolean; attempt: number; reason: string }> {
  const day = localDate(schedule, now);
  const { count, succeeded } = await todaysAttempts(day, reviewer, source);

  // Only when the slots are RETRIES does a success close the day. On an
  // all-day schedule they are not retries, they are the times the import
  // runs: stopping at the first one that worked is exactly the behaviour
  // that left the queue showing six in the morning at four in the afternoon.
  if (!schedule.allDay && succeeded) {
    return { due: false, attempt: count, reason: "today's export already succeeded" };
  }
  if (count >= schedule.attemptsPerDay) {
    return {
      due: false, attempt: count,
      reason: schedule.allDay
        ? `all ${schedule.attemptsPerDay} of today's runs are done`
        : `all ${schedule.attemptsPerDay} attempts used today`,
    };
  }

  const slot = slotsFor(schedule, day)[count]!;
  if (now < slot) {
    return { due: false, attempt: count + 1, reason: `attempt ${count + 1} is due at ${slot.toISOString()}` };
  }
  return { due: true, attempt: count + 1, reason: `attempt ${count + 1} is due` };
}

export async function recentRuns(limit = 20, reviewer?: string): Promise<RunRow[]> {
  await ensure();
  // Whose runs, when somebody is named. An admin looking at the app as Brian
  // was shown everybody's: his view carried Eric's successful 320-item pull
  // in the history above his own running one, which is a reasonable thing to
  // read as "this is about to export Eric's expenses". It is not — the run
  // signs in as Brian — but a history that mixes two accounts with nothing
  // saying so cannot be read any other way.
  const who = (reviewer ?? "").trim().toLowerCase();
  const { rows } = await db().query(
    `SELECT id, started_at, finished_at, local_date, attempt, trigger, ok, steps,
            item_line, error, import_id, (screenshot IS NOT NULL) AS has_screenshot,
            reviewer, source
       FROM export_runs
      WHERE $2::text IS NULL OR lower(reviewer) = $2
      ORDER BY id DESC LIMIT $1`,
    [limit, reviewer === undefined ? null : who],
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
    reviewer: (r.reviewer as string) ?? "",
    source: (r.source as string) ?? "",
  }));
}

/**
 * Whether an export/import is in flight right now.
 *
 * A run writes its row when it starts and stamps `finished_at` when it ends,
 * so an unfinished row IS a run in progress. Automatic approvals stand aside
 * while one is going: an import adds and removes expenses underneath the
 * very queue the automation is reading, and the rules have not seen the new
 * arrivals yet.
 *
 * The hour is a fuse, not a nicety. A process killed mid-run leaves a row
 * that never finishes, and without this that stuck row would silently
 * disable automatic approvals for ever — a fault that looks exactly like
 * the feature being broken. `closeOrphanedRuns` tidies them on boot; this
 * makes the automation safe in the meantime.
 */
export async function exportInFlight(): Promise<boolean> {
  await ensure();
  const { rows } = await db().query(
    `SELECT 1 FROM export_runs
      WHERE finished_at IS NULL AND started_at > now() - interval '1 hour' LIMIT 1`);
  return rows.length > 0;
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
    /**
     * Whose Needs Review to read, by app user.
     *
     * Omitted means the one chosen for the shared import. Given, the run
     * signs in as that person and everything it brings back is stamped as
     * theirs, which is what keeps two reviewers' queues apart.
     */
    reviewer?: string;
    /**
     * Which Emburse list to export: blank for Transactions, or a key from
     * the configured sources. Reimbursements is a separate page with its
     * own queue and the same export dialog, so the whole run works on it
     * unchanged once it is pointed at the right path.
     */
    source?: string;
  } = {},
): Promise<{ id: number; run: ExportRun; importId: number | null }> {
  await ensure();
  const settings = await readSettings();
  const day = localDate(settings.schedule);

  const { rows } = await db().query<{ id: string; attempt: number }>(
    `INSERT INTO export_runs (local_date, attempt, trigger, reviewer, source)
     VALUES ($1, (SELECT count(*) + 1 FROM export_runs
                   WHERE local_date = $1 AND trigger = $2 AND reviewer = $3 AND source = $4),
             $2, $3, $4)
     RETURNING id, attempt`,
    [day, trigger, opts.reviewer ?? "", opts.source ?? ""],
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
    // THE reviewer's own login when one is named, so the export reads THEIR
    // Needs Review. Falling back to the shared choice would read somebody
    // else's queue and stamp it as theirs, which is worse than not running.
    const login = opts.reviewer
      ? await credentialForUser(opts.reviewer).then((c) =>
          c ? { ...c, userEmail: opts.reviewer!, chosen: `the import for ${opts.reviewer}` } : null)
      : (await credentialForExport()) ?? envLogin();
    if (opts.reviewer && !login) {
      throw new Error(
        `${opts.reviewer} has no Emburse login stored, so their Needs Review cannot be read. ` +
        `Nothing else's queue will be used in its place — that would be a different set of ` +
        `expenses recorded as theirs.`);
    }
    if (!login) {
      throw new Error(
        "No Emburse login is stored. Whoever will own the export can add one under " +
          "their user menu, or set EMBURSE_LOGIN_EMAIL and EMBURSE_LOGIN_PASSWORD.",
      );
    }
    // WHOSE queue this is. Emburse's Needs Review is relative to whoever
    // signed in, so the account below decides what the entire app shows —
    // and until now nothing anywhere said which account that was.
    console.log(
      `export: signing in as ${login.email}` +
      ("chosen" in login && login.chosen ? ` (${login.chosen})` : " (from the environment)"));

    // A verification code can only be asked of somebody who is there to be
    // asked. Derived from the trigger rather than passed in, so there is no
    // way for a caller to hand a 6am scheduled run a prompt nobody will see —
    // it would park a browser for five minutes and then fail anyway, holding
    // the profile lock the whole time.
    const onChallenge =
      trigger === "scheduled"
        ? undefined
        : (ctx: { prompt: string; screenshot: string | null; attempt: number; lastError: string | null }) =>
            waitForCode({ ...ctx, owner: by, loginEmail: login?.email ?? null });

    /*
     * The list to read, as a selector override rather than a new parameter.
     *
     * `gridPath` is already the one thing that says WHERE the grid is, and
     * Reimbursements is the same dialog on a different page — so pointing
     * the existing run at it is the whole change. Everything downstream
     * (the item count, the section chips, the PDF, the download) is
     * untouched and stays tested by the runs it already has.
     */
    const list = settings.sources.find((x) => x.key === (opts.source ?? ""));
    if (opts.source && !list) {
      throw new Error(`There is no import source called “${opts.source}”.`);
    }
    const forThisRun = list
      ? ({ ...settings.selectors, gridPath: list.path } as Selectors)
      : (settings.selectors as Selectors);

    run = await runAutoExport(settings, forThisRun, login, {
      ...opts,
      onChallenge,
      // Written as they happen. A run can take twenty minutes, most of it
      // waiting for Emburse to build the file, and the steps used to appear
      // only once it was over — so "is it stuck?" had no answer anywhere.
      onStep: (steps) => {
        void db()
          .query("UPDATE export_runs SET steps = $2 WHERE id = $1", [id, JSON.stringify(steps)])
          .catch(() => {});
      },
      shouldStop: () => stopping.has(id),
    });

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
      // The run read every section chip, refused to guess at any it could not
      // read, and verified the result — so the weaker header check has nothing
      // left to add about sections.
      const sectionsVerified = run.steps.some((s) => s.name === "set the sections" && s.ok);
      // Stamped with WHOSE Needs Review this is, which is what keeps one
      // reviewer's import from purging another's queue. `userEmail` is the
      // app user who owns the credential; the env fallback has no owner, so
      // it imports as the blank reviewer exactly as a hand upload does.
      const reviewer = "userEmail" in login ? String(login.userEmail ?? "") : "";
      const imported = await ingestExport(
        run.pdf, `emburse-${day}.pdf`, by,
        { sectionsVerified, reviewer, source: opts.source ?? "" });
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

  stopping.delete(id);
  await db().query(
    `UPDATE export_runs SET finished_at = now(), ok = $2, steps = $3, item_line = $4,
                            error = $5, import_id = $6, screenshot = $7
      WHERE id = $1`,
    [id, run.ok, JSON.stringify(run.steps), run.itemLine, error, importId,
     run.screenshot ? Buffer.from(run.screenshot, "base64") : null],
  );

  return { id, run, importId };
}

/**
 * Runs somebody has asked to stop.
 *
 * In memory, and that is the right place: a run only exists inside the process
 * driving its browser, so a restart ends it anyway. Ids are dropped once the
 * run notices, and a stop for a run that has already finished is harmless.
 */
const stopping = new Set<number>();

export function stopRun(id: number): void {
  stopping.add(id);
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

export type ReviewerImport = {
  userEmail: string;
  enabled: boolean;
  /** The reviewer's own times, or the shared schedule where they set none. */
  schedule: Schedule;
  /** True where every field came from the shared schedule. */
  shared: boolean;
};

/**
 * Who the scheduler imports for, and on what timetable.
 *
 * One row per person with a stored Emburse login, because that is exactly
 * who HAS a Needs Review to read. A reviewer with no times of their own
 * runs on the shared schedule, which is what everybody gets until somebody
 * wants different ones — a reviewer whose expenses arrive in the afternoon
 * has no use for a 2am run.
 *
 * The person chosen for the shared import (`importAs`) is not special here:
 * they are simply one of the reviewers, and if nobody has been chosen the
 * blank reviewer stands in so a single-login deployment behaves exactly as
 * it did before any of this existed.
 */
export async function reviewerImports(): Promise<ReviewerImport[]> {
  await ensure();
  const { schedule: shared } = await readSettings();
  const { listCredentials } = await import("./credentials.js");
  const people = await listCredentials().catch(() => []);
  if (people.length === 0) {
    return [{ userEmail: "", enabled: true, schedule: shared, shared: true }];
  }

  const { rows } = await db().query<{
    user_email: string; enabled: boolean; timezone: string | null; first_run: string | null;
    retry_hours: number | null; attempts_per_day: number | null; grace_minutes: number | null;
    all_day: boolean | null;
  }>("SELECT * FROM reviewer_imports");
  const own = new Map(rows.map((r) => [r.user_email.toLowerCase(), r]));

  return people.map((p) => {
    const r = own.get(p.userEmail.toLowerCase());
    const set = [r?.timezone, r?.first_run, r?.retry_hours, r?.attempts_per_day,
                 r?.grace_minutes, r?.all_day].some((v) => v !== null && v !== undefined);
    return {
      userEmail: p.userEmail,
      enabled: r?.enabled ?? true,
      shared: !set,
      schedule: {
        timezone: r?.timezone ?? shared.timezone,
        firstRun: r?.first_run ?? shared.firstRun,
        retryHours: r?.retry_hours ?? shared.retryHours,
        attemptsPerDay: r?.attempts_per_day ?? shared.attemptsPerDay,
        graceMinutes: r?.grace_minutes ?? shared.graceMinutes,
        allDay: r?.all_day ?? shared.allDay,
      },
    };
  });
}

/** Set or clear one reviewer's own import times. */
export async function setReviewerImport(
  userEmail: string,
  input: { enabled?: boolean; schedule?: Partial<Schedule> | null },
  by: string,
): Promise<void> {
  await ensure();
  const sc = input.schedule;
  await db().query(
    `INSERT INTO reviewer_imports (user_email, enabled, timezone, first_run, retry_hours,
                                   attempts_per_day, grace_minutes, all_day, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_email) DO UPDATE SET
       enabled = EXCLUDED.enabled, timezone = EXCLUDED.timezone,
       first_run = EXCLUDED.first_run, retry_hours = EXCLUDED.retry_hours,
       attempts_per_day = EXCLUDED.attempts_per_day, grace_minutes = EXCLUDED.grace_minutes,
       all_day = EXCLUDED.all_day, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [userEmail.trim().toLowerCase(), input.enabled ?? true,
     sc?.timezone ?? null, sc?.firstRun ?? null, sc?.retryHours ?? null,
     sc?.attemptsPerDay ?? null, sc?.graceMinutes ?? null, sc?.allDay ?? null, by]);
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
      // One timeline per reviewer. Emburse's Needs Review is per account, so
      // "is an import due" is a question about one person's queue — asked
      // across all of them, the first reviewer's morning run spends
      // everybody's attempts and the rest never update.
      const lists = (await readSettings()).sources.filter((x) => x.enabled);
      for (const who of await reviewerImports()) {
        if (!who.enabled) continue;
        // One timeline per reviewer PER LIST. Transactions and
        // Reimbursements are separate queues on separate pages, so sharing
        // a count means the first one read spends the other's attempts and
        // the second never updates — the same fault as sharing one between
        // two reviewers, one level along.
        for (const list of lists) {
          const { due, attempt } = await nextDue(who.schedule, new Date(), who.userEmail, list.key);
          if (!due) continue;

          console.log(
            `export: starting scheduled attempt ${attempt} of ${list.label}` +
            (who.userEmail ? ` for ${who.userEmail}` : ""));
          const { run } = await attemptExport(
            "scheduled", "scheduler", { reviewer: who.userEmail, source: list.key });
          const failed = run.steps.find((s) => !s.ok);
          console.log(
            run.ok
              ? `export: attempt ${attempt} of ${list.label} succeeded (${run.itemLine ?? "no item count"})`
              : `export: attempt ${attempt} of ${list.label} failed at "${failed?.name ?? "start"}" — ${failed?.detail ?? "unknown"}`,
          );
        }
      }
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

  /**
   * The catch-up after a restart, and why it is not a minute any more.
   *
   * It was 60s, so a VM that restarted inside a due window started driving a
   * browser one minute into its life — before outbound networking and DNS
   * are reliably up on this host. The 6:29am run failed at "open Emburse"
   * with the page not loading in 90 seconds, twice, while a manual run
   * hours later opened the same URL in under two. Nothing was wrong with
   * the app; it was asked to reach the internet too early.
   *
   * The cost of that mistake is not a slow run, it is a SPENT ATTEMPT: the
   * day allows two, so one boot inside the window burns half the budget and
   * the export does not land. Waiting costs at most a few minutes, because
   * the interval below would catch the same window anyway.
   */
  const BOOT_CATCHUP_MS = 4 * 60_000;
  setTimeout(() => void tick(), BOOT_CATCHUP_MS);
  timer = setInterval(() => void tick(), 5 * 60_000);
  console.log("Export scheduler running (checks every 5 min)");
}
