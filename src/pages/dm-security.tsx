import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Globe, Shield, ShieldAlert, UserX } from "lucide-react";

type Event = {
  id: string; at: string; actor: string; action: string;
  subject: string; detail: string; ip: string;
};
type Payload = {
  events: Event[];
  byAddress: { subject: string; attempts: number; last: string }[];
  byIp: { ip: string; attempts: number; addresses: number; last: string }[];
  total: number;
  days: number;
  lockout: { maxFailures: number; windowMinutes: number; lockMinutes: number };
};

/**
 * The security log: attempts that failed, and anything worth a look.
 *
 * Separate from the audit trail on purpose. The trail records what was
 * DONE and is mostly ordinary; this records only what did not work.
 * Four real attempts buried in nine hundred routine lines is how they
 * get missed.
 */
const WHAT: Record<string, { label: string; why: string; bad: boolean }> = {
  "login.unknown": {
    label: "Unknown address asked for a link",
    why: "Nobody has ever invited that address. One is a typo; a run of them is somebody "
      + "working through a list.",
    bad: true,
  },
  "signin.denied": {
    label: "Signed in to the tenant, refused by the app",
    why: "A real Microsoft account that is not on the access list.",
    bad: true,
  },
  "login.rejected": {
    label: "Link refused",
    why: "Expired, already used, or for an account that is not active.",
    bad: false,
  },
  "code.failed": {
    label: "Wrong confirmation code",
    why: "A mistyped code, or somebody guessing at one.",
    bad: false,
  },
  "locked.out": {
    label: "Locked out",
    why: "Too many failures from that address inside the window, so it is being refused.",
    bad: true,
  },
  "session.rejected": {
    label: "Session refused",
    why: "A sign-in cookie presented after the account behind it was switched off or "
      + "revoked.",
    bad: true,
  },
};

const when = (iso: string) => new Date(iso).toLocaleString();

export function DmSecurityPage() {
  const [days, setDays] = useState(30);

  const data = useQuery({
    queryKey: ["dm-security", days],
    queryFn: async () => {
      const res = await fetch(`/api/dutch-miller/security?days=${days}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as Payload;
    },
  });

  const d = data.data;
  // One address is somebody fumbling their own sign-in. One IP reaching
  // for several is the thing worth a phone call.
  const probing = (d?.byIp ?? []).filter((r) => r.addresses >= 3);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Shield className="h-4 w-4" />
            Security Log
          </h1>
          <p className="text-sm text-muted-foreground">
            Failed sign-in attempts and anything else worth a look. Successful sign-ins are
            not listed — they would bury what matters.
          </p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-md border border-border bg-background px-2.5 py-2 text-sm"
        >
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
      </div>

      {data.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}

      {d && d.total === 0 && (
        <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300">
          Nothing to report. No failed sign-ins, refused links or lockouts in this period.
        </p>
      )}

      {probing.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400">
            <ShieldAlert className="h-4 w-4" />
            One address reaching for several accounts
          </p>
          <p className="mt-1 text-xs text-red-700/90 dark:text-red-400/90">
            Somebody mistyping their own sign-in touches one account. This is the shape of
            working through a list.
          </p>
          <ul className="mt-2 space-y-0.5 text-xs">
            {probing.map((r) => (
              <li key={r.ip} className="font-mono">
                {r.ip} — {r.addresses} addresses, {r.attempts} attempts, last {when(r.last)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {d && d.total > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <Panel title="By address" icon={<UserX className="h-3.5 w-3.5" />}>
            {d.byAddress.map((r) => (
              <Line
                key={r.subject}
                left={r.subject}
                right={`${r.attempts}`}
                sub={`last ${when(r.last)}`}
              />
            ))}
          </Panel>
          <Panel title="By origin" icon={<Globe className="h-3.5 w-3.5" />}>
            {d.byIp.map((r) => (
              <Line
                key={r.ip}
                left={r.ip}
                right={`${r.attempts}`}
                sub={`${r.addresses} address${r.addresses === 1 ? "" : "es"} · last ${when(r.last)}`}
                warn={r.addresses >= 3}
              />
            ))}
          </Panel>
        </div>
      )}

      {d && d.events.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">When</th>
                <th className="px-3 py-2 text-left font-semibold">What happened</th>
                <th className="px-3 py-2 text-left font-semibold">Address</th>
                <th className="px-3 py-2 text-left font-semibold">From</th>
                <th className="px-3 py-2 text-left font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody>
              {d.events.map((e) => {
                const what = WHAT[e.action];
                return (
                  <tr key={e.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {when(e.at)}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        {what?.bad && (
                          <AlertTriangle className="h-3 w-3 shrink-0 text-red-600" />
                        )}
                        <span className={what?.bad ? "font-semibold" : ""}>
                          {what?.label ?? e.action}
                        </span>
                      </span>
                      {/* The line that turns a log into something an
                          administrator can act on rather than squint at. */}
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {what?.why ?? ""}
                      </span>
                    </td>
                    <td className="px-3 py-2 break-all">{e.subject || "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {e.ip || "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{e.detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {d && (
        <p className="text-xs text-muted-foreground">
          An address is refused automatically after {d.lockout.maxFailures} failures within{" "}
          {d.lockout.windowMinutes} minutes, for {d.lockout.lockMinutes} minutes. Nothing
          here is ever edited or removed, and no entry contains a link or a code.
        </p>
      )}
    </div>
  );
}

function Panel({
  title, icon, children,
}: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <p className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-semibold">
        {icon}{title}
      </p>
      <div className="max-h-64 overflow-auto">{children}</div>
    </div>
  );
}

function Line({
  left, right, sub, warn,
}: { left: string; right: string; sub: string; warn?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-1.5 last:border-b-0">
      <span className="min-w-0">
        <span className={`block truncate text-sm ${warn ? "font-semibold text-red-600" : ""}`}>
          {left}
        </span>
        <span className="block text-[11px] text-muted-foreground">{sub}</span>
      </span>
      <span className="shrink-0 text-sm tabular-nums">{right}</span>
    </div>
  );
}
