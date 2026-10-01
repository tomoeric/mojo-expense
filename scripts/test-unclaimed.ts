/**
 * Ownership of unclaimed rows must not move when somebody's export works.
 *
 *   pnpm exec tsx scripts/test-unclaimed.ts        (needs DATABASE_URL)
 *
 * "He is showing that he still sees Eric's tickets." He was, and the cause
 * was the one thing nobody would look at: ownership of the rows no import
 * had claimed followed `(last_ok_at IS NOT NULL) DESC, last_ok_at DESC` —
 * the credential most recently PROVEN TO WORK.
 *
 * That is a sensible way to pick a login and a disastrous way to decide
 * whose expenses are whose, because it moves. Brian's first export
 * succeeded at 3:40pm. That gave his credential the newest last_ok_at,
 * which made him the shared importer, which handed him every unclaimed row
 * in the table — all of Eric's. A successful import of his own queue took
 * Eric's expenses away from Eric and gave them to Brian, in silence.
 *
 * So the rule never drifts now, and the unclaimed rows can be settled for
 * good rather than re-derived on every request.
 */

process.env.SESSION_SECRET ||= "test-secret-for-credentials";

import { db, ensureSchema } from "../server/db.js";
import {
  claimUnclaimed, deleteCredential, noteResult, saveCredential, scopeFor,
  sharedImporter, unclaimedExpenses,
} from "../server/emburse/credentials.js";
import { setFlagOwner } from "../server/flags.js";

const ERIC = "eric.s@test.invalid";
const BRIAN = "brian.c@test.invalid";
const TAG = `zz-unclaimed-${Date.now()}`;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await deleteCredential(ERIC).catch(() => false);
  await deleteCredential(BRIAN).catch(() => false);
  await db().query("DELETE FROM app_flags WHERE key = 'importAs'").catch(() => undefined);
};

/** Place (or re-place) a row in somebody's queue, as an import would. */
const add = (n: number, reviewer: string) =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox, reviewer)
     VALUES ($1,'Someone','2026-09-24','MERCHANT',1000,'Meals','Ops','Site','','Card',true,$2)
     ON CONFLICT (dedupe_key) DO UPDATE SET
       in_inbox = true,
       -- The import's own rule: the first reviewer to claim a row keeps it,
       -- and a row nobody holds goes to whoever turns up.
       reviewer = CASE WHEN expenses.reviewer = ''
                       THEN EXCLUDED.reviewer ELSE expenses.reviewer END`,
    [`${TAG}-${n}`, reviewer]);

/** What this person would be shown, by the one rule that decides it. */
const sees = async (who: string): Promise<number> => {
  const { reviewer, ownsBlanks } = await scopeFor(who);
  const { rows } = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM expenses
      WHERE dedupe_key LIKE $1 AND (reviewer = $2 OR (reviewer = '' AND $3))`,
    [`${TAG}%`, reviewer, ownsBlanks]);
  return Number(rows[0]?.n ?? 0);
};

await ensureSchema();

try {
  await clean();
  // Three rows from before the app recorded whose queue they came from.
  for (const n of [1, 2, 3]) await add(n, "");

  console.log("\nOne login: they own the unclaimed rows, as they always have");
  await saveCredential(ERIC, ERIC, ERIC, "pw-eric");
  check("the only login is the shared importer", (await sharedImporter()) === ERIC);
  check("…and sees all three", (await sees(ERIC)) === 3, String(await sees(ERIC)));

  console.log("\nA second login arrives and its first export SUCCEEDS");
  // The exact sequence from the report: Brian stores a login, runs his
  // first export, and it works.
  await saveCredential(BRIAN, BRIAN, BRIAN, "pw-brian");
  await noteResult(BRIAN, true, null, false);
  {
    // The line this test exists for.
    check("Brian sees none of Eric's", (await sees(BRIAN)) === 0, String(await sees(BRIAN)));
    check("…and succeeding did not make him the owner",
      (await sharedImporter()) !== BRIAN, String(await sharedImporter()));
    check("…nobody is guessed at while two could be meant",
      (await sharedImporter()) === null, String(await sharedImporter()));
    check("…so Eric is not shown them either, rather than the wrong person being",
      (await sees(ERIC)) === 0, String(await sees(ERIC)));
  }

  console.log("\nThe app says there is something to settle");
  {
    const u = await unclaimedExpenses();
    check("it counts them", u.count >= 3, String(u.count));
    check("…says nobody holds them", u.owner === null);
    check("…and offers both logins", u.candidates.includes(ERIC) && u.candidates.includes(BRIAN));
  }

  console.log("\nNaming an owner settles it without touching a row");
  await setFlagOwner("importAs", ERIC);
  {
    check("Eric has them back", (await sees(ERIC)) === 3, String(await sees(ERIC)));
    check("…and Brian still has none", (await sees(BRIAN)) === 0, String(await sees(BRIAN)));
    // And it STAYS settled, whoever signs in next.
    await noteResult(BRIAN, true, null, false);
    check("…and another successful export by Brian changes nothing",
      (await sees(BRIAN)) === 0 && (await sees(ERIC)) === 3);
  }

  console.log("\nClaiming writes it into the rows, so nothing has to decide again");
  {
    const n = await claimUnclaimed(ERIC);
    check("all three are stamped", n === 3, String(n));
    await db().query("DELETE FROM app_flags WHERE key = 'importAs'");
    check("…and they are still Eric's with nobody named", (await sees(ERIC)) === 3,
      String(await sees(ERIC)));
    check("…and still not Brian's", (await sees(BRIAN)) === 0, String(await sees(BRIAN)));
    check("…and nothing is left unclaimed", (await unclaimedExpenses()).count === 0);
  }

  console.log("\nClaiming cannot take an expense off another reviewer");
  {
    await add(9, BRIAN);
    await claimUnclaimed(ERIC);
    check("Brian's row is still Brian's", (await sees(BRIAN)) === 1, String(await sees(BRIAN)));
  }

  console.log("\nStarting ownership over takes them back off everybody");
  // The state this exists for: one import, made while the export was still
  // reading the team-wide list, claimed every row. The other reviewer's
  // queue is empty and no import of theirs can refill it, because an
  // expense belongs to the FIRST reviewer who imported it and theirs sees
  // a row somebody already holds.
  {
    await clean();
    await saveCredential(ERIC, ERIC, ERIC, "pw-eric");
    await saveCredential(BRIAN, BRIAN, BRIAN, "pw-brian");
    for (const n of [1, 2, 3]) await add(n, BRIAN);
    check("Brian holds all three", (await sees(BRIAN)) === 3, String(await sees(BRIAN)));
    check("…and Eric has nothing", (await sees(ERIC)) === 0, String(await sees(ERIC)));

    const n = await claimUnclaimed("", "reset");
    check("the reset unstamps them", n === 3, String(n));
    check("…so nobody holds them", (await unclaimedExpenses()).held.length === 0);
    // Nothing is deleted — that is the whole difference between this and
    // starting again.
    const { rows } = await db().query<{ n: string }>(
      "SELECT count(*) AS n FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
    check("…and all three expenses are still there", Number(rows[0]!.n) === 3, rows[0]!.n);

    // And the next import to carry one claims it, because blank loses to
    // whoever turns up: that is how each reviewer gets their own back.
    await add(1, ERIC);
    check("Eric's import claims the one his export carries", (await sees(ERIC)) === 1,
      String(await sees(ERIC)));
    check("…and the other two are still nobody's",
      (await unclaimedExpenses()).count >= 2, String((await unclaimedExpenses()).count));
  }

  console.log("\nAnd it refuses somebody with no Emburse login at all");
  {
    await add(10, "");
    let said = "";
    await claimUnclaimed("nobody@test.invalid").catch((e: Error) => { said = e.message; });
    check("it refuses", /no Emburse login stored/.test(said), said.slice(0, 120));
  }
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
