import crypto from "node:crypto";
import { db, ensureSchema } from "../db.js";
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

function seal(plain: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  // iv | tag | ciphertext, so one column holds everything needed to open it.
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function open(sealed: Buffer): string {
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
): Promise<void> {
  await ensure();
  await db().query(
    `INSERT INTO emburse_credentials (user_id, user_email, login_email, secret, updated_at, last_ok_at, last_error)
     VALUES ($1,$2,$3,$4, now(), NULL, NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       user_email = EXCLUDED.user_email, login_email = EXCLUDED.login_email,
       secret = EXCLUDED.secret, updated_at = now(),
       -- A new password invalidates what the old one proved.
       last_ok_at = NULL, last_error = NULL, needs_reentry = false`,
    [userId, userEmail, loginEmail, seal(password)],
  );
}

export async function deleteCredential(userId: string): Promise<boolean> {
  await ensure();
  const r = await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [userId]);
  return (r.rowCount ?? 0) > 0;
}

/** Status for one user. Never includes the password. */
export async function credentialStatus(userId: string): Promise<CredentialStatus | null> {
  await ensure();
  const { rows } = await db().query(
    `SELECT user_email, login_email, updated_at, last_ok_at, last_error, needs_reentry
       FROM emburse_credentials WHERE user_id = $1`, [userId]);
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
    `SELECT user_email, login_email, updated_at, last_ok_at, last_error, needs_reentry
       FROM emburse_credentials ORDER BY user_email`);
  return rows.map(toStatus);
}

function toStatus(r: Record<string, unknown>): CredentialStatus {
  return {
    userEmail: r.user_email as string,
    loginEmail: r.login_email as string,
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
  { userId: string; email: string; password: string } | null
> {
  await ensure();
  const { rows } = await db().query<{ user_id: string; login_email: string; secret: Buffer }>(
    `SELECT user_id, login_email, secret FROM emburse_credentials
      ORDER BY (last_ok_at IS NOT NULL) DESC, last_ok_at DESC, updated_at DESC
      LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;

  try {
    return { userId: row.user_id, email: row.login_email, password: open(row.secret) };
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
): Promise<void> {
  await ensure();
  await db().query(
    `UPDATE emburse_credentials
        SET last_ok_at    = CASE WHEN $2 THEN now() ELSE last_ok_at END,
            last_error    = CASE WHEN $2 THEN NULL ELSE $3 END,
            needs_reentry = CASE WHEN $2 THEN false ELSE $4 END
      WHERE user_id = $1`,
    [userId, ok, error?.slice(0, 500) ?? null, credentialFault],
  );
}
