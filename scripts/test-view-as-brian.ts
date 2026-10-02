/**
 * Viewing as Brian: his login, his automation, his receipts.
 *
 *   pnpm exec tsx scripts/test-view-as-brian.ts   (needs DATABASE_URL)
 *
 * "Want to verify that when I view as for Brian that it logs in for him,
 * and Eric can view receipts being auto approved and AI reviewing
 * receipts."
 *
 * Three separate claims, each of which has been wrong at some point:
 *
 *  1. An import started from inside the view signs into Emburse as BRIAN
 *     and is stamped as his, while the log still names the admin who
 *     pressed it. It used to sign in as whoever had most recently
 *     succeeded.
 *  2. The automatic-approval card inside the view is HIS — his switch, his
 *     eligible count, his reasons.
 *  3. The receipt-reading backlog inside the view is HIS. This one was
 *     still wrong: `readingBacklog()` counted every blob in the
 *     deployment, so an admin viewing as Brian watched Eric's 300-odd
 *     receipts being read under Brian's name.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret-view-as-brian";
process.env.EMBURSE_PROFILE_DIR = `/tmp/mojo-viewas-${Date.now()}`;
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "15000";
process.env.EMBURSE_SIGN_IN_WAIT_MS ||= "25000";

const { startMock } = await import("./mock-emburse.js");
const mock = await startMock(5415, "/dev/null");
process.env.EMBURSE_LOGIN_URL = mock.url;

const { db, ensureSchema } = await import("../server/db.js");
const { deleteCredential, saveCredential } = await import("../server/emburse/credentials.js");
const { attemptExport, recentRuns } = await import("../server/emburse/export-scheduler.js");
const { autoApproveReport } = await import("../server/rules/auto-approve.js");
const { readingBacklog } = await import("../server/emburse/receipt-items.js");
const { readSettings, writeSettings } = await import("../server/import/settings.js");

const ERIC = "eric.s@test.invalid";
const BRIAN = "brian.c@test.invalid";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM expense_receipts WHERE dedupe_key LIKE 'va-%'");
  await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE 'va-%'");
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE 'va-%'");
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'va-%'");
  await db().query("DELETE FROM export_runs WHERE reviewer IN ($1,$2)", [ERIC, BRIAN]);
  await db().query("DELETE FROM reviewer_imports WHERE user_email IN ($1,$2)", [ERIC, BRIAN]);
  await deleteCredential(ERIC).catch(() => false);
  await deleteCredential(BRIAN).catch(() => false);
};

/** One expense, owned by somebody, optionally with a receipt waiting to be read. */
async function expense(
  key: string, reviewer: string, opts: { receipt?: boolean; read?: boolean } = {},
): Promise<void> {
  await db().query(
    `INSERT INTO expenses (dedupe_key, reviewer, employee, merchant, amount_cents,
                           expense_date, category)
     VALUES ($1,$2,'Someone','A Shop',1000,'2026-09-01','Meals')
     ON CONFLICT (dedupe_key) DO UPDATE SET reviewer = EXCLUDED.reviewer`,
    [key, reviewer]);
  if (!opts.receipt) return;
  const sha = `va-${key}`;
  await db().query(
    `INSERT INTO receipt_blobs (sha256, bytes, byte_size, content_type)
     VALUES ($1, '\\x00'::bytea, 1, 'image/png') ON CONFLICT (sha256) DO NOTHING`, [sha]);
  await db().query(
    `INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`, [key, sha]);
  if (opts.read) {
    await db().query(
      `INSERT INTO receipt_readings (sha256, model, attempts, error)
       VALUES ($1, 'test', 1, NULL) ON CONFLICT (sha256) DO NOTHING`, [sha]);
  }
}

await ensureSchema();

/** The settings as they were, restored at the end. */
let was = await readSettings();

try {
  await clean();
  // Two accounts with two DIFFERENT passwords, so "which login signed in"
  // has a checkable answer rather than a plausible one.
  await saveCredential(ERIC, ERIC, ERIC, "eric-password");
  await saveCredential(BRIAN, BRIAN, BRIAN, "brian-password");

  // The stored settings carry the Emburse address, and they outrank the
  // environment — so without this the run goes to the real spend.emburse.com
  // and fails on the network instead of proving anything.
  was = await readSettings();
  await writeSettings(was.sections, was.receiptsOnly, was.schedule, was.selectors,
    mock.url, "test", was.sources);

  console.log("\n1. An import started inside the view signs in as Brian");
  {
    // Exactly what POST /api/export-run does inside a view: the reviewer is
    // the person being VIEWED, the log line names the real admin, and the
    // code prompt belongs to the admin because they are the one at a screen.
    const { id } = await attemptExport("manual", `${ERIC} (for ${BRIAN})`, {
      dryRun: true, reviewer: BRIAN, startedBy: ERIC,
    });

    const who = await fetch(`${mock.url}/__state`).then((r) => r.json())
      .then((s: { whoami?: string }) => s.whoami).catch(() => null);
    check("Emburse was signed into as Brian", who === BRIAN, String(who));
    check("…not as Eric", who !== ERIC, String(who));

    const run = (await recentRuns(5, BRIAN)).find((r) => r.id === id);
    check("the run is recorded as Brian's", run?.reviewer === BRIAN, run?.reviewer);
    const signIn = run?.steps.find((s) => s.name === "sign in");
    check("…and the sign-in step names him", (signIn?.detail ?? "").includes(BRIAN),
      run?.steps.map((x) => `${x.ok ? "ok" : "XX"} ${x.name}: ${x.detail}`).join(" | "));
    // A dry run stops before exporting, so nothing of Brian's was touched.
    check("…and nothing was exported", !run?.steps.some((s) => s.name === "start the export"));
  }

  console.log("\n2. Eric sees BRIAN's automatic approvals inside the view");
  await expense("va-b1", BRIAN);
  await expense("va-b2", BRIAN);
  await expense("va-e1", ERIC);
  await expense("va-e2", ERIC);
  await expense("va-e3", ERIC);
  {
    // What `/api/flags/autoApprove/report` passes: the viewed person inside
    // a view, null outside one.
    const his = await autoApproveReport(BRIAN);
    const hers = await autoApproveReport(ERIC);
    check("his card counts his queue", his.counts.inbox === 2, String(his.counts.inbox));
    check("…and not Eric's as well", his.counts.inbox < hers.counts.inbox,
      `${his.counts.inbox} vs ${hers.counts.inbox}`);
    check("…and Eric's counts only his three", hers.counts.inbox === 3,
      String(hers.counts.inbox));
    // The card also names the other reviewer and their share, so an admin
    // can see at a glance that the rest of the queue is somebody else's.
    check("…and his card names Eric's share",
      his.others.some((o) => o.reviewer.toLowerCase() === ERIC && o.count === 3),
      JSON.stringify(his.others));
    check("…and it says whose it is", (his.owner ?? "").toLowerCase() === BRIAN,
      String(his.owner));
    check("Eric's own card is still Eric's", (hers.owner ?? "").toLowerCase() === ERIC,
      String(hers.owner));
  }

  console.log("\n3. And BRIAN's receipts being read, not the deployment's");
  // Brian: one receipt waiting. Eric: four waiting. A global count shows
  // five under Brian's name and makes his queue look stuck when it is one
  // receipt from done.
  await expense("va-b3", BRIAN, { receipt: true });
  await expense("va-b4", BRIAN, { receipt: true, read: true });
  for (const k of ["va-e4", "va-e5", "va-e6", "va-e7"]) {
    await expense(k, ERIC, { receipt: true });
  }
  {
    const his = await readingBacklog(BRIAN);
    const hers = await readingBacklog(ERIC);
    const all = await readingBacklog();
    check("Brian has one receipt waiting", his.waiting === 1, String(his.waiting));
    check("…Eric has four", hers.waiting === 4, String(hers.waiting));
    check("…and the unscoped total is still everybody's",
      all.waiting >= his.waiting + hers.waiting, String(all.waiting));
    check("a read receipt is not counted as waiting", his.waiting !== 2, String(his.waiting));
  }
} finally {
  // Put the address back. It is one shared settings row, and a test that
  // leaves the mock's URL in it breaks the next one that reads it.
  await writeSettings(was.sections, was.receiptsOnly, was.schedule, was.selectors,
    was.emburseUrl, "test", was.sources).catch(() => {});
  await clean();
  await mock.close();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
