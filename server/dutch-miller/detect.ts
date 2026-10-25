import { db, ensureSchema } from "../db.js";
import { SUSPICIOUS, type Severity } from "./event-catalog.js";

/**
 * Patterns worth a person's attention — and nothing stronger than that.
 *
 * Every rule here produces a CONCERN: a group of real events, a stated
 * threshold, and the count that met it. A concern is not a finding and
 * is never an incident. Only an investigator can conclude anything, in
 * `investigations.ts`, and nothing in this file may write that
 * conclusion.
 *
 * Three rules about honesty that the wording of each concern follows:
 *
 *   A single failure is never a concern. One expired link is a person
 *   coming back to an old email, and a product that calls that an
 *   attack teaches people to ignore it.
 *
 *   A successful sign-in after a run of failures is raised FOR REVIEW,
 *   not as proof of compromise. It is also exactly what somebody
 *   finally remembering their own email looks like.
 *
 *   An IP is a clue. A dealership is one office behind one address, so
 *   "many failures from one IP" is weak on its own and is only raised
 *   when it spans several different accounts.
 */

export const THRESHOLDS = {
  /** Refusals against ONE address before it is worth looking at. */
  failuresPerAddress: 5,
  /** Distinct addresses tried from one IP. Below this it is one office. */
  addressesPerIp: 4,
  /** Refused page or API requests by one signed-in account. */
  deniedPerActor: 10,
  /** Member exports by one person in the window. */
  exportsPerActor: 5,
  /** Hours the rules look back over. */
  windowHours: 24,
} as const;

export type Concern = {
  /** Stable for the same pattern over the same subject, so it can be deduped. */
  key: string;
  title: string;
  severity: Severity;
  /** The threshold in words, and what was actually counted. */
  rule: string;
  observed: string;
  count: number;
  first: string;
  last: string;
  /** The events behind it, so an investigation can point at them. */
  eventIds: string[];
  /** What this is NOT. Printed beside every concern, deliberately. */
  caveat: string;
};

type Grouped = {
  k: string; n: string; first: Date; last: Date; ids: (string | number)[];
};

const WINDOW = `at > now() - (${THRESHOLDS.windowHours} || ' hours')::interval`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> => (ready ??= ensureSchema());

/**
 * Every rule, run.
 *
 * Read-only: this writes nothing, raises no alert and sends no mail.
 * The page asks for it when somebody opens the page, which is the only
 * thing that should make a security view do work.
 */
export async function concerns(): Promise<Concern[]> {
  await ensure();
  const out: Concern[] = [];

  /* 1. A run of refusals against one address. */
  const byAddress = await db().query<Grouped>(
    `SELECT subject AS k, count(*) AS n, min(at) AS first, max(at) AS last,
            array_agg(id ORDER BY at DESC) AS ids
       FROM dm_audit
      WHERE action = ANY($1::text[]) AND subject <> '' AND ${WINDOW}
      GROUP BY subject HAVING count(*) >= ${THRESHOLDS.failuresPerAddress}
      ORDER BY count(*) DESC LIMIT 25`, [SUSPICIOUS]);
  for (const r of byAddress.rows) {
    out.push({
      key: `failures:${r.k}`,
      title: `${r.n} refused sign-in attempts for ${r.k}`,
      severity: Number(r.n) >= THRESHOLDS.failuresPerAddress * 3 ? "high" : "medium",
      rule: `${THRESHOLDS.failuresPerAddress} or more refusals against one address `
        + `in ${THRESHOLDS.windowHours} hours`,
      observed: `${r.n} refusals`,
      count: Number(r.n),
      first: r.first.toISOString(),
      last: r.last.toISOString(),
      eventIds: r.ids.slice(0, 100).map(String),
      caveat: "Also what somebody locked out of their own email looks like. "
        + "Check whether the attempts came from one place or many.",
    });
  }

  /* 2. One origin working through several different accounts. */
  const byIp = await db().query<Grouped & { addrs: string }>(
    `SELECT ip AS k, count(*) AS n, count(DISTINCT subject) AS addrs,
            min(at) AS first, max(at) AS last, array_agg(id ORDER BY at DESC) AS ids
       FROM dm_audit
      WHERE action = ANY($1::text[]) AND ip <> '' AND subject <> '' AND ${WINDOW}
      GROUP BY ip HAVING count(DISTINCT subject) >= ${THRESHOLDS.addressesPerIp}
      ORDER BY count(DISTINCT subject) DESC LIMIT 25`, [SUSPICIOUS]);
  for (const r of byIp.rows) {
    out.push({
      key: `spray:${r.k}`,
      title: `${r.addrs} different accounts tried from ${r.k}`,
      severity: "high",
      rule: `${THRESHOLDS.addressesPerIp} or more distinct addresses refused from one `
        + `origin in ${THRESHOLDS.windowHours} hours`,
      observed: `${r.addrs} addresses, ${r.n} refusals`,
      count: Number(r.addrs),
      first: r.first.toISOString(),
      last: r.last.toISOString(),
      eventIds: r.ids.slice(0, 100).map(String),
      caveat: "A whole dealership shares one address, so this can be several "
        + "colleagues on a bad morning. The addresses themselves are the evidence.",
    });
  }

  /*
   * 3. A sign-in that succeeded after that address had been failing.
   *
   * Raised for REVIEW. It is the shape of a successful guess and it is
   * equally the shape of somebody finally finding the right email, and
   * nothing here can tell those apart.
   */
  const after = await db().query<{
    k: string; n: string; first: Date; last: Date; ids: (string | number)[];
  }>(
    `WITH failed AS (
       SELECT subject, count(*) AS fails, max(at) AS last_fail
         FROM dm_audit
        WHERE action = ANY($1::text[]) AND subject <> '' AND ${WINDOW}
        GROUP BY subject HAVING count(*) >= ${THRESHOLDS.failuresPerAddress}
     )
     SELECT a.subject AS k, count(*) AS n, min(a.at) AS first, max(a.at) AS last,
            array_agg(a.id ORDER BY a.at DESC) AS ids
       FROM dm_audit a JOIN failed f ON f.subject = a.subject
      WHERE a.action IN ('signin.ok', 'login.ok', 'code.verified')
        AND a.at > f.last_fail - interval '1 hour'
        AND ${"a." + WINDOW}
      GROUP BY a.subject LIMIT 25`, [SUSPICIOUS]);
  for (const r of after.rows) {
    out.push({
      key: `after-failures:${r.k}`,
      title: `${r.k} signed in around a run of refusals`,
      severity: "medium",
      rule: "A successful sign-in within an hour of a refusal pattern for the "
        + "same address",
      observed: `${r.n} successful sign-in(s)`,
      count: Number(r.n),
      first: r.first.toISOString(),
      last: r.last.toISOString(),
      eventIds: r.ids.slice(0, 100).map(String),
      caveat: "FOR REVIEW ONLY. This is not evidence of compromise — it is also "
        + "exactly what somebody who eventually got their own code right looks like. "
        + "Confirm with the account holder.",
    });
  }

  /* 4. An account being refused pages or routes over and over. */
  const denied = await db().query<Grouped>(
    `SELECT actor AS k, count(*) AS n, min(at) AS first, max(at) AS last,
            array_agg(id ORDER BY at DESC) AS ids
       FROM dm_audit
      WHERE action = 'access.denied' AND actor <> '' AND ${WINDOW}
      GROUP BY actor HAVING count(*) >= ${THRESHOLDS.deniedPerActor}
      ORDER BY count(*) DESC LIMIT 25`);
  for (const r of denied.rows) {
    out.push({
      key: `denied:${r.k}`,
      title: `${r.k} was refused ${r.n} times`,
      severity: "medium",
      rule: `${THRESHOLDS.deniedPerActor} or more refused page or API requests by one `
        + `signed-in account in ${THRESHOLDS.windowHours} hours`,
      observed: `${r.n} refusals`,
      count: Number(r.n),
      first: r.first.toISOString(),
      last: r.last.toISOString(),
      eventIds: r.ids.slice(0, 100).map(String),
      caveat: "Often a stale browser tab or a bookmark to a page somebody's role "
        + "no longer covers. Worth a look when the routes vary.",
    });
  }

  /* 5. Unusual volume of member data leaving. */
  const exports = await db().query<Grouped>(
    `SELECT actor AS k, count(*) AS n, min(at) AS first, max(at) AS last,
            array_agg(id ORDER BY at DESC) AS ids
       FROM dm_audit
      WHERE action IN ('export.members', 'export.rfid') AND actor <> '' AND ${WINDOW}
      GROUP BY actor HAVING count(*) >= ${THRESHOLDS.exportsPerActor}
      ORDER BY count(*) DESC LIMIT 25`);
  for (const r of exports.rows) {
    out.push({
      key: `exports:${r.k}`,
      title: `${r.k} exported ${r.n} times`,
      severity: "low",
      rule: `${THRESHOLDS.exportsPerActor} or more exports by one person in `
        + `${THRESHOLDS.windowHours} hours`,
      observed: `${r.n} exports`,
      count: Number(r.n),
      first: r.first.toISOString(),
      last: r.last.toISOString(),
      eventIds: r.ids.slice(0, 100).map(String),
      caveat: "Usually somebody rebuilding a spreadsheet. Worth asking about when "
        + "it is not their normal job.",
    });
  }

  const order: Record<Severity, number> = {
    critical: 0, high: 1, medium: 2, low: 3, info: 4,
  };
  return out.sort((a, b) => order[a.severity] - order[b.severity]
    || b.last.localeCompare(a.last));
}

/**
 * What this application can and cannot see.
 *
 * Stated rather than implied, because the gap is the part that gets
 * people hurt: a security page that lists five sources looks complete,
 * and anything blocked before the request reached this process left no
 * trace here at all.
 */
export type CoverageSource = {
  name: string;
  connected: boolean;
  what: string;
  gap: string;
};

export function coverage(): CoverageSource[] {
  return [
    {
      name: "Application events",
      connected: true,
      what: "Sign-ins and refusals, invitations, account and role changes, "
        + "view-as sessions, exports, member and RFID activity, notifications.",
      gap: "Only requests that reached this process. Anything refused earlier "
        + "is invisible here.",
    },
    {
      name: "Sign-in throttling",
      connected: true,
      what: "Repeated failures per address, and the temporary refusal they trigger.",
      gap: "Counted per address, not per origin, so one origin trying many "
        + "addresses is caught by the detection rules rather than by the lockout.",
    },
    {
      name: "Microsoft Entra sign-in logs",
      connected: false,
      what: "Would show tenant sign-ins, conditional-access decisions and "
        + "multi-factor outcomes for staff accounts.",
      gap: "NOT CONNECTED. A staff sign-in refused by Microsoft before it reached "
        + "this app does not appear anywhere in this workspace.",
    },
    {
      name: "Hosting platform and WAF",
      connected: false,
      what: "Would show requests dropped at the edge, rate limiting, and "
        + "network-level blocking.",
      gap: "NOT CONNECTED. Scanning and probing that never reached the "
        + "application leaves no record here. The absence of events is not "
        + "evidence that nothing was attempted.",
    },
    {
      name: "TLS and network logs",
      connected: false,
      what: "Would show handshake failures and connection-level activity.",
      gap: "NOT CONNECTED, and not available to the application in any case.",
    },
  ];
}
