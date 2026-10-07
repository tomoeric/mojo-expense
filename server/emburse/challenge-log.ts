/**
 * A verification code Emburse asked for that NOBODY WAS THERE TO ANSWER.
 *
 * `challenge.ts` parks a live browser while a person types six digits. It is
 * the right mechanism and it works — but it only exists while somebody is
 * watching, because a scheduled run is deliberately given no prompt hook: a
 * browser parked five minutes for a prompt nobody will see just delays the
 * same failure while holding the profile lock.
 *
 * The consequence was that the unattended case left NO TRACE IN THE APP. A
 * 5am import hit the verification screen, Emburse mailed a code to the
 * reviewer's inbox, the run stopped, and the only signal anybody got was an
 * email from Emburse at five in the morning. Nothing on any page said the
 * app was locked out, and the import simply appeared not to have happened.
 *
 * So this is the durable half: a row saying Emburse asked, whose login it
 * asked about, and during what. It outlives the browser, the run and a
 * restart, which the in-memory one cannot. The app shows it until a sign-in
 * for that login succeeds, at which point it clears itself.
 *
 * One open row per login, counted rather than repeated. A scheduled run that
 * is locked out asks again every morning, and a page listing fourteen
 * identical rows says no more than one row saying "asked 14 times, last at
 * 5:06am" and buries the second login if there ever is one.
 *
 * The code itself is NOT recorded, and could not usefully be: by the time
 * anybody reads this it has expired. The row's job is to say "a sign-in is
 * needed and here is who can do it", not to carry a secret.
 */
import { db, ensureSchema } from "../db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS emburse_code_requests (
  id             bigserial PRIMARY KEY,
  login_email    text        NOT NULL,
  first_asked_at timestamptz NOT NULL DEFAULT now(),
  last_asked_at  timestamptz NOT NULL DEFAULT now(),
  times          integer     NOT NULL DEFAULT 1,
  -- What was running: "the scheduled import", "automatic approvals". The
  -- first question on seeing this is which job is stuck.
  during         text        NOT NULL,
  -- What Emburse's own screen said, so the row can be believed.
  prompt         text,
  cleared_at     timestamptz,
  cleared_how    text
);
CREATE UNIQUE INDEX IF NOT EXISTS emburse_code_requests_one_open
  ON emburse_code_requests (lower(login_email)) WHERE cleared_at IS NULL;
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

export type CodeRequest = {
  id: number;
  loginEmail: string;
  firstAskedAt: string;
  lastAskedAt: string;
  times: number;
  during: string;
  prompt: string | null;
};

/**
 * Emburse asked for a code and the run had nobody to ask.
 *
 * Never throws: this runs inside a failing sign-in, and a logging table that
 * can turn one failure into two is worse than no logging table.
 */
export async function noteCodeAsked(input: {
  loginEmail: string;
  during: string;
  prompt?: string | null;
}): Promise<void> {
  try {
    await ensure();
    await db().query(
      `INSERT INTO emburse_code_requests (login_email, during, prompt)
            VALUES ($1, $2, $3)
       ON CONFLICT (lower(login_email)) WHERE cleared_at IS NULL
       DO UPDATE SET last_asked_at = now(),
                     times         = emburse_code_requests.times + 1,
                     during        = excluded.during,
                     prompt        = coalesce(excluded.prompt, emburse_code_requests.prompt)`,
      [input.loginEmail, input.during, input.prompt?.slice(0, 2000) ?? null],
    );
  } catch (err) {
    console.error("emburse: could not record the verification-code request —", err);
  }
}

/**
 * A sign-in for this login worked, so whatever was asked for is answered.
 *
 * Called on EVERY successful sign-in, including "already signed in": the
 * question the row stands for is "can this app get in", and a run that got
 * in has answered it. Silent when there was nothing open, which is the
 * normal case and must stay cheap.
 */
export async function clearCodeAsked(loginEmail: string, how: string): Promise<void> {
  try {
    await ensure();
    await db().query(
      `UPDATE emburse_code_requests
          SET cleared_at = now(), cleared_how = $2
        WHERE cleared_at IS NULL AND lower(login_email) = lower($1)`,
      [loginEmail, how.slice(0, 500)],
    );
  } catch (err) {
    console.error("emburse: could not clear the verification-code request —", err);
  }
}

/** Every login currently locked out, newest first. Usually none. */
export async function openCodeRequests(): Promise<CodeRequest[]> {
  try {
    await ensure();
    const { rows } = await db().query<{
      id: string; login_email: string; first_asked_at: Date; last_asked_at: Date;
      times: number; during: string; prompt: string | null;
    }>(
      `SELECT id, login_email, first_asked_at, last_asked_at, times, during, prompt
         FROM emburse_code_requests
        WHERE cleared_at IS NULL
        ORDER BY last_asked_at DESC`);
    return rows.map((r) => ({
      id: Number(r.id),
      loginEmail: r.login_email,
      firstAskedAt: r.first_asked_at.toISOString(),
      lastAskedAt: r.last_asked_at.toISOString(),
      times: r.times,
      during: r.during,
      prompt: r.prompt,
    }));
  } catch (err) {
    console.error("emburse: could not read the verification-code requests —", err);
    return [];
  }
}
