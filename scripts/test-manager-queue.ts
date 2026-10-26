/**
 * The manager queue, per reviewer, on or off.
 *
 *   pnpm exec tsx scripts/test-manager-queue.ts
 *
 * The switch has to be NARROWER than the import switch, or it is just
 * a second way to do the same thing with a different name. What is
 * checked here is what it leaves alone:
 *
 *   Reimbursements is a separate page with its own queue and keeps
 *   running. Taking it down with the manager queue is the exact
 *   failure that made people switch off whole imports instead.
 *
 *   A reviewer pointed at their PERSONAL grid is not reading the
 *   manager queue at all, so switching it off must not stop them.
 *
 *   Default ON. A column appearing must never quietly stop an import
 *   that was running yesterday.
 */
import {
  MANAGER_GRID, gridPathFor, reviewerImports, setReviewerImport,
} from "../server/emburse/export-scheduler.js";
import { deleteCredential, saveCredential } from "../server/emburse/credentials.js";
import { readSettings } from "../server/import/settings.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const ERIC = "mq-eric@example.invalid";
const BRIAN = "mq-brian@example.invalid";
const MINE = [ERIC, BRIAN];
const BY = "owner@example.invalid";

/**
 * What the scheduler would actually run for somebody.
 *
 * The same two lines the tick uses, so this tests the real rule
 * rather than a restatement of it that can drift.
 */
const listsFor = async (email: string): Promise<string[]> => {
  const every = (await readSettings()).sources;
  const who = (await reviewerImports()).find((r) => r.userEmail === email);
  if (!who || !who.enabled) return [];
  return (who.sources
    ? every.filter((x) => who.sources!.includes(x.key))
    : every.filter((x) => x.enabled))
    .filter((x) => who.managerEnabled || gridPathFor(x.key, x, who) !== MANAGER_GRID)
    .map((x) => x.label);
};

try {
  // reviewerImports() is built from who has an Emburse login stored,
  // so the fixtures need one each. Not a real credential: the password
  // is sealed by saveCredential and never read back here.
  for (const e of MINE) {
    await saveCredential(`uid-${e}`, e, e, "not-a-real-password").catch((err) => {
      console.log("  (credential fixture failed)", (err as Error).message);
    });
  }

  console.log("1. On by default");
  const fresh = (await reviewerImports()).filter((r) => MINE.includes(r.userEmail));
  check("both reviewers are there", fresh.length === 2, String(fresh.length));
  // A column appearing must not stop an import that ran yesterday.
  check("…and nobody's manager queue was switched off by the column appearing",
    fresh.every((r) => r.managerEnabled));
  check("…so the manager list is in their run",
    (await listsFor(ERIC)).includes("Transactions"));

  console.log("\n2. Switching one off");
  await setReviewerImport(BRIAN, { managerEnabled: false }, BY);
  const after = await reviewerImports();
  check("it is off for them",
    after.find((r) => r.userEmail === BRIAN)?.managerEnabled === false);
  check("…and the manager list is out of their run",
    !(await listsFor(BRIAN)).includes("Transactions"),
    (await listsFor(BRIAN)).join(","));
  // One person at a time. Both reviewers reading one queue is the
  // thing this is for, so flipping one must not flip the other.
  check("the other reviewer is untouched",
    after.find((r) => r.userEmail === ERIC)?.managerEnabled === true);
  check("…and still runs it", (await listsFor(ERIC)).includes("Transactions"));

  console.log("\n3. It leaves everything else alone");
  const brian = after.find((r) => r.userEmail === BRIAN)!;
  // The reason this is not just `enabled`: switching the whole import
  // off takes the schedule, the other lists and the approvals with it.
  check("their import is still enabled", brian.enabled === true);
  check("…their schedule is untouched", Boolean(brian.schedule.firstRun));
  check("…and their automatic approvals are as they were",
    brian.autoApprove === false);

  console.log("\n4. Reimbursements keeps running");
  // A separate page with its own queue. Taking it down with the
  // manager queue is the failure that made people switch off whole
  // imports instead of one list.
  await setReviewerImport(BRIAN, { sources: ["", "reimbursements"] }, BY);
  const mixed = await listsFor(BRIAN);
  check("the manager list is still skipped", !mixed.includes("Transactions"), mixed.join(","));
  check("…and Reimbursements is not", mixed.includes("Reimbursements"), mixed.join(","));

  console.log("\n5. Somebody on the personal grid is not affected");
  // They are not reading the manager queue, so a switch about it must
  // not stop them importing.
  await setReviewerImport(ERIC, {
    gridPath: "/transactions", sources: [""], managerEnabled: false,
  }, BY);
  const personal = await listsFor(ERIC);
  check("their list still runs", personal.includes("Transactions"), personal.join(","));
  check("…because the grid they open is not the manager one",
    gridPathFor("", { path: MANAGER_GRID },
      (await reviewerImports()).find((r) => r.userEmail === ERIC)) !== MANAGER_GRID);

  console.log("\n6. Switching it back on");
  await setReviewerImport(BRIAN, { managerEnabled: true }, BY);
  check("it returns", (await listsFor(BRIAN)).includes("Transactions"));
} finally {
  await db().query("DELETE FROM reviewer_imports WHERE user_email = ANY($1::text[])", [MINE])
    .catch(() => {});
  for (const e of MINE) await deleteCredential(`uid-${e}`).catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
