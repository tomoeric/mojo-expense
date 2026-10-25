import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Info, Search } from "lucide-react";
import {
  Empty, EventRow, TZ_LABEL, ViewTabs, stamp, type DmEvent,
} from "@/components/dm-events";

/**
 * Audit History — the whole trail, searchable.
 *
 * Three views over ONE table, split by what somebody is asking rather
 * than by where the record came from:
 *
 *   Security        refusals, blocked attempts, and the sensitive
 *                   changes an investigator wants beside them
 *   Access activity sign-ins, invitations, accounts, roles, view-as
 *   Business        members, RFID, imports, notifications, reminders
 *
 * This replaces the long table that used to live inside the Users
 * dialog. Per-account History is now this page with the account
 * filled in — the same read, not a second implementation, so the two
 * cannot disagree about what happened.
 */

type View = "security" | "access" | "business" | "all" | "viewas";

export function DmAuditPage({ subject = "" }: { subject?: string }) {
  const [view, setView] = useState<View>("all");
  const [who, setWho] = useState(subject);
  const [search, setSearch] = useState("");
  const [days, setDays] = useState(90);

  const q = useQuery({
    enabled: view !== "viewas",
    queryKey: ["dm-audit-history", view, who, search, days],
    queryFn: async () => {
      const p = new URLSearchParams({
        category: view, days: String(days), limit: "300",
      });
      if (who.trim()) p.set("who", who.trim());
      if (search.trim()) p.set("search", search.trim());
      const res = await fetch(`/api/dutch-miller/event-log?${p}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as { rows: DmEvent[]; total: number };
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Audit History</h1>
        <p className="text-sm text-muted-foreground">
          Everything this application has recorded — who did it, to whom, and what
          happened. Times are {TZ_LABEL}.
        </p>
      </div>

      <ViewTabs<View>
        active={view}
        onPick={setView}
        tabs={[
          { key: "all", label: "Everything" },
          { key: "security", label: "Security" },
          { key: "access", label: "Access activity" },
          { key: "business", label: "Business activity" },
          { key: "viewas", label: "View As sessions" },
        ]}
      />

      {view === "viewas" && <ViewAsSessions who={who} onWho={setWho} days={days} />}

      {view !== "viewas" && (
      <>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={who}
            onChange={(e) => setWho(e.target.value)}
            placeholder="Account"
            aria-label="Filter by account"
            className="w-48 bg-transparent text-sm outline-none"
          />
        </label>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search the detail"
          aria-label="Search event detail"
          className="w-56 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="How far back"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
          <option value={3650}>Everything</option>
        </select>
        {(who || search) && (
          <button
            type="button"
            onClick={() => { setWho(""); setSearch(""); }}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
          >
            Clear
          </button>
        )}
      </div>

      <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Append-only. Nothing in this application edits or deletes a line, and no
          entry contains a sign-in link, a confirmation code or a credential. A
          notification shown as sent was <strong>accepted for delivery</strong> by
          Microsoft — that is not the same as it arriving, and nothing here can tell
          you it was read.
          {" "}
          {/* Said here as well as on the tab, because somebody looking
              for a view-as session will look in Everything first. */}
          These views cover general audit activity; starting and stopping a
          <strong> View As</strong> session is session metadata and has its own tab.
          What an administrator <em>did</em> inside one stays here, attributed to
          both identities.
        </span>
      </p>

      <div className="overflow-hidden rounded-lg border border-border">
        {q.isPending && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>
        )}
        {q.isError && (
          <p className="px-3 py-6 text-center text-sm font-semibold text-red-600">
            {(q.error as Error).message}
          </p>
        )}
        {q.data?.rows.length === 0 && (
          <Empty
            title="Nothing matches"
            note="No record in this window fits those filters."
          />
        )}
        {q.data?.rows.map((e) => <EventRow key={e.id} event={e} />)}
      </div>

      {q.data && q.data.total > q.data.rows.length && (
        <p className="text-xs text-muted-foreground">
          Showing {q.data.rows.length.toLocaleString()} of {q.data.total.toLocaleString()}.
          Narrow the window or the filters.
        </p>
      )}
      </>
      )}
    </div>
  );
}

/**
 * Who wore whose identity, and for how long.
 *
 * Its own tab because it is a different KIND of record from the rest
 * of the trail: session metadata about an administrator, not an
 * action taken. Keeping the two bracketing events out of the other
 * views — and out of their counts — means a page of fifty events is
 * fifty things that happened, rather than forty-eight plus the
 * footprints of somebody looking.
 *
 * What an administrator DID inside a view is not here. Those stay in
 * the general views, carrying both identities, where anybody
 * investigating will actually look for them.
 *
 * Start and end are paired on the session id both events carry —
 * never on "the next end for the same two addresses", which is wrong
 * the moment one person is viewed twice in an afternoon. A view with
 * no recorded end says so. No duration is ever inferred.
 */
function ViewAsSessions({
  who, onWho, days,
}: {
  who: string;
  onWho: (v: string) => void;
  days: number;
}) {
  const q = useQuery({
    queryKey: ["dm-view-as-sessions", who, days],
    queryFn: async () => {
      const p = new URLSearchParams({ days: String(days), limit: "200" });
      if (who.trim()) p.set("who", who.trim());
      const res = await fetch(`/api/dutch-miller/view-as-sessions?${p}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as { sessions: Session[] };
    },
  });

  const rows = q.data?.sessions ?? [];

  const download = () => {
    const head = [
      "Administrator", "Viewed as", "Started", "Ended", "Duration",
      "App", "Source address", "Session ID",
    ];
    const body = rows.map((r) => [
      r.administrator, r.viewed,
      `${stamp(r.startedAt)} ${TZ_LABEL}`,
      r.endedAt ? `${stamp(r.endedAt)} ${TZ_LABEL}` : "end not recorded",
      duration(r.durationSeconds),
      "Dutch Miller", r.ip, r.sid || "not recorded",
    ]);
    const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [head, ...body].map((l) => l.map(cell).join(",")).join("\r\n");
    const url = URL.createObjectURL(
      new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `view-as-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    // This tab only, and recorded like any other export.
    void fetch("/api/dutch-miller/exported", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "security", rows: rows.length, detail: "view-as sessions",
      }),
    }).catch(() => undefined);
  };

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Starting and stopping a view is <strong>session metadata</strong>, so it lives
          here rather than in the other tabs or their counts. Anything an administrator
          actually did while viewing — a member edited, a role changed, an export —
          stays in those tabs, attributed to both the real administrator and the account
          they were wearing.
        </span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={who}
            onChange={(e) => onWho(e.target.value)}
            placeholder="Either account"
            aria-label="Filter by administrator or viewed account"
            className="w-56 bg-transparent text-sm outline-none"
          />
        </label>
        {who && (
          <button
            type="button"
            onClick={() => onWho("")}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
          >
            Clear
          </button>
        )}
        <button
          type="button"
          disabled={rows.length === 0}
          onClick={download}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          Export these sessions
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Administrator</th>
              <th className="px-3 py-2 text-left font-semibold">Viewed as</th>
              <th className="px-3 py-2 text-left font-semibold">Started ({TZ_LABEL})</th>
              <th className="px-3 py-2 text-left font-semibold">Ended</th>
              <th className="px-3 py-2 text-left font-semibold">Duration</th>
              <th className="px-3 py-2 text-left font-semibold">From</th>
            </tr>
          </thead>
          <tbody>
            {q.isPending && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                Loading…
              </td></tr>
            )}
            {q.data && rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-10 text-center">
                <span className="block text-sm font-medium">No view-as sessions</span>
                <span className="mx-auto mt-1 block max-w-md text-xs text-muted-foreground">
                  Nobody has looked at the app as somebody else in this window.
                </span>
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.startEventId} className="border-t border-border">
                <td className="px-3 py-2">{r.administrator || "—"}</td>
                <td className="px-3 py-2">{r.viewed}</td>
                <td className="px-3 py-2 text-muted-foreground">{stamp(r.startedAt)}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {r.endedAt
                    ? stamp(r.endedAt)
                    /* Not a guess, and not blank either: a view left
                       open, or ended by a cookie expiring, genuinely
                       has no end event and saying so is the answer. */
                    : <span className="italic">end not recorded</span>}
                </td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">
                  {duration(r.durationSeconds)}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {r.ip || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Session = {
  sid: string;
  administrator: string;
  viewed: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  ip: string;
  userAgent: string;
  startEventId: string;
  endEventId: string | null;
};

/** Only from two real timestamps. Never worked out from one. */
function duration(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
