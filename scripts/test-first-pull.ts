/**
 * Brian's first pull must not know Eric's exists.
 *
 *   pnpm exec tsx scripts/test-first-pull.ts        (needs DATABASE_URL)
 *
 * "Brian's first pull should not interact with Eric's pull at all — want to
 * ensure that Eric's data is completely different than Brian's. This
 * includes DB data."
 *
 * It did interact, in the worst way available: his first import, a correct
 * and current export of his own Needs Review, was REFUSED. Every step of
 * the run came back green — signed in, filtered, 320 items, $18,289.08 —
 * and then the import said his newest expense was older than ones already
 * stored and told him to re-run the export he had just run. The expenses it
 * was comparing against were Eric's.
 *
 * Three guards in the import ask "have we seen this before", and the answer
 * is only ever about one reviewer's queue and one Emburse list:
 *
 *   - stale export      — the newest expense we hold FOR THEM
 *   - duplicate file    — a file THEY have already imported
 *   - truncation fence  — the share of THEIR waiting expenses it would take
 *
 * The third was already scoped. This is the test for the other two, driving
 * the real `ingestExport` with synthetic parses so the guards are tested
 * where they sit rather than as a copy of their arithmetic.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const { ingestExport } = await import("../server/import/ingest.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

await ensureSchema();

const TAG = `zz-first-${Date.now()}`;
const ERIC = "eric.s@test.invalid";
const BRIAN = "brian.c@test.invalid";

const clean = async () => {
  await db().query("DELETE FROM expenses WHERE employee LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expense_imports WHERE filename LIKE $1", [`${TAG}%`]);
};
await clean();

const expense = (who: string, date: string, n: number) => ({
  employee: `${TAG} ${who}`,
  merchant: `MERCHANT ${n}`,
  note: "",
  date,
  method: "Corporate Card",
  receiptLabel: "yes",
  location: "Corporate",
  department: "Operations",
  category: "Meals",
  amountCents: 1000 + n,
  sourcePage: 1,
});

/** A parse of three expenses for one person, newest on `date`. */
const parseOf = (who: string, date: string) => {
  const expenses = [0, 1, 2].map((i) => expense(who, date, i));
  return {
    expenses,
    receipts: [],
    statedTotalCents: expenses.reduce((a, e) => a + e.amountCents, 0),
    header: null,
    pageCount: 1,
  };
};

let serial = 0;
const run = (
  who: string,
  date: string,
  opts: { reviewer: string; source?: string; hash?: string },
) =>
  ingestExport(Buffer.from(""), `${TAG}-${who}-${date}.pdf`, "test", {
    parsed: parseOf(who, date) as never,
    fileHash: opts.hash ?? `${TAG}-${++serial}`,
    sectionsVerified: true,
    reviewer: opts.reviewer,
    source: opts.source ?? "",
  });

const held = async (who: string) =>
  Number((await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM expenses WHERE employee = $1", [`${TAG} ${who}`])).rows[0]!.n);

try {
  console.log("\n1. Eric imports first, and his is the newest data in the table");
  const eric = await run("Eric", "2026-09-29", { reviewer: ERIC });
  check("it lands", eric.importId !== null, eric.warnings.join(" | ").slice(0, 160));
  check("three of his are waiting", (await held("Eric")) === 3, String(await held("Eric")));

  console.log("\n2. Brian's FIRST pull, a day older than Eric's, is imported");
  // The whole point. Nothing about Eric's queue can say anything about
  // whether Brian's export is current — they are different Emburse
  // accounts holding different expenses.
  const brian = await run("Brian", "2026-09-28", { reviewer: BRIAN });
  check("it is not refused as stale", brian.importId !== null,
    brian.warnings.join(" | ").slice(0, 200));
  check("…and no warning claims it is older than something",
    !brian.warnings.some((w) => /older than one already imported/.test(w)),
    brian.warnings.join(" | ").slice(0, 160));
  check("…three of his are waiting", (await held("Brian")) === 3, String(await held("Brian")));
  check("…and all three of Eric's are still there", (await held("Eric")) === 3,
    String(await held("Eric")));

  console.log("\n3. Brian's own older export IS refused");
  // The guard still has to work. It is just his own data it works against.
  const back = await run("Brian", "2026-09-27", { reviewer: BRIAN });
  check("nothing was imported", back.importId === null);
  check("…and it says why", back.warnings.some((w) => /older than one already imported/.test(w)),
    back.warnings.join(" | ").slice(0, 160));
  check("…his queue is untouched", (await held("Brian")) === 3, String(await held("Brian")));

  console.log("\n4. The same file is a duplicate for its own reviewer, not for the other");
  {
    const shared = `${TAG}-same-bytes`;
    const mine = await run("Dup", "2026-09-29", { reviewer: ERIC, hash: shared });
    check("Eric's import of it lands", mine.importId !== null);
    const theirs = await run("Dup", "2026-09-29", { reviewer: BRIAN, hash: shared });
    check("Brian importing the same bytes is NOT called a duplicate",
      theirs.duplicateFile === false, theirs.warnings.join(" | ").slice(0, 160));
    const again = await run("Dup", "2026-09-29", { reviewer: ERIC, hash: shared });
    check("…but Eric re-uploading it is", again.duplicateFile === true);
  }

  console.log("\n5. Transactions and Reimbursements are separate timelines too");
  // Same argument one level along: his reimbursements export knows nothing
  // about the dates on his transactions.
  {
    const reimb = await run("Brian", "2026-09-26",
      { reviewer: BRIAN, source: "reimbursements" });
    check("an older reimbursements export still imports", reimb.importId !== null,
      reimb.warnings.join(" | ").slice(0, 160));
  }

  console.log("\n6. The same expenses in two exports do not change hands");
  // The one that was actually happening. Both accounts read the team-wide
  // tab with no per-person filter, so both exports carry the SAME rows —
  // Eric's run and Brian's first run each read 320 items, $18,289.08. Under
  // "last import wins" every import moved all of them to whoever had just
  // run, so the queue changed hands on a timer.
  {
    const held = async (who: string) =>
      Number((await db().query<{ n: string }>(
        "SELECT count(*) AS n FROM expenses WHERE employee = $1 AND reviewer = $2",
        [`${TAG} Both`, who])).rows[0]!.n);

    const first = await run("Both", "2026-09-29", { reviewer: ERIC });
    check("Eric's import brings them in", first.inserted === 3, String(first.inserted));
    check("…and they are his", (await held(ERIC)) === 3, String(await held(ERIC)));

    const second = await run("Both", "2026-09-29", { reviewer: BRIAN });
    check("Brian's export carries the very same expenses", second.importId !== null);
    // The line this exists for.
    check("…and they STAY Eric's", (await held(ERIC)) === 3, String(await held(ERIC)));
    check("…none of them moved to Brian", (await held(BRIAN)) === 0, String(await held(BRIAN)));
    check("…and the import says so rather than hiding it",
      second.warnings.some((w) => /already in another reviewer's queue/.test(w)),
      second.warnings.join(" | ").slice(0, 200));
    check("…naming the shared-list cause when the match is total",
      second.warnings.some((w) => /both Emburse accounts are reading the same list/.test(w)),
      second.warnings.join(" | ").slice(0, 240));
  }

  console.log("\n7. Every import row records whose it was");
  {
    const { rows } = await db().query<{ reviewer: string; source: string; n: string }>(
      `SELECT reviewer, source, count(*) AS n FROM expense_imports
        WHERE filename LIKE $1 GROUP BY reviewer, source ORDER BY reviewer, source`,
      [`${TAG}%`]);
    check("Eric's imports are stamped with his email",
      rows.some((r) => r.reviewer === ERIC && r.source === ""));
    check("Brian's with his", rows.some((r) => r.reviewer === BRIAN && r.source === ""));
    check("…and the reimbursements one with the list it came from",
      rows.some((r) => r.reviewer === BRIAN && r.source === "reimbursements"));
    check("nothing was recorded against nobody",
      !rows.some((r) => r.reviewer === ""), JSON.stringify(rows));
  }
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
