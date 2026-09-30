import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, X } from "lucide-react";

type WhileAway = {
  from: string | null;
  to: string | null;
  approved: number;
  mine: number;
};

/**
 * What the automation did between the last visit and this one.
 *
 * The automation approves with nobody watching, which is the point of it and
 * also the problem with it: a reviewer comes back to a queue forty rows
 * shorter than they left it and nothing says why. This is the line that says
 * why, and it is the only place in the app where an automatic approval is
 * reported as an event rather than sitting silently in a row's history.
 *
 * Deliberately not a warning. Nothing here needs doing — it is a report on
 * work already finished, and it dismisses to nothing.
 */
export function WhileAway() {
  const [gone, setGone] = useState(false);
  const q = useQuery<WhileAway>({
    queryKey: ["while-away"],
    queryFn: async () => {
      const res = await fetch("/api/auth/while-away");
      if (!res.ok) return { from: null, to: null, approved: 0, mine: 0 };
      return (await res.json()) as WhileAway;
    },
    // Once per page load. The window it reports is frozen when the visit
    // starts, so re-asking cannot change the answer, and a count that ticked
    // upwards while somebody read it would not be "while you were away".
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const d = q.data;
  if (gone || !d || d.approved === 0 || !d.from) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-xs">
      <Bot className="h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
      <span className="text-emerald-800 dark:text-emerald-300">
        <strong className="font-semibold tabular-nums">{d.approved.toLocaleString()}</strong>{" "}
        {d.approved === 1 ? "expense was" : "expenses were"} approved automatically while you were
        away{when(d.from)}.
        {/* Whose name is on them in Emburse. An automatic approval is made
            under a real person's login, and for that person this is a
            statement about their own account, not about the app's. */}
        {d.mine > 0 && (
          <span className="text-muted-foreground">
            {" "}
            {d.mine === d.approved
              ? d.approved === 1 ? "It carries your Emburse login." : "They carry your Emburse login."
              : `${d.mine.toLocaleString()} of them carry your Emburse login.`}
          </span>
        )}
        <span className="text-muted-foreground"> Nothing here needs doing.</span>
      </span>
      <button
        type="button"
        onClick={() => setGone(true)}
        title="Dismiss"
        aria-label="Dismiss"
        className="ml-auto rounded-lg border border-border px-1.5 py-1 hover:bg-muted"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * " since 4:15 PM yesterday", or nothing when the gap is too short to name
 * usefully. A time on its own is ambiguous the moment it is more than a day
 * old, and "since 4:15 PM" about last Thursday is worse than saying nothing.
 */
function when(from: string): string {
  const then = new Date(from);
  if (Number.isNaN(then.getTime())) return "";

  const time = then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.round((midnight.getTime() - startOfDay(then).getTime()) / 86_400_000);

  if (days === 0) return ` since ${time}`;
  if (days === 1) return ` since ${time} yesterday`;
  if (days < 7) {
    return ` since ${time} on ${then.toLocaleDateString(undefined, { weekday: "long" })}`;
  }
  return ` since ${then.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}
