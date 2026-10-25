import { AlertTriangle } from "lucide-react";

/**
 * The shared pieces every event view is built from.
 *
 * One component for a row, one for severity, one for an agent string —
 * because Security, Sign-ins and Audit History show the SAME records
 * and three separate renderings would drift until the same event read
 * three different ways depending on which page you opened.
 */

export type DmEvent = {
  id: string;
  at: string;
  receivedAt: string;
  actor: string;
  actorReal: string;
  action: string;
  subject: string;
  resource: string;
  detail: string;
  ip: string;
  userAgent: string;
  path: string;
  forwarded: string;
  category: "security" | "access" | "business";
  outcome: "attempted" | "blocked" | "succeeded" | "unknown";
  severity: "info" | "low" | "medium" | "high" | "critical";
  label: string;
};

/**
 * Times in one zone, named.
 *
 * Everything is stored in UTC and shown in America/Chicago, which is
 * where the people reading it are. The zone is printed rather than
 * assumed: a timestamp with no zone beside an IP address is the kind
 * of detail an investigation turns on.
 */
export const TZ = "America/Chicago";
export const TZ_LABEL = "CT";

export const stamp = (iso: string): string =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: TZ, year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });

export const shortStamp = (iso: string): string =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

const SEVERITY_STYLE: Record<DmEvent["severity"], string> = {
  info: "bg-muted text-muted-foreground",
  low: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  high: "bg-orange-500/20 text-orange-700 dark:text-orange-400",
  critical: "bg-red-500/20 text-red-700 dark:text-red-400",
};

export function SeverityTag({ severity }: { severity: DmEvent["severity"] }) {
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
      SEVERITY_STYLE[severity]
    }`}>
      {severity}
    </span>
  );
}

const OUTCOME_STYLE: Record<DmEvent["outcome"], string> = {
  attempted: "text-muted-foreground",
  blocked: "text-red-700 dark:text-red-400 font-semibold",
  succeeded: "text-emerald-700 dark:text-emerald-400",
  unknown: "text-muted-foreground italic",
};

export function OutcomeTag({ outcome }: { outcome: DmEvent["outcome"] }) {
  return <span className={`text-xs ${OUTCOME_STYLE[outcome]}`}>{outcome}</span>;
}

/**
 * What claimed to be making the request.
 *
 * Self-reported and freely forgeable, which is rather the point of
 * showing it: a run of attempts sharing one odd string is a pattern an
 * address and a time alone do not reveal. It is a clue, never an
 * identity, and a missing one is MISSING TELEMETRY rather than proof
 * of anything — plenty of ordinary clients omit it, and anybody
 * sending one can send whatever they like.
 */
export function Agent({ ua }: { ua: string }) {
  if (!ua) {
    return (
      <span
        title={"No user agent was recorded. Some clients do not send one, and anybody "
          + "sending one can send anything, so this is missing information rather "
          + "than a finding."}
        className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground"
      >
        <AlertTriangle className="h-2.5 w-2.5" />
        no agent recorded
      </span>
    );
  }
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
      : /Chrome\//.test(ua) ? "Chrome"
        : /Safari\//.test(ua) ? "Safari"
          : /Firefox\//.test(ua) ? "Firefox" : "";
  const os = /Windows/.test(ua) ? "Windows"
    : /iPhone|iPad/.test(ua) ? "iOS"
      : /Android/.test(ua) ? "Android"
        : /Mac OS X|Macintosh/.test(ua) ? "Mac"
          : /Linux/.test(ua) ? "Linux" : "";

  // Does not name a browser. Worth noticing, worth nothing on its own.
  const tool = !browser;
  return (
    <span
      title={ua}
      className={`inline-block max-w-40 truncate rounded-full px-1.5 py-0.5 text-[10px] ${
        tool
          ? "bg-amber-500/15 font-semibold text-amber-700 dark:text-amber-400"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {tool ? ua.split("/")[0]!.slice(0, 24) || "unnamed client" : [browser, os].filter(Boolean).join(" · ")}
    </span>
  );
}

/**
 * One event, expandable.
 *
 * The readable line is the summary from the catalogue plus whoever it
 * concerned; everything technical is behind the disclosure, because a
 * table that shows all of it is a table nobody scans.
 */
export function EventRow({
  event, selected, onSelect,
}: {
  event: DmEvent;
  selected?: boolean;
  onSelect?: (id: string, on: boolean) => void;
}) {
  const e = event;
  return (
    <details className="group border-b border-border last:border-b-0">
      <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2 hover:bg-muted/40">
        {onSelect && (
          <input
            type="checkbox"
            checked={Boolean(selected)}
            onClick={(ev) => ev.stopPropagation()}
            onChange={(ev) => onSelect(e.id, ev.target.checked)}
            aria-label={`Select event ${e.id}`}
            className="mt-1 h-3.5 w-3.5 shrink-0"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <SeverityTag severity={e.severity} />
            <span className="text-sm font-medium">{e.label}</span>
            <OutcomeTag outcome={e.outcome} />
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {[e.subject || e.actor || "—", e.detail].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-xs tabular-nums text-muted-foreground">
            {shortStamp(e.at)} {TZ_LABEL}
          </span>
          <span className="block font-mono text-[10px] text-muted-foreground">
            {e.ip || "no address"}
          </span>
        </span>
      </summary>
      <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 bg-muted/30 px-3 py-2.5 text-xs">
        <Fact label="Event" value={`#${e.id} · ${e.action}`} mono />
        <Fact label={`Occurred (${TZ_LABEL})`} value={stamp(e.at)} />
        {e.receivedAt !== e.at && (
          <Fact label={`Recorded (${TZ_LABEL})`} value={stamp(e.receivedAt)} />
        )}
        <Fact label="Category" value={e.category} />
        <Fact label="Subject" value={e.subject || "—"} />
        <Fact label="Acting as" value={e.actor || "not signed in"} />
        {/* Both identities. An action taken during a view belongs to the
            account it was taken as AND to the person who chose to wear it. */}
        {e.actorReal && e.actorReal !== e.actor && (
          <Fact label="Really" value={`${e.actorReal} (viewing as ${e.actor})`} />
        )}
        {e.resource && <Fact label="Record" value={e.resource} mono />}
        {e.path && <Fact label="Route" value={e.path} mono />}
        <Fact label="Source address" value={e.ip || "—"} mono />
        {e.forwarded && <Fact label="Forwarded chain" value={e.forwarded} mono />}
        <dt className="text-muted-foreground">Client</dt>
        <dd><Agent ua={e.userAgent} /></dd>
      </dl>
    </details>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono text-[11px]" : ""}`}>{value}</dd>
    </>
  );
}

/** The same tab strip on every workspace view. */
export function ViewTabs<T extends string>({
  tabs, active, onPick,
}: {
  tabs: { key: T; label: string; count?: number }[];
  active: T;
  onPick: (key: T) => void;
}) {
  return (
    <div role="tablist" className="flex flex-wrap items-center gap-1 border-b border-border">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          type="button"
          aria-selected={active === t.key}
          onClick={() => onPick(t.key)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
            active === t.key
              ? "border-foreground font-semibold"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && (
            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Nothing to show, said in a way that distinguishes the reasons. */
export function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className="px-3 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
