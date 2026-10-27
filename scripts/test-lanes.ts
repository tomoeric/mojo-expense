/**
 * Three tabs for one person, and nothing shared between them.
 *
 *   pnpm exec tsx scripts/test-lanes.ts
 *
 * Eric has a manager queue and two personal Emburse accounts. Each
 * is a separate import, and the failures worth protecting against
 * are all the ones where they quietly turn out to be the same
 * import wearing three labels:
 *
 *   A SETTING CHANGED ON ONE TAB LANDING ON ANOTHER. The row was
 *   keyed on the person, so a second account had nowhere to put its
 *   own stages, lists, receipt filter or schedule.
 *
 *   THE MANAGER TAB MOVING. Every row that already exists is the
 *   manager tab, by the column's default, and the brief says that
 *   queue must not change. A new personal tab must not take its
 *   settings, its history or its place in the schedule.
 *
 *   A TAB WITH NO ACCOUNT LINKED RUNNING ANYWAY. It can only fail,
 *   twenty minutes apart, filling a tab somebody has not finished
 *   setting up with failures that read like a broken import rather
 *   than a missing password.
 *
 *   ONE TAB SPENDING ANOTHER'S ATTEMPTS. A day allows a few runs;
 *   three tabs sharing that budget means the first one read uses it
 *   and the other two never update.
 */
import {
  ensureSchedulerSchema, localDate, nextDue, recentRuns, reviewerImports,
  setReviewerImport,
} from "../server/emburse/export-scheduler.js";
import {
  MANAGER_LANE, addConnection, credentialForLaneOf, lanesFor, linkedLanesOf,
} from "../server/emburse/connections.js";
import { deleteCredential, saveCredential } from "../server/emburse/credentials.js";
import { db, ensureSchema } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const ID = "test-lanes-user";
const APP = "eric.s@mojocarwash.com";
const MAMMOTH = "eric.s@mammothholdings.com";
const MOJO_LANE = "personal-mojo";
const MAM_LANE = "personal-mammoth";

await ensureSchema();
await ensureSchedulerSchema();

try {
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID]);
  await db().query("DELETE FROM reviewer_imports WHERE user_email = $1", [APP]);
  await db().query("DELETE FROM export_runs WHERE reviewer = $1", [APP]);

  console.log("1. The connection that exists today is the manager tab's");
  await saveCredential(ID, APP, MAMMOTH, "mammoth-password");
  let mine = (await reviewerImports()).filter((r) => r.userEmail.toLowerCase() === APP);
  check("all three tabs are offered", mine.length === 3,
    mine.map((r) => r.laneLabel).join(" · "));
  const mgr = mine.find((r) => r.lane === MANAGER_LANE)!;
  const mojo = mine.find((r) => r.lane === MOJO_LANE)!;
  const mam = mine.find((r) => r.lane === MAM_LANE)!;
  check("the manager tab is connected", mgr.connected);
  check("the Mammoth tab is connected, by its address", mam.connected,
    mam.laneLoginEmail);
  check("THE MOJO TAB IS NOT, and says why",
    !mojo.connected && mojo.connectionProblem.includes(APP), mojo.connectionProblem);
  check("…and is OFF until it is, rather than failing every twenty minutes",
    mojo.enabled === false);
  check("the manager tab is on", mgr.enabled === true);

  console.log("\n2. A setting on one tab does not land on another");
  await setReviewerImport(APP, { lane: MOJO_LANE, gridQuery: "?reviewer=mojo" }, "test");
  await setReviewerImport(APP, { lane: MAM_LANE, receiptsOnly: true }, "test");
  await setReviewerImport(APP, { gridPath: "/transactions/team" }, "test");
  mine = (await reviewerImports()).filter((r) => r.userEmail.toLowerCase() === APP);
  const got = (lane: string) => mine.find((r) => r.lane === lane)!;
  check("the MOJO tab kept its filter", got(MOJO_LANE).gridQuery === "?reviewer=mojo");
  check("…and did NOT get the Mammoth tab's receipt filter",
    got(MOJO_LANE).receiptsOnly === null, String(got(MOJO_LANE).receiptsOnly));
  check("the Mammoth tab kept its receipt filter", got(MAM_LANE).receiptsOnly === true);
  check("…and did NOT get the MOJO tab's filter", got(MAM_LANE).gridQuery === null);
  check("THE MANAGER TAB KEPT ITS OWN GRID",
    got(MANAGER_LANE).gridPath === "/transactions/team");
  check("…and neither personal tab took it",
    got(MOJO_LANE).gridPath === null && got(MAM_LANE).gridPath === null);

  console.log("\n3. Each tab has its own schedule slot");
  const slots = mine.map((r) => r.staggeredBy);
  check("no two tabs share one", new Set(slots).size === slots.length, slots.join(", "));

  console.log("\n4. A personal tab signs in as ITS OWN Emburse account");
  const added = await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "mojo-password", label: "MOJO",
  });
  check("the MOJO account is stored", added.ok === true, added.ok ? "" : added.problem);
  const mojoCred = await credentialForLaneOf(APP, MOJO_LANE);
  check("the MOJO tab gets the MOJO password",
    mojoCred.ok && mojoCred.password === "mojo-password");
  const mamCred = await credentialForLaneOf(APP, MAM_LANE);
  check("the Mammoth tab gets the MAMMOTH password",
    mamCred.ok && mamCred.password === "mammoth-password");
  check("…which are not the same one",
    mojoCred.ok && mamCred.ok && mojoCred.password !== mamCred.password);
  check("the MOJO tab is on now that it is linked",
    (await reviewerImports()).find(
      (r) => r.userEmail.toLowerCase() === APP && r.lane === MOJO_LANE)?.enabled === true);

  console.log("\n5. One tab's attempts are not another's");
  const schedule = {
    timezone: "America/Chicago", firstRun: "02:00", retryHours: 4,
    attemptsPerDay: 1, graceMinutes: 90, allDay: false,
  };
  const day = (await nextDue(schedule, new Date(), APP, "", MOJO_LANE));
  check("the MOJO tab has an attempt available", day.attempt === 1, day.reason);
  // A run recorded against ONE tab, on the schedule's OWN local
  // date — the count is per local day, and `now()` in UTC is the
  // day before in Chicago for six hours of every one.
  await db().query(
    `INSERT INTO export_runs (local_date, attempt, trigger, reviewer, source, lane, ok)
     VALUES ($3, 1, 'scheduled', $1, '', $2, true)`,
    [APP, MOJO_LANE, localDate(schedule)]);
  const afterMojo = await nextDue(schedule, new Date(), APP, "", MOJO_LANE);
  check("…and it is spent once a run lands", afterMojo.due === false, afterMojo.reason);
  const stillMam = await nextDue(schedule, new Date(), APP, "", MAM_LANE);
  check("THE MAMMOTH TAB STILL HAS ITS OWN", stillMam.attempt === 1, stillMam.reason);
  const stillMgr = await nextDue(schedule, new Date(), APP, "", "");
  check("…and so does the manager tab", stillMgr.attempt === 1, stillMgr.reason);

  console.log("\n6. Each tab's history is its own");
  const all = await recentRuns(20, APP);
  const justMojo = await recentRuns(20, APP, MOJO_LANE);
  const justMam = await recentRuns(20, APP, MAM_LANE);
  check("the run shows in the MOJO tab", justMojo.length === 1, String(justMojo.length));
  check("…and NOT in the Mammoth tab", justMam.length === 0, String(justMam.length));
  check("…and the unfiltered list still has it", all.length >= 1);
  check("…tagged with the tab it belongs to", justMojo[0]?.lane === MOJO_LANE);

  console.log("\n7. A tab nobody has is refused rather than quietly created");
  const theirs = await lanesFor(APP);
  check("there are exactly three", theirs.length === 3);
  const bogus = await credentialForLaneOf(APP, "personal-invented");
  check("an invented tab has no credential", bogus.ok === false,
    bogus.ok ? "" : bogus.problem);

  console.log("\n8. Somebody with one Emburse account still has one tab");
  await saveCredential("test-lanes-solo", "solo@mojocarwash.com", "solo@example.com", "x");
  const solo = (await reviewerImports())
    .filter((r) => r.userEmail.toLowerCase() === "solo@mojocarwash.com");
  check("one tab, the manager one", solo.length === 1 && solo[0]!.lane === MANAGER_LANE,
    solo.map((r) => r.laneLabel).join(", "));
  check("…and it is on", solo[0]?.enabled === true);
  check("…and connected", solo[0]?.connected === true);

} finally {
  await deleteCredential(ID).catch(() => undefined);
  await db().query("DELETE FROM emburse_credentials WHERE user_id = ANY($1::text[])",
    [[ID, "test-lanes-solo"]]).catch(() => undefined);
  await db().query("DELETE FROM reviewer_imports WHERE user_email = ANY($1::text[])",
    [[APP, "solo@mojocarwash.com"]]).catch(() => undefined);
  await db().query("DELETE FROM export_runs WHERE reviewer = $1", [APP])
    .catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
