import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, Search } from "lucide-react";
import { Empty, EventRow, TZ_LABEL, ViewTabs, type DmEvent } from "@/components/dm-events";

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

type View = "security" | "access" | "business" | "all";

export function DmAuditPage({ subject = "" }: { subject?: string }) {
  const [view, setView] = useState<View>("all");
  const [who, setWho] = useState(subject);
  const [search, setSearch] = useState("");
  const [days, setDays] = useState(90);

  const q = useQuery({
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
        ]}
      />

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
    </div>
  );
}
