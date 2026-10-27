import { db, ensureSchema } from "../db.js";
import { PRIMARY, open, seal, type CredentialStatus } from "./credentials.js";

/**
 * One person, more than one Emburse account.
 *
 * Eric submits expenses in two Emburse tenants — MOJO and Mammoth —
 * and until now this app could hold one login per person. Adding a
 * second is not a bigger version of the same thing; it is three new
 * ways to be wrong, and this file exists to make each of them hard:
 *
 *   SIGNING IN AS THE WRONG ONE. Every read and every write names
 *   its connection explicitly. There is no "the user's credential"
 *   any more and no fallback from one of somebody's accounts to
 *   another — a missing connection is an error with a sentence, not
 *   a quiet substitution. The manager queue and every approval stay
 *   pinned to the PRIMARY connection, which is what they have
 *   always used, so nothing about them moves.
 *
 *   CLAIMING A MIGRATION THAT DID NOT HAPPEN. The connection that
 *   already exists signs in as some address; which personal tab it
 *   belongs to is decided by COMPARING that address to the tab's,
 *   never by assuming that the app user's own email says anything
 *   about it. An address that matches neither is reported as
 *   unverified and linked to nothing.
 *
 *   MIXING UP WHOSE VERIFICATION CODE IS WHOSE. A parked sign-in
 *   belongs to one connection. The other one's tab says which
 *   account is waiting rather than offering a code box that would
 *   submit six digits to the wrong tenant.
 *
 * The password is still never returned by any route, to its owner
 * or to an administrator.
 */

/** A lane is one import configuration: a tab in Export settings. */
export type LaneKind = "manager" | "personal";

export type Lane = {
  key: string;
  label: string;
  kind: LaneKind;
  /**
   * The Emburse login this lane MUST use.
   *
   * Empty on the manager lane, which uses the primary connection
   * whatever its address is. On a personal lane it is the whole
   * point: the lane is defined by the account, so a connection only
   * counts as this lane's when its login matches.
   */
  loginEmail: string;
  position: number;
};

export type LinkedLane = Lane & {
  /** The connection serving it, or null when none matches. */
  connection: Connection | null;
  /**
   * Why it is not linked, when it is not. A sentence rather than a
   * blank, because "no connection" and "a connection that signs in
   * as somebody else" need different answers from the person.
   */
  problem: string;
};

export type Connection = CredentialStatus & {
  /** True for the connection the manager queue and decisions use. */
  isPrimary: boolean;
  /** A sign-in of THIS connection is parked on a verification code. */
  awaitingCode: boolean;
  codeAskedAt: string | null;
};

const SCHEMA = `
/**
 * Which Emburse account each tab of Export settings signs in with.
 *
 * A row per (person, tab). The LOGIN EMAIL is the definition of a
 * personal tab — "Personal Tab - MOJO" means the MOJO Emburse
 * account and nothing else — and the connection is linked only when
 * a stored one actually signs in as that address. Keeping the two
 * columns apart is what makes "we have not verified this" sayable.
 */
CREATE TABLE IF NOT EXISTS emburse_lanes (
  user_email  text    NOT NULL,
  lane_key    text    NOT NULL,
  label       text    NOT NULL,
  kind        text    NOT NULL DEFAULT 'personal',
  login_email text    NOT NULL DEFAULT '',
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, lane_key)
);
`;

/** The manager lane. Its connection is the primary one, by definition. */
export const MANAGER_LANE = "manager";

/**
 * The lane as it is STORED on a run and on an expense.
 *
 * The manager queue stores the EMPTY string, not "manager", and
 * that is load-bearing rather than tidy: every expense and every
 * run already in the database has an empty lane, the dedupe key
 * includes the lane, and a key that changes is a new expense with
 * no decision history — for every row at once.
 *
 * So the conversion happens in exactly one place, here, and
 * everything downstream of `attemptExport` deals in tags rather
 * than in lane keys.
 */
export const laneTag = (lane: string | null | undefined): string =>
  !lane || lane === MANAGER_LANE ? "" : lane.trim();

/**
 * The mapping the owner confirmed, seeded once.
 *
 * Seeded rather than hardcoded in a constant that every read
 * consults: the labels and addresses are this deployment's fact,
 * not the application's, and a second person with two Emburse
 * accounts must be a row rather than a code change. `ON CONFLICT DO
 * NOTHING`, so an edit here is never undone by a redeploy.
 */
const SEED: { userEmail: string; lanes: Omit<Lane, "position">[] }[] = [
  {
    userEmail: "eric.s@mojocarwash.com",
    lanes: [
      { key: MANAGER_LANE, label: "Manager tab", kind: "manager", loginEmail: "" },
      {
        key: "personal-mojo", label: "Personal Tab - MOJO", kind: "personal",
        loginEmail: "eric.s@mojocarwash.com",
      },
      {
        key: "personal-mammoth", label: "Personal Tab - Mammoth", kind: "personal",
        loginEmail: "eric.s@mammothholdings.com",
      },
    ],
  },
];

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
    for (const person of SEED) {
      let position = 0;
      for (const lane of person.lanes) {
        position += 10;
        await db().query(
          `INSERT INTO emburse_lanes (user_email, lane_key, label, kind, login_email, position)
                VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_email, lane_key) DO NOTHING`,
          [person.userEmail.toLowerCase(), lane.key, lane.label, lane.kind,
            lane.loginEmail.toLowerCase(), position]);
      }
    }
  }));

/** For a test that needs the schema re-asserted against a fresh database. */
export const resetConnectionsCache = (): void => { ready = null; };

type DbConn = {
  user_email: string; login_email: string; updated_at: Date; last_ok_at: Date | null;
  last_error: string | null; needs_reentry: boolean; account_key: string; label: string;
  awaiting_code: boolean; code_asked_at: Date | null;
};

const C_COLS = `user_email, login_email, updated_at, last_ok_at, last_error,
                needs_reentry, account_key, label, awaiting_code, code_asked_at`;

const shape = (r: DbConn): Connection => ({
  userEmail: r.user_email,
  loginEmail: r.login_email,
  updatedAt: r.updated_at.toISOString(),
  lastOkAt: r.last_ok_at?.toISOString() ?? null,
  lastError: r.last_error,
  needsReentry: Boolean(r.needs_reentry),
  accountKey: r.account_key,
  label: r.label,
  isPrimary: r.account_key === PRIMARY,
  awaitingCode: Boolean(r.awaiting_code),
  codeAskedAt: r.code_asked_at?.toISOString() ?? null,
});

/**
 * Every Emburse account this person has stored.
 *
 * Never a password, and never anybody else's: the caller passes its
 * own user id, so there is no ownership check to get wrong.
 */
export async function listConnections(userId: string): Promise<Connection[]> {
  await ensure();
  const { rows } = await db().query<DbConn>(
    `SELECT ${C_COLS} FROM emburse_credentials
      WHERE user_id = $1 ORDER BY (account_key = $2) DESC, label, login_email`,
    [userId, PRIMARY]);
  return rows.map(shape);
}

/**
 * The same, by the address somebody signs into THIS APP with.
 *
 * The scheduler knows a reviewer by email and never sees a user
 * id, so it needs this. Identical rows, identical ordering — the
 * two functions differ only in which column they are given.
 */
export async function connectionsOf(userEmail: string): Promise<Connection[]> {
  await ensure();
  const { rows } = await db().query<DbConn>(
    `SELECT ${C_COLS} FROM emburse_credentials
      WHERE lower(user_email) = lower($1)
      ORDER BY (account_key = $2) DESC, label, login_email`,
    [userEmail, PRIMARY]);
  return rows.map(shape);
}

export async function getConnection(
  userId: string, accountKey: string,
): Promise<Connection | null> {
  await ensure();
  const { rows } = await db().query<DbConn>(
    `SELECT ${C_COLS} FROM emburse_credentials WHERE user_id = $1 AND account_key = $2`,
    [userId, accountKey]);
  return rows[0] ? shape(rows[0]) : null;
}

/** A key that is this person's own, stable, and not guessable as somebody's. */
const mintKey = (loginEmail: string): string => {
  const slug = loginEmail.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18) || "acct";
  return `acct_${slug}_${Date.now().toString(36)}`;
};

export type AddResult =
  | { ok: true; connection: Connection; created: boolean }
  | { ok: false; problem: string };

/**
 * Store another Emburse account for this person.
 *
 * The same Emburse login twice is refused. Two rows for one tenant
 * would be two sealed passwords that can disagree, two sign-in
 * states, and a lane link that picks whichever came back first —
 * and the symptom would be an intermittent sign-in failure nobody
 * could reproduce.
 */
export async function addConnection(opts: {
  userId: string; userEmail: string; loginEmail: string; password: string;
  label?: string;
  /** Replace an existing one rather than adding. Its key, never a new one. */
  accountKey?: string;
}): Promise<AddResult> {
  await ensure();
  const loginEmail = opts.loginEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(loginEmail)) {
    return { ok: false, problem: "That does not look like an email address." };
  }
  if (!opts.password) return { ok: false, problem: "The Emburse password is required." };

  const mine = await listConnections(opts.userId);
  const clash = mine.find((c) => c.loginEmail.toLowerCase() === loginEmail
    && c.accountKey !== opts.accountKey);
  if (clash) {
    return {
      ok: false,
      problem: `${loginEmail} is already stored${clash.label ? ` as “${clash.label}”` : ""}. `
        + "Replace that one rather than adding it twice — two rows for one Emburse account "
        + "is two passwords that can disagree.",
    };
  }

  const key = opts.accountKey ?? mintKey(loginEmail);
  const label = (opts.label ?? "").trim().slice(0, 60);
  const { rows } = await db().query<DbConn>(
    `INSERT INTO emburse_credentials
       (user_id, user_email, login_email, secret, account_key, label)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, account_key) DO UPDATE SET
       login_email = excluded.login_email, secret = excluded.secret,
       label = CASE WHEN excluded.label = '' THEN emburse_credentials.label
                    ELSE excluded.label END,
       updated_at = now(),
       -- A new password invalidates what the old one proved, and
       -- clears a code challenge that was waiting on the old one.
       last_ok_at = NULL, last_error = NULL, needs_reentry = false,
       awaiting_code = false, code_asked_at = NULL
     RETURNING ${C_COLS}`,
    [opts.userId, opts.userEmail, loginEmail, seal(opts.password), key, label]);
  return {
    ok: true, connection: shape(rows[0]!), created: opts.accountKey === undefined,
  };
}

/** Rename one. A label decides nothing, so this cannot break a sign-in. */
export async function labelConnection(
  userId: string, accountKey: string, label: string,
): Promise<boolean> {
  await ensure();
  const { rowCount } = await db().query(
    "UPDATE emburse_credentials SET label = $3 WHERE user_id = $1 AND account_key = $2",
    [userId, accountKey, label.trim().slice(0, 60)]);
  return (rowCount ?? 0) > 0;
}

export async function removeConnection(
  userId: string, accountKey: string,
): Promise<boolean> {
  await ensure();
  const { rowCount } = await db().query(
    "DELETE FROM emburse_credentials WHERE user_id = $1 AND account_key = $2",
    [userId, accountKey]);
  return (rowCount ?? 0) > 0;
}

/**
 * The password for ONE named connection.
 *
 * The only function here that decrypts, and it names its account.
 * There is deliberately no variant that takes a person and works
 * out which of their accounts to use.
 */
export async function credentialFor(
  userEmail: string, accountKey: string,
): Promise<{ userId: string; email: string; password: string; accountKey: string } | null> {
  await ensure();
  const { rows } = await db().query<{ user_id: string; login_email: string; secret: Buffer }>(
    `SELECT user_id, login_email, secret FROM emburse_credentials
      WHERE lower(user_email) = lower($1) AND account_key = $2`,
    [userEmail, accountKey]);
  const row = rows[0];
  if (!row) return null;
  try {
    return {
      userId: row.user_id, email: row.login_email, password: open(row.secret),
      accountKey,
    };
  } catch {
    throw new Error(
      "The stored Emburse password could not be decrypted — SESSION_SECRET or "
      + "EMBURSE_CREDENTIAL_KEY has changed since it was saved. Its owner needs to enter "
      + "it again.");
  }
}

/* ------------------------------------------------------------------ *
 * Lanes, and which connection serves each
 * ------------------------------------------------------------------ */

export async function lanesFor(userEmail: string): Promise<Lane[]> {
  await ensure();
  const { rows } = await db().query<{
    lane_key: string; label: string; kind: string; login_email: string; position: number;
  }>(`SELECT lane_key, label, kind, login_email, position FROM emburse_lanes
       WHERE lower(user_email) = lower($1) ORDER BY position, lane_key`, [userEmail]);
  if (rows.length === 0) {
    // Somebody with no mapping still has the tab they have always
    // had. A person who has never needed a second Emburse account
    // must not lose Export settings because this table is empty.
    return [{
      key: MANAGER_LANE, label: "Manager tab", kind: "manager", loginEmail: "", position: 10,
    }];
  }
  return rows.map((r) => ({
    key: r.lane_key,
    label: r.label,
    kind: r.kind === "manager" ? "manager" : "personal",
    loginEmail: r.login_email,
    position: r.position,
  }));
}

/**
 * Each tab, and the stored connection that actually serves it.
 *
 * THE VERIFICATION, and the reason this is a function rather than a
 * column. A personal lane is linked to a connection only when that
 * connection's Emburse login IS the lane's address. The app user's
 * own address says nothing: the one already stored here displays a
 * Mammoth login while the person signs into this app as MOJO, and
 * assuming the two agree is exactly how the wrong tenant gets
 * written to.
 *
 * A lane with no match is returned with a sentence saying what was
 * found instead, and linked to nothing.
 */
export async function linkedLanes(
  userId: string, userEmail: string,
): Promise<LinkedLane[]> {
  const [lanes, conns] = await Promise.all([
    lanesFor(userEmail), listConnections(userId),
  ]);
  return link(lanes, conns);
}

/** The same, for a caller that knows the person only by email. */
export async function linkedLanesOf(userEmail: string): Promise<LinkedLane[]> {
  const [lanes, conns] = await Promise.all([
    lanesFor(userEmail), connectionsOf(userEmail),
  ]);
  return link(lanes, conns);
}

function link(lanes: Lane[], conns: Connection[]): LinkedLane[] {
  const primary = conns.find((c) => c.isPrimary) ?? null;
  return lanes.map((lane) => {
    if (lane.kind === "manager") {
      return {
        ...lane,
        connection: primary,
        problem: primary ? ""
          : "No Emburse login is stored, so the manager queue cannot be read.",
      };
    }
    const match = conns.find(
      (c) => c.loginEmail.toLowerCase() === lane.loginEmail.toLowerCase());
    if (match) return { ...lane, connection: match, problem: "" };
    const near = conns.map((c) => c.loginEmail).join(", ");
    return {
      ...lane,
      connection: null,
      problem: conns.length === 0
        ? `No Emburse login is stored for ${lane.loginEmail}.`
        : `Nothing stored here signs in as ${lane.loginEmail}. The ${conns.length} `
          + `connection${conns.length === 1 ? "" : "s"} on file sign${conns.length === 1
            ? "s" : ""} in as ${near}. Add ${lane.loginEmail} rather than assuming one of `
          + "those is it.",
    };
  });
}

/**
 * The connection one lane must use, or a refusal naming the lane.
 *
 * Every import, upload and write-back goes through here, so there
 * is one place that can answer "which account is this about" and no
 * caller that can answer it differently.
 */
export async function credentialForLane(
  userId: string, userEmail: string, laneKey: string,
): Promise<
  | { ok: true; lane: LinkedLane; email: string; password: string; accountKey: string }
  | { ok: false; problem: string }
> {
  return laneCredential(await linkedLanes(userId, userEmail), userEmail, laneKey);
}

/** The same, for the scheduler, which knows a reviewer only by email. */
export async function credentialForLaneOf(
  userEmail: string, laneKey: string,
): Promise<
  | { ok: true; lane: LinkedLane; email: string; password: string; accountKey: string }
  | { ok: false; problem: string }
> {
  return laneCredential(await linkedLanesOf(userEmail), userEmail, laneKey);
}

async function laneCredential(
  lanes: LinkedLane[], userEmail: string, laneKey: string,
): Promise<
  | { ok: true; lane: LinkedLane; email: string; password: string; accountKey: string }
  | { ok: false; problem: string }
> {
  const lane = lanes.find((l) => l.key === laneKey);
  if (!lane) return { ok: false, problem: `No tab called “${laneKey}”.` };
  if (!lane.connection) {
    return { ok: false, problem: lane.problem || "That tab has no Emburse account linked." };
  }
  const cred = await credentialFor(userEmail, lane.connection.accountKey);
  if (!cred) {
    return { ok: false, problem: `${lane.label} has no Emburse login stored.` };
  }
  return {
    ok: true, lane, email: cred.email, password: cred.password,
    accountKey: lane.connection.accountKey,
  };
}

/* ------------------------------------------------------------------ *
 * A sign-in parked on a verification code
 * ------------------------------------------------------------------ */

/**
 * Mark one connection as waiting for six digits, or no longer.
 *
 * Recorded per connection so the OTHER tab can say "Mammoth is
 * waiting" instead of showing a code box of its own. Two tabs each
 * offering to answer, with one browser between them, is how a code
 * meant for one tenant gets typed into the other.
 */
export async function setAwaitingCode(
  userEmail: string, accountKey: string, waiting: boolean,
): Promise<void> {
  await ensure();
  await db().query(
    `UPDATE emburse_credentials
        SET awaiting_code = $3,
            code_asked_at = CASE WHEN $3 THEN now() ELSE NULL END
      WHERE lower(user_email) = lower($1) AND account_key = $2`,
    [userEmail, accountKey, waiting]);
}

/** Which of this person's accounts is waiting on a code, if any. */
export async function awaitingCode(userId: string): Promise<Connection | null> {
  const mine = await listConnections(userId);
  return mine.find((c) => c.awaitingCode) ?? null;
}

/** Drop every connection a removed person had. */
export async function forgetConnections(userId: string): Promise<void> {
  await ensure();
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [userId]);
}
