/**
 * The event trail, the detection rules, and what may call something an
 * incident.
 *
 *   pnpm exec tsx scripts/test-events.ts
 *
 * Four things here are the difference between a security log and a
 * list, and each fails silently:
 *
 *   Redaction. A log that records the credential is a credential store
 *   with a nicer name, and the failure is invisible until somebody
 *   reads the log.
 *
 *   Append-only. An investigator's conclusion must never be able to
 *   alter the evidence it was drawn from.
 *
 *   Successful sign-ins are RECORDED and searchable, and kept out of
 *   the triage feed. Dropping them entirely is what left the old log
 *   unable to answer "did the attempt eventually work?".
 *
 *   No rule may call anything a confirmed incident. Only a person can.
 */
import {
  audit, listEvents, listSecurityLog, metaFor, redact, collectionHealth,
} from "../server/dutch-miller/audit.js";
import { AUDIT_ACTIONS, SUSPICIOUS, actionsIn } from "../server/dutch-miller/event-catalog.js";
import { concerns, coverage } from "../server/dutch-miller/detect.js";
import {
  getInvestigation, listInvestigations, openInvestigation, updateInvestigation,
} from "../server/dutch-miller/investigations.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const TAG = "evt-test@example.invalid";
const IP = "203.0.113.77";
const MADE: string[] = [];

try {
  console.log("1. Every action is classified");
  const unknown = AUDIT_ACTIONS.filter((a) => metaFor(a).label.includes("does not recognise"));
  check("no action falls through to unknown", unknown.length === 0, unknown.join(","));
  check("an action nobody has heard of still reads as unknown rather than throwing",
    metaFor("made.up").outcome === "unknown");
  check("the three categories partition the catalogue",
    AUDIT_ACTIONS.length
      === new Set([...actionsIn("security"), ...actionsIn("access"), ...actionsIn("business")]).size,
    `${AUDIT_ACTIONS.length}`);
  // The triage feed is BLOCKED security events. A successful sign-in in
  // it would bury the four that matter under nine hundred that do not.
  check("the triage feed is refusals only",
    SUSPICIOUS.every((a) => metaFor(a).outcome === "blocked"));
  check("…so a successful sign-in is not in it", !SUSPICIOUS.includes("signin.ok"));
  check("…but it IS in the catalogue", AUDIT_ACTIONS.includes("signin.ok"));

  console.log("\n2. Secrets never reach the log");
  check("a token in free text is removed",
    !redact("link token=abcdefghijklmnopqrstuvwxyz012345").includes("abcdefgh"));
  check("a long opaque string is removed",
    redact("saw 7f3a9b2c1d4e5f60718293a4b5c6d7e8f9").includes("[redacted]"));
  check("a query string carrying one is removed",
    !redact("GET /dm/login?t=supersecretvalue").includes("supersecretvalue"));
  check("…and ordinary words survive",
    redact("Dana Reyes · RFID 12345+678901") === "Dana Reyes · RFID 12345+678901",
    redact("Dana Reyes · RFID 12345+678901"));
  // The path is where a one-time link would actually end up.
  await audit({
    action: "login.rejected", subject: TAG, ip: IP,
    path: "GET /api/dm/login?token=abcdefghijklmnop",
    detail: "link expired",
  });
  const first = (await listEvents({ who: TAG, days: 1 })).rows[0];
  check("a query string is stripped from the recorded route",
    !(first?.path ?? "").includes("token"), first?.path ?? "");

  console.log("\n3. Both identities survive a view");
  await audit({
    action: "signup.opened", actor: "dealer@example.invalid",
    actorReal: "boss@example.invalid", resource: "res-1", ip: IP,
  });
  const viewed = (await listEvents({ who: "boss@example.invalid", days: 1 })).rows[0];
  check("the effective actor is kept", viewed?.actor === "dealer@example.invalid");
  check("…and so is the person at the keyboard",
    viewed?.actorReal === "boss@example.invalid");
  check("…and searching for either finds it",
    (await listEvents({ who: "dealer@example.invalid", days: 1 })).rows.length > 0);

  console.log("\n4. Successful sign-ins are recorded AND searchable");
  await audit({ action: "signin.ok", subject: TAG, ip: IP, detail: "Microsoft SSO" });
  check("it is in the trail",
    (await listEvents({ who: TAG, days: 1 })).rows.some((r) => r.action === "signin.ok"));
  check("…and out of the refusals feed",
    !(await listSecurityLog({ days: 1 })).some((r) => r.action === "signin.ok"));
  check("…and findable by itself",
    (await listEvents({ action: "signin.ok", days: 1 })).rows.length > 0);

  console.log("\n5. One failure is never a concern");
  const quiet = await concerns();
  check("a single refusal raises nothing",
    !quiet.some((c) => c.key === `failures:${TAG}`),
    quiet.map((c) => c.key).join(","));
  // Five is the stated threshold, so four must still be quiet.
  for (let i = 0; i < 3; i++) {
    await audit({ action: "code.failed", subject: TAG, ip: IP, detail: "wrong code" });
  }
  check("…nor do four", !(await concerns()).some((c) => c.key === `failures:${TAG}`));
  await audit({ action: "code.failed", subject: TAG, ip: IP, detail: "wrong code" });
  const raised = (await concerns()).find((c) => c.key === `failures:${TAG}`);
  check("five does", Boolean(raised));
  check("…and says which rule and what it counted",
    (raised?.rule ?? "").includes("5") && (raised?.observed ?? "").includes("5"),
    `${raised?.rule} / ${raised?.observed}`);
  check("…and points at the real events", (raised?.eventIds.length ?? 0) >= 5);
  check("…and says what it is NOT", (raised?.caveat ?? "").length > 20);

  console.log("\n6. Nothing automatic calls anything an incident");
  const all = await concerns();
  check("no concern claims a confirmed incident",
    !all.some((c) => /confirmed|breach|hacked/i.test(`${c.title} ${c.rule} ${c.observed}`)),
    all.map((c) => c.title).join(" | "));
  // A sign-in after a run of failures is the one that would tempt it.
  await audit({ action: "login.ok", subject: TAG, ip: IP, detail: "emailed link" });
  const review = (await concerns()).find((c) => c.key === `after-failures:${TAG}`);
  check("a sign-in after failures IS raised", Boolean(review));
  check("…for review, explicitly, not as proof",
    (review?.caveat ?? "").toUpperCase().includes("FOR REVIEW"),
    review?.caveat ?? "");
  check("…at medium, not critical", review?.severity === "medium");

  console.log("\n6b. The other product's events stay out of this log");
  /*
   * One deployment, two products, one table — and two security logs.
   * An Emburse API route being refused is not a Dutch Miller matter,
   * and a dealer administrator should not have to wade past it.
   */
  await audit({
    action: "access.denied", app: "emburse", subject: TAG, ip: IP,
    path: "GET /api/expenses", detail: "app emburse",
  });
  await audit({
    action: "access.denied", app: "dutch-miller", subject: TAG, ip: IP,
    path: "GET /api/dutch-miller/roles", detail: "account administrator only",
  });
  const mine = (await listEvents({ who: TAG, days: 1 })).rows;
  check("the other product's refusal is not here",
    !mine.some((r) => r.app === "emburse"),
    mine.filter((r) => r.app === "emburse").map((r) => r.path).join(","));
  check("…and no Emburse route is mentioned at all",
    !mine.some((r) => r.path.includes("/api/expenses")));
  check("this product's refusal IS here",
    mine.some((r) => r.action === "access.denied" && r.app === "dutch-miller"));
  check("…and shared sign-in events still are",
    mine.some((r) => r.action === "signin.ok"));
  // The count has to agree with the rows, or neither is believed.
  const scoped = await listEvents({ who: TAG, days: 1 });
  check("the total matches what is shown",
    scoped.total === scoped.rows.length, `${scoped.total} vs ${scoped.rows.length}`);
  check("the refusals feed is scoped too",
    !(await listSecurityLog({ days: 1 })).some((r) => r.app === "emburse"));
  // Nothing was deleted: it is the other log's business, not nobody's.
  const kept = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_audit WHERE app = 'emburse' AND ip = $1", [IP]);
  check("…but the event is still recorded", Number(kept.rows[0]?.n ?? 0) === 1);

  console.log("\n7. Missing coverage is stated, not implied");
  const sources = coverage();
  check("upstream sources are listed as NOT connected",
    sources.some((s) => !s.connected && /NOT CONNECTED/.test(s.gap)));
  check("…and the app's own gap is admitted",
    sources.some((s) => s.connected && /reached this process/i.test(s.gap)));
  const health = await collectionHealth();
  check("collection health counts what is there", health.total > 0);

  console.log("\n8. An investigation cannot rewrite the evidence");
  const before = (await listEvents({ who: TAG, days: 1 })).rows;
  const made = await openInvestigation({
    title: "Repeated refusals for the test address",
    by: "boss@example.invalid",
    eventIds: before.slice(0, 3).map((e) => e.id),
    evidence: "5 refusals in the window",
  });
  MADE.push(made.id);
  check("it opens as new", made.status === "new");
  check("…unclassified", made.classification === "unclassified");
  check("…pointing at events by id", made.eventIds.length === 3);
  const after = (await listEvents({ who: TAG, days: 1 })).rows;
  check("THE EVENTS ARE UNCHANGED",
    JSON.stringify(before.map((e) => [e.id, e.action, e.detail]))
      === JSON.stringify(after.map((e) => [e.id, e.action, e.detail])));

  console.log("\n9. Closing one needs a conclusion");
  const bare = await updateInvestigation({
    id: made.id, by: "boss@example.invalid", status: "resolved",
  });
  check("resolving with no reason is refused", bare.ok === false);
  const claim = await updateInvestigation({
    id: made.id, by: "boss@example.invalid", classification: "confirmed-incident",
  });
  check("…and so is calling it an incident with no reason", claim.ok === false);
  const done = await updateInvestigation({
    id: made.id, by: "boss@example.invalid", status: "false-positive",
    resolution: "Account holder confirmed they were using an old bookmark.",
    note: "Rang the dealership.",
  });
  check("with one, it closes", done.ok === true);
  const full = await getInvestigation(made.id);
  check("…and it is marked closed", Boolean(full?.closedAt));
  check("…by whom", full?.closedBy === "boss@example.invalid");
  check("…with every change in its own trail",
    (full?.notes?.length ?? 0) >= 2, String(full?.notes?.length));
  check("…naming what changed",
    (full?.notes ?? []).some((n) => n.change.includes("status")));
  check("it is listed under its status",
    (await listInvestigations({ status: "false-positive" })).some((c) => c.id === made.id));
} finally {
  await db().query("DELETE FROM dm_investigations WHERE id = ANY($1::bigint[])",
    [MADE.map(Number)]).catch(() => {});
  await db().query(
    `DELETE FROM dm_audit
      WHERE subject = $1 OR actor = $2 OR actor_real = $2 OR resource = 'res-1'`,
    [TAG, "boss@example.invalid"]).catch(() => {});
  await db().query("DELETE FROM dm_audit WHERE ip = $1", [IP]).catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
