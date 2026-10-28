import { db, ensureSchema, isDbConfigured } from "../db.js";
import { ingestExport } from "../import/ingest.js";
import { readSettings, type Schedule } from "../import/settings.js";
import { envLogin, runAutoExport, type ExportRun, type Selectors } from "./auto-export.js";
import { waitForCode } from "./challenge.js";
import { credentialForExport, credentialForUser, noteResult } from "./credentials.js";
import {
  MANAGER_LANE, credentialForLaneOf, laneTag, linkedLanesOf, type LinkedLane,
} from "./connections.js";

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

-- WHICH list in Emburse this reviewer's export reads.
--
-- The reason these exist. Approval here is a chain: Eric approves, and the
-- expense then goes to Brian to approve. Two stages, two queues, one at a
-- time — so the same expense is Eric's today and Brian's tomorrow, and it
-- is never both at once.
--
-- The export did not know that. It clicks the team-wide tab and opens
-- /transactions/team?filters[section]=inbox for everybody, which is the
-- whole review stage regardless of whose turn it is, so both accounts
-- exported the identical 320 items and the two queues were one queue read
-- twice. Pointing each reviewer at their own stage is the fix, and the
-- path and section are the two things that say which stage.
--
-- Null means the shared setting, which is what a single-reviewer tenant
-- wants and has always had.
ALTER TABLE reviewer_imports ADD COLUMN IF NOT EXISTS grid_path text;
ALTER TABLE reviewer_imports ADD COLUMN IF NOT EXISTS grid_section text;

-- Automatic approvals, per reviewer.
--
-- There is one global switch with one owner, and the sweep only ever touches
-- that owner's own queue — it has to, because an approval is applied by
-- signing in as them and another reviewer's rows are not in their Needs
-- Review. Which left the Configuration card correctly telling somebody
-- "whoever they belong to has to switch this on for themselves" with no way
-- anywhere in the app for them to do it. 340 expenses, no automation, and an
-- instruction that could not be followed.
--
-- Off for everybody until switched on, deliberately: this is the one path
-- that approves spending with no human in the loop, and nobody's automation
-- should start because a column appeared.
-- The manager queue, per reviewer, on or off.
--
-- Approval here is a chain: Eric approves, then it goes to Brian. The
-- team-wide grid at /transactions/team is the queue they each approve
-- FROM, and there are ordinary reasons to stop reading one person's for
-- a while -- somebody away, or a stage being run by hand -- without
-- switching their whole import off and losing their schedule, their
-- Reimbursements and their automatic approvals with it.
--
-- ON for everybody, because that is what every existing reviewer is
-- doing today and a column appearing must not quietly stop an import.
ALTER TABLE reviewer_imports
  ADD COLUMN IF NOT EXISTS manager_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE reviewer_imports ADD COLUMN IF NOT EXISTS auto_approve boolean NOT NULL DEFAULT false;
ALTER TABLE reviewer_imports ADD COLUMN IF NOT EXISTS auto_approve_per_run integer;

-- The filters that pick out THIS reviewer's queue, copied from Emburse.
-- Above all its Current Reviewer dropdown: an expense in an approval chain
-- sits with exactly one reviewer at a time, and that filter is the only
-- thing in the grid that says which. Opaque ids, so they are pasted, not
-- constructed.
ALTER TABLE reviewer_imports ADD COLUMN IF NOT EXISTS grid_query text;

-- WHOSE LOGIN reads it, which is not the same question as whose queue it
-- is. A manager can see the rows waiting on the people under them, so one
-- login can pull everybody's queues — each filtered to its owner and
-- stamped as theirs. That is worth more than tidiness: a second reviewer's
-- login means a second verification code, from somebody who is not at the
-- screen, every time the trust lapses. Null means they run as themselves,
-- which is what a single-reviewer deployment has always done.
ALTER TABLE reviewer_imports ADD COLUMN IF NOT EXISTS run_as text;

-- WHICH STAGES this reviewer's export covers, as the chips in Emburse's
-- export dialog are named.
--
-- This was one shared list for everybody, and sharing it is wrong for the
-- same reason sharing the grid URL was: the two reviewers are two stages of
-- one approval chain, so one of them having Needs Review off is not a
-- statement about the other. Worse, it was a shared setting that looked
-- like a per-reviewer one — untick a chip while reading somebody's tab and
-- it silently changed everybody's import.
--
-- Null means the shared list, which is what a single-reviewer tenant has
-- always had.
ALTER TABLE reviewer_imports ADD COLUMN IF NOT EXISTS sections jsonb;

-- And whether their export is filtered to expenses that HAVE a receipt.
--
-- Part of scope for the same reason the stages are: it decides what comes
-- back. It is also the switch that gets the receipt image downloaded at
-- all, so it belongs beside the list and the stages in one person's tab,
-- not in a deployment-wide block somewhere else on the page.
--
-- Null means the default, which is on.
ALTER TABLE reviewer_imports ADD COLUMN IF NOT EXISTS receipts_only boolean;

-- WHICH Emburse lists this reviewer imports: Transactions, Reimbursements,
-- or both.
--
-- They are separate pages with separate queues, and which of them a person
-- has anything in is a fact about that person — Brian has two
-- reimbursements waiting and Eric may have none. It was one global switch
-- that turned a second import on for everybody at once, buried in the
-- defaults block, which is neither where it would be looked for nor what it
-- means.
--
-- Null means the lists enabled in the defaults, which is how every existing
-- deployment already behaves.
ALTER TABLE reviewer_imports ADD COLUMN IF NOT EXISTS sources jsonb;

-- WHICH TAB this configuration is.
--
-- One person can now have more than one Emburse account, and each
-- one is a separate import with its own stages, lists, receipt
-- filter, schedule and history. The row was keyed on the person, so
-- a second account had nowhere to put any of that.
--
-- Widened with a DEFAULT, so every row that already exists becomes
-- the MANAGER tab and keeps working untouched. That is deliberately
-- the conservative reading: the manager queue is the thing the brief
-- says must not move, and calling an existing row "personal" on the
-- strength of its grid path would be guessing about live data.
ALTER TABLE reviewer_imports ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'manager';

DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviewer_imports_user_lane_pk'
  ) THEN
    ALTER TABLE reviewer_imports DROP CONSTRAINT IF EXISTS reviewer_imports_pkey;
    ALTER TABLE reviewer_imports
      ADD CONSTRAINT reviewer_imports_user_lane_pk PRIMARY KEY (user_email, lane);
  END IF;
END $do$;

-- Which tab a run belongs to, so each tab's history is its own.
ALTER TABLE export_runs ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS export_runs_lane_idx
  ON export_runs (reviewer, lane, local_date, id DESC);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
  }));

/**
 * Create this module's tables, for a caller that reaches them
 * without going through one of its functions first.
 *
 * Every route does — `ensure()` is the first line of each — so this
 * only matters on a cold database, which is exactly where it was
 * missing: `test-run-as.ts` and `test-reviewer-schedules.ts` write
 * straight into `reviewer_imports` and both died on "relation does
 * not exist" against an empty one. Harmless on this deployment,
 * fatal on the first boot of a new one.
 */
export const ensureSchedulerSchema = (): Promise<void> => ensure();

export type RunRow = {
  id: number;
  /** Which tab this run belongs to. Blank on runs made before tabs. */
  lane?: string;
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
  day: string, reviewer = "", source = "", lane = "",
): Promise<{ count: number; succeeded: boolean }> {
  const { rows } = await db().query<{ count: string; succeeded: boolean }>(
    // Counted per TAB as well as per reviewer and per list. Eric's
    // manager queue, his MOJO account and his Mammoth account are
    // three different Needs Review lists; sharing a day's attempts
    // means the first one read spends the others' budget and they
    // never update.
    `SELECT count(*)::text AS count, coalesce(bool_or(ok), false) AS succeeded
       FROM export_runs
      WHERE local_date = $1 AND trigger = 'scheduled' AND reviewer = $2
        AND source = $3 AND lane = $4`,
    [day, reviewer, source, lane],
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
  /** And which tab. The manager queue and each personal account are separate. */
  lane = "",
): Promise<{ due: boolean; attempt: number; reason: string }> {
  const day = localDate(schedule, now);
  const { count, succeeded } = await todaysAttempts(day, reviewer, source, lane);

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

export async function recentRuns(
  limit = 20, reviewer?: string, lane?: string,
): Promise<RunRow[]> {
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
            reviewer, source, lane
       FROM export_runs
      WHERE ($2::text IS NULL OR lower(reviewer) = $2)
        AND ($3::text IS NULL OR lane = $3)
      ORDER BY id DESC LIMIT $1`,
    // Each tab's history is its own. Three tabs' runs in one list,
    // with nothing saying which account each read, is the same
    // unreadable mixture two reviewers' runs used to be.
    [limit, reviewer === undefined ? null : who, lane === undefined ? null : lane],
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
    lane: (r.lane as string) ?? "",
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
     * The person who can answer a verification code, as a plain email.
     *
     * Separate from `by`, which is a log line and may read "eric.s@… (for
     * brian.c@…)" for a run started from a view. That string was being used
     * as the challenge owner, and `answerChallenge` compares it to the
     * caller's own email — so a run started from a view parked for a code
     * that NOBODY could answer: not the admin, whose email is only part of
     * it, and not the person being viewed. Ten minutes of "Step 1 of 11",
     * then a failed sign-in, which is exactly what a hang looks like.
     */
    startedBy?: string;
    /**
     * Try a different list for THIS RUN only, without saving anything.
     *
     * Dry runs only, enforced below. The question "which Emburse list is
     * waiting on this person" can only be answered by asking Emburse, and
     * asking it should not require committing a setting first — somebody
     * sensibly nervous about changing how the import works will not find
     * out by changing how the import works.
     */
    probe?: { gridPath?: string; gridSection?: string };
    /**
     * Which Emburse list to export: blank for Transactions, or a key from
     * the configured sources. Reimbursements is a separate page with its
     * own queue and the same export dialog, so the whole run works on it
     * unchanged once it is pointed at the right path.
     */
    source?: string;
    /**
     * WHICH TAB is running: the manager queue, or one personal
     * Emburse account.
     *
     * It decides the login, so it is not cosmetic. A personal tab
     * signs in as ITS OWN Emburse account — not the primary one,
     * and not the other personal one — because Needs Review is per
     * account and reading the wrong tenant's list would file one
     * company's expenses under the other.
     */
    lane?: string;
  } = {},
): Promise<{ id: number; run: ExportRun; importId: number | null }> {
  await ensure();
  const settings = await readSettings();
  const day = localDate(settings.schedule);

  /*
   * Stored as a TAG, which is empty for the manager queue.
   *
   * Every run and every expense already in the database has an
   * empty lane, and the lane is part of the dedupe key — so
   * writing "manager" here would re-identify every expense in the
   * manager queue at once and lose its whole decision history.
   */
  const lane = laneTag(opts.lane);
  const { rows } = await db().query<{ id: string; attempt: number }>(
    `INSERT INTO export_runs (local_date, attempt, trigger, reviewer, source, lane)
     VALUES ($1, (SELECT count(*) + 1 FROM export_runs
                   WHERE local_date = $1 AND trigger = $2 AND reviewer = $3
                     AND source = $4 AND lane = $5),
             $2, $3, $4, $5)
     RETURNING id, attempt`,
    [day, trigger, opts.reviewer ?? "", opts.source ?? "", lane],
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
    /*
     * WHOSE LOGIN reads this, which is a different question from whose
     * queue it is.
     *
     * A manager can see the rows waiting on the people under them, so one
     * login can pull everybody's queues — each narrowed by that person's
     * own filters and stamped as theirs. Worth far more than tidiness: a
     * second reviewer's login means a second verification code, from
     * somebody who is not at the screen, every time Emburse stops trusting
     * the browser.
     *
     * `runAs` is only taken from the reviewer's own stored settings, never
     * from a request. Defaults to themselves, which is what every
     * deployment did before this existed.
     */
    const mineForLogin = await importFor(opts.reviewer, lane);
    const signsIn = mineForLogin?.runAs?.trim() || opts.reviewer;

    /*
     * Whether this is a personal tab, decided once.
     *
     * The tab itself says so; the empty tag is the manager queue and
     * every pre-existing run has it. Read from the lane row where
     * there is one so a future kind of tab is not silently personal.
     */
    const personalQueue =
      (mineForLogin?.laneKind ?? (lane ? "personal" : "manager")) === "personal";

    /*
     * A PERSONAL TAB SIGNS IN AS ITS OWN EMBURSE ACCOUNT.
     *
     * Not the primary one, and not the other personal one. Needs
     * Review is per account, so reading the wrong tenant's list
     * would file one company's expenses under the other — and
     * every step of the run would come back green while it
     * happened. `credentialForLaneOf` refuses rather than
     * substituting, and the refusal names the address the tab
     * wants, which is the one thing somebody can act on.
     *
     * The manager tab is untouched: it is `credentialForUser`,
     * exactly as before, pinned to the primary connection.
     */
    const forLane = opts.reviewer && lane
      ? await credentialForLaneOf(opts.reviewer, lane)
      : null;
    if (forLane && !forLane.ok) throw new Error(forLane.problem);

    /*
     * Somebody else's login AND no filter is the one combination that
     * silently imports the wrong person's queue.
     *
     * Needs Review is per account: signed in as Eric it is Eric's, however
     * the run is labelled. Borrowing his login to fetch Brian's queue only
     * works if something narrows it back down to Brian — the Current
     * Reviewer filter. Without that the run reads Eric's rows, stamps them
     * as Brian's, and every step comes back green.
     *
     * Refused rather than warned about. A warning on an unattended run is
     * read after the queue has already changed hands, and this one is
     * recoverable only by working out which rows were never his.
     */
    if (!forLane && opts.reviewer && signsIn
        && signsIn.toLowerCase() !== opts.reviewer.toLowerCase()
        && !mineForLogin?.gridQuery) {
      throw new Error(
        `${opts.reviewer}'s import is set to sign in as ${signsIn}, with no filter to pick ` +
        `${opts.reviewer}'s rows out. Needs Review is per account, so that would read ` +
        `${signsIn}'s queue and file it as ${opts.reviewer}'s. Either set the login back to ` +
        `${opts.reviewer}, or paste a URL from Emburse with Current Reviewer set to them.`);
    }

    const login = forLane?.ok
      ? {
        userId: "",
        email: forLane.email,
        password: forLane.password,
        userEmail: opts.reviewer!,
        chosen: `${forLane.lane.label}, signed in as ${forLane.email}`,
      }
      : opts.reviewer
        ? await credentialForUser(signsIn!).then((c) =>
          c ? {
            ...c,
            // The QUEUE's owner, not the login's. This is what the import
            // stamps rows with, and conflating the two is how one person's
            // pull landed in another's queue.
            userEmail: opts.reviewer!,
            chosen: signsIn!.toLowerCase() === opts.reviewer!.toLowerCase()
              ? `the import for ${opts.reviewer}`
              : `${opts.reviewer}'s queue, read with ${signsIn}'s login`,
          } : null)
        : (await credentialForExport()) ?? envLogin();
    if (opts.reviewer && !login) {
      throw new Error(
        `${signsIn} has no Emburse login stored, so ${opts.reviewer}'s queue cannot be read. ` +
        `Nothing else's login will be used in its place — that would read a different set of ` +
        `expenses and record them as theirs.`);
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
            waitForCode({ ...ctx, owner: opts.startedBy ?? by, loginEmail: login?.email ?? null });

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
    /*
     * And WHOSE stage to read, by the same mechanism — THE SAME ROW THE
     * LOGIN WAS TAKEN FROM, tab and all.
     *
     * Approval is a chain — Eric approves, then it goes to Brian — so the
     * two reviewers have two queues that the same URL cannot both describe.
     * A reviewer's own path and section override the shared ones; set
     * neither and nothing changes, which is every single-reviewer tenant.
     *
     * This used to be its own lookup, matched on the email ALONE, and
     * `reviewerImports()` now returns one row per (person, tab). So a
     * personal tab's run found Eric's FIRST row — the manager tab — and
     * took its list, its sections and its receipt filter. The manager tab
     * stores no path of its own, so `chosenPath` came back undefined and
     * the run fell through to the shared default: the team-wide grid. A
     * personal tab therefore clicked the team tab and exported the
     * approver's queue, which is the opposite of what the tab is for.
     * `mineForLogin` was already lane-aware for picking the password;
     * there is no second row to find.
     */
    const mine = mineForLogin;
    const askedForAnotherList = Boolean(opts.source);
    const chosenPath = gridPathFor(opts.source, list, mine);
    /*
     * A PERSONAL TAB POINTED AT THE TEAM LIST IS REFUSED, NOT RUN.
     *
     * Everything else about the run is already correct by here — the right
     * login, the team-view step skipped because this is a personal tab —
     * and then it opened the approver's queue anyway, because the path
     * stored on the tab says so. On an account that is not an approver of
     * that tenant, Emburse answers with the nav and an empty main area, so
     * the run waited out its timeout and reported "the grid did not appear,
     * tried the grid selector and the item-count line" — sending somebody
     * to correct four selectors that are perfectly right.
     *
     * Refused rather than quietly rewritten: the Scope row on that tab says
     * "Manager queue" and would go on saying it while the run read
     * something else, which is a worse lie than the one being fixed. One
     * click changes it, and the sentence says which click.
     */
    if (personalQueue && chosenPath && /\/team\b/.test(chosenPath)) {
      const why =
        `This tab reads ${chosenPath}, which is the approver's team-wide queue — and it is a `
        + `personal tab, so the expenses it exists to find are ${login.email}'s own and are not `
        + `on that list. Nothing was exported. Open Export settings, pick this tab, and set `
        + `Scope to "Personal queue". This is not a selector problem.`;
      /*
       * Recorded as a STEP as well as an error, because a run with no steps
       * at all renders as a stopped run with nothing to open — and the list
       * of steps is where somebody looks for the reason. This one names
       * itself after the thing it was doing, so it reads in sequence with
       * the steps that would have followed it.
       */
      run = { ...run, ok: false, steps: [
        { name: "choose the list to read", ok: false, detail: why, ms: 0 },
      ] };
      throw new Error(why);
    }
    const forThisRun = {
      ...settings.selectors,
      ...(chosenPath ? { gridPath: chosenPath } : {}),
      // The reviewer's section belongs to the list it was chosen on. Ask for
      // a DIFFERENT list and it does not travel: Reimbursements has its own
      // sections, and "inbox" there is a filter for something else or for
      // nothing at all.
      ...(askedForAnotherList
        ? (list?.section === undefined ? {} : { gridSection: list.section })
        // An EMPTY section is a choice, not an absence: it means "the
        // list's own default view", which is what a personal tab wants
        // and what `gridUrl` does with a blank. Tested for presence
        // rather than truthiness, or the empty string falls through to
        // the deployment's "inbox" and the tab reads the approver's
        // stage of its own list.
        : (mine?.gridSection !== null && mine?.gridSection !== undefined
          ? { gridSection: mine.gridSection } : {})),
      // The filters that pick this reviewer's queue out of a list their
      // login can see more of than their own.
      ...(mine?.gridQuery ? { gridQuery: mine.gridQuery } : {}),
      // Last, and only on a dry run: a probe beats every stored setting
      // precisely because it is not one. A real run must never take a list
      // from a request — that is how an import reads the wrong queue.
      ...(opts.dryRun && opts.probe?.gridPath ? { gridPath: opts.probe.gridPath } : {}),
      ...(opts.dryRun && opts.probe?.gridSection ? { gridSection: opts.probe.gridSection } : {}),
    } as Selectors;

    /*
     * Every other Emburse login we hold, so the run can catch itself being
     * signed in as one of them. It is the check that was missing while
     * two reviewers' queues kept turning out to be the same queue: every
     * step reported the account we MEANT to use and nothing ever asked the
     * page.
     *
     * This now includes the OTHER accounts belonging to the same
     * person, and that is the point rather than an oversight:
     * signing in as your own Mammoth login when the run meant your
     * MOJO one pulls the wrong tenant's expenses, and it is exactly
     * as wrong as signing in as somebody else's.
     */
    const otherLogins = await (async () => {
      try {
        const { listCredentials } = await import("./credentials.js");
        return (await listCredentials())
          .map((c) => c.loginEmail)
          .filter((e) => e && e.toLowerCase() !== login.email.toLowerCase());
      } catch {
        return [];
      }
    })();

    /*
     * And WHICH STAGES to export, by the same rule.
     *
     * The export dialog's chips used to come from one shared list, so
     * unticking Needs Review while reading one reviewer's tab quietly
     * changed every reviewer's import. They are part of a reviewer's scope,
     * not the deployment's.
     */
    const forRun = {
      ...settings,
      ...(mine?.sections?.length ? { sections: mine.sections } : {}),
      ...(mine?.receiptsOnly !== null && mine?.receiptsOnly !== undefined
        ? { receiptsOnly: mine.receiptsOnly } : {}),
    };

    run = await runAutoExport(forRun, forThisRun, login, {
      ...opts,
      otherLogins,
      onChallenge,
      /*
       * This run reads ONE PERSON'S OWN expenses, not a queue.
       *
       * The browser needs telling, because two of its steps reach for
       * the team-wide view on their own: it clicks the MANAGER/ADMIN
       * tab before opening anything, and if the configured path does
       * not load it tries "<path>/team" as the tenant's own naming
       * scheme. Both are right for an approver and wrong here — the
       * second is how a personal tab that asked for /transactions
       * ended up reporting the team grid as a fallback.
       */
      personalQueue,
      // Written as they happen. A run can take twenty minutes, most of it
      // waiting for Emburse to build the file, and the steps used to appear
      // only once it was over — so "is it stuck?" had no answer anywhere.
      onStep: (steps) => {
        void db()
          .query("UPDATE export_runs SET steps = $2 WHERE id = $1", [id, JSON.stringify(steps)])
          .catch(() => {});
      },
      shouldStop: () => stopping.has(id),
      onOpen: (close) => closers.set(id, close),
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
      // The queue's owner. `login.userEmail` is set to opts.reviewer above
      // precisely so this stays the person whose queue was read and not
      // whoever's login read it — those are now allowed to differ, and the
      // stamp has to follow the queue or an admin pulling for somebody
      // else takes their expenses.
      const reviewer = opts.reviewer
        ?? ("userEmail" in login ? String(login.userEmail ?? "") : "");
      const imported = await ingestExport(
        run.pdf, `emburse-${day}.pdf`, by,
        { sectionsVerified, reviewer, source: opts.source ?? "",
          // WHICH EMBURSE ACCOUNT these rows are. Part of their
          // identity, not a label: the same purchase submitted in
          // both tenants is two expenses, and without this they
          // would collapse into one and each import would purge
          // the other's queue.
          lane, sourceLogin: login.email,
          // This run downloaded it moments ago, so the staleness guard —
          // which exists to catch somebody choosing yesterday's PDF out of
          // a folder — has nothing to protect against here, and refuses
          // perfectly current exports whenever the newest expense in the
          // queue has since been approved.
          downloadedNow: true,
          sections: mine?.sections ?? undefined,
          receiptsOnly: mine?.receiptsOnly ?? undefined });
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

/**
 * How to shut each live run's browser, by run id.
 *
 * The flag alone could only stop a run BETWEEN steps, and the step that
 * strands a run is "open Emburse" — three attempts at a 90-second
 * navigation, six minutes inside one step with nobody reading the flag.
 * Stop this run set it, returned 200, and the run carried on, which is
 * worse than having no button.
 */
const closers = new Map<number, () => Promise<void>>();

export function stopRun(id: number): void {
  stopping.add(id);
  // Shut the browser too. Whatever the run is waiting on — a navigation, a
  // selector, Emburse building a file — it fails immediately and the run
  // records itself as stopped. Fire and forget: the caller is an HTTP
  // handler and the close can take a moment.
  const close = closers.get(id);
  if (close) {
    closers.delete(id);
    void close().catch(() => {});
  }
}

/** Whether a stop has been asked for, so the page can say "stopping". */
export function isStopping(id: number): boolean {
  return stopping.has(id);
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
  /**
   * WHICH TAB this is: the manager queue, or one personal Emburse
   * account. A person has one row per tab and they share nothing —
   * changing one must not change another, which is the whole
   * reason the table is keyed on the pair.
   */
  lane: string;
  laneLabel: string;
  laneKind: "manager" | "personal";
  /** The Emburse login this tab must sign in as. Empty on the manager tab. */
  laneLoginEmail: string;
  /** Whether a stored Emburse account actually signs in as that address. */
  connected: boolean;
  /** Why not, when not. A sentence, because a blank teaches nobody. */
  connectionProblem: string;
  enabled: boolean;
  /** The reviewer's own times, or the shared schedule where they set none. */
  schedule: Schedule;
  /** True where every field came from the shared schedule. */
  shared: boolean;
  /** Minutes this reviewer's shared slots are offset, so two never collide. */
  staggeredBy: number;
  /** The grid this reviewer's export reads, or null for the shared one. */
  gridPath: string | null;
  /** The section filter it asks for, or null for the shared one. */
  gridSection: string | null;
  /** Which export-dialog stages this reviewer exports, or null for shared. */
  sections: string[] | null;
  /** Only expenses with a receipt attached, or null for the default. */
  receiptsOnly: boolean | null;
  /** Which Emburse lists they import, by source key, or null for the defaults. */
  sources: string[] | null;
  /** Extra filters that pick out their queue, copied from Emburse. */
  gridQuery: string | null;
  /** Whose Emburse login reads it. Null is themselves. */
  runAs: string | null;
  /**
   * Whether their scheduled import reads the MANAGER queue.
   *
   * Off skips only the team-wide grid. Their schedule, their other
   * lists and their automatic approvals are untouched, which is the
   * difference between this and `enabled`.
   */
  managerEnabled: boolean;
  /** Whether the sweep approves their unflagged expenses, under their login. */
  autoApprove: boolean;
  /** How many per pass, or null for the shared number. */
  autoApprovePerRun: number | null;
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

/**
 * Minutes between one reviewer's shared-schedule slots and the next's.
 *
 * Two reviewers on the shared schedule are due at the same minute, and one
 * browser serialises them — so the second waits out the first, which on an
 * export that takes Emburse fifteen minutes to build can push it past its
 * grace window and be recorded as a miss it never had a chance at. Worse
 * when a run parks for a verification code: ten minutes of one person's
 * sign-in is ten minutes the other is not running.
 *
 * Twenty minutes is comfortably longer than a normal run and far shorter
 * than the gap between slots, so the staggered times stay recognisably
 * "the 2am one".
 */
const STAGGER_MINUTES = 20;

/** "02:00" plus n minutes, wrapping at midnight. */
function shiftClock(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Which Emburse list one run opens.
 *
 * A reviewer's own list wins over the default; an explicitly chosen list
 * wins over everything, because Reimbursements is a different page rather
 * than a different stage and asking for it means asking for it.
 *
 * Pulled out of `attemptExport` because the bug it had was invisible in
 * place. The Transactions source carries the EMPTY key — it is what every
 * existing row has — so the scheduler passes `source: ""` for it and the
 * lookup matched every time. The guard read `!list && mine.gridPath`, which
 * was therefore never true, and a reviewer's own list was silently thrown
 * away on every run. The tab somebody picked did nothing at all, which is
 * exactly what "still pulling Eric's receipts even though scope was
 * changed" looks like from the outside.
 */
/**
 * The team-wide approval queue.
 *
 * The grid both approvers read FROM — Emburse calls the tab ADMIN on
 * some tenants and MANAGER on others, but the path is the same. Named
 * once here so the toggle and the scheduler cannot disagree about
 * which grid is being switched off.
 */
export const MANAGER_GRID = "/transactions/team";

/**
 * The grid a PERSONAL tab reads: the person's own expenses.
 *
 * A personal tab that reads /transactions/team is reading the
 * approver's queue, which is the opposite of what the tab is. It
 * defaulted there because the shared default is the team grid and
 * a lane with nothing stored inherited it — so the first personal
 * tab anybody set up pulled other people's expenses.
 */
export const PERSONAL_GRID = "/transactions";

/**
 * One person's import settings FOR ONE TAB.
 *
 * `reviewerImports()` returns a row per (person, tab), so a lookup by
 * email alone is a lookup for "whichever tab happens to come first" —
 * which is the manager one, because that is how the lanes are ordered.
 * A personal run that took that row got the manager tab's list, stages
 * and receipt filter: it clicked the team tab and exported the
 * approver's queue under the personal tab's name.
 *
 * `attemptExport` had this right where it picked the PASSWORD and wrong
 * where it picked the LIST, because the lookup was written twice. There
 * is one of it now, and it takes the tab.
 */
export async function importFor(
  reviewer: string | undefined,
  lane: string,
): Promise<ReviewerImport | undefined> {
  if (!reviewer) return undefined;
  return (await reviewerImports().catch(() => []))
    .find((r) => r.userEmail.toLowerCase() === reviewer.toLowerCase()
      && r.lane === (lane || MANAGER_LANE));
}

export function gridPathFor(
  source: string | undefined,
  list: { path: string } | undefined,
  mine: { gridPath: string | null } | undefined,
): string | undefined {
  // Only a NON-EMPTY source names a different list. The empty one is the
  // default, which is not a request.
  if (source) return list?.path;
  return mine?.gridPath ?? list?.path;
}

export async function reviewerImports(): Promise<ReviewerImport[]> {
  await ensure();
  const { schedule: shared } = await readSettings();
  const { listCredentials } = await import("./credentials.js");
  /*
   * ONE ROW PER PERSON, not per stored login.
   *
   * Somebody can now hold two Emburse accounts, and this used to
   * build a reviewer from every credential row — so the moment Eric
   * added his second, he would have appeared twice in Export
   * settings, taken two stagger slots, and had his import run
   * twice on every tick. The primary one is kept because
   * `listCredentials` orders it first.
   */
  const everyLogin = await listCredentials().catch(() => []);
  const seen = new Set<string>();
  const people = everyLogin.filter((c) => {
    const who = c.userEmail.toLowerCase();
    if (seen.has(who)) return false;
    seen.add(who);
    return true;
  });
  if (people.length === 0) {
    return [{ userEmail: "", lane: MANAGER_LANE, laneLabel: "Manager tab",
              laneKind: "manager", laneLoginEmail: "", connected: false,
              connectionProblem: "No Emburse login is stored.",
              enabled: true, schedule: shared, shared: true,
              staggeredBy: 0, gridPath: null, gridSection: null, gridQuery: null,
              sections: null, receiptsOnly: null, sources: null, runAs: null,
              managerEnabled: true, autoApprove: false,
              autoApprovePerRun: null }];
  }

  const { rows } = await db().query<{
    user_email: string; enabled: boolean; timezone: string | null; first_run: string | null;
    retry_hours: number | null; attempts_per_day: number | null; grace_minutes: number | null;
    all_day: boolean | null; grid_path: string | null; grid_section: string | null;
    manager_enabled: boolean | null;
    auto_approve: boolean | null; auto_approve_per_run: number | null;
    grid_query: string | null; run_as: string | null; sections: unknown;
    receipts_only: boolean | null; sources: unknown; lane: string;
  }>("SELECT * FROM reviewer_imports");
  // Keyed on the PAIR now. One person's manager tab and their two
  // personal tabs are three independent configurations, and reading
  // them back under one key is how a change to one would appear on
  // another.
  const own = new Map(rows.map(
    (r) => [`${r.user_email.toLowerCase()}\u0000${r.lane || MANAGER_LANE}`, r]));

  /*
   * Sorted, so the stagger below is the same on every tick.
   *
   * listCredentials orders by how recently each login worked, which moves
   * — and a reviewer whose slot time changed every time somebody else
   * signed in would miss them all.
   */
  const ordered = [...people].sort((a, b) =>
    a.userEmail.toLowerCase() < b.userEmail.toLowerCase() ? -1 : 1);

  /*
   * Every tab of every person, flattened, so each one gets its own
   * stagger slot. Two tabs of the SAME person cannot share import
   * times any more than two people can: one browser runs them one
   * at a time, so the second waits out the first and can lose its
   * window entirely.
   */
  const slots: { userEmail: string; lane: LinkedLane }[] = [];
  for (const p of ordered) {
    const lanes = await linkedLanesOf(p.userEmail).catch(() => []);
    const use = lanes.length > 0
      ? lanes
      : [{ key: MANAGER_LANE, label: "Manager tab", kind: "manager" as const,
           loginEmail: "", position: 10, connection: null, problem: "" }];
    for (const lane of use) slots.push({ userEmail: p.userEmail, lane });
  }

  return slots.map(({ userEmail: who, lane }, i) => {
    const r = own.get(`${who.toLowerCase()}\u0000${lane.key}`);
    const set = [r?.timezone, r?.first_run, r?.retry_hours, r?.attempts_per_day,
                 r?.grace_minutes, r?.all_day].some((v) => v !== null && v !== undefined);
    /*
     * Nobody shares a slot, even on the shared schedule.
     *
     * Two scopes cannot share import times: one browser runs them one at a
     * time, so the second waits out the first and can lose its own window.
     * A reviewer with no times of their own gets the shared ones offset by
     * their position — 02:00, 02:20, 02:40 — which keeps the shared
     * schedule meaning what it says while giving each run a clear slot.
     * Anybody who sets their own times is left exactly where they put them.
     */
    const stagger = set ? 0 : i * STAGGER_MINUTES;
    return {
      userEmail: who,
      lane: lane.key,
      laneLabel: lane.label,
      laneKind: lane.kind,
      laneLoginEmail: lane.loginEmail,
      connected: lane.connection !== null,
      connectionProblem: lane.problem,
      /*
       * A personal tab with no Emburse account linked is OFF until
       * one is. Leaving it on would mean a scheduled run every
       * twenty minutes that can only fail, filling the history of
       * a tab somebody has not finished setting up — and the
       * failure would read like a broken import rather than a
       * missing password.
       */
      enabled: (r?.enabled ?? true)
        && (lane.kind === "manager" || lane.connection !== null),
      shared: !set,
      /*
       * A PERSONAL TAB READS THE PERSON'S OWN EXPENSES.
       *
       * Null means "inherit", and what it inherited was the
       * shared default — the team grid — so a personal tab
       * arrived pointing at the approver's queue. The lane
       * already knows what it is; it should not need telling.
       */
      gridPath: r?.grid_path ?? (lane.kind === "personal" ? PERSONAL_GRID : null),
      /*
       * AND NO SECTION FILTER.
       *
       * The shared default is "inbox", which is Emburse's Needs
       * Review — the approver's stage. On a personal tab that asks
       * the person's own list for the slice waiting on an approver,
       * which on a tenant that does not have that section on the
       * personal view comes back as a page with no grid on it at
       * all. "/transactions did not load" was this, and the run
       * then went looking for a team-wide list instead.
       *
       * Empty string rather than null because null means inherit.
       * `blank()` writes an empty box back as null, so a personal
       * tab somebody clears lands here again rather than on the
       * approver's section.
       */
      gridSection: r?.grid_section ?? (lane.kind === "personal" ? "" : null),
      gridQuery: r?.grid_query ?? null,
      sections: Array.isArray(r?.sections)
        ? (r!.sections as unknown[]).filter((x): x is string => typeof x === "string")
        : null,
      /*
       * AND IT DOES NOT FILTER OUT THE EXPENSES MISSING A RECEIPT.
       *
       * "Receipts: true" is right for the manager queue, where an
       * expense with no receipt is not yet worth reviewing. On a
       * personal tab it is exactly backwards: the expenses that
       * need a receipt FOUND are the ones with none attached, and
       * filtering them out means the mailbox search has nothing
       * to match against. Inheriting the shared default did that
       * silently.
       */
      receiptsOnly: r?.receipts_only ?? (lane.kind === "personal" ? false : null),
      sources: Array.isArray(r?.sources)
        ? (r!.sources as unknown[]).filter((x): x is string => typeof x === "string")
        : null,
      runAs: r?.run_as ?? null,
      // On unless somebody turned it off — a reviewer with no row has
      // never been configured and is importing today.
      managerEnabled: r?.manager_enabled ?? true,
      autoApprove: r?.auto_approve ?? false,
      autoApprovePerRun: r?.auto_approve_per_run ?? null,
      /** True where every field came from the shared schedule (stagger aside). */
      staggeredBy: stagger,
      schedule: {
        timezone: r?.timezone ?? shared.timezone,
        firstRun: r?.first_run ?? shiftClock(shared.firstRun, stagger),
        retryHours: r?.retry_hours ?? shared.retryHours,
        attemptsPerDay: r?.attempts_per_day ?? shared.attemptsPerDay,
        graceMinutes: r?.grace_minutes ?? shared.graceMinutes,
        allDay: r?.all_day ?? shared.allDay,
      },
    };
  });
}

/**
 * Set one reviewer's own import times, list or approval switch.
 *
 * Only the fields actually supplied are written. That is not tidiness: the
 * same row holds a schedule, a grid path and the switch that approves
 * spending unattended, and three different screens write to it. Writing
 * every column every time meant flipping the automation switch silently
 * cleared the grid path that had just been set to separate two reviewers'
 * queues — the fix for one problem quietly undoing the fix for the other.
 *
 * Passing `schedule: null` DOES clear the times, which is how a reviewer
 * goes back to the shared schedule. Omitting it leaves them alone.
 */
export async function setReviewerImport(
  userEmail: string,
  input: {
    /**
     * Which tab to write. Defaults to the manager one, which is
     * what every existing caller means and what every existing row
     * is. A change to one tab must never land on another.
     */
    lane?: string;
    enabled?: boolean;
    /** Their own times; null puts them back on the shared schedule. */
    schedule?: Partial<Schedule> | null;
    /** Empty string clears it back to the shared setting. */
    gridPath?: string | null;
    gridSection?: string | null;
    /** The stages their export covers; null or empty goes back to shared. */
    sections?: string[] | null;
    /** Only expenses with a receipt; null goes back to the default. */
    receiptsOnly?: boolean | null;
    /** Which lists they import, by key. Null goes back to the defaults. */
    sources?: string[] | null;
    /** Extra filters picking out their queue, copied from Emburse. */
    gridQuery?: string | null;
    /** Whose login reads it. Empty or null means themselves. */
    runAs?: string | null;
    /** Whether their scheduled import reads the manager queue. */
    managerEnabled?: boolean;
    autoApprove?: boolean;
    autoApprovePerRun?: number | null;
  },
  by: string,
): Promise<void> {
  await ensure();
  const blank = (v: string | null | undefined) =>
    v === undefined || v === null || v.trim() === "" ? null : v.trim();

  const set: Record<string, unknown> = {};
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.schedule !== undefined) {
    const sc = input.schedule;
    set.timezone = sc?.timezone ?? null;
    set.first_run = sc?.firstRun ?? null;
    set.retry_hours = sc?.retryHours ?? null;
    set.attempts_per_day = sc?.attemptsPerDay ?? null;
    set.grace_minutes = sc?.graceMinutes ?? null;
    set.all_day = sc?.allDay ?? null;
  }
  if (input.gridPath !== undefined) set.grid_path = blank(input.gridPath);
  if (input.gridSection !== undefined) set.grid_section = blank(input.gridSection);
  if (input.sections !== undefined) {
    set.sections = input.sections && input.sections.length > 0
      ? JSON.stringify(input.sections) : null;
  }
  if (input.receiptsOnly !== undefined) set.receipts_only = input.receiptsOnly;
  if (input.sources !== undefined) {
    // An empty array is a real answer — "import nothing" — but it is almost
    // always a mis-click, and a reviewer who imports nothing simply stops
    // without saying so. Null, the defaults, is the safer reading.
    set.sources = input.sources && input.sources.length > 0
      ? JSON.stringify(input.sources) : null;
  }
  if (input.gridQuery !== undefined) set.grid_query = blank(input.gridQuery);
  if (input.runAs !== undefined) set.run_as = blank(input.runAs)?.toLowerCase() ?? null;
  if (input.managerEnabled !== undefined) set.manager_enabled = input.managerEnabled;
  if (input.autoApprove !== undefined) set.auto_approve = input.autoApprove;
  if (input.autoApprovePerRun !== undefined) set.auto_approve_per_run = input.autoApprovePerRun;
  set.updated_by = by;

  const lane = (input.lane ?? MANAGER_LANE).trim() || MANAGER_LANE;
  const cols = ["user_email", "lane", ...Object.keys(set)];
  const vals = [userEmail.trim().toLowerCase(), lane, ...Object.values(set)];
  const marks = vals.map((_, i) => `$${i + 1}`).join(",");
  const updates = [
    ...Object.keys(set).map((c) => `${c} = EXCLUDED.${c}`),
    "updated_at = now()",
  ].join(", ");
  await db().query(
    `INSERT INTO reviewer_imports (${cols.join(",")}) VALUES (${marks})
     ON CONFLICT (user_email, lane) DO UPDATE SET ${updates}`,
    vals);
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
      const every = (await readSettings()).sources;
      for (const who of await reviewerImports()) {
        if (!who.enabled) continue;
        // THEIR lists. Transactions and Reimbursements are separate pages
        // with separate queues, and which of them somebody has anything in
        // is a fact about that person, not about the deployment.
        const lists = (who.sources
          ? every.filter((x) => who.sources!.includes(x.key))
          : every.filter((x) => x.enabled))
          /*
           * The manager queue, if they have it switched off.
           *
           * Only that grid. Reimbursements is a different page with its
           * own queue and keeps running, which is the whole point of
           * this being separate from `enabled` — switching somebody's
           * whole import off to pause one queue would take their
           * schedule and their other lists with it.
           *
           * Judged on the path the run would ACTUALLY open, via
           * `gridPathFor`, rather than on the list's own default: a
           * reviewer pointed at the personal grid is not reading the
           * manager queue, and this must not stop them.
           */
          .filter((x) => who.managerEnabled
            || gridPathFor(x.key, x, who) !== MANAGER_GRID);
        // One timeline per reviewer PER LIST. Transactions and
        // Reimbursements are separate queues on separate pages, so sharing
        // a count means the first one read spends the other's attempts and
        // the second never updates — the same fault as sharing one between
        // two reviewers, one level along.
        for (const list of lists) {
          /*
           * One timeline per TAB per list, not per person per list.
           *
           * Eric's manager queue, his MOJO account and his Mammoth
           * account are three different Needs Review lists. Sharing
           * a day's attempts between them means the first one read
           * spends the others' budget and they never update — the
           * same fault as sharing one between two reviewers, one
           * level further along. The manager tab passes the empty
           * lane, which is what every run recorded so far carries,
           * so its count is unchanged by any of this.
           */
          const { due, attempt } = await nextDue(
            who.schedule, new Date(), who.userEmail, list.key,
            laneTag(who.lane));
          if (!due) continue;

          console.log(
            `export: starting scheduled attempt ${attempt} of ${list.label}` +
            (who.userEmail ? ` for ${who.userEmail}` : "") +
            (who.lane === MANAGER_LANE ? "" : ` (${who.laneLabel})`));
          const { run } = await attemptExport("scheduled", "scheduler", {
            reviewer: who.userEmail, source: list.key, lane: who.lane,
          });
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
