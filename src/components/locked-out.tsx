import { useState } from "react";
import { ChevronDown, ChevronRight, KeyRound, Loader2 } from "lucide-react";
import type { CodeAsked } from "@/lib/decisions";

/**
 * "Emburse is asking for a code and nobody answered."
 *
 * The case this exists for: a scheduled import runs at 5am, Emburse decides
 * it does not recognise the browser, mails a code to the reviewer, and the
 * run stops. Until now the app said nothing at all — the import just
 * appeared not to have happened, and the only sign was an Emburse email at
 * five in the morning that reads like spam.
 *
 * It does NOT ask for the code that was mailed. That code expired hours ago
 * and telling somebody to type it would waste their time and teach them the
 * banner lies. The only thing that works is a fresh sign-in, done now, with
 * somebody here to read the new code — so that is the button.
 *
 * Pressing it starts an attended sign-in. The live prompt that appears is
 * the Queue's existing CodePrompt, which is already mounted above this and
 * already polls for a parked challenge; this component deliberately does
 * not grow its own copy of that.
 */
/**
 * Whether the detail is showing, remembered per browser.
 *
 * This banner stays up until somebody is at a keyboard to answer a code,
 * which on a scheduled import has meant a fortnight — four lines of
 * explanation above every page, every day, saying the same thing. So it
 * folds, and it remembers being folded. Still never hidden outright: the
 * headline and the button that fixes it are always on screen, because a
 * dismissable warning about an import that is doing nothing is a warning
 * nobody sees.
 *
 * localStorage can throw in a private window and come back empty with
 * cleared site data, so every read and write is guarded and the default
 * is OPEN — a first sighting explains itself.
 */
const FOLD_KEY = "mojo.lockedOut.folded";
const readFolded = (): boolean => {
  try {
    return window.localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    return false;
  }
};

export function LockedOut({ rows }: { rows: CodeAsked[] }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [folded, setFolded] = useState(readFolded);

  if (rows.length === 0) return null;

  const fold = (next: boolean) => {
    setFolded(next);
    try {
      window.localStorage.setItem(FOLD_KEY, next ? "1" : "0");
    } catch { /* a browser that will not remember is not a reason to fail */ }
  };

  const signInNow = async () => {
    setBusy(true);
    setProblem("");
    try {
      const res = await fetch("/api/emburse-check", { method: "POST" });
      if (!res.ok) throw new Error((await res.text()) || "The sign-in could not be started.");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "The sign-in could not be started.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* The headline is the toggle. A separate chevron to one side is
              a smaller target for the same job, and this row is already
              the thing somebody reaches for. */}
          <button
            type="button"
            onClick={() => fold(!folded)}
            aria-expanded={!folded}
            className="flex w-full items-start gap-1.5 text-left text-sm font-semibold"
          >
            {folded
              ? <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              : <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
            <span>
              Emburse is asking for a verification code, and nothing can sign in until it gets one
              {folded && rows.length > 0 && (
                <span className="ml-1 font-normal text-muted-foreground">
                  — {rows.length === 1 ? rows[0]!.loginEmail : `${rows.length} accounts`}
                </span>
              )}
            </span>
          </button>
          {!folded && rows.map((r) => (
            <p key={r.id} className="text-xs text-muted-foreground">
              It asked during <strong className="text-foreground">{r.during}</strong> and there was
              nobody to answer, so that run stopped and did nothing.{" "}
              {r.times > 1
                ? `${r.times} runs have been turned away since ${when(r.firstAskedAt)}; the last was ${when(r.lastAskedAt)}.`
                : `That was ${when(r.lastAskedAt)}.`}{" "}
              The code was emailed to{" "}
              <strong className="text-foreground">{r.loginEmail}</strong> — but it has expired, so
              there is nothing to type from it.
            </p>
          ))}
          {!folded && (
            <p className="text-xs text-muted-foreground">
              Start a sign-in now and Emburse will send a fresh code. Answer it once and this
              device stays trusted, so the scheduled runs go through on their own again.
            </p>
          )}
          {problem && <p className="text-xs font-semibold text-red-600">{problem}</p>}
        </div>
        <button
          type="button"
          onClick={() => void signInNow()}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber-600/50 bg-background px-2.5 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-300"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? "Starting…" : "Sign in now"}
        </button>
      </div>
    </div>
  );
}

/** "at 5:06 AM" for today, the date as well once it is not. */
function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  return today ? `at ${time}` : `on ${d.toLocaleDateString()} at ${time}`;
}
