/**
 * A category change is a record, not a button press.
 *
 * "Have Send to Emburse persist after clicking out of this pop up." The
 * first version ran the whole thing inside the request — sign in, find the
 * row, edit, save, check, about a minute — and reported back to the
 * component that started it. Close the drawer and the work carried on with
 * nobody to tell, so the one thing worth knowing, did it take, was lost.
 *
 * Needs DATABASE_URL. Cleans up after itself.
 */

import { db } from "../server/db.js";
import {
  clearFailedCorrections, correctionReport, correctionsFor, pendingCorrections,
  queueCorrection, retryFailedCorrections, settleCorrection,
} from "../server/emburse/corrections.js";

const TAG = `zz-corr-${Date.now()}`;
const KEY = `${TAG}-exxon`;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM category_corrections WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
};

try {
  // The table before anything tries to tidy it.
  await correctionsFor([]);
  await clean();
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,'Horace Mitchell','2026-09-28','ExxonMobil',8307,
             'Travel - Mileage & Ground Transportation','Operations and Field',
             'Corporate-Mammoth','Gas for travel','Corporate Card',true)`, [KEY]);

  console.log("\n1. Asking for one writes it down");
  const asked = await queueCorrection({
    dedupeKey: KEY, from: "Travel - Mileage & Ground Transportation",
    to: "Auto Fee & Fuel", requestedBy: "eric.s@mammothholdings.com",
  });
  check("it is accepted", asked.ok === true);
  check("…and waiting", (await pendingCorrections()).some((c) => c.dedupeKey === KEY));
  // The whole point: the record outlives whatever asked for it.
  const seen = await correctionsFor([KEY]);
  check("…and the queue can see it without the drawer being open",
    seen.get(KEY)?.state === "pending" && seen.get(KEY)?.to === "Auto Fee & Fuel",
    JSON.stringify(seen.get(KEY)));
  check("…and it remembers what the category WAS",
    seen.get(KEY)?.from === "Travel - Mileage & Ground Transportation");

  console.log("\n2. Two at once is refused, not raced");
  // Two runs editing the same row in the same minute is a race over
  // somebody's finance record.
  const again = await queueCorrection({
    dedupeKey: KEY, from: "x", to: "Meals", requestedBy: "someone.else@mammothholdings.com",
  });
  check("the second is refused", again.ok === false);
  check("…naming what is already happening and who asked",
    again.ok === false && /Auto Fee & Fuel/.test(again.error) && /eric\.s@/.test(again.error),
    again.ok === false ? again.error : "");

  console.log("\n3. A failure survives to be read");
  const id = (asked.ok ? asked.correction.id : 0);
  await settleCorrection(id, {
    ok: false,
    error: 'no Category control on the edit form matched "[role=combobox]". What IS on the form: ' +
           "input role=combobox aria-label=Merchant | select name=gl_code",
  }, [{ name: "correct the category", ok: false, detail: "no Category control matched" }]);
  const failed = (await correctionsFor([KEY])).get(KEY);
  check("it is failed, with the reason kept", failed?.state === "failed" && !!failed?.error);
  check("…and nothing is left waiting",
    !(await pendingCorrections()).some((c) => c.dedupeKey === KEY));

  console.log("\n4. The file somebody can send on");
  const md = await correctionReport();
  check("names the expense", /ExxonMobil/.test(md));
  check("…what was asked for", /Auto Fee & Fuel/.test(md));
  check("…what Emburse said back", /What IS on the form/.test(md));
  // The reason this file exists rather than a toast: a correction fails
  // because a selector no longer matches, and the fix is in Export settings.
  check("…and where the fix goes", /Export settings/.test(md));
  check("…with the run step by step", /step by step/.test(md));

  console.log("\n4b. Asking again, exactly as it was asked");
  /*
   * Six corrections failed in one morning on one cause — a ⋮ the run
   * could not find. Nothing about any of them was wrong; the app's
   * ability to carry them out was. The only way back was to reopen each
   * row's picker and choose the same category again, six times, from a
   * list of dozens.
   */
  {
    const mine = (await correctionsFor([KEY])).get(KEY);
    check("it is sitting there failed", mine?.state === "failed", mine?.state);

    const again = await retryFailedCorrections("somebody.else@test.invalid");
    check("it is asked for again", again === 1, String(again));

    const now = (await correctionsFor([KEY])).get(KEY);
    check("…as pending", now?.state === "pending", now?.state);
    check("…to the same category", now?.to === mine?.to, `${now?.to} vs ${mine?.to}`);
    // The one thing that must not drift. Emburse records a category change
    // against whichever account makes it, so retrying under the person who
    // pressed the button would put the wrong name on somebody's record.
    check("…and under the ORIGINAL requester, not whoever pressed it",
      now?.requestedBy === mine?.requestedBy, `${now?.requestedBy} vs ${mine?.requestedBy}`);

    // Idempotent: one already on its way is not asked for twice.
    check("asking again while it is in flight does nothing",
      (await retryFailedCorrections("somebody.else@test.invalid")) === 0);

    // Put it back to failed for the clearing section below.
    const pend = (await pendingCorrections()).find((c) => c.dedupeKey === KEY);
    if (pend) await settleCorrection(pend.id, { ok: false, error: "still cannot find the menu" });
  }

  console.log("\n5. Clearing puts it down without touching Emburse");
  check("one is cleared", await clearFailedCorrections("eric.s@mammothholdings.com") >= 1);
  check("…and the queue stops offering it",
    (await correctionsFor([KEY])).get(KEY) === undefined);
  check("…so the row can be corrected again",
    (await queueCorrection({ dedupeKey: KEY, from: "", to: "Meals", requestedBy: "eric.s@mammothholdings.com" })).ok);
  check("…and nothing is left failing",
    /No failed corrections/.test(await correctionReport()));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
