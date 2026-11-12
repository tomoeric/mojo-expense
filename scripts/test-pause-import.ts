/**
 * Pausing an import stops the clock and keeps the settings.
 *
 *   pnpm exec tsx scripts/test-pause-import.ts
 *
 * Asked for as *"how to temporary turn off the auto and import
 * functions"*. The field has always existed and the API has always
 * accepted it; nothing on the settings page ever set it. So the only
 * way to stop a scheduled import was to empty its settings — untick
 * its stages, its lists, its schedule — which is not a pause, it is a
 * dismantling, and putting it back afterwards is from memory.
 *
 * Temporary is the whole point, so what is checked here is that the
 * settings SURVIVE it.
 */
import { MANAGER_LANE } from "../server/emburse/connections.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const { db, ensureSchema } = await import("../server/db.js");
const { reviewerImports, setReviewerImport, importFor } =
  await import("../server/emburse/export-scheduler.js");
const { addConnection } = await import("../server/emburse/connections.js");

await ensureSchema();
const WHO = "zz-pause@mojocarwash.com";

try {
  await db().query("DELETE FROM reviewer_imports WHERE user_email = $1", [WHO])
    .catch(() => undefined);
  await db().query("DELETE FROM emburse_credentials WHERE user_email = $1", [WHO])
    .catch(() => undefined);
  await addConnection({
    userId: "zz-pause", userEmail: WHO, loginEmail: WHO, password: "pw", label: "MOJO",
  }).catch(() => undefined);

  // Settings worth keeping: the stages and the lists somebody chose.
  await setReviewerImport(WHO, {
    lane: MANAGER_LANE,
    sections: ["Needs Review", "Needs Manager Review"],
    receiptsOnly: true,
  }, "test");

  const mine = () => importFor(WHO, MANAGER_LANE);

  console.log("1. It starts running, as it always has");
  check("the import is on", (await mine())?.enabled === true,
    String((await mine())?.enabled));

  console.log("\n2. Pausing takes it out of the scheduler's list");
  await setReviewerImport(WHO, { lane: MANAGER_LANE, enabled: false }, "test");
  check("it reads as off", (await mine())?.enabled === false,
    String((await mine())?.enabled));
  {
    // The scheduler skips a row that is off — `if (!who.enabled) continue`.
    const due = (await reviewerImports()).filter((r) => r.userEmail === WHO && r.enabled);
    check("…so the scheduler has nothing to run for them", due.length === 0,
      `${due.length} row(s) still due`);
  }

  console.log("\n3. AND THE SETTINGS SURVIVE IT — that is what makes it a pause");
  {
    const row = await mine();
    check("the stages are still theirs",
      JSON.stringify(row?.sections) === JSON.stringify(["Needs Review", "Needs Manager Review"]),
      JSON.stringify(row?.sections));
    check("…and the receipts-only choice", row?.receiptsOnly === true,
      String(row?.receiptsOnly));
  }

  console.log("\n4. Unpausing puts it straight back");
  await setReviewerImport(WHO, { lane: MANAGER_LANE, enabled: true }, "test");
  {
    const row = await mine();
    check("it runs again", row?.enabled === true, String(row?.enabled));
    check("…with the same settings it had",
      JSON.stringify(row?.sections) === JSON.stringify(["Needs Review", "Needs Manager Review"])
      && row?.receiptsOnly === true,
      `${JSON.stringify(row?.sections)} / ${String(row?.receiptsOnly)}`);
  }
} catch (err) {
  /*
   * A THROW IS A FAILURE, not a quiet exit.
   *
   * Without this the finally below printed PASS and exited 0 for a run
   * that had not reached a single check — the worst possible result,
   * because it looks exactly like success.
   */
  failures += 1;
  console.log(`  FAIL the test threw — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await db().query("DELETE FROM reviewer_imports WHERE user_email = $1", [WHO])
    .catch(() => undefined);
  await db().query("DELETE FROM emburse_credentials WHERE user_email = $1", [WHO])
    .catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
