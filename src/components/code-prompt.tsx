import { useEffect, useState } from "react";
import { KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
import type { Challenge } from "@/lib/decisions";

/**
 * Emburse wants a verification code before it will let a decision through.
 *
 * This lives on the queue, not on the admin Import page where the export's
 * copy lives, because the person who has the code on their phone is the one
 * who just clicked Approve — and until now they had no way to give it, so the
 * first decision made from any account the server's browser had not seen
 * simply failed.
 *
 * It is a one-time thing per account: the run ticks Emburse's "remember this
 * device" box before submitting the code, and the browser's cookies are then
 * written to the database — so the trust survives both the next run and the
 * next deploy, which rebuilds the browser profile directory.
 *
 * The wording has to carry three things or somebody is left guessing at a
 * screen with a timer running:
 *
 *   - the code comes by EMAIL, not by text, and often to a different address
 *     than the one they signed into this app with;
 *   - how long they have, because there IS a deadline and hiding it does not
 *     make it longer;
 *   - that this is the only time they will be asked, which is the difference
 *     between a small chore and a thing worth refusing to set up.
 */
export function CodePrompt({
  challenge,
  busy,
  error,
  onAnswer,
}: {
  challenge: Challenge;
  busy: boolean;
  error: string;
  onAnswer: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const remaining = useCountdown(challenge.expiresAt);

  if (!challenge.mine) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Emburse is waiting on a verification code for <strong>{challenge.owner}</strong>, so their
          decisions are paused until they enter it. Yours are unaffected.
          {challenge.loginEmail ? (
            <> It was emailed to <strong>{challenge.loginEmail}</strong>{remaining ? <>, and there is{" "}
            <strong>{remaining}</strong> left to use it</> : null}.</>
          ) : null}
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) onAnswer(code.trim());
      }}
      className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
    >
      <div className="flex items-start gap-2">
        <Mail className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Emburse has emailed you a verification code</p>
          <ol className="mt-1 ml-4 list-decimal space-y-0.5 text-xs">
            <li>
              <strong>Open your email</strong>
              {challenge.loginEmail ? <> — the one for <strong>{challenge.loginEmail}</strong></> : null}
              . Emburse sends the code by email, not by text, and it can take a minute to arrive.
              Check junk if it is not there.
            </li>
            <li>Type the 6-digit code below and press <strong>Send it</strong>.</li>
            <li>
              That is the last time you will be asked. This browser is marked as trusted and
              remembered, so every approval after this one goes straight through.
            </li>
          </ol>
          <p className="mt-1 text-xs opacity-80">
            Your decision is held until you do — nothing is lost, and nothing has reached Emburse yet.
            {remaining ? <> <strong>{remaining}</strong> left to enter it.</> : null}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              // A code is short, numeric and arrives on a phone: the keyboard
              // and the autofill hint both matter more than they look.
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="6-digit code"
              className="tnum w-36 rounded-lg border border-amber-400 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-amber-600"
            />
            <button
              type="submit"
              disabled={busy || !code.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Send it
            </button>
            {challenge.attempt > 1 && (
              <span className="text-xs opacity-80">
                Attempt {challenge.attempt} of {challenge.maxAttempts}
              </span>
            )}
          </div>

          {(error || challenge.lastError) && (
            <p className="mt-1.5 text-xs font-semibold">{error || challenge.lastError}</p>
          )}

          {/* Said once more, at the point of pressing. Somebody weighing up
              whether this is a chore they will face every morning decides
              it here, not three paragraphs up. */}
          <p className="mt-1.5 flex items-center gap-1 text-[11px] opacity-75">
            <ShieldCheck className="h-3 w-3 shrink-0" />
            Stored for good: this device stays trusted across restarts and new releases.
          </p>
        </div>
      </div>
    </form>
  );
}

/**
 * "4 min 12 s left", ticking.
 *
 * The wait is bounded — a parked sign-in holds a live browser and the
 * profile lock, so it cannot be unbounded — and a deadline nobody can see is
 * the worst of both: the pressure without the information. Finding an email
 * on a phone while an invisible timer runs down is how somebody gives up on
 * a thing that would have worked.
 */
function useCountdown(expiresAt: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min} min ${String(sec).padStart(2, "0")}s` : `${sec}s`;
}
