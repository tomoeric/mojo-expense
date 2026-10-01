import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, ShieldAlert, Check, Clock, Info, AlertTriangle } from "lucide-react";
import { ExportRunner } from "@/components/export-runner";
import { useAuth } from "@/lib/api";

type Schedule = {
  timezone: string;
  firstRun: string;
  retryHours: number;
  attemptsPerDay: number;
  graceMinutes: number;
  allDay: boolean;
};

type ImportSource = { key: string; label: string; path: string; enabled: boolean };

type Settings = {
  sections: string[];
  sources: ImportSource[];
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
  // Whose eyes this page is being read through. The settings above the
  // per-reviewer rows are shared, so saving them is refused inside a view —
  // and somebody trying to change one person's import time deserves to be
  // told which control does that rather than shown a flat refusal.
  const viewingAs = useAuth().data?.viewingAs?.viewed ?? null;
  const qc = useQueryClient();
  const [sections, setSections] = useState<string[] | null>(null);
  const [receiptsOnly, setReceiptsOnly] = useState(true);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [sources, setSources] = useState<ImportSource[] | null>(null);
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
      setSources(q.data.sources ?? []);
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
    JSON.stringify(schedule) !== JSON.stringify(q.data?.schedule) ||
    JSON.stringify(sources) !== JSON.stringify(q.data?.sources);

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
        body: JSON.stringify({ sections, receiptsOnly, schedule, sources }),
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
            <strong className="text-foreground">This is what actually runs the import.</strong> The server
            signs into Emburse itself at the first time below, then again on the gap you set.
            Changes take effect on the next check — no restart. A run only asks for a verification
            code if Emburse stops trusting the browser, and only when somebody started it by hand; a
            scheduled run fails rather than waiting for an answer nobody is there to give.
          </span>
        </p>
      </div>

      {/* WHICH Emburse lists to read, before when to read them.
          Transactions is the queue this app was built around;
          Reimbursements is a separate page with its own queue and the same
          export dialog, so the whole run works on it once pointed at the
          right path. Each list keeps its own rows and its own timeline —
          one can never purge the other. */}
      <div className="rounded-xl border border-border p-3.5">
        <p className="text-sm font-bold">Which lists to import</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Each one is read separately, on its own timeline, and keeps its own expenses — turning
          one on cannot disturb the other.
        </p>
        <ul className="mt-2 space-y-2">
          {(sources ?? []).map((src, i) => (
            <li key={src.key} className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={src.enabled}
                  disabled={!isAdmin}
                  onChange={(e) => setSources((prev) =>
                    (prev ?? []).map((x, k) => (k === i ? { ...x, enabled: e.target.checked } : x)))}
                  className="h-4 w-4 accent-emerald-600 disabled:opacity-60"
                />
                <span className="font-semibold">{src.label}</span>
              </label>
              <input
                value={src.path}
                disabled={!isAdmin}
                onChange={(e) => setSources((prev) =>
                  (prev ?? []).map((x, k) => (k === i ? { ...x, path: e.target.value } : x)))}
                spellCheck={false}
                className="ml-auto w-72 rounded-lg border border-border bg-transparent px-2 py-1 font-mono text-xs outline-none focus:border-sky-500 disabled:opacity-60"
              />
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          The path is where that list lives in Emburse — correct it here rather than in code if
          this tenant keeps it somewhere else.
        </p>
      </div>

      {/* The switch that decides what every other field below MEANS, so it
          sits above them rather than among them. */}
      <label className="flex items-start gap-3 rounded-xl border border-border p-3.5">
        <input
          type="checkbox"
          checked={schedule.allDay}
          disabled={!isAdmin}
          onChange={(e) => setSchedule({ ...schedule, allDay: e.target.checked })}
          className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600 disabled:opacity-60"
        />
        <span className="text-sm">
          <strong>Keep importing all day</strong>
          <span className="mt-1 block text-xs text-muted-foreground">
            On, the times below are simply when the import runs — every one of them, whether or not
            an earlier one worked. The queue then keeps up with Emburse through the day: an expense
            submitted at eleven is here by noon, and one somebody approved in Emburse by hand stops
            being offered for a decision. Off, they are retries: the first one that succeeds closes
            the day, and what you are looking at after that is whatever Emburse held at{" "}
            {schedule.firstRun}.
            <span className="mt-1 block">
              Receipt reading and queued approvals run continuously either way — this setting is
              only about the import that brings expenses in.
            </span>
          </span>
        </span>
      </label>

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

        <Field label="First run" hint="When the server first signs in and requests the export.">
          <input
            type="time"
            value={schedule.firstRun}
            disabled={!isAdmin}
            onChange={(e) => setSchedule({ ...schedule, firstRun: e.target.value })}
            className="w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-sky-500 disabled:opacity-60"
          />
        </Field>

        <Field
          label={schedule.allDay ? "Runs per day" : "Attempts per day"}
          hint={schedule.allDay
            ? "How many times the import runs, counting the first. 16 hourly from 6am reaches 9pm."
            : "After the last one fails, the day is left until tomorrow."}
        >
          <input
            type="number" min={1} max={24}
            value={schedule.attemptsPerDay}
            disabled={!isAdmin}
            onChange={(e) => setSchedule({ ...schedule, attemptsPerDay: Number(e.target.value) })}
            className="w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-sky-500 disabled:opacity-60"
          />
        </Field>

        <Field
          label={schedule.allDay ? "Hours between runs" : "Hours between attempts"}
          hint={schedule.allDay
            ? "How long the queue may be behind Emburse at worst."
            : "How long to wait before retrying a failed run."}
        >
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
          hint="Emburse queues the export and the folder poll then takes up to an hour, so a run that fired on time still lands late. Nothing arriving this long after a slot is what gets reported as a miss."
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

      {viewingAs && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          Everything above is the <strong>shared</strong> export setting, which is everybody&rsquo;s
          — so Save is refused while you are viewing as {viewingAs}. To change only{" "}
          <strong>{viewingAs}</strong>&rsquo;s import times, use <strong>Own times</strong> on their
          row below; that one does save from here.
        </p>
      )}

      {isAdmin && <ReviewerGrids />}

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
              body: JSON.stringify({ sections, receiptsOnly, schedule, sources, selectors: next }),
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
                setSources(q.data?.sources ?? null);
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
      label: schedule.allDay
        ? (i === 0 ? "first import" : "import")
        : (i === 0 ? "first attempt" : `retry ${i}`),
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
            {schedule.allDay
              ? <>marked behind if nothing has arrived since the last run — then quiet until {schedule.firstRun} tomorrow</>
              : <>marked missed if nothing has arrived — next attempt tomorrow at {schedule.firstRun}</>}
          </span>
        </li>
      </ol>
      {schedule.allDay && (
        <p className="mt-2 text-xs text-muted-foreground">
          Every one of these runs, whether or not an earlier one worked, so the queue is never more
          than {schedule.retryHours === 1 ? "an hour" : `${schedule.retryHours} hours`} behind
          Emburse while the window is open.
        </p>
      )}
      {spillsOver && !schedule.allDay && (
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

/**
 * Which Emburse list each reviewer's export reads.
 *
 * Approval here is a chain: one person approves and the expense goes to the
 * next. So at any moment the reviewers have DIFFERENT queues, and the one
 * URL the export used for everybody — the team-wide tab, every review stage
 * at once — described neither of them. Both accounts exported the same 320
 * expenses, the app stamped each import with whoever had just run, and the
 * queue changed hands on a timer.
 *
 * There is no guessing here about what Emburse calls the right list, because
 * nothing outside Emburse knows: the tenant's own URLs are the only answer.
 * Open the list in Emburse as that person, copy the path and the
 * `filters[section]` value out of the address bar, put them here, and press
 * Test run — the "read the item count" step prints what that URL returns, so
 * a wrong guess costs one minute and produces no file and no email.
 */
function ReviewerGrids() {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  // These ARE settable from inside a view — they are admin settings the
  // same admin could set for the same person without entering one, and the
  // change is recorded against whoever pressed it, not whose row it is.
  const auth = useAuth();
  const viewingAs = auth.data?.viewingAs?.viewed ?? null;
  const q = useQuery({
    queryKey: ["reviewer-imports"],
    queryFn: async () => {
      const res = await fetch("/api/reviewer-imports");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()) as {
        reviewers: { userEmail: string; enabled: boolean; gridPath: string | null;
                     gridSection: string | null; autoApprove: boolean;
                     autoApprovePerRun: number | null; shared: boolean;
                     schedule: Schedule }[];
      };
    },
  });

  const [draft, setDraft] = useState<Record<string, { path: string; section: string }>>({});
  const rows = q.data?.reviewers.filter((r) => r.userEmail) ?? [];
  if (rows.length < 1) return null;

  const valueFor = (e: string, r: { gridPath: string | null; gridSection: string | null }) =>
    draft[e] ?? { path: r.gridPath ?? "", section: r.gridSection ?? "" };

  async function save(
    email: string,
    v: { path: string; section: string },
    auto?: boolean,
  ) {
    setError("");
    const now = rows.find((r) => r.userEmail === email);
    try {
      const res = await fetch("/api/reviewer-imports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email, gridPath: v.path, gridSection: v.section,
          autoApprove: auto ?? now?.autoApprove ?? false,
        }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      await qc.invalidateQueries({ queryKey: ["reviewer-imports"] });
      setDraft((d) => { const n = { ...d }; delete n[email]; return n; });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="border-t border-border pt-5">
      <h2 className="text-base font-bold">Per-reviewer imports and approvals</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Approval is a chain — one person approves and it goes to the next — so each reviewer has
        their own queue in Emburse. Leave these blank and everybody reads the shared list above,
        which is the team-wide one: every stage at once, the same rows for everybody.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        To fill one in: sign into Emburse as that person, open the list that holds what is
        waiting on <em>them</em>, and copy the path (the part after the host, e.g.{" "}
        <code className="rounded bg-muted px-1">/transactions</code>) and the{" "}
        <code className="rounded bg-muted px-1">filters[section]</code> value out of the address
        bar. Then press <strong>Test run</strong> below — it stops before exporting anything and
        prints how many items that URL returns, so you can see at a glance whether it is their
        queue or everybody&rsquo;s.
      </p>

      {/* The whole setting, as one button, because under a two-stage chain
          there is only one sensible answer: each reviewer reads their own
          Needs Review. The per-row fields below stay for the case this
          tenant spells the path differently. */}
      {viewingAs && (
        <p className="mt-2 rounded-lg bg-sky-500/10 p-2 text-sm">
          Viewing as <strong>{viewingAs}</strong>. These are settable from here and the change
          is recorded against you — but it is still everybody&rsquo;s settings on this page, not
          only theirs.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void Promise.all(
            rows.map((r) => save(r.userEmail, { path: "/transactions", section: "inbox" })))}
          className="rounded-lg bg-foreground px-3 py-1 text-sm font-semibold text-background disabled:opacity-50"
        >
          Everyone reads their own Needs Review
        </button>
        <button
          type="button"
          onClick={() => void Promise.all(
            rows.map((r) => save(r.userEmail, { path: "", section: "" })))}
          className="rounded-lg border border-border px-3 py-1 text-sm font-semibold disabled:opacity-50"
        >
          Back to the shared team-wide list
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Try it, then press <strong>Test run</strong> below as each person. If the item count
        drops below the team-wide one and differs between them, that is their own queue. Nothing
        is exported and nobody is emailed by a test run, and an import that came back nearly
        empty would be refused by the truncation fence rather than wiping anything.
      </p>

      <div className="mt-3 space-y-2">
        {rows.map((r) => {
          const v = valueFor(r.userEmail, r);
          const dirty = Boolean(draft[r.userEmail]);
          return (
            <div key={r.userEmail} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-56 font-medium">{r.userEmail}</span>
              <input
                value={v.path}
                onChange={(e) => setDraft((d) => ({ ...d, [r.userEmail]: { ...v, path: e.target.value } }))}
                placeholder="shared (/transactions/team)"
                className="w-64 rounded-lg border border-border bg-background px-2 py-1 font-mono text-xs"
              />
              <input
                value={v.section}
                onChange={(e) => setDraft((d) => ({ ...d, [r.userEmail]: { ...v, section: e.target.value } }))}
                placeholder="shared (inbox)"
                className="w-36 rounded-lg border border-border bg-background px-2 py-1 font-mono text-xs"
              />
              <button
                type="button"
                disabled={!dirty}
                onClick={() => void save(r.userEmail, v)}
                className="rounded-lg bg-foreground px-3 py-1 text-xs font-semibold text-background disabled:opacity-40"
              >
                Save
              </button>
              {/* The one control that approves money without anybody
                  clicking, so it says whose login it would use and starts
                  off for everybody. */}
              <ReviewerSchedule
                row={r}
                onSaved={() => void qc.invalidateQueries({ queryKey: ["reviewer-imports"] })}
              />
              <button
                type="button"
                onClick={() => void save(r.userEmail, v, !r.autoApprove)}
                title={`Approve ${r.userEmail}'s unflagged expenses automatically, signed in as them.`}
                className={`rounded-lg border px-3 py-1 text-xs font-semibold disabled:opacity-50 ${
                  r.autoApprove
                    ? "border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-200"
                    : "border-border"
                }`}
              >
                Auto-approve {r.autoApprove ? "on" : "off"}
              </button>
            </div>
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

/**
 * One reviewer's own import times, or the shared ones.
 *
 * The scheduler has always been able to run two people on two timetables —
 * it asks "is an import due" once per person and counts their attempts
 * separately — and there was no way to say so from a screen, so both ran on
 * the shared schedule and the capability may as well not have existed.
 *
 * Blank is the shared schedule, which is what everybody has until somebody
 * wants otherwise: a reviewer whose expenses arrive in the afternoon has no
 * use for a 2am run, and a second stage of an approval chain is behind the
 * first by definition.
 */
function ReviewerSchedule({
  row, onSaved,
}: {
  row: { userEmail: string; shared: boolean; schedule: Schedule };
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sc, setSc] = useState<Schedule>(row.schedule);

  async function send(schedule: Schedule | null) {
    setBusy(true);
    try {
      // Only the schedule. The same row holds this person's grid path and
      // their approval switch, and the server writes only what it is sent.
      await fetch("/api/reviewer-imports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: row.userEmail, schedule }),
      });
      onSaved();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  const field = (
    label: string, value: string | number,
    onChange: (v: string) => void, width = "w-20",
  ) => (
    <label className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        className={`${width} rounded border border-border bg-background px-1.5 py-0.5`}
      />
    </label>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-border px-3 py-1 text-xs font-semibold"
      >
        {row.shared ? "Shared times" : "Own times"}
      </button>
      {open && (
        <div className="flex w-full flex-wrap items-center gap-3 rounded-lg bg-muted/50 p-2">
          {field("Timezone", sc.timezone, (v) => setSc({ ...sc, timezone: v }), "w-40")}
          {field("First run", sc.firstRun, (v) => setSc({ ...sc, firstRun: v }), "w-24")}
          {field("Runs/day", sc.attemptsPerDay,
            (v) => setSc({ ...sc, attemptsPerDay: Number(v) || 1 }))}
          {field("Hours between", sc.retryHours,
            (v) => setSc({ ...sc, retryHours: Number(v) || 1 }))}
          {field("Grace", sc.graceMinutes,
            (v) => setSc({ ...sc, graceMinutes: Number(v) || 0 }))}
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={sc.allDay}
              onChange={(e) => setSc({ ...sc, allDay: e.target.checked })}
            />
            <span className="text-muted-foreground">All day</span>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void send(sc)}
            className="rounded-lg bg-foreground px-3 py-1 text-xs font-semibold text-background disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save their times"}
          </button>
          <button
            type="button"
            disabled={busy || row.shared}
            onClick={() => void send(null)}
            className="rounded-lg border border-border px-3 py-1 text-xs font-semibold disabled:opacity-40"
          >
            Back to shared
          </button>
        </div>
      )}
    </>
  );
}
