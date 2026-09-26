import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, ShieldAlert, Check, Clock, Info, AlertTriangle } from "lucide-react";
import { ExportRunner } from "@/components/export-runner";

type Schedule = {
  timezone: string;
  firstRun: string;
  retryHours: number;
  attemptsPerDay: number;
  graceMinutes: number;
};

type Settings = {
  sections: string[];
  selectors: Record<string, string>;
  selectorHelp: Record<string, string>;
  stepSelectors: Record<string, string[]>;
  defaultSelectors: Record<string, string>;
  receiptsOnly: boolean;
  schedule: Schedule;
  updatedAt: string | null;
  updatedBy: string | null;
  allSections: string[];
};

/** Zones the export schedule is plausibly set in. */
const ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC",
];

/** What the section means for the people whose expenses are in it. */
const WHY: Record<string, string> = {
  "Needs Review": "The reviewer's queue — the reason this app exists.",
  "Pending Other's Review": "With somebody else, still in flight. Not yours to decide.",
  "Pending Submission": "Not submitted yet. The employee's to finish, not yours.",
  Denied: "Sent back. These tend to return, so they are rarely finished.",
  Completed: "Done. Its absence from the export is how a row leaves the queue.",
};

/**
 * Declare what the daily export is supposed to contain.
 *
 * Read twice: once by the runner, which drives Emburse to produce exactly this,
 * and once by the importer, which checks what actually came back against it.
 * The second reading is the one that earns its keep — every export prints its
 * search on page 1, so a run that quietly produced something else says so.
 *
 * That matters because a section chip toggled the wrong way in Emburse produces
 * a valid PDF of the wrong rows, which parses cleanly and reconciles against its
 * own printed total. Every other check passes. Only the header disagrees.
 */
export function ExportSettingsPage({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [sections, setSections] = useState<string[] | null>(null);
  const [receiptsOnly, setReceiptsOnly] = useState(true);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const q = useQuery({
    queryKey: ["export-settings"],
    queryFn: async () => {
      const res = await fetch("/api/export-settings");
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      return (await res.json()) as Settings;
    },
  });

  // Seed the form once, then leave it alone so a background refetch cannot
  // discard what someone is in the middle of typing.
  useEffect(() => {
    if (q.data && sections === null) {
      setSections(q.data.sections);
      setReceiptsOnly(q.data.receiptsOnly);
      setSchedule(q.data.schedule);
    }
  }, [q.data, sections]);

  if (q.isLoading || sections === null || schedule === null) {
    return <Loader2 className="mx-auto mt-10 h-6 w-6 animate-spin text-muted-foreground" />;
  }
  if (q.error) {
    return <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm">{(q.error as Error).message}</p>;
  }

  const all = q.data?.allSections ?? [];
  const dirty =
    JSON.stringify(sections) !== JSON.stringify(q.data?.sections) ||
    receiptsOnly !== q.data?.receiptsOnly ||
    JSON.stringify(schedule) !== JSON.stringify(q.data?.schedule);

  const toggle = (name: string) =>
    setSections((prev) =>
      (prev ?? []).includes(name) ? (prev ?? []).filter((s) => s !== name) : [...(prev ?? []), name],
    );

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/export-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sections, receiptsOnly, schedule }),
      });
      const body = (await res.json()) as Settings & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
      qc.setQueryData(["export-settings"], body);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-base font-bold">Export scope</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Which Emburse sections the daily export covers. The app sets these in Emburse when it runs,
          then checks each import back against them — which is the only way to catch a section chip that
          ended up in the wrong state anyway.
        </p>
      </div>

      {!isAdmin && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          You can see this but not change it. Ask an administrator.
        </p>
      )}

      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {all.map((name) => {
          const on = sections.includes(name);
          return (
            <label
              key={name}
              className={`flex cursor-pointer items-start gap-3 p-3.5 transition-colors hover:bg-muted ${
                isAdmin ? "" : "cursor-not-allowed opacity-70"
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!isAdmin}
                onChange={() => toggle(name)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-sky-600"
              />
              <span className="min-w-0">
                <span className="text-sm font-semibold">{name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{WHY[name] ?? ""}</span>
              </span>
            </label>
          );
        })}
      </div>

      <label
        className={`flex items-start gap-3 rounded-xl border border-border p-3.5 ${
          isAdmin ? "cursor-pointer hover:bg-muted" : "cursor-not-allowed opacity-70"
        }`}
      >
        <input
          type="checkbox"
          checked={receiptsOnly}
          disabled={!isAdmin}
          onChange={(e) => setReceiptsOnly(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-sky-600"
        />
        <span>
          <span className="text-sm font-semibold">Receipts: true</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Only expenses that have a receipt attached. Switching this off means expenses with no
            receipt are expected too, and the receipt-vs-claim check has nothing to read for them.
          </span>
        </span>
      </label>

      <div>
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Clock className="h-4 w-4" />
          Export automation schedule
        </h2>
        <p className="mt-1 flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong className="text-foreground">This is what actually runs the export.</strong> The server
            signs into Emburse itself at the first time below, and retries on the gap you set if a run
            fails. Changes take effect on the next check — no restart. A run only asks for a verification
            code if Emburse stops trusting the browser, and only when somebody started it by hand; a
            scheduled run fails rather than waiting for an answer nobody is there to give.
          </span>
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Timezone" hint="All the times below are read in this zone.">
          <select
            value={schedule.timezone}
            disabled={!isAdmin}
            onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })}
            className="w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-sky-500 disabled:opacity-60"
          >
            {[...new Set([schedule.timezone, ...ZONES])].map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </Field>

        <Field label="First run" hint="When the server signs in and requests the export.">
          <input
            type="time"
            value={schedule.firstRun}
            disabled={!isAdmin}
            onChange={(e) => setSchedule({ ...schedule, firstRun: e.target.value })}
            className="w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-sky-500 disabled:opacity-60"
          />
        </Field>

        <Field label="Attempts per day" hint="After the last one fails, the day is left until tomorrow.">
          <input
            type="number" min={1} max={8}
            value={schedule.attemptsPerDay}
            disabled={!isAdmin}
            onChange={(e) => setSchedule({ ...schedule, attemptsPerDay: Number(e.target.value) })}
            className="w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-sky-500 disabled:opacity-60"
          />
        </Field>

        <Field label="Hours between attempts" hint="How long to wait before retrying a failed run.">
          <input
            type="number" min={1} max={12}
            value={schedule.retryHours}
            disabled={!isAdmin}
            onChange={(e) => setSchedule({ ...schedule, retryHours: Number(e.target.value) })}
            className="w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-sky-500 disabled:opacity-60"
          />
        </Field>

        <Field
          label="Grace, minutes"
          hint="Emburse queues the export and the folder poll then takes up to an hour, so an attempt that fired on time still lands late."
        >
          <input
            type="number" min={0} max={720} step={15}
            value={schedule.graceMinutes}
            disabled={!isAdmin}
            onChange={(e) => setSchedule({ ...schedule, graceMinutes: Number(e.target.value) })}
            className="w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-sky-500 disabled:opacity-60"
          />
        </Field>
      </div>

      <SchedulePreview schedule={schedule} />

      {/* Below the settings it exercises: the run is how you find out whether
          what is configured above actually works against the real Emburse. */}
      <div className="border-t border-border pt-5">
        <ExportRunner
          isAdmin={isAdmin}
          selectors={q.data?.selectors ?? {}}
          help={q.data?.selectorHelp ?? {}}
          stepSelectors={q.data?.stepSelectors ?? {}}
          defaults={q.data?.defaultSelectors ?? {}}
          onSaveSelectors={async (next) => {
            const res = await fetch("/api/export-settings", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sections, receiptsOnly, schedule, selectors: next }),
            });
            const body = (await res.json()) as Settings & { error?: string };
            if (!res.ok) throw new Error(body.error ?? "Could not save selectors");
            qc.setQueryData(["export-settings"], body);
          }}
        />
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">{error}</p>
      )}

      {/* A sticky bar, because this page is long and the Save button used to sit
          at the bottom of it. Unchecking a section looked like it had taken
          effect, and the change was silently lost on the next refresh — the
          setting was never written. Nothing on a settings page should be able
          to look saved when it is not. */}
      {dirty && (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-t-xl border border-b-0 border-amber-300 bg-amber-50 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
          <span className="text-sm font-semibold text-amber-900">
            Unsaved changes — nothing here takes effect until you save.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setSections(q.data?.sections ?? []);
                setReceiptsOnly(q.data?.receiptsOnly ?? true);
                setSchedule(q.data?.schedule ?? null);
              }}
              className="rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            >
              Discard
            </button>
            <button
              type="button"
              disabled={!isAdmin || saving || sections.length === 0}
              onClick={() => void save()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save changes
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!isAdmin || !dirty || saving || sections.length === 0}
          onClick={() => void save()}
          className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </button>

        {saved && (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-500">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
        {sections.length === 0 && (
          <span className="text-sm text-amber-500">
            Choose at least one section, or every import will be flagged.
          </span>
        )}
        {q.data?.updatedAt && !saved && (
          <span className="ml-auto text-xs text-muted-foreground">
            Last changed {new Date(q.data.updatedAt).toLocaleString()}
            {q.data.updatedBy ? ` by ${q.data.updatedBy}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}


function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-semibold">{label}</span>
      {children}
      <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
    </label>
  );
}

/**
 * The day the settings describe, before saving them.
 *
 * Deliberately computed in the browser from the values in the form rather than
 * fetched: the point is to see what a change does *before* committing it, which
 * a round trip to the saved schedule could not show.
 */
function SchedulePreview({ schedule }: { schedule: Schedule }) {
  const slots: { at: string; label: string }[] = [];
  const [h, m] = schedule.firstRun.split(":").map(Number);

  for (let i = 0; i < schedule.attemptsPerDay; i++) {
    const minutes = (h ?? 6) * 60 + (m ?? 0) + i * schedule.retryHours * 60;
    slots.push({
      at: clock(minutes),
      label: i === 0 ? "first attempt" : `retry ${i}`,
    });
  }

  const last = (h ?? 6) * 60 + (m ?? 0) + (schedule.attemptsPerDay - 1) * schedule.retryHours * 60;
  const givesUp = last + schedule.graceMinutes;
  const spillsOver = givesUp >= 24 * 60;

  return (
    <div className="rounded-xl border border-border p-3.5">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        A day on this schedule
      </p>
      <ol className="mt-2 space-y-1.5">
        {slots.map((s, i) => (
          <li key={i} className="flex items-center gap-2 text-sm">
            <span className="tnum w-20 shrink-0 whitespace-nowrap font-semibold">{s.at}</span>
            <span className="text-muted-foreground">{s.label}</span>
          </li>
        ))}
        <li className="flex items-center gap-2 text-sm">
          <span className="tnum w-20 shrink-0 whitespace-nowrap font-semibold text-amber-600">{clock(givesUp)}</span>
          <span className="text-muted-foreground">
            marked missed if nothing has arrived — next attempt tomorrow at {schedule.firstRun}
          </span>
        </li>
      </ol>
      {spillsOver && (
        <p className="mt-2 text-xs text-amber-600">
          The last attempt plus its grace runs past midnight, so a miss is only reported the next day.
          Move the first run earlier, or shorten the grace.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        All times {schedule.timezone}. The scheduler checks every few minutes, so an attempt can start a
        little after its slot — and a change here is picked up on the next check, without a restart.
      </p>
    </div>
  );
}

const clock = (minutes: number) => {
  const total = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const ampm = h < 12 ? "AM" : "PM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ampm}`;
};
