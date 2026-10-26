import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Info, Loader2, X } from "lucide-react";

/**
 * The manager queue, per reviewer, on or off.
 *
 * Approval here is a chain: one person approves and it goes to the
 * next, and the team-wide grid in Emburse is the queue they each
 * approve FROM. There are ordinary reasons to stop reading one
 * person's for a while — somebody away, or a stage being worked by
 * hand — and no good way to do it before this: switching their whole
 * import off took their schedule, their other lists and their
 * automatic approvals with it.
 *
 * So this switches ONE thing. What it does not touch is said on the
 * card, because a switch whose blast radius is unclear is a switch
 * nobody dares use.
 */

type Reviewer = {
  email: string;
  managerEnabled: boolean;
  /** False when their import is pointed somewhere else entirely. */
  readsManagerQueue: boolean;
  importEnabled: boolean;
  autoApprove: boolean;
  otherLists: string[];
};

export function ManagerQueueDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState("");

  const q = useQuery({
    queryKey: ["manager-queue"],
    queryFn: async () => {
      const res = await fetch("/api/manager-queue");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as { reviewers: Reviewer[]; managerGrid: string };
    },
  });

  const set = useMutation({
    mutationFn: async (v: { email: string; managerEnabled: boolean }) => {
      const res = await fetch("/api/manager-queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(v),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save it.");
      return body;
    },
    onSuccess: () => {
      setError("");
      void qc.invalidateQueries({ queryKey: ["manager-queue"] });
      void qc.invalidateQueries({ queryKey: ["reviewer-imports"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const rows = q.data?.reviewers ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Manager queue"
        className="w-full max-w-xl space-y-4 rounded-xl border border-border bg-background p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Manager queue</h2>
            <p className="text-sm text-muted-foreground">
              Whether each reviewer&rsquo;s scheduled import reads the team-wide
              approval queue.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* What it does NOT touch. A switch with an unclear blast radius
            is a switch nobody dares use, and the whole reason this is
            separate from the import switch is that it is narrower. */}
        <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Off skips only that grid on the <strong>scheduled</strong> import. Their
            schedule, their other lists and their automatic approvals carry on, and
            a run started by hand still works. Expenses already imported stay in the
            queue — switching this off stops new ones arriving, it does not clear
            what is there.
          </span>
        </p>

        {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.isError && (
          <p className="text-sm font-semibold text-red-600">{(q.error as Error).message}</p>
        )}
        {q.data && rows.length === 0 && (
          <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No reviewers have an Emburse login stored yet.
          </p>
        )}
        {error && <p className="text-sm font-semibold text-red-600">{error}</p>}

        <div className="space-y-2">
          {rows.map((r) => (
            <div
              key={r.email}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.email}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.managerEnabled
                    ? "Reading the manager queue on schedule."
                    : "Not reading the manager queue."}
                  {r.otherLists.length > 0
                    && ` Still reading ${r.otherLists.join(" and ")}.`}
                </p>
                {/* Two things that make the switch misleading if unsaid. */}
                {!r.importEnabled && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    Their whole import is switched off, so this changes nothing
                    until that is back on.
                  </p>
                )}
                {r.importEnabled && !r.readsManagerQueue && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    Their import is pointed at a different grid, so this switch
                    does nothing for them.
                  </p>
                )}
                {r.managerEnabled === false && r.autoApprove && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    Automatic approvals are still on for them, working from
                    expenses already imported.
                  </p>
                )}
              </div>
              <Switch
                on={r.managerEnabled}
                busy={set.isPending && set.variables?.email === r.email}
                label={`Manager queue for ${r.email}`}
                onChange={(on) => set.mutate({ email: r.email, managerEnabled: on })}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A real checkbox underneath, so it is reachable by keyboard and screen reader. */
function Switch({
  on, busy, label, onChange,
}: {
  on: boolean;
  busy: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={`relative h-5 w-9 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-foreground peer-focus-visible:ring-offset-2 ${
          on ? "bg-emerald-600" : "bg-muted-foreground/40"
        } ${busy ? "opacity-50" : ""}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            on ? "left-[1.125rem]" : "left-0.5"
          }`}
        />
      </span>
      <span className="w-8 text-xs font-semibold tabular-nums">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : on ? "On" : "Off"}
      </span>
    </label>
  );
}
