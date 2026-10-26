import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, CheckCircle2, Clock, Loader2, Send } from "lucide-react";

type ReviewerCheck = {
  email: string; ok: boolean; problems: string[]; because: string;
};
type Notify = {
  reviewers: string[];
  notifiers: string[];
  enabled: boolean;
  copySubmitter: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

/**
 * Email and notification settings — SHARED across every partner.
 *
 * One schedule, one set of reviewers, one set of notifiers, for the
 * whole platform. That is the brief's: a reviewer is a job somebody
 * does across partners, and a per-partner copy of this page would
 * mean seven lists where six are quietly out of date.
 *
 * The page says so rather than leaving it inferable, because the
 * reverse — a setting that looks like this account's and is not — is
 * how somebody switches off a partner's reminders and stops
 * everybody's.
 *
 * One section for now. It is its own page rather than a panel on Users
 * because the next setting will not be about people, and a settings page
 * that starts as a tenant of another page never moves out.
 */
export function DmSettingsPage() {
  const qc = useQueryClient();
  const [reviewer, setReviewer] = useState("");
  const [text, setText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [copySubmitter, setCopySubmitter] = useState(false);
  const [dirty, setDirty] = useState(false);
  // The last answer the server gave about the reviewer, from the load
  // or the save — whichever came later.
  const [saved, setSaved] = useState<{ reviewerChecks?: ReviewerCheck[] }>({});
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const data = useQuery({
    queryKey: ["dm-notify"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/settings/notifications");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        notify: Notify; mailConfigured: boolean; reviewerChecks: ReviewerCheck[];
      };
    },
  });

  // Seed the editor once, and never again: refetching while somebody is
  // halfway through typing a list of addresses would wipe it.
  useEffect(() => {
    if (!data.data || dirty) return;
    setReviewer(data.data.notify.reviewers.join("\n"));
    setText(data.data.notify.notifiers.join("\n"));
    setEnabled(data.data.notify.enabled);
    setCopySubmitter(data.data.notify.copySubmitter);
    setSaved({ reviewerChecks: data.data.reviewerChecks });
  }, [data.data, dirty]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/settings/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewers: reviewer, notifiers: text, enabled, copySubmitter }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save.");
      return body as { notify: Notify; reviewerChecks: ReviewerCheck[] };
    },
    onSuccess: (b) => {
      setError("");
      setDirty(false);
      setReviewer(b.notify.reviewers.join("\n"));
      setText(b.notify.notifiers.join("\n"));
      setSaved({ reviewerChecks: b.reviewerChecks });
      setNote(`Saved. ${b.notify.reviewers.join(", ") || "no reviewer"}`
        + `${b.notify.notifiers.length > 0
          ? `, plus ${b.notify.notifiers.length} notified`
          : ""}.`);
      void qc.invalidateQueries({ queryKey: ["dm-notify"] });
    },
    onError: (e) => { setError((e as Error).message); setNote(""); },
  });

  const sample = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/settings/notifications/sample", {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not send.");
      return body as { to: string; usedRealSignup: boolean };
    },
    onSuccess: (b) => {
      setError("");
      setNote(`Sample sent to ${b.to}${b.usedRealSignup
        ? ", built from the most recent signup."
        : " — no signups yet, so it uses made-up details."}`);
    },
    onError: (e) => { setError((e as Error).message); setNote(""); },
  });

  const mailOff = data.data && !data.data.mailConfigured;
  const count = text.split(/[,;\n\r]+/).map((s) => s.trim()).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Email &amp; Notifications</h1>
        <p className="text-sm text-muted-foreground">
          What the platform sends, and when. SHARED — these recipients, this
          schedule and this wording apply to every partner account, and a change
          here changes them all. Administrators only.
        </p>
      </div>

      {mailOff && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200">
          Email is not configured, so nothing will be sent whatever is set here.
        </p>
      )}
      {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
      {note && <p className="text-sm text-emerald-700 dark:text-emerald-400">{note}</p>}

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Bell className="h-4 w-4" />
              New member notifications
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              When a dealer submits a member signup, email the details to these addresses.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => { setEnabled(e.target.checked); setDirty(true); }}
            />
            On
          </label>
        </div>

        <div className="space-y-4">
          {/* One person, deliberately. "Who is reviewing this?" has to
              have a single answer — a shared list of reviewers is a
              list where everybody assumes somebody else has it. */}
          <div>
            <label htmlFor="reviewer" className="mb-1 block text-xs font-semibold">
              CSC Reviewers
            </label>
            <p className="mb-1 text-xs text-muted-foreground">
              One per line. Each gets the email with a button straight to the record,
              and the review is theirs to do. Approving is one-way and first-come, so
              a second reviewer opening a record that is already done is told so
              rather than doing it twice.
            </p>
            <textarea
              id="reviewer"
              rows={2}
              value={reviewer}
              onChange={(e) => { setReviewer(e.target.value); setDirty(true); setNote(""); }}
              placeholder={"csc@mojocarwash.com\nsecond.csc@mojocarwash.com"}
              className="w-full max-w-md rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            />
            {/* Checked against what they can actually DO, every time the
                page opens — not only when it is saved. The reviewer can
                stop being able to approve long afterwards, because
                somebody else changed their role, and the failure is
                silent: the email goes out with a link to a record they
                will be refused. */}
            {!dirty && <ReviewerStatus checks={saved.reviewerChecks} />}
          </div>

          <div>
            <label htmlFor="recipients" className="mb-1 block text-xs font-semibold">
              Optional notifiers
            </label>
            <p className="mb-1 text-xs text-muted-foreground">
              One per line. They get the same details, with the button greyed out and a
              line saying the review is not theirs.
            </p>
            <textarea
              id="recipients"
              rows={3}
              value={text}
              onChange={(e) => { setText(e.target.value); setDirty(true); setNote(""); }}
              placeholder={"operations@mojocarwash.com\nmemberships@mojocarwash.com"}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {count === 0
                ? "Nobody else is notified."
                : `${count} address${count === 1 ? "" : "es"}.`}
              {" "}Each one gets its own message, so a bad address cannot stop the others.
            </p>
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={copySubmitter}
            onChange={(e) => { setCopySubmitter(e.target.checked); setDirty(true); }}
          />
          Also send a copy to whoever submitted it
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <button
            type="button"
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate()}
            className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {dirty ? "Save" : "Saved"}
          </button>
          {/* To the administrator asking, never to the list: checking the
              wording should not mail the finance team. */}
          <button
            type="button"
            disabled={sample.isPending || mailOff}
            onClick={() => sample.mutate()}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            {sample.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send me a sample
          </button>
          {data.data?.notify.updatedAt && !dirty && (
            <span className="text-xs text-muted-foreground">
              Last changed {new Date(data.data.notify.updatedAt).toLocaleString()}
              {data.data.notify.updatedBy ? ` by ${data.data.notify.updatedBy}` : ""}
            </span>
          )}
        </div>
      </section>

      <RemindersSection />

      {/* Worth saying where it does NOT reach: somebody expecting a
          notification for a tag going out, or for the Mark complete, will
          otherwise assume it is broken. */}
      <p className="text-xs text-muted-foreground">
        Notifications are sent for member signups only, at the moment one is submitted.
        A failed send never fails the signup — the member is saved and the RFID claimed
        first — and every attempt is recorded in{" "}
        <a href="#/admin/audit" className="font-medium text-sky-600 hover:underline">
          Audit History
        </a>.
      </p>
    </div>
  );
}


/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

type Reminders = {
  enabled: boolean;
  frequency: "day" | "week";
  days: number[];
  hour: number;
  minute: number;
  meridiem: "AM" | "PM";
  lastSentAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

/**
 * A standing reminder about signups nobody has finished with.
 *
 * Daily means "on each of the days ticked"; weekly means "once, on the
 * one ticked". They are the same mechanism underneath — the difference
 * is only how many days may be chosen — so switching to weekly keeps
 * the first day rather than clearing the lot and making somebody start
 * again.
 */
function RemindersSection() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Reminders | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const data = useQuery({
    queryKey: ["dm-reminders"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/settings/reminders");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        reminders: Reminders; days: string[]; timezone: string;
      };
    },
  });

  useEffect(() => {
    if (data.data && !draft) setDraft(data.data.reminders);
  }, [data.data, draft]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/settings/reminders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save.");
      return body as { reminders: Reminders };
    },
    onSuccess: (b) => {
      setError("");
      setDraft(b.reminders);
      setNote(b.reminders.enabled ? "Saved." : "Saved — reminders are off.");
      void qc.invalidateQueries({ queryKey: ["dm-reminders"] });
    },
    onError: (e) => { setError((e as Error).message); setNote(""); },
  });

  const runNow = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/settings/reminders/run", { method: "POST" });
      return (await res.json()) as { sent: boolean; reason: string; outstanding: number };
    },
    onSuccess: (r) => {
      setError("");
      setNote(r.sent
        ? `Sent — ${r.outstanding} signup${r.outstanding === 1 ? "" : "s"} outstanding.`
        : `Nothing sent: ${r.reason}.`);
    },
  });

  const days = data.data?.days ?? [];
  const d = draft;
  const dirty = Boolean(d && data.data
    && JSON.stringify(d) !== JSON.stringify(data.data.reminders));

  const toggleDay = (i: number) => {
    if (!d) return;
    if (d.frequency === "week") { setDraft({ ...d, days: [i] }); return; }
    setDraft({
      ...d,
      days: d.days.includes(i) ? d.days.filter((x) => x !== i) : [...d.days, i].sort(),
    });
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Clock className="h-4 w-4" />
            Email reminders
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A standing reminder of member signups MOJO has not finished with, to the same
            addresses as above.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={d?.enabled ?? false}
            onChange={(e) => d && setDraft({ ...d, enabled: e.target.checked })}
          />
          On
        </label>
      </div>

      {d && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="freq" className="mb-1 block text-xs text-muted-foreground">
                How often
              </label>
              <select
                id="freq"
                value={d.frequency}
                onChange={(e) => {
                  const frequency = e.target.value as "day" | "week";
                  // Weekly takes one day. Keep the first rather than
                  // clearing them all and making somebody start again.
                  setDraft({
                    ...d, frequency,
                    days: frequency === "week" ? d.days.slice(0, 1) : d.days,
                  });
                }}
                className="rounded-md border border-border bg-background px-2.5 py-2 text-sm"
              >
                <option value="day">Daily</option>
                <option value="week">Weekly</option>
              </select>
            </div>

            <div>
              <span className="mb-1 block text-xs text-muted-foreground">At</span>
              <div className="flex items-center gap-1">
                <select
                  aria-label="Hour"
                  value={d.hour}
                  onChange={(e) => setDraft({ ...d, hour: Number(e.target.value) })}
                  className="rounded-md border border-border bg-background px-2 py-2 text-sm"
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                <span className="text-sm text-muted-foreground">:</span>
                <select
                  aria-label="Minute"
                  value={d.minute}
                  onChange={(e) => setDraft({ ...d, minute: Number(e.target.value) })}
                  className="rounded-md border border-border bg-background px-2 py-2 text-sm"
                >
                  {MINUTES.map((m) => (
                    <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
                  ))}
                </select>
                <select
                  aria-label="AM or PM"
                  value={d.meridiem}
                  onChange={(e) => setDraft({ ...d, meridiem: e.target.value as "AM" | "PM" })}
                  className="rounded-md border border-border bg-background px-2 py-2 text-sm"
                >
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>
                {/* Named, not assumed. A schedule with no zone beside
                    it is read as "my time" by whoever is looking, and
                    half the year that is an hour out. */}
                <span className="ml-1 text-xs text-muted-foreground">
                  {tzLabel(data.data?.timezone ?? "America/Chicago")}
                </span>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Times are {tzLabel(data.data?.timezone ?? "America/Chicago")}, and follow
            daylight saving — 9:00 AM stays 9:00 AM in the office through the
            March and November changes.
          </p>

          <div>
            <span className="mb-1 block text-xs text-muted-foreground">
              {d.frequency === "week" ? "On this day" : "On these days"}
            </span>
            <div className="flex flex-wrap gap-2">
              {days.map((name, i) => (
                <label
                  key={name}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
                    d.days.includes(i) ? "border-foreground bg-muted/50" : "border-border"
                  }`}
                >
                  <input
                    // Radio when only one may be chosen, so the control
                    // itself says the rule rather than silently undoing
                    // the previous tick.
                    type={d.frequency === "week" ? "radio" : "checkbox"}
                    name={d.frequency === "week" ? "reminder-day" : undefined}
                    checked={d.days.includes(i)}
                    onChange={() => toggleDay(i)}
                  />
                  {name}
                </label>
              ))}
            </div>
          </div>

          {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
          {note && <p className="text-sm text-emerald-700 dark:text-emerald-400">{note}</p>}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <button
              type="button"
              disabled={save.isPending || !dirty}
              onClick={() => save.mutate()}
              className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background disabled:opacity-50"
            >
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {dirty ? "Save" : "Saved"}
            </button>
            <button
              type="button"
              disabled={runNow.isPending}
              onClick={() => runNow.mutate()}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
            >
              {runNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send one now
            </button>
            {d.lastSentAt && (
              <span className="text-xs text-muted-foreground">
                Last sent {d.lastSentAt}
              </span>
            )}
          </div>

          {/* The one behaviour people would otherwise report as a fault. */}
          <p className="text-xs text-muted-foreground">
            Nothing is sent when there is nothing outstanding. A reminder that arrives every
            week saying there is nothing to do is one people stop reading — and then they
            stop reading the one that matters.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * Whether the configured reviewer can actually complete the review.
 *
 * Three ways it goes wrong and all of them are silent: an address with
 * no account, an account that is invited or disabled, and an account
 * that is active but does not hold the one role that approves. Nobody
 * finds out until a dealer rings asking why their member still cannot
 * wash.
 *
 * Reported rather than refused. There are reasons to point
 * notifications at somebody while a role is sorted out, and blocking
 * the save would leave the previous reviewer in place with nothing on
 * screen saying so.
 */
function ReviewerStatus({ checks }: { checks?: ReviewerCheck[] }) {
  if (!checks) return null;
  // Nobody set at all is one message; otherwise one answer per person,
  // because a list where only the third cannot approve is exactly as
  // broken as a single one who cannot, and only naming them finds it.
  if (checks.length === 0) {
    return (
      <div className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          No reviewer is set, so new members notify nobody.
        </p>
      </div>
    );
  }
  return <>{checks.map((c) => <OneReviewer key={c.email} check={c} />)}</>;
}

function OneReviewer({ check }: { check: ReviewerCheck }) {
  if (check.ok) {
    return (
      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span><strong>{check.email}</strong> — {check.because}</span>
      </p>
    );
  }
  return (
    <div className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {check.email} cannot complete the review they would be sent
      </p>
      <ul className="mt-1 space-y-0.5 text-xs text-amber-900 dark:text-amber-200">
        {check.problems.map((p) => <li key={p}>• {p}</li>)}
      </ul>
    </div>
  );
}

/**
 * "Central Time (CDT)" rather than "Chicago".
 *
 * The abbreviation is read from the browser against the schedule's own
 * zone, so it says CST or CDT according to the date rather than
 * whichever one somebody typed into a string once.
 */
function tzLabel(zone: string): string {
  try {
    const abbr = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, timeZoneName: "short",
    }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
    return abbr ? `${abbr} (${zone.replace("America/", "").replace("_", " ")})` : zone;
  } catch {
    return zone;
  }
}
