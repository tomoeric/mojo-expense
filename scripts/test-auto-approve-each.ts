/**
 * Automatic approvals, one switch per reviewer.
 *
 *   pnpm exec tsx scripts/test-auto-approve-each.ts   (needs DATABASE_URL)
 *
 * "When does the auto approval kick on for Brian?" It did not, and could
 * not. There was one switch with one owner, and the sweep only ever touches
 * that owner's own queue — it has to, because an approval is applied by
 * signing in as them and another reviewer's rows are not in their Needs
 * Review. So the Configuration card correctly told somebody "whoever they
 * belong to has to switch this on for themselves", and there was nowhere in
 * the app to do it. 340 expenses and an instruction that could not be
 * followed.
 *
 * Each reviewer has their own switch now, off until somebody turns it on,
 * sweeping their own queue under their own login.
 */

process.env.SESSION_SECRET ||= "test-secret-each";

import { db, ensureSchema } from "../server/db.js";
import { deleteCredential, saveCredential } from "../server/emburse/credentials.js";
import { reviewerImports, setReviewerImport } from "../server/emburse/export-scheduler.js";

const ERIC = "eric.s@test.invalid";
const BRIAN = "brian.c@test.invalid";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM reviewer_imports WHERE user_email IN ($1,$2)", [ERIC, BRIAN]);
  await deleteCredential(ERIC).catch(() => false);
  await deleteCredential(BRIAN).catch(() => false);
};

const mine = async (who: string) =>
  (await reviewerImports()).find((r) => r.userEmail.toLowerCase() === who);

await ensureSchema();

try {
  await clean();
  await saveCredential(ERIC, ERIC, ERIC, "pw-eric");
  await saveCredential(BRIAN, BRIAN, BRIAN, "pw-brian");

  console.log("\nIt is off for everybody until somebody says otherwise");
  // The line that matters most here. This is the one path that approves
  // spending with no human in the loop; nobody's automation may start
  // because a column appeared.
  check("Eric's is off", (await mine(ERIC))?.autoApprove === false);
  check("Brian's is off", (await mine(BRIAN))?.autoApprove === false);

  console.log("\nBrian can have it on without Eric having it");
  await setReviewerImport(BRIAN, { autoApprove: true }, "test");
  check("Brian's is on", (await mine(BRIAN))?.autoApprove === true);
  check("…and Eric's is still off", (await mine(ERIC))?.autoApprove === false);

  console.log("\nAnd a per-pass number of his own");
  await setReviewerImport(BRIAN, { autoApprove: true, autoApprovePerRun: 25 }, "test");
  check("it is kept", (await mine(BRIAN))?.autoApprovePerRun === 25,
    String((await mine(BRIAN))?.autoApprovePerRun));

  console.log("\nSwitching it back off sticks");
  await setReviewerImport(BRIAN, { autoApprove: false }, "test");
  check("off again", (await mine(BRIAN))?.autoApprove === false);

  console.log("\nSaving an unrelated setting never switches it on");
  // The shape of the mistake worth guarding: a form that posts the grid
  // path and forgets the flag must not read as "approve everything".
  await setReviewerImport(BRIAN, { gridPath: "/transactions" }, "test");
  {
    const r = await mine(BRIAN);
    check("the path is saved", r?.gridPath === "/transactions", String(r?.gridPath));
    check("…and it is still off", r?.autoApprove === false);
  }
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
