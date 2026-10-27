import crypto from "node:crypto";
import { db, ensureSchema } from "../db.js";
import { flagOwner } from "../flags.js";
import { env } from "../env.js";

/**
 * Per-user Emburse logins, entered by their owner and never shown to anyone.
 *
 * What this does guarantee: no endpoint in this app returns a stored password,
 * to its owner or to an administrator. The owner can replace it or delete it,
 * and can see whether it works; nobody can read it back out, and it is stored
 * encrypted so it is not legible to anyone browsing the database.
 *
 * What it cannot guarantee: secrecy from whoever controls the deployment. The
 * scheduler has to sign in at six in the morning with nobody present, so the
 * server must hold a key it can use unaided — and anyone who can read both the
 * database and the environment can therefore recover the password. That is not
 * a flaw in the encryption, it is what unattended automation costs.
 *
 * The way out of that trade is not a cleverer scheme, it is a credential nobody
 * owns personally: a dedicated Emburse service account. Then there is no private
 * password in here to protect.
 */

/**
 * ONE PERSON, MORE THAN ONE EMBURSE ACCOUNT.
 *
 * The table was keyed on the app user, one row each, which was true
 * until somebody had two Emburse logins — a company one and a second
 * company's. Widened rather than replaced, and widened with a
 * DEFAULT, so every row that already exists becomes the 'primary'
 * connection and every caller that asks the old question gets the
 * old answer.
 *
 * 'primary' is not a label, it is a JOB: it is the connection the
 * manager queue is read with and the one a decision is applied
 * under. A second connection must never be able to inherit that by
 * being newer or by having signed in more recently — this codebase
 * has already been bitten once by "most recently proven to work"
 * silently moving whose queue the app shows.
 */
export const PRIMARY = "primary";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS emburse_credentials (
  user_id      text PRIMARY KEY,
  user_email   text        NOT NULL,
  login_email  text        NOT NULL,
  secret       bytea       NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  last_ok_at   timestamptz,
  last_error   text
);
ALTER TABLE emburse_credentials ADD COLUMN IF NOT EXISTS needs_reentry boolean NOT NULL DEFAULT false;
ALTER TABLE emburse_credentials
  ADD COLUMN IF NOT EXISTS account_key text NOT NULL DEFAULT 'primary';
/* What its owner calls it. Never used to decide anything. */
ALTER TABLE emburse_credentials ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';
/* A sign-in parked on a verification code, per connection, so a tab
   can say "this one is waiting" without claiming the other is. */
ALTER TABLE emburse_credentials
  ADD COLUMN IF NOT EXISTS awaiting_code boolean NOT NULL DEFAULT false;
ALTER TABLE emburse_credentials ADD COLUMN IF NOT EXISTS code_asked_at timestamptz;

DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'emburse_credentials_user_account_pk'
  ) THEN
    ALTER TABLE emburse_credentials DROP CONSTRAINT IF EXISTS emburse_credentials_pkey;
    ALTER TABLE emburse_credentials
      ADD CONSTRAINT emburse_credentials_user_account_pk PRIMARY KEY (user_id, account_key);
  END IF;
END $do$;

CREATE INDEX IF NOT EXISTS emburse_credentials_owner
  ON emburse_credentials (lower(user_email), account_key);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
  }));

export type CredentialStatus = {
  /** Whose it is. Shown to admins so they know a credential exists, and whose. */
  userEmail: string;
  /** The Emburse account it signs in as. Not a secret — the password is. */
  loginEmail: string;
  updatedAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  /**
   * Whether the owner needs to type it again.
   *
   * Only ever true after a failure to *sign in*. A run that gets past the login
   * and then trips over a changed button is a selector problem, and telling
   * someone their password is wrong when it is not teaches them to ignore the
   * message.
   */
  needsReentry: boolean;
  /** Which of its owner's Emburse accounts this is. */
  accountKey: string;
  /** What its owner calls it. Never used to decide anything. */
  label: string;
};

const ALGO = "aes-256-gcm";

/**
 * The encryption key.
 *
 * Derived from a dedicated secret when there is one, and from the session
 * secret otherwise, so the feature works on a deployment that has not been told
 * about it. Rotating either makes stored passwords undecryptable, which surfaces
 * as a sign-in failure telling the owner to re-enter it — the right outcome,
 * since the alternative is a silent fallback to something weaker.
 */
function key(): Buffer {
  const material = env.credentialKey || env.sessionSecret;
  if (!material) {
    throw new Error("Set SESSION_SECRET (or EMBURSE_CREDENTIAL_KEY) before storing an Emburse login.");
  }
  return crypto.scryptSync(material, "mojo-expense.emburse-credential.v1", 32);
}

export function seal(plain: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  // iv | tag | ciphertext, so one column holds everything needed to open it.
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function open(sealed: Buffer): string {
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const decipher = crypto.createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8");
}

export async function saveCredential(
  userId: string,
  userEmail: string,
  loginEmail: string,
  password: string,
  /** Which of this person's Emburse accounts. Theirs alone decides. */
  accountKey: string = PRIMARY,
  label = "",
): Promise<void> {
  await ensure();
  await db().query(
    `INSERT INTO emburse_credentials
       (user_id, user_email, login_email, secret, updated_at, last_ok_at, last_error,
        account_key, label)
     VALUES ($1,$2,$3,$4, now(), NULL, NULL, $5, $6)
     ON CONFLICT (user_id, account_key) DO UPDATE SET
       user_email = EXCLUDED.user_email, login_email = EXCLUDED.login_email,
       secret = EXCLUDED.secret, updated_at = now(),
       label = CASE WHEN EXCLUDED.label = '' THEN emburse_credentials.label
                    ELSE EXCLUDED.label END,
       -- A new password invalidates what the old one proved.
       last_ok_at = NULL, last_error = NULL, needs_reentry = false,
       awaiting_code = false, code_asked_at = NULL`,
    [userId, userEmail, loginEmail, seal(password), accountKey, label],
  );
}

export async function deleteCredential(
  userId: string, accountKey: string = PRIMARY,
): Promise<boolean> {
  await ensure();
  const r = await db().query(
    "DELETE FROM emburse_credentials WHERE user_id = $1 AND account_key = $2",
    [userId, accountKey]);
  return (r.rowCount ?? 0) > 0;
}

/** Status for one user. Never includes the password. */
export async function credentialStatus(
  userId: string, accountKey: string = PRIMARY,
): Promise<CredentialStatus | null> {
  await ensure();
  const { rows } = await db().query(
    `SELECT user_email, login_email, updated_at, last_ok_at, last_error, needs_reentry,
            account_key, label
       FROM emburse_credentials WHERE user_id = $1 AND account_key = $2`,
    [userId, accountKey]);
  return rows[0] ? toStatus(rows[0]) : null;
}

/**
 * Every stored credential, for choosing which one the scheduler uses.
 *
 * Deliberately whose-and-whether, never what: an administrator needs to know a
 * credential exists and that it still works, and has no need of its contents.
 */
export async function listCredentials(): Promise<CredentialStatus[]> {
  await ensure();
  const { rows } = await db().query(
    `SELECT user_email, login_email, updated_at, last_ok_at, last_error, needs_reentry,
            account_key, label
       FROM emburse_credentials ORDER BY user_email, (account_key = 'primary') DESC, label`);
  return rows.map(toStatus);
}

function toStatus(r: Record<string, unknown>): CredentialStatus {
  return {
    userEmail: r.user_email as string,
    loginEmail: r.login_email as string,
    accountKey: (r.account_key as string) ?? PRIMARY,
    label: (r.label as string) ?? "",
    updatedAt: (r.updated_at as Date).toISOString(),
    lastOkAt: r.last_ok_at ? (r.last_ok_at as Date).toISOString() : null,
    lastError: (r.last_error as string | null) ?? null,
    needsReentry: Boolean(r.needs_reentry),
  };
}

/**
 * The credential the export should sign in with.
 *
 * The one most recently proven to work, falling back to the most recently
 * saved. With a handful of users that ordering needs no configuring: a login
 * that has actually signed in beats one that has only been typed. Only ever
 * called by the export runner, and the plaintext never leaves that call.
 */
export async function credentialForExport(): Promise<
  { userId: string; email: string; password: string; userEmail: string; chosen: string } | null
> {
  await ensure();

  /**
   * WHOSE Needs Review the import brings in.
   *
   * This matters more than it looks, and it was decided by accident. Emburse's
   * Needs Review is relative to whoever signed in, so the account the import
   * uses IS the queue this whole app shows. The rule was "the credential most
   * recently proven to work, else the most recently saved" — which, the moment
   * a second person stores a login and it succeeds once, silently moves the
   * entire queue to THEIR Needs Review. Nobody is told, nothing in the app
   * says whose list it is, and expenses appear or vanish for everyone.
   *
   * So it is a deliberate choice now, stored as the owner of the `importAs`
   * flag. The old rule remains only as the fallback for a deployment that has
   * never made the choice, and every run says which it used and why.
   */
  const preferred = await flagOwner("importAs").catch(() => null);
  if (preferred) {
    const { rows } = await db().query<{ user_id: string; login_email: string; secret: Buffer; user_email: string }>(
      /*
       * Their PRIMARY connection, never just "a connection of
       * theirs". Somebody's second Emburse account is a different
       * Needs Review, and letting the shared import drift onto one
       * because it happened to be newer is the same bug this
       * function was rewritten to stop.
       */
      `SELECT user_id, login_email, secret, user_email FROM emburse_credentials
        WHERE lower(btrim(user_email)) = lower(btrim($1)) AND account_key = $2`,
      [preferred, PRIMARY]);
    const chosen = rows[0];
    if (chosen) {
      try {
        return {
          userId: chosen.user_id, email: chosen.login_email, password: open(chosen.secret),
          userEmail: chosen.user_email, chosen: `chosen: the import is set to run as ${preferred}`,
        };
      } catch {
        throw new Error(
          `The stored Emburse password for ${preferred}, who the import is set to run as, could ` +
          "not be decrypted — SESSION_SECRET or EMBURSE_CREDENTIAL_KEY has changed since it was " +
          "saved. They need to enter it again.");
      }
    }
    // Named but not stored. Falling through silently is how the queue would
    // move without anybody noticing, which is the thing this exists to stop.
    throw new Error(
      `The import is set to run as ${preferred}, who has no Emburse login stored. Either they ` +
      "store one, or somebody else is chosen — until then the import must not quietly use " +
      "another account's Needs Review, because that is a different queue.");
  }

  const { rows } = await db().query<{ user_id: string; login_email: string; secret: Buffer; user_email: string }>(
    `SELECT user_id, login_email, secret, user_email FROM emburse_credentials
      WHERE account_key = $1
      ORDER BY (last_ok_at IS NOT NULL) DESC, last_ok_at DESC, updated_at DESC
      LIMIT 1`,
    [PRIMARY],
  );
  const row = rows[0];
  if (!row) return null;

  try {
    return {
      userId: row.user_id, email: row.login_email, password: open(row.secret),
      userEmail: row.user_email,
      chosen:
        `by default: nobody has chosen whose Needs Review the import reads, so it used ` +
        `${row.user_email} — the login most recently proven to work. Choose one deliberately ` +
        `before a second person stores a login, or the queue moves when theirs succeeds.`,
    };
  } catch {
    // A rotated key looks exactly like a corrupted row from here. Either way the
    // owner has to re-enter it, and saying so beats a bare decryption error.
    throw new Error(
      "The stored Emburse password could not be decrypted — SESSION_SECRET or EMBURSE_CREDENTIAL_KEY " +
        "has changed since it was saved. Its owner needs to enter it again.",
    );
  }
}

/**
 * One person's own Emburse credential.
 *
 * Used when applying their approvals and denials, and only then. An approval
 * is an audit-relevant act: Emburse records it against whichever account
 * signed in, so applying Brian's denial under Eric's login would put Eric's
 * name on a decision he did not make — in the finance system, permanently,
 * where nobody would think to doubt it.
 *
 * Returns null when that person has stored nothing. The caller must refuse
 * rather than fall back to somebody else's login, which is the whole reason
 * this is separate from `credentialForExport`.
 */
export async function credentialForUser(userEmail: string): Promise<
  { userId: string; email: string; password: string } | null
> {
  await ensure();
  /*
   * Their PRIMARY connection and no other.
   *
   * An approval is recorded in Emburse against whichever account
   * signed in. Now that one person can hold two, "a credential of
   * theirs" is not good enough: applying Eric's manager approval
   * under his personal Mammoth login would put the wrong account's
   * name on a decision, in the finance system, permanently.
   * Falling back to another of their own connections is as wrong
   * as falling back to somebody else's.
   */
  const { rows } = await db().query<{ user_id: string; login_email: string; secret: Buffer }>(
    `SELECT user_id, login_email, secret FROM emburse_credentials
      WHERE lower(user_email) = lower($1) AND account_key = $2`,
    [userEmail, PRIMARY],
  );
  const row = rows[0];
  if (!row) return null;

  try {
    return { userId: row.user_id, email: row.login_email, password: open(row.secret) };
  } catch {
    throw new Error(
      "The stored Emburse password could not be decrypted — SESSION_SECRET or EMBURSE_CREDENTIAL_KEY " +
        "has changed since it was saved. Its owner needs to enter it again.",
    );
  }
}

/** Whether this person could act in Emburse as themselves, without decrypting. */
export async function hasCredential(userEmail: string): Promise<boolean> {
  await ensure();
  // The primary one, because that is the one a decision would use.
  const { rows } = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM emburse_credentials
      WHERE lower(user_email) = lower($1) AND account_key = $2`,
    [userEmail, PRIMARY],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Record whether the login itself worked.
 *
 * Called only for the sign-in step, never for the run as a whole: a stored
 * password is not made wrong by Emburse moving a button, and prompting for it
 * every time a selector drifts would train its owner to dismiss the prompt.
 */
export async function noteResult(
  userId: string,
  ok: boolean,
  error: string | null,
  /**
   * Whether the password is the thing that needs changing.
   *
   * Separate from `error` on purpose. A device check, a moved button and a
   * wrong password are all failed sign-ins, but only one of them is answered
   * by typing the password again. Flagging all three for re-entry meant asking
   * somebody to re-type a working password, watching it fail identically, and
   * teaching them to ignore the warning by the time it is real.
   */
  credentialFault: boolean,
  /** Which of this person's accounts signed in, or tried to. */
  accountKey: string = PRIMARY,
): Promise<void> {
  await ensure();
  await db().query(
    `UPDATE emburse_credentials
        SET last_ok_at    = CASE WHEN $2 THEN now() ELSE last_ok_at END,
            last_error    = CASE WHEN $2 THEN NULL ELSE $3 END,
            needs_reentry = CASE WHEN $2 THEN false ELSE $4 END,
            awaiting_code = false,
            code_asked_at = NULL
      WHERE user_id = $1 AND account_key = $5`,
    [userId, ok, error?.slice(0, 500) ?? null, credentialFault, accountKey],
  );
}

/**
 * Who the shared import runs as, by app user — or nobody.
 *
 * Needed by the queue, not only by the export: rows that no import has
 * claimed belong to this person. Deliberately does NOT decrypt anything;
 * the question is whose name is on the shared import, and a password has
 * nothing to do with answering it.
 */
export async function sharedImporter(): Promise<string | null> {
  await ensure();
  const chosen = await flagOwner("importAs").catch(() => null);
  if (chosen) return chosen;

  // Nobody has been named. The old answer here was "the credential most
  // recently proven to work", and borrowing that rule for OWNERSHIP was a
  // bad mistake: it is a sensible way to pick a login and a disastrous way
  // to decide whose expenses are whose, because it MOVES.
  //
  // What that did, exactly. Brian's first export succeeded at 3:40pm. That
  // gave his credential the newest `last_ok_at`, which made him the shared
  // importer, which handed him ownership of every unclaimed row in the
  // table — all of Eric's. A successful import of his own queue took Eric's
  // expenses away from Eric and showed them to Brian, and nothing anywhere
  // said so.
  //
  // So it never drifts now. One credential is unambiguous: there is nobody
  // else those rows could belong to, and a single-login deployment behaves
  // exactly as it always has. More than one and nobody named is genuinely
  // ambiguous, and the app says so and offers to settle it (Import page →
  // claim) rather than guessing and being wrong in silence.
  const { rows } = await db().query<{ user_email: string }>(
    // DISTINCT, and primary only: one person with two Emburse
    // accounts is still one candidate, and counting their second
    // connection as a second person would make an unambiguous
    // deployment look ambiguous and stop naming an owner at all.
    `SELECT DISTINCT user_email FROM emburse_credentials
      WHERE account_key = $1 LIMIT 2`, [PRIMARY]);
  return rows.length === 1 ? rows[0]!.user_email : null;
}

/**
 * How many expenses nobody has claimed, and who could claim them.
 *
 * Only ever a transitional state: rows imported before the app tracked whose
 * queue they came from, and hand-uploaded files, which deliberately import
 * as nobody so a dragged-in PDF cannot purge a scheduled reviewer's work.
 * Shown rather than inferred, because the inferring is what went wrong.
 */
export async function unclaimedExpenses(): Promise<{
  count: number; owner: string | null; candidates: string[];
  /** Who holds the waiting expenses right now, and how many each. */
  held: { reviewer: string; count: number }[];
}> {
  await ensure();
  const { rows } = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM expenses WHERE reviewer = '' AND in_inbox");
  const { rows: people } = await db().query<{ user_email: string }>(
    `SELECT DISTINCT user_email FROM emburse_credentials
      WHERE account_key = $1 ORDER BY user_email`, [PRIMARY]);
  // Whose the queue actually is, counted from the rows themselves. The one
  // readout that would have answered "why is Brian seeing Eric's?" in a
  // glance, instead of three rounds of inference from screenshots.
  const { rows: held } = await db().query<{ reviewer: string; n: string }>(
    `SELECT reviewer, count(*)::text AS n FROM expenses
      WHERE in_inbox AND reviewer <> '' GROUP BY reviewer ORDER BY count(*) DESC`);
  return {
    count: Number(rows[0]?.n ?? 0),
    owner: await sharedImporter().catch(() => null),
    candidates: people.map((p) => p.user_email),
    held: held.map((h) => ({ reviewer: h.reviewer, count: Number(h.n) })),
  };
}

/**
 * Settle it: stamp every unclaimed expense with one reviewer, for good.
 *
 * The permanent end of the question, rather than another rule for answering
 * it. After this the rows ARE theirs — the queue, the purge, the automation
 * and the import guards all read the same column and agree, and nothing
 * depends any more on which credential most recently worked.
 *
 * Scoped to `reviewer = ''` so it can only ever claim rows nobody holds; it
 * cannot move an expense from one reviewer to another.
 */
export async function claimUnclaimed(
  userEmail: string,
  /**
   * "unclaimed" touches only rows nobody holds — the safe, ordinary case.
   *
   * "all" moves every waiting expense, including ones another reviewer
   * holds, and exists because the app got this wrong on live data: while
   * the import re-stamped every row with whoever had run most recently, one
   * reviewer's 3:40pm import took the other's entire queue. Keeping the
   * first owner stops that happening again and does nothing about the
   * queue already sitting with the wrong person. This is the way back.
   */
  scope: "unclaimed" | "all" | "reset" = "unclaimed",
): Promise<number> {
  await ensure();
  const who = userEmail.trim().toLowerCase();

  /*
   * "reset" names nobody, and is the way out of ownership the app got wrong.
   *
   * An expense belongs to the FIRST reviewer who imported it, which stops
   * the queue changing hands on a timer and has one consequence worth a
   * button: a reviewer whose import claimed rows that were never theirs
   * keeps them, and no later import can take them back — the other
   * person's import sees a row somebody already holds and leaves it alone.
   * That is exactly what happened here. One import, made while the export
   * was still reading the team-wide list, claimed all 340 and left the
   * other reviewer looking at an empty queue with no way to refill it.
   *
   * Unstamping is the honest repair. It takes the rows away from everybody
   * rather than handing them to somebody else on another guess, and then
   * each reviewer's next import claims what is genuinely in their own
   * Needs Review. Nothing is deleted: the expenses, their receipts, their
   * readings and their decisions all stay exactly where they are.
   */
  if (scope === "reset") {
    const { rowCount } = await db().query(
      "UPDATE expenses SET reviewer = '' WHERE in_inbox AND reviewer <> ''");
    return rowCount ?? 0;
  }

  if (!who) throw new Error("Name whose expenses these are.");
  const { rows } = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM emburse_credentials
      WHERE lower(user_email) = $1 AND account_key = $2`, [who, PRIMARY]);
  if (Number(rows[0]?.n ?? 0) === 0) {
    throw new Error(
      `${userEmail} has no Emburse login stored, so these expenses cannot be theirs — ` +
      "their queue has never been read.");
  }
  const { rowCount } = await db().query(
    scope === "all"
      ? "UPDATE expenses SET reviewer = $1 WHERE in_inbox AND reviewer <> $1"
      : "UPDATE expenses SET reviewer = $1 WHERE reviewer = ''",
    [who]);
  return rowCount ?? 0;
}

/**
 * Which expenses belong to one person: their own, and maybe the unclaimed.
 *
 * The one definition of "whose data is this", so every read that has to
 * answer it answers it the same way. There is exactly one scope rule in
 * this app and it is this: an expense belongs to the reviewer whose Needs
 * Review it was imported from, and a row no import claimed belongs to
 * whoever the shared import runs as.
 *
 * It exists because the rule was written out by hand in four places and had
 * drifted in three of them — which is the whole reason Brian could see
 * Eric's receipts. A caller that cannot reach the credentials table (tests,
 * a cold boot) gets the narrow answer: their own rows only. Failing closed
 * here shows somebody too little of their own data; failing open shows them
 * somebody else's.
 */
export async function scopeFor(
  userEmail: string,
): Promise<{ reviewer: string; ownsBlanks: boolean }> {
  const reviewer = (userEmail ?? "").trim().toLowerCase();
  const shared = (await sharedImporter().catch(() => null))?.trim().toLowerCase() ?? "";
  return { reviewer, ownsBlanks: reviewer !== "" && reviewer === shared };
}
