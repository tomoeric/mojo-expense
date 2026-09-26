/**
 * A short export must not be allowed to wipe the queue.
 *
 *   pnpm exec tsx scripts/test-truncated-export.ts     (needs DATABASE_URL)
 *
 * Deleting what the newest export no longer carries is the right rule, and it
 * makes a truncated export a destructive event rather than a thin day. A file
 * holding 5 rows where yesterday held 137 reconciles against its own TOTAL
 * line, is not a duplicate, and is not stale — none of the existing guards
 * see it. And the receipts it would delete can never be fetched again: an
 * expense out of the inbox is out of every future export too.
 *
 * So: refuse when a file would take more than four in five of the waiting
 * expenses, warn above half, and never get in the way of a small queue or of
 * somebody who has looked and said go.
 *
 * Drives the real `ingestExport` with a synthetic parse, so the fence is
 * tested where it sits rather than as a copy of its arithmetic.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const { ingestExport } = await import("../server/import/ingest.js");
const { dedupeKey } = await import("../server/import/key.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();

const TAG = `zz-trunc-${Date.now()}`;
const clean = async () => {
  await db().query("DELETE FROM expenses WHERE employee LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expense_imports WHERE filename LIKE $1", [`${TAG}%`]);
};
await clean();

const expense = (n: number) => ({
  employee: `${TAG} Person`,
  merchant: `MERCHANT ${n}`,
  note: "",
  date: "2026-09-20",
  method: "Corporate Card",
  receiptLabel: "yes",
  location: "Corporate",
  department: "Operations",
  category: "Meals",
  amountCents: 1000 + n,
  sourcePage: 1,
});

/** A parse of `n` expenses, reconciling against its own printed total. */
const parseOf = (n: number) => {
  const expenses = Array.from({ length: n }, (_, i) => expense(i));
  return {
    expenses,
    receipts: [],
    statedTotalCents: expenses.reduce((a, e) => a + e.amountCents, 0),
    header: null,
    pageCount: 1,
  };
};

// Each run needs its own file identity, or the duplicate-file guard answers
// first and the fence is never reached.
let serial = 0;
const run = (n: number, opts: { force?: boolean } = {}) =>
  ingestExport(Buffer.from(""), `${TAG}-${n}.pdf`, "test", {
    parsed: parseOf(n) as never,
    fileHash: `${TAG}-${++serial}`,
    sectionsVerified: true,
    ...opts,
  });

const waiting = async () =>
  Number((await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM expenses WHERE employee = $1", [`${TAG} Person`])).rows[0]!.n);

try {
  console.log("\n1. A full export builds the queue");
  const first = await run(100);
  check("100 expenses land", first.inserted === 100, String(first.inserted));
  check("nothing was purged on the way in", first.purged === 0, String(first.purged));
  check("and the queue holds them", (await waiting()) === 100, String(await waiting()));

  console.log("\n2. A truncated export is refused, not applied");
  const short = await run(5);
  check("nothing was imported", short.importId === null);
  check("the queue is untouched", (await waiting()) === 100, String(await waiting()));
  check("and it says what it saw and what to do",
    short.warnings.some((w) => /would delete 95 of the 100/.test(w) && /Re-run the export/.test(w)),
    short.warnings.join(" | ").slice(0, 160));

  console.log("\n3. Forcing it through is still possible");
  const forced = await run(5, { force: true });
  check("it imports", forced.importId !== null);
  check("and purges the 95", forced.purged === 95, String(forced.purged));
  check("leaving only what the file carried", (await waiting()) === 5, String(await waiting()));

  console.log("\n4. A small queue is never fenced");
  // Five waiting, one in the file. Four in five gone, but a fence that fired
  // at this size would block every quiet week for no safety at all.
  const tiny = await run(1);
  check("it imports without a fight", tiny.importId !== null);
  check("and purges the rest", tiny.purged === 4, String(tiny.purged));

  console.log("\n5. A big-but-plausible day warns rather than refuses");
  await run(100, { force: true });
  const half = await run(40);
  check("it imports", half.importId !== null);
  check("…and still purges", half.purged === 60, String(half.purged));
  check("…but says so out loud",
    half.warnings.some((w) => /60 of the 100 waiting expenses are absent/.test(w)),
    half.warnings.join(" | ").slice(0, 160));

  console.log("\n6. A normal day is silent");
  const normal = await run(38);
  check("no warning about the share purged",
    !normal.warnings.some((w) => /absent from this export/.test(w)),
    normal.warnings.join(" | ").slice(0, 120));
  check("the key of a row is unchanged by any of this",
    dedupeKey(expense(0)) === dedupeKey(expense(0)));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
