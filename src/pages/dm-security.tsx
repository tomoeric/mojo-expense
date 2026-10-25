import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, FolderOpen, Info, Loader2, Plug, Search, Shield,
} from "lucide-react";
import {
  Empty, EventRow, SeverityTag, TZ_LABEL, ViewTabs, shortStamp, stamp,
  type DmEvent,
} from "@/components/dm-events";

/**
 * The security workspace.
 *
 * Five views over ONE set of records, not five logs:
 *
 *   Concerns        patterns worth somebody's time, with the threshold
 *                   that raised them and what each one is NOT
 *   Events          every security-relevant record, searchable
 *   Sign-ins        successful and failed, together, because the
 *                   question is almost always whether an attempt
 *                   eventually worked
 *   Investigations  what a person concluded, kept off the evidence
 *   Coverage        what this app can and cannot see
 *
 * The honesty rules are in the server (`detect.ts`, `investigations.ts`)
 * rather than in this file's wording, so they cannot be undone by an
 * edit here. What this page must not do is add emphasis the data does
 * not carry: nothing is red unless it was blocked, and the word
 * "incident" appears only where a named person chose it.
 */

type Concern = {
  key: string; title: string; severity: DmEvent["severity"];
  rule: string; observed: string; count: number;
  first: string; last: string; eventIds: string[]; caveat: string;
};

type Investigation = {
  id: string; title: string; status: string; classification: string;
  assignee: string; openedAt: string; openedBy: string;
  closedAt: string | null; closedBy: string; resolution: string;
  eventIds: string[]; evidence: string;
  notes?: { id: string; at: string; author: string; change: string; body: string }[];
};

type View = "concerns" | "events" | "signins" | "cases" | "coverage";

export function DmSecurityPage() {
  const [view, setView] = useState<View>("concerns");
  const counts = useQuery({
    queryKey: ["dm-concerns"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/security/concerns");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        concerns: Concern[];
        thresholds: Record<string, number>;
        counts: Record<string, number>;
      };
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Security</h1>
        <p className="text-sm text-muted-foreground">
          Attempts, refusals and patterns worth a look — and a plain statement of
          what this application can and cannot see.
        </p>
      </div>

      <ViewTabs<View>
        active={view}
        onPick={setView}
        tabs={[
          { key: "concerns", label: "Concerns", count: counts.data?.concerns.length },
          { key: "events", label: "Events" },
          { key: "signins", label: "Sign-ins" },
          { key: "cases", label: "Investigations", count: counts.data?.counts.open },
          { key: "coverage", label: "Coverage & health" },
        ]}
      />

      {view === "concerns" && <Concerns data={counts.data} loading={counts.isPending} />}
      {view === "events" && (
        <Events preset="suspicious" blurb={
          "Every security-relevant record, including individual refusals. One "
          + "refused link is an ordinary event, not an attack."
        } />
      )}
      {view === "signins" && (
        <Events preset="signins" blurb={
          "Successful and failed sign-ins together. Successes are here because "
          + "the question an investigator asks is whether an attempt eventually "
          + "worked — they are kept out of the Concerns feed, not out of the record."
        } />
      )}
      {view === "cases" && <Cases />}
      {view === "coverage" && <Coverage />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Concerns
 * ------------------------------------------------------------------ */

function Concerns({
  data, loading,
}: {
  data: { concerns: Concern[]; thresholds: Record<string, number> } | undefined;
  loading: boolean;
}) {
  const qc = useQueryClient();
  const [opening, setOpening] = useState<Concern | null>(null);

  const open = useMutation({
    mutationFn: async (c: Concern) => {
      const res = await fetch("/api/dutch-miller/investigations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: c.title, eventIds: c.eventIds,
          evidence: `${c.rule} — observed ${c.observed}`,
          note: "Opened from the concerns feed.",
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not open it.");
      return body as { case: Investigation };
    },
    onSuccess: () => {
      setOpening(null);
      void qc.invalidateQueries({ queryKey: ["dm-concerns"] });
      void qc.invalidateQueries({ queryKey: ["dm-cases"] });
    },
  });

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const list = data?.concerns ?? [];

  return (
    <div className="space-y-3">
      {/* Said once, at the top, rather than implied by colour. */}
      <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          A concern is a <strong>pattern across several events</strong> that met a
          stated threshold. It is a reason for somebody to look, not a finding. Only
          an investigator can conclude anything, and only an investigator can mark
          something a confirmed incident.
        </span>
      </p>

      {list.length === 0 && (
        <div className="rounded-lg border border-border">
          <Empty
            title="Nothing has met a threshold"
            note={"No pattern in the last day crossed one of the rules. This means no "
              + "rule fired — it does not mean nothing was attempted. See Coverage "
              + "& health for what is not watched."}
          />
        </div>
      )}

      {list.map((c) => (
        <div key={c.key} className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2">
                <SeverityTag severity={c.severity} />
                <span className="font-semibold">{c.title}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {shortStamp(c.first)} to {shortStamp(c.last)} {TZ_LABEL}
                {" · "}{c.eventIds.length} event{c.eventIds.length === 1 ? "" : "s"}
              </p>
            </div>
            <button
              type="button"
              disabled={open.isPending}
              onClick={() => { setOpening(c); open.mutate(c); }}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
            >
              {open.isPending && opening?.key === c.key
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <FolderOpen className="h-3.5 w-3.5" />}
              Open an investigation
            </button>
          </div>

          <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[7rem_1fr]">
            <dt className="text-muted-foreground">Rule</dt>
            <dd>{c.rule}</dd>
            <dt className="text-muted-foreground">Observed</dt>
            <dd className="font-semibold">{c.observed}</dd>
          </dl>

          {/* What it is NOT, beside every single one. A security page that
              only ever says "suspicious" trains people to stop reading it. */}
          <p className="mt-2 flex items-start gap-1.5 rounded-md bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{c.caveat}</span>
          </p>
        </div>
      ))}

      {open.isError && (
        <p className="text-sm font-semibold text-red-600">{(open.error as Error).message}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Events and Sign-ins
 * ------------------------------------------------------------------ */

function Events({ preset, blurb }: { preset: "suspicious" | "signins"; blurb: string }) {
  const [who, setWho] = useState("");
  const [ip, setIp] = useState("");
  const [days, setDays] = useState(30);
  const [minSeverity, setMinSeverity] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  const q = useQuery({
    queryKey: ["dm-events", preset, who, ip, days, minSeverity],
    queryFn: async () => {
      const p = new URLSearchParams({ preset, days: String(days), limit: "300" });
      if (who.trim()) p.set("who", who.trim());
      if (ip.trim()) p.set("ip", ip.trim());
      if (minSeverity) p.set("minSeverity", minSeverity);
      const res = await fetch(`/api/dutch-miller/event-log?${p}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as { rows: DmEvent[]; total: number };
    },
  });

  const qc = useQueryClient();
  const makeCase = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/investigations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: `${picked.length} event(s) picked out for review`,
          eventIds: picked,
          evidence: "Selected by hand from the events view.",
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not open it.");
      return res.json();
    },
    onSuccess: () => {
      setPicked([]);
      void qc.invalidateQueries({ queryKey: ["dm-cases"] });
    },
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{blurb}</p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={who}
            onChange={(e) => setWho(e.target.value)}
            placeholder="Account"
            aria-label="Filter by account"
            className="w-40 bg-transparent text-sm outline-none"
          />
        </label>
        <input
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="Source address"
          aria-label="Filter by source address"
          className="w-40 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs"
        />
        <select
          value={minSeverity}
          onChange={(e) => setMinSeverity(e.target.value)}
          aria-label="Minimum severity"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any severity</option>
          <option value="low">Low and above</option>
          <option value="medium">Medium and above</option>
          <option value="high">High and above</option>
        </select>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="How far back"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
        {picked.length > 0 && (
          <button
            type="button"
            disabled={makeCase.isPending}
            onClick={() => makeCase.mutate()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Investigate {picked.length} selected
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        {q.isPending && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>}
        {q.data?.rows.length === 0 && (
          <Empty
            title="No events match"
            note={"Nothing recorded in this window fits those filters. Events are never "
              + "edited or removed, so an empty result means none were recorded — "
              + "see Coverage & health for what is not watched at all."}
          />
        )}
        {q.data?.rows.map((e) => (
          <EventRow
            key={e.id}
            event={e}
            selected={picked.includes(e.id)}
            onSelect={(id, on) =>
              setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)))}
          />
        ))}
      </div>

      {q.data && q.data.total > q.data.rows.length && (
        <p className="text-xs text-muted-foreground">
          Showing {q.data.rows.length.toLocaleString()} of {q.data.total.toLocaleString()}.
          Narrow the window or the filters.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Investigations
 * ------------------------------------------------------------------ */

const STATUS_LABEL: Record<string, string> = {
  new: "New", investigating: "Investigating",
  resolved: "Resolved", "false-positive": "False positive",
};
const CLASS_LABEL: Record<string, string> = {
  unclassified: "Not yet classified", benign: "Benign",
  suspicious: "Suspicious — unproven", "confirmed-incident": "Confirmed incident",
};

function Cases() {
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["dm-cases"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/investigations");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        cases: Investigation[]; counts: Record<string, number>;
        statuses: string[]; classifications: string[];
      };
    },
  });

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          An investigation holds what a <strong>person</strong> concluded. It points at
          events by reference and can never change them — the record of what happened
          stays exactly as it was written. Every change here is itself kept.
        </span>
      </p>

      <div className="overflow-hidden rounded-lg border border-border">
        {list.isPending && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>
        )}
        {list.data?.cases.length === 0 && (
          <Empty
            title="No investigations"
            note="Open one from a concern, or by picking events out of the Events view."
          />
        )}
        {list.data?.cases.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setOpenId(c.id)}
            className="flex w-full items-start justify-between gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/40"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{c.title}</span>
              <span className="block text-xs text-muted-foreground">
                #{c.id} · opened {shortStamp(c.openedAt)} {TZ_LABEL} by {c.openedBy}
                {c.assignee ? ` · ${c.assignee}` : " · unassigned"}
              </span>
            </span>
            <span className="shrink-0 text-right">
              <StatusTag status={c.status} />
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {CLASS_LABEL[c.classification] ?? c.classification}
              </span>
            </span>
          </button>
        ))}
      </div>

      {openId && (
        <CaseDetail
          id={openId}
          statuses={list.data?.statuses ?? []}
          classifications={list.data?.classifications ?? []}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function StatusTag({ status }: { status: string }) {
  const style = status === "new" ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
    : status === "investigating" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
      : status === "resolved" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function CaseDetail({
  id, statuses, classifications, onClose,
}: {
  id: string; statuses: string[]; classifications: string[]; onClose: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["dm-case", id],
    queryFn: async () => {
      const res = await fetch(`/api/dutch-miller/investigations/${id}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as { case: Investigation; events: DmEvent[] };
    },
  });
  const c = q.data?.case;

  const [status, setStatus] = useState<string>("");
  const [classification, setClassification] = useState<string>("");
  const [assignee, setAssignee] = useState<string>("");
  const [resolution, setResolution] = useState<string>("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  // Seeded from the case once, then left alone: refetching while
  // somebody is typing a conclusion must not take it away from them.
  if (c && !touched) {
    if (status === "") setStatus(c.status);
    if (classification === "") setClassification(c.classification);
    if (assignee === "") setAssignee(c.assignee);
    if (resolution === "") setResolution(c.resolution);
  }

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/dutch-miller/investigations/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, classification, assignee, resolution, note }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save it.");
      return body;
    },
    onSuccess: () => {
      setNote("");
      void qc.invalidateQueries({ queryKey: ["dm-case", id] });
      void qc.invalidateQueries({ queryKey: ["dm-cases"] });
      void qc.invalidateQueries({ queryKey: ["dm-concerns"] });
    },
  });

  const closing = status === "resolved" || status === "false-positive";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Investigation"
        className="w-full max-w-3xl space-y-4 rounded-xl border border-border bg-background p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{c?.title ?? "Investigation"}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            Close
          </button>
        </div>

        {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}

        {c && (
          <>
            <p className="text-xs text-muted-foreground">
              #{c.id} · opened {stamp(c.openedAt)} {TZ_LABEL} by {c.openedBy}
              {c.closedAt ? ` · closed ${stamp(c.closedAt)} ${TZ_LABEL} by ${c.closedBy}` : ""}
            </p>
            {c.evidence && (
              <p className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                <span className="font-semibold">What raised it: </span>{c.evidence}
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Status">
                <select
                  value={status}
                  onChange={(e) => { setTouched(true); setStatus(e.target.value); }}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                >
                  {statuses.map((s) => (
                    <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
                  ))}
                </select>
              </Field>
              <Field label="What it turned out to be">
                <select
                  value={classification}
                  onChange={(e) => { setTouched(true); setClassification(e.target.value); }}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                >
                  {classifications.map((s) => (
                    <option key={s} value={s}>{CLASS_LABEL[s] ?? s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Assigned to">
                <input
                  value={assignee}
                  onChange={(e) => { setTouched(true); setAssignee(e.target.value); }}
                  placeholder="nobody"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                />
              </Field>
            </div>

            {/* Required to close, and required to call anything an
                incident. The server refuses both without it. */}
            <Field label={
              classification === "confirmed-incident" || closing
                ? "Conclusion — required"
                : "Conclusion"
            }>
              <textarea
                value={resolution}
                onChange={(e) => { setTouched(true); setResolution(e.target.value); }}
                rows={3}
                placeholder="What you found, and how you know."
                className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
              />
            </Field>

            <Field label="Add a note">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Rang the dealership; they confirmed it was their own bookmark."
                className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
              />
            </Field>

            {save.isError && (
              <p className="text-sm font-semibold text-red-600">
                {(save.error as Error).message}
              </p>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate()}
                className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50"
              >
                {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save
              </button>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
                Case history
              </p>
              <div className="overflow-hidden rounded-lg border border-border">
                {(c.notes ?? []).map((n) => (
                  <div key={n.id} className="border-b border-border px-3 py-2 text-xs last:border-b-0">
                    <p className="text-muted-foreground">
                      {shortStamp(n.at)} {TZ_LABEL} · {n.author}
                      {n.change ? ` · ${n.change}` : ""}
                    </p>
                    {n.body && <p className="mt-0.5">{n.body}</p>}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
                Evidence — {q.data?.events.length ?? 0} event
                {(q.data?.events.length ?? 0) === 1 ? "" : "s"}, unchanged
              </p>
              <div className="overflow-hidden rounded-lg border border-border">
                {(q.data?.events ?? []).map((e) => <EventRow key={e.id} event={e} />)}
                {(q.data?.events.length ?? 0) === 0 && (
                  <Empty title="No events linked" note="Pick some from the Events view." />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * Coverage & health
 * ------------------------------------------------------------------ */

function Coverage() {
  const q = useQuery({
    queryKey: ["dm-coverage"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/security/coverage");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        sources: { name: string; connected: boolean; what: string; gap: string }[];
        health: {
          total: number; oldest: string | null; newest: string | null;
          byCategory: { category: string; events: number; last: string | null }[];
        };
      };
    },
  });

  return (
    <div className="space-y-4">
      {/* The single most important sentence on the page. */}
      <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong>An empty log is not proof that nothing happened.</strong> This
          application can only record requests that reached it. Anything stopped
          earlier — at the network, the hosting platform or Microsoft's own sign-in —
          leaves no trace in this workspace unless that source is connected below.
        </span>
      </p>

      <div className="space-y-2">
        {(q.data?.sources ?? []).map((s) => (
          <div key={s.name} className="rounded-lg border border-border bg-card p-4">
            <p className="flex items-center gap-2 text-sm font-semibold">
              {s.connected
                ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                : <Plug className="h-4 w-4 text-muted-foreground" />}
              {s.name}
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                s.connected
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground"
              }`}>
                {s.connected ? "collecting" : "not connected"}
              </span>
            </p>
            <p className="mt-1.5 text-xs">{s.what}</p>
            <p className="mt-1 text-xs text-muted-foreground">{s.gap}</p>
          </div>
        ))}
      </div>

      {q.data?.health && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <Shield className="h-4 w-4" />
            What is stored
          </p>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Events held</dt>
            <dd className="tabular-nums">{q.data.health.total.toLocaleString()}</dd>
            <dt className="text-muted-foreground">Oldest</dt>
            <dd>{q.data.health.oldest
              ? `${stamp(q.data.health.oldest)} ${TZ_LABEL}` : "—"}</dd>
            <dt className="text-muted-foreground">Most recent</dt>
            <dd>{q.data.health.newest
              ? `${stamp(q.data.health.newest)} ${TZ_LABEL}` : "—"}</dd>
            {q.data.health.byCategory.map((c) => (
              <Row key={c.category} label={c.category} value={
                `${c.events.toLocaleString()} event(s)`
                + (c.last ? ` · last ${shortStamp(c.last)} ${TZ_LABEL}` : "")
              } />
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Events are append-only: nothing in this application edits or deletes one.
            Times are stored in UTC and shown in {TZ_LABEL}. No entry contains a
            sign-in link, a confirmation code, a cookie or a credential — detail text
            is filtered and query strings are dropped before anything is written.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground capitalize">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
