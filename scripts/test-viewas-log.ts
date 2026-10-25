/**
 * View-as sessions, kept apart from the rest of the trail.
 *
 *   pnpm exec tsx scripts/test-viewas-log.ts
 *
 * Three ways this goes wrong quietly:
 *
 *   The bracketing events leak into the other views, so a page of
 *   fifty "things that happened" is really forty-eight plus the
 *   footprints of somebody looking — and the COUNT disagrees with the
 *   rows beneath it.
 *
 *   Pairing by "the next end for the same two addresses", which is
 *   wrong the first time one person is viewed twice in an afternoon
 *   and produces a confident, invented duration.
 *
 *   What an administrator DID inside a view getting swept into the
 *   session tab with the session metadata, where nobody
 *   investigating would ever find it.
 */
import { audit, listEvents, listViewAsSessions } from "../server/dutch-miller/audit.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const BOSS = "va-boss@example.invalid";
const DEALER = "va-dealer@example.invalid";
const IP = "203.0.113.90";

try {
  console.log("1. A complete session pairs up");
  await audit({
    action: "viewas.started", subject: DEALER, actor: BOSS, actorReal: BOSS,
    resource: "sid-one", ip: IP, occurredAt: new Date(Date.now() - 30 * 60_000),
  });
  await audit({
    action: "viewas.ended", subject: DEALER, actor: BOSS, actorReal: BOSS,
    resource: "sid-one", ip: IP, occurredAt: new Date(Date.now() - 25 * 60_000),
  });
  const one = (await listViewAsSessions({ who: BOSS })).find((s) => s.sid === "sid-one");
  check("the session is there", Boolean(one));
  check("…naming the administrator", one?.administrator === BOSS);
  check("…and who they were wearing", one?.viewed === DEALER);
  check("…with an end", one?.endedAt !== null);
  check("…and a duration of five minutes",
    one?.durationSeconds === 300, String(one?.durationSeconds));

  console.log("\n2. A session with no end is said to have no end");
  await audit({
    action: "viewas.started", subject: DEALER, actor: BOSS, actorReal: BOSS,
    resource: "sid-open", ip: IP,
  });
  const open = (await listViewAsSessions({ who: BOSS })).find((s) => s.sid === "sid-open");
  check("it is listed", Boolean(open));
  // A view left open, or ended by a cookie quietly expiring, genuinely
  // has no end event. Inventing one would be the worst kind of wrong:
  // confident and unfalsifiable.
  check("…with NO end time invented", open?.endedAt === null);
  check("…and no duration guessed", open?.durationSeconds === null);

  console.log("\n3. Two views of the same person do not get muddled");
  /*
   * The case that breaks "pair with the next end for this pair of
   * addresses". Same administrator, same viewed account, twice.
   */
  const base = Date.now() - 10 * 60_000;
  await audit({
    action: "viewas.started", subject: DEALER, actor: BOSS, actorReal: BOSS,
    resource: "sid-a", ip: IP, occurredAt: new Date(base),
  });
  await audit({
    action: "viewas.started", subject: DEALER, actor: BOSS, actorReal: BOSS,
    resource: "sid-b", ip: IP, occurredAt: new Date(base + 60_000),
  });
  // Ends arrive in the OPPOSITE order to the starts.
  await audit({
    action: "viewas.ended", subject: DEALER, actor: BOSS, actorReal: BOSS,
    resource: "sid-b", ip: IP, occurredAt: new Date(base + 120_000),
  });
  await audit({
    action: "viewas.ended", subject: DEALER, actor: BOSS, actorReal: BOSS,
    resource: "sid-a", ip: IP, occurredAt: new Date(base + 600_000),
  });
  const all = await listViewAsSessions({ who: BOSS });
  const a = all.find((s) => s.sid === "sid-a");
  const b = all.find((s) => s.sid === "sid-b");
  check("both are listed", Boolean(a) && Boolean(b));
  check("the first ran ten minutes", a?.durationSeconds === 600, String(a?.durationSeconds));
  check("…and the second one minute", b?.durationSeconds === 60, String(b?.durationSeconds));

  console.log("\n4. The bracketing events are OUT of every other view");
  const views = ["all", "security", "access", "business"] as const;
  for (const category of views) {
    const { rows, total } = await listEvents({ category, who: BOSS, days: 1 });
    const leaked = rows.filter((r) => r.action.startsWith("viewas."));
    check(`${category}: no session metadata`, leaked.length === 0,
      leaked.map((r) => r.action).join(","));
    // And the COUNT too. A total that disagrees with the rows beneath
    // it is worse than either number on its own.
    check(`${category}: the count agrees`, total === rows.length,
      `${total} vs ${rows.length}`);
  }

  console.log("\n5. What they DID while viewing stays in the general views");
  // The distinction the whole split turns on.
  await audit({
    action: "signup.opened", subject: DEALER, actor: DEALER, actorReal: BOSS,
    resource: "some-guid", ip: IP,
  });
  const business = await listEvents({ category: "business", who: BOSS, days: 1 });
  const act = business.rows.find((r) => r.action === "signup.opened");
  check("the action is in Business activity", Boolean(act));
  check("…attributed to the account they wore", act?.actor === DEALER);
  check("…AND to the real administrator", act?.actorReal === BOSS);
  check("…and it is not in the sessions tab",
    !(await listViewAsSessions({ who: BOSS })).some((s) => s.sid === "some-guid"));

  console.log("\n6. Either account finds the session");
  check("searching by the administrator",
    (await listViewAsSessions({ who: BOSS })).length >= 4);
  check("…and by the person viewed",
    (await listViewAsSessions({ who: DEALER })).length >= 4);
  check("somebody uninvolved finds nothing",
    (await listViewAsSessions({ who: "nobody@example.invalid" })).length === 0);
} finally {
  await db().query("DELETE FROM dm_audit WHERE ip = $1", [IP]).catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
