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
    const mineForLogin = opts.reviewer
      ? (await reviewerImports().catch(() => []))
          .find((r) => r.userEmail.toLowerCase() === opts.reviewer!.toLowerCase())
      : undefined;
    const signsIn = mineForLogin?.runAs?.trim() || opts.reviewer;

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
    if (opts.reviewer && signsIn && signsIn.toLowerCase() !== opts.reviewer.toLowerCase()
        && !mineForLogin?.gridQuery) {
      throw new Error(
        `${opts.reviewer}'s import is set to sign in as ${signsIn}, with no filter to pick ` +
        `${opts.reviewer}'s rows out. Needs Review is per account, so that would read ` +
        `${signsIn}'s queue and file it as ${opts.reviewer}'s. Either set the login back to ` +
        `${opts.reviewer}, or paste a URL from Emburse with Current Reviewer set to them.`);
    }

    const login = opts.reviewer
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
     * And WHOSE stage to read, by the same mechanism.
     *
     * Approval is a chain — Eric approves, then it goes to Brian — so the
     * two reviewers have two queues that the same URL cannot both describe.
     * A reviewer's own path and section override the shared ones; set
     * neither and nothing changes, which is every single-reviewer tenant.
     */
    const mine = opts.reviewer
      ? (await reviewerImports().catch(() => []))
          .find((r) => r.userEmail.toLowerCase() === opts.reviewer!.toLowerCase())
      : undefined;
    const askedForAnotherList = Boolean(opts.source);
    const chosenPath = gridPathFor(opts.source, list, mine);
    const forThisRun = {
      ...settings.selectors,
      ...(chosenPath ? { gridPath: chosenPath } : {}),
      // The reviewer's section belongs to the list it was chosen on. Ask for
      // a DIFFERENT list and it does not travel: Reimbursements has its own
      // sections, and "inbox" there is a filter for something else or for
      // nothing at all.
      ...(askedForAnotherList
        ? (list?.section === undefined ? {} : { gridSection: list.section })
        : (mine?.gridSection ? { gridSection: mine.gridSection } : {})),
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
  const people = await listCredentials().catch(() => []);
  if (people.length === 0) {
    return [{ userEmail: "", enabled: true, schedule: shared, shared: true,
              staggeredBy: 0, gridPath: null, gridSection: null, gridQuery: null,
              sections: null, receiptsOnly: null, sources: null, runAs: null,
              autoApprove: false,
              autoApprovePerRun: null }];
  }

  const { rows } = await db().query<{
    user_email: string; enabled: boolean; timezone: string | null; first_run: string | null;
    retry_hours: number | null; attempts_per_day: number | null; grace_minutes: number | null;
    all_day: boolean | null; grid_path: string | null; grid_section: string | null;
    auto_approve: boolean | null; auto_approve_per_run: number | null;
    grid_query: string | null; run_as: string | null; sections: unknown;
    receipts_only: boolean | null; sources: unknown;
  }>("SELECT * FROM reviewer_imports");
  const own = new Map(rows.map((r) => [r.user_email.toLowerCase(), r]));

  /*
   * Sorted, so the stagger below is the same on every tick.
   *
   * listCredentials orders by how recently each login worked, which moves
   * — and a reviewer whose slot time changed every time somebody else
   * signed in would miss them all.
   */
  const ordered = [...people].sort((a, b) =>
    a.userEmail.toLowerCase() < b.userEmail.toLowerCase() ? -1 : 1);

  return ordered.map((p, i) => {
    const r = own.get(p.userEmail.toLowerCase());
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
      userEmail: p.userEmail,
      enabled: r?.enabled ?? true,
      shared: !set,
      gridPath: r?.grid_path ?? null,
      gridSection: r?.grid_section ?? null,
      gridQuery: r?.grid_query ?? null,
      sections: Array.isArray(r?.sections)
        ? (r!.sections as unknown[]).filter((x): x is string => typeof x === "string")
        : null,
      receiptsOnly: r?.receipts_only ?? null,
      sources: Array.isArray(r?.sources)
        ? (r!.sources as unknown[]).filter((x): x is string => typeof x === "string")
        : null,
      runAs: r?.run_as ?? null,
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
  if (input.autoApprove !== undefined) set.auto_approve = input.autoApprove;
  if (input.autoApprovePerRun !== undefined) set.auto_approve_per_run = input.autoApprovePerRun;
  set.updated_by = by;

  const cols = ["user_email", ...Object.keys(set)];
  const vals = [userEmail.trim().toLowerCase(), ...Object.values(set)];
  const marks = vals.map((_, i) => `$${i + 1}`).join(",");
  const updates = [
    ...Object.keys(set).map((c) => `${c} = EXCLUDED.${c}`),
    "updated_at = now()",
  ].join(", ");
  await db().query(
    `INSERT INTO reviewer_imports (${cols.join(",")}) VALUES (${marks})
     ON CONFLICT (user_email) DO UPDATE SET ${updates}`,
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
        const lists = who.sources
          ? every.filter((x) => who.sources!.includes(x.key))
          : every.filter((x) => x.enabled);
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
