import { useState } from "react";
import { Loader2, UserPlus, ShieldAlert, Users } from "lucide-react";
import type { Editors } from "@/lib/rules";

/**
 * Who may write rules.
 *
 * A toggle per person rather than a text box, because the question being
 * answered is "is Brian ready yet" and that is a yes/no about somebody you
 * already know, not a string to type correctly. People appear here once the
 * app has seen them — a stored Emburse login, or a rule they wrote — so Brian
 * shows up on his own after the one step he has to do anyway.
 *
 * The panel is deliberately blunt about what it is not. While AUTH_ADMINS is
 * unset every signed-in person is an admin and could switch themselves back
 * on, so this reads as a guard rail and says how to make it a lock.
 */
export function RuleEditors({
  data,
  pending,
  onToggle,
}: {
  data: Editors | undefined;
  pending: boolean;
  onToggle: (email: string, allowed: boolean) => void;
}) {
  const [adding, setAdding] = useState("");

  if (!data) return null;
  if (!data.youAreAdmin) return null;

  const allowed = data.people.filter((p) => p.allowed);

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm font-semibold">Who can write rules</p>
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <p className="ml-auto text-xs text-muted-foreground">
          {data.restricted
            ? `${allowed.length} ${allowed.length === 1 ? "person" : "people"}`
            : "Anyone who can sign in"}
        </p>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        {data.restricted
          ? "Only these people can create, edit, enable or run rules. Everyone else can still see them."
          : "Nobody is named yet, so any admin can write rules. Switch someone on to restrict it to them."}
      </p>

      <ul className="mt-3 space-y-1">
        {data.people.map((p) => (
          <li key={p.email} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
            <span className={`text-sm ${p.allowed ? "font-medium" : "text-muted-foreground"}`}>
              {p.email}
              {p.email === data.you && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
            </span>
            {!p.hasEmburseLogin && (
              <span
                className="text-xs text-muted-foreground"
                title="Without a stored Emburse login, their rules can flag but cannot approve or deny."
              >
                · no Emburse login
              </span>
            )}
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={p.allowed}
                onChange={(e) => onToggle(p.email, e.target.checked)}
              />
              <span className={p.allowed ? "font-semibold text-emerald-700" : "text-muted-foreground"}>
                {p.allowed ? "Can write rules" : "Cannot"}
              </span>
            </label>
          </li>
        ))}
      </ul>

      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const email = adding.trim();
          if (!email) return;
          onToggle(email, true);
          setAdding("");
        }}
      >
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="Someone not listed yet — their email"
          className="min-w-56 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-muted-foreground/50"
        />
        <button
          type="submit"
          disabled={!adding.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs disabled:opacity-40"
        >
          <UserPlus className="h-3.5 w-3.5" /> Add
        </button>
      </form>

      {/* The honest caveat. This list is only as strong as the admin list
          behind it, and saying so is cheaper than the surprise. */}
      {!data.adminsRestricted && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-800">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <strong>This is a guard rail, not a lock.</strong> <code>AUTH_ADMINS</code> is not set, so everyone
            who can sign in is an administrator and could switch themselves back on here. Set{" "}
            <code>AUTH_ADMINS</code> to the people who should administer the app, and this list becomes real.
          </span>
        </p>
      )}
    </div>
  );
}
