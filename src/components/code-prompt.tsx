import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
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
 * It is a one-time thing per account: answering it once leaves the device
 * remembered, and the next decision goes straight through.
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

  if (!challenge.mine) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Emburse is waiting on a verification code for <strong>{challenge.owner}</strong>, so their
          decisions are paused until they enter it. Yours are unaffected.
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
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Emburse wants to verify it is you</p>
          <p className="mt-0.5 text-xs">
            {challenge.prompt || "Enter the code Emburse just sent you."} Your decision is held until
            you do. You should only have to do this once — after that this device stays trusted.
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
        </div>
      </div>
    </form>
  );
}
