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
  PERSONAL_GRID, attemptExport, ensureSchedulerSchema, gridPathFrom, localDate, nextDue,
  recentRuns, reviewerImports, setReviewerImport,
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
  const got = (lane: string) => mine.find((r) => r.lane === lane)!;
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

  console.log("\n2. A personal tab starts pointed at the right place");
  /*
   * Both of these defaulted the wrong way, and both are silent.
   *
   * The grid: null means "inherit", and the shared default is
   * the TEAM grid — so a personal tab arrived reading the
   * approver's queue, which is the opposite of what it is.
   *
   * The receipt filter: "Receipts: true" is right for the
   * manager queue, where an expense with no receipt is not yet
   * worth reviewing, and exactly backwards on a personal tab —
   * the expenses that need a receipt FOUND are the ones with
   * none attached, so the filter removes precisely the rows the
   * mailbox search exists to serve.
   */
  // Against the constant, not a literal. This said "/transactions" and
  // that turned out to be a 404 on the real tenant — the personal list is
  // "/transactions/me" — so a literal here just has to be chased every
  // time the truth about a tenant changes.
  check("a personal tab reads the person's own expenses",
    got(MOJO_LANE).gridPath === PERSONAL_GRID, String(got(MOJO_LANE).gridPath));
  check("…and so does the other one",
    got(MAM_LANE).gridPath === PERSONAL_GRID, String(got(MAM_LANE).gridPath));
  check("THE MANAGER TAB STILL INHERITS, as it always did",
    got(MANAGER_LANE).gridPath === null, String(got(MANAGER_LANE).gridPath));
  check("a personal tab does NOT filter out receiptless expenses",
    got(MOJO_LANE).receiptsOnly === false, String(got(MOJO_LANE).receiptsOnly));
  check("…and the manager tab still inherits that too",
    got(MANAGER_LANE).receiptsOnly === null, String(got(MANAGER_LANE).receiptsOnly));
  /*
   * And no SECTION filter, for the same reason one level along.
   * The shared default is "inbox" — Emburse's Needs Review, the
   * approver's stage. Asked of a personal list on a tenant that
   * has no such section there, the page comes back with no grid
   * on it: "/transactions did not load", after which the run went
   * hunting for a team-wide list to read instead. Empty string,
   * not null, because null means inherit.
   */
  check("a personal tab asks for no section at all",
    got(MOJO_LANE).gridSection === "", JSON.stringify(got(MOJO_LANE).gridSection));
  check("…and the manager tab still inherits the approver's stage",
    got(MANAGER_LANE).gridSection === null, JSON.stringify(got(MANAGER_LANE).gridSection));

  console.log("\n3. A setting on one tab does not land on another");
  await setReviewerImport(APP, { lane: MOJO_LANE, gridQuery: "?reviewer=mojo" }, "test");
  await setReviewerImport(APP, { lane: MAM_LANE, receiptsOnly: true }, "test");
  await setReviewerImport(APP, { gridPath: "/transactions/team" }, "test");
  mine = (await reviewerImports()).filter((r) => r.userEmail.toLowerCase() === APP);
  check("the MOJO tab kept its filter", got(MOJO_LANE).gridQuery === "?reviewer=mojo");
  // Its own default, not the Mammoth tab's explicit `true`. The
  // assertion is about not taking the other tab's value, so it
  // tests that rather than a literal that moved when the
  // personal default did.
  check("…and did NOT get the Mammoth tab's receipt filter",
    got(MOJO_LANE).receiptsOnly === false, String(got(MOJO_LANE).receiptsOnly));
  check("the Mammoth tab kept its receipt filter", got(MAM_LANE).receiptsOnly === true);
  check("…and did NOT get the MOJO tab's filter", got(MAM_LANE).gridQuery === null);
  check("THE MANAGER TAB KEPT ITS OWN GRID",
    got(MANAGER_LANE).gridPath === "/transactions/team");
  check("…and neither personal tab took it",
    got(MOJO_LANE).gridPath !== "/transactions/team"
    && got(MAM_LANE).gridPath !== "/transactions/team",
    `${got(MOJO_LANE).gridPath} / ${got(MAM_LANE).gridPath}`);

  console.log("\n4. Each tab has its own schedule slot");
  const slots = mine.map((r) => r.staggeredBy);
  check("no two tabs share one", new Set(slots).size === slots.length, slots.join(", "));

  console.log("\n5. A personal tab signs in as ITS OWN Emburse account");
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

  console.log("\n6. One tab's attempts are not another's");
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

  console.log("\n7. Each tab's history is its own");
  const all = await recentRuns(20, APP);
  const justMojo = await recentRuns(20, APP, MOJO_LANE);
  const justMam = await recentRuns(20, APP, MAM_LANE);
  check("the run shows in the MOJO tab", justMojo.length === 1, String(justMojo.length));
  check("…and NOT in the Mammoth tab", justMam.length === 0, String(justMam.length));
  check("…and the unfiltered list still has it", all.length >= 1);
  check("…tagged with the tab it belongs to", justMojo[0]?.lane === MOJO_LANE);

  console.log("\n8. A tab nobody has is refused rather than quietly created");
  const theirs = await lanesFor(APP);
  check("there are exactly three", theirs.length === 3);
  const bogus = await credentialForLaneOf(APP, "personal-invented");
  check("an invented tab has no credential", bogus.ok === false,
    bogus.ok ? "" : bogus.problem);

  console.log("\n9. Somebody with one Emburse account still has one tab");
  await saveCredential("test-lanes-solo", "solo@mojocarwash.com", "solo@example.com", "x");
  const solo = (await reviewerImports())
    .filter((r) => r.userEmail.toLowerCase() === "solo@mojocarwash.com");
  check("one tab, the manager one", solo.length === 1 && solo[0]!.lane === MANAGER_LANE,
    solo.map((r) => r.laneLabel).join(", "));
  check("…and it is on", solo[0]?.enabled === true);
  check("…and connected", solo[0]?.connected === true);

  /*
   * A PERSONAL TAB POINTED AT THE TEAM LIST IS REFUSED BEFORE A BROWSER OPENS.
   *
   * This is what the fault looked like from outside: the right login, the
   * team-view step correctly skipped because the tab is personal — and then
   * the grid opened at /transactions/team anyway, because that path was
   * stored on the tab. Emburse answers an account that is not an approver of
   * that tenant with the nav and an empty main area, so the run waited out
   * its timeout and reported "the grid did not appear, tried the grid
   * selector and the item-count line", offering to fix four selectors that
   * were perfectly right.
   *
   * No browser is launched by this check, which is why it is testable here:
   * it runs while resolving the list, before anything is opened.
   */
  console.log("\n10. A personal tab on the team list is refused, with the reason");
  await setReviewerImport(APP, { lane: MOJO_LANE, gridPath: "/transactions/team" }, "test");
  const refused = await attemptExport("manual", "test", { reviewer: APP, lane: MOJO_LANE });
  const why = refused.run.steps.find((st) => !st.ok)?.detail
    ?? refused.run.steps.map((st) => st.detail).join(" ");
  check("the run does not go ahead", refused.run.ok === false);
  check("…it names the list it was pointed at",
    why.includes("/transactions/team"), why);
  /*
   * AND WHICH OF THE THREE SETTINGS CHOSE IT.
   *
   * "The run opened /transactions/team" is not a diagnosis: the tab's
   * Scope, the list's shared path and a dry-run probe can each say it, and
   * they are on three different parts of the page. Without this, looking
   * at the right setting and finding it already correct is indistinguish-
   * able from looking at the wrong one — which cost two rounds.
   */
  check("…and WHICH setting chose that path", /this tab's Scope setting/.test(why), why);
  check("…and says plainly that the selectors are not the problem",
    /not a selector problem/i.test(why), why);
  // The sign-in step is green on every one of these runs, and reading a
  // stopped run as "it cannot log in" is the wrong place to start looking.
  check("…and that the sign-in was not the problem either",
    /not a sign-in problem/i.test(why), why);

  // The other way to the same path: a NAMED list brings its own page, and
  // the tab's Scope does not apply to it. Same refusal, different sentence,
  // because the setting to change is somewhere else entirely.
  const named = gridPathFrom("reimbursements", { path: "/reimbursements/team" },
    { gridPath: "/transactions" });
  check("a named list says the path came from the shared default",
    named.path === "/reimbursements/team" && /under Defaults/.test(named.from), named.from);
  // And a tab whose settings could not be read at all must say THAT, rather
  // than looking like a tab somebody pointed at the team queue.
  const unread = gridPathFrom("", { path: "/transactions/team" }, undefined);
  check("…and an unreadable tab says its settings could not be read",
    /could not be read/.test(unread.from), unread.from);
  // It must not have got as far as a browser: the point is that this is
  // answered in milliseconds rather than after a 60-second timeout.
  check("…without opening Emburse at all",
    !refused.run.steps.some((st) => st.name === "open Emburse"),
    refused.run.steps.map((st) => st.name).join(" → ") || "(no steps)");
  // And it is a STEP, not only an error column: a run with no steps renders
  // as a stopped run with nothing to open, and the step list is where
  // somebody looks for the reason.
  check("…as a step somebody can open, like every other stop",
    refused.run.steps.length === 1 && refused.run.steps[0]!.ok === false,
    refused.run.steps.map((st) => st.name).join(" → ") || "(no steps)");
  const stored = await recentRuns(5, APP, MOJO_LANE);
  check("…and the same sentence is on the run itself",
    /this tab's Scope setting/.test(stored[0]?.error ?? ""),
    stored[0]?.error ?? "(no error)");

  // And the same tab, set correctly, gets past this check — so the refusal
  // is about the path and not about personal tabs in general.
  await setReviewerImport(APP, { lane: MOJO_LANE, gridPath: "/transactions" }, "test");
  const allowed = await attemptExport("manual", "test", { reviewer: APP, lane: MOJO_LANE });
  const stopped = allowed.run.steps.find((st) => !st.ok)?.detail ?? "";
  check("a correctly pointed personal tab is NOT refused",
    !/not a selector problem/.test(stopped), stopped.slice(0, 120));

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
