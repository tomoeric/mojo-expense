import { env } from "../env.js";

/**
 * A sign-in parked halfway, waiting for a person to read a code off their phone.
 *
 * Emburse asks an unrecognised browser to prove itself. No automation can
 * answer that, and until now it was simply where the export stopped. But the
 * same screen offers to remember the device, so the wall is one-time rather
 * than permanent — if somebody can be let through it once.
 *
 * That is the whole job here: hold a live browser open across several HTTP
 * requests while a person types six digits, then hand them to the page that is
 * waiting. The browser cannot be serialised and picked up by another process,
 * so this is deliberately in-memory and deliberately singular.
 *
 * Only one at a time, and that is not an arbitrary cap: the runs share one
 * persistent profile directory, and Chromium takes an exclusive lock on it. Two
 * concurrent sign-ins are already impossible. Saying so here means the second
 * one fails with a sentence instead of a lock error.
 *
 * Three things this must not become:
 *
 *   - **A way in for somebody else.** A parked challenge is a half-open session
 *     to a real finance system. Only the person who started the run can answer
 *     it, checked by identity rather than by whoever happens to ask.
 *   - **A brute-force oracle.** A six-digit code with unlimited guesses is a
 *     six-digit code with no security. Attempts are capped and the challenge is
 *     torn down when they run out.
 *   - **A browser nobody closes.** Every path out of here — answered, refused,
 *     abandoned, timed out — settles the waiting promise, so the run always
 *     reaches its `finally` and the browser always dies.
 */

export type ChallengeView = {
  id: string;
  /** What Emburse's own page says, so the person knows which code it wants. */
  prompt: string;
  /** PNG of that page, base64. Wording alone is often not enough to be sure. */
  screenshot: string | null;
  /** Who is allowed to answer, for showing "waiting on you" vs "waiting on X". */
  owner: string;
  startedAt: string;
  expiresAt: string;
  /** Codes tried so far, and how many are left before this is torn down. */
  attempts: number;
  attemptsLeft: number;
  /** Why the last code was refused, when one was. */
  lastError: string | null;
};

type Pending = ChallengeView & {
  settle: (outcome: { code: string } | { cancelled: string }) => void;
  timer: NodeJS.Timeout;
};

let pending: Pending | null = null;

/** Attempts before the challenge is abandoned. Emburse's own limit is lower. */
const MAX_ATTEMPTS = 3;

/** Raised when nobody answers in time — the run then fails as it used to. */
export class ChallengeAbandoned extends Error {}

/**
 * Park the browser and wait for a code.
 *
 * Returns the code somebody typed, or throws `ChallengeAbandoned` when the
 * wait ends any other way. The caller is inside sign-in with a live page, so
 * this is the one place in the app that blocks on a human.
 */
export function waitForCode(input: {
  prompt: string;
  screenshot: string | null;
  owner: string;
  /** Set when a previous code was refused, so the page can say so. */
  lastError?: string | null;
  /** 1 for the first code asked of this sign-in, 2 for the retry after a bad one. */
  attempt: number;
}): Promise<string> {
  // Only a first attempt can collide with another sign-in; a retry is the same
  // sign-in coming back for another code and is expected to find itself here.
  if (pending && input.attempt <= 1) {
    throw new Error(
      `A sign-in started by ${pending.owner} is already waiting for a verification code. ` +
        "Finish or cancel that one first — they share the same browser.",
    );
  }

  const attempts = Math.max(0, input.attempt - 1);
  const id = pending?.id ?? `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = pending?.startedAt ?? new Date().toISOString();
  clearTimeout(pending?.timer);

  return new Promise<string>((resolve, reject) => {
    const settle = (outcome: { code: string } | { cancelled: string }) => {
      clearTimeout(entry.timer);
      pending = null;
      if ("code" in outcome) resolve(outcome.code);
      else reject(new ChallengeAbandoned(outcome.cancelled));
    };

    const ms = env.emburseLogin.challengeTimeoutMs;
    const entry: Pending = {
      id,
      prompt: input.prompt,
      screenshot: input.screenshot,
      owner: input.owner,
      startedAt,
      expiresAt: new Date(Date.now() + ms).toISOString(),
      attempts,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts),
      lastError: input.lastError ?? null,
      settle,
      timer: setTimeout(
        () =>
          settle({
            cancelled:
              `Nobody entered the verification code within ${humanWait(ms)}, so the sign-in was ` +
              "abandoned. Start another test run when you have the code to hand.",
          }),
        ms,
      ),
    };
    pending = entry;
  });
}

/** The challenge waiting right now, if any. Safe to show to any signed-in user. */
export function currentChallenge(): ChallengeView | null {
  if (!pending) return null;
  const { settle: _s, timer: _t, ...view } = pending;
  return view;
}

/**
 * Hand a code to the waiting browser.
 *
 * `by` is the caller's own identity, taken from their session rather than from
 * anything they sent. A challenge is a half-open sign-in to somebody else's
 * finance account; being an administrator is not the same as being the person
 * who started it.
 */
export function answerChallenge(rawCode: unknown, by: string): { ok: true } | { ok: false; error: string } {
  if (!pending) return { ok: false, error: "Nothing is waiting for a code right now." };
  if (pending.owner !== by) {
    return {
      ok: false,
      error: `This sign-in was started by ${pending.owner}, so only they can complete it.`,
    };
  }

  const code = typeof rawCode === "string" ? rawCode.replace(/[\s-]/g, "") : "";
  if (!/^[A-Za-z0-9]{4,10}$/.test(code)) {
    // Refused without spending an attempt: a typo is not a guess, and burning
    // one of three tries on a stray space would be its own small cruelty.
    return { ok: false, error: "That does not look like a verification code. Enter the 6 digits Emburse sent." };
  }

  pending.settle({ code });
  return { ok: true };
}

/** Give up, from the UI or because the run is being torn down. */
export function cancelChallenge(why: string, by?: string): { ok: true } | { ok: false; error: string } {
  if (!pending) return { ok: false, error: "Nothing is waiting for a code right now." };
  if (by && pending.owner !== by) {
    return { ok: false, error: `This sign-in was started by ${pending.owner}, so only they can cancel it.` };
  }
  pending.settle({ cancelled: why });
  return { ok: true };
}

/** "5 minutes", "90 seconds" — never "0 minutes", which a bare round gives. */
function humanWait(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  return `${Math.round(ms / 60_000)} minutes`;
}

export const maxAttempts = MAX_ATTEMPTS;
