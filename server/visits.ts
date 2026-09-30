/**
 * What happened while somebody was away.
 *
 * The automation approves expenses with nobody watching, which is the point
 * of it and also the problem with it: a reviewer comes back to a queue that
 * is forty rows shorter than they left it and nothing says why. Trusting an
 * automation you cannot see the work of is a lot to ask.
 *
 * So each person gets one row recording when they were last here, and coming
 * back after a gap freezes the window they missed. The count is then a plain
 * fact about a fixed period — "23 while you were away, from 4:15pm yesterday"
 * — rather than a number that creeps upwards as they sit and read it.
 *
 * "Login" is the wrong hinge for this, incidentally, and it is worth saying
 * why. Sessions here are signed cookies renewed silently through Entra, so a
 * person can use the app for weeks without a login event ever happening. What
 * they mean by "since I last logged in" is "since I was last here", and that
 * is what a gap measures.
 */

import { db, ensureSchema } from "./db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_visits (
  email        text        PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- The window they missed: from when they were last here, to when they came
  -- back. Both null on a first-ever visit, which reports nothing — there is
  -- no "while you were away" before there was an away.
  away_from    timestamptz,
  away_to      timestamptz
);
`;

let ready: Promise<void> | null = null;
/** Exported so the test can stand the table up before it tidies it. */
export const ensureVisits = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));
const ensure = ensureVisits;

/**
 * How long an absence has to be before coming back counts as coming back.
 *
 * Thirty minutes: long enough that a coffee, a meeting or a tab left open in
 * the background does not reset the window and lose what they had not read
 * yet, short enough that the morning's first look reports the night.
 */
const AWAY_MS = 30 * 60_000;

/**
 * Don't write on every poll.
 *
 * The queue polls every few seconds while it is open, and the only thing
 * that write establishes is "still here" — which a row already a few seconds
 * old says just as well. In memory rather than in the database because being
 * wrong about it costs one extra UPDATE.
 */
const WRITE_EVERY_MS = 60_000;
const lastWrite = new Map<string, number>();

/**
 * Record that somebody is here, and roll the window if they have been away.
 *
 * Never throws and never blocks the request it rides on: this is a note in
 * the margin, and no page should fail to load because it could not be
 * written.
 */
export async function noteVisit(
  email: string,
  /**
   * Skip the once-a-minute throttle. Only the test uses it — respecting the
   * throttle honestly would make the suite take an hour, and the alternative
   * (the test writing its own copy of the statement) is how a rule quietly
   * drifts away from the one that ships.
   */
  opts: { force?: boolean } = {},
): Promise<void> {
  const key = email.trim().toLowerCase();
  if (!key) return;

  const now = Date.now();
  if (!opts.force) {
    const previous = lastWrite.get(key) ?? 0;
    if (now - previous < WRITE_EVERY_MS) return;
  }
  lastWrite.set(key, now);

  try {
    await ensure();
    // One statement, so two requests arriving together cannot both decide
    // they are the one that rolled the window. The gap is measured against
    // the stored value inside the same update that replaces it.
    await db().query(
      `INSERT INTO user_visits (email, last_seen_at, away_from, away_to)
       VALUES ($1, now(), NULL, NULL)
       ON CONFLICT (email) DO UPDATE SET
         away_from = CASE
           WHEN now() - user_visits.last_seen_at > ($2 || ' milliseconds')::interval
           THEN user_visits.last_seen_at ELSE user_visits.away_from END,
         away_to = CASE
           WHEN now() - user_visits.last_seen_at > ($2 || ' milliseconds')::interval
           THEN now() ELSE user_visits.away_to END,
         last_seen_at = now()`,
      [key, String(AWAY_MS)],
    );
  } catch {
    // Deliberately silent. A missing table on an install that has never had
    // a database is not worth a line in the log on every request.
    lastWrite.delete(key);
  }
}

export type WhileAway = {
  /** Start of the window they missed, ISO. Null on a first visit. */
  from: string | null;
  /** End of it — when they came back. */
  to: string | null;
  /** Automatic approvals that reached Emburse in that window. */
  approved: number;
  /** Whether those were made under THIS person's Emburse login. */
  mine: number;
};

/**
 * What the automation did between their last visit and this one.
 *
 * Counted on `applied_at`, not on when the decision was queued: the claim is
 * that these reached Emburse, and a decision queued at midnight that failed
 * at eight is not an approval. Cancelled and failed ones are excluded for
 * the same reason.
 *
 * `mine` is separated because an automatic approval carries a real person's
 * name in Emburse — whoever owns the automation — and that person is the one
 * for whom "the automation approved 23" is a statement about their own
 * account rather than about the app's.
 */
export async function whileAway(email: string): Promise<WhileAway> {
  const key = email.trim().toLowerCase();
  const empty: WhileAway = { from: null, to: null, approved: 0, mine: 0 };
  if (!key) return empty;

  await ensure();
  const { rows } = await db().query<{ away_from: Date | null; away_to: Date | null }>(
    "SELECT away_from, away_to FROM user_visits WHERE email = $1", [key]);
  const v = rows[0];
  if (!v?.away_from || !v.away_to) return empty;

  const counts = await db().query<{ approved: string; mine: string }>(
    `SELECT count(*) AS approved,
            count(*) FILTER (WHERE lower(btrim(decided_by)) = $1) AS mine
       FROM expense_decisions
      WHERE automatic = true AND state = 'applied' AND decision = 'approve'
        AND applied_at >= $2 AND applied_at < $3`,
    [key, v.away_from, v.away_to]);

  return {
    from: v.away_from.toISOString(),
    to: v.away_to.toISOString(),
    approved: Number(counts.rows[0]?.approved ?? 0),
    mine: Number(counts.rows[0]?.mine ?? 0),
  };
}
