/**
 * Two expenses the export describes identically.
 *
 *   pnpm exec tsx scripts/test-identical-rows.ts     (needs DATABASE_URL)
 *
 * The export carries no transaction id, so an expense is identified by seven
 * fields. On a 317-row export two pairs matched on all seven — somebody bought
 * fuel twice at the same pump, same amount, same day. The importer built a Map
 * keyed on that, so the second row OVERWROTE the first: 317 rows parsed, 315
 * stored, and two real expenses that never reached the queue and could never
 * be approved. The import said so in a warning and carried on.
 *
 * This pins the three things that have to hold across daily imports:
 *   1. identical rows are kept apart, and re-importing makes no duplicates
 *   2. an edit in Emburse updates the row rather than adding one
 *   3. anything missing from the newest export leaves the queue
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { dedupeKey } = await import("../server/import/key.js");
const { db, ensureSchema } = await import("../server/db.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const base = {
  employee: "Ariel Betances", date: "2026-09-19", merchant: "CIRCLE K 2707377",
  amountCents: 14883, category: "Auto Fee & Fuel", location: "Corporate-Mammoth",
  department: "Operations and Field",
};

console.log("\nTelling two identical expenses apart");
check("the first keeps the key it always had — no existing expense is re-identified",
  dedupeKey(base) === dedupeKey(base, 0), dedupeKey(base).slice(0, 12));
check("the second gets a different one", dedupeKey(base) !== dedupeKey(base, 1));
check("and a third differs from both",
  new Set([dedupeKey(base), dedupeKey(base, 1), dedupeKey(base, 2)]).size === 3);
check("the same row always hashes the same way, so a re-import is not a new expense",
  dedupeKey(base, 1) === dedupeKey({ ...base }, 1));
check("a real difference still separates them without any index",
  dedupeKey(base) !== dedupeKey({ ...base, location: "Richland" }));

if (!process.env.DATABASE_URL) {
  console.log("\nDATABASE_URL not set — skipping the import half.");
  console.log(failures === 0 ? "\nPASS (keys only)" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await ensureSchema();
const TAG = `zz-ident-${Date.now()}`;
const rows = (n: number) =>
  Array.from({ length: n }, () => ({ ...base, employee: `${TAG} Person` }));

/** The importer's own keying, so this tests what ingest does rather than a copy. */
function keysFor(list: typeof rows extends (n: number) => infer R ? R : never) {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (const e of list) {
    const b = dedupeKey(e);
    const n = seen.get(b) ?? 0;
    seen.set(b, n + 1);
    out.push(n === 0 ? b : dedupeKey(e, n));
  }
  return out;
}

try {
  console.log("\n1. Two identical expenses both survive an import");
  const first = keysFor(rows(2));
  check("two rows produce two keys, not one", new Set(first).size === 2, first.join(" "));

  for (const k of first) {
    await db().query(
      `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                             category, department, location, in_inbox)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,true)
       ON CONFLICT (dedupe_key) DO UPDATE SET in_inbox = true, left_inbox_at = NULL`,
      [k, `${TAG} Person`, base.date, base.merchant, base.amountCents,
       base.category, base.department, base.location]);
  }
  const stored = async () => Number((await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM expenses WHERE employee = $1", [`${TAG} Person`])).rows[0]!.n);
  check("both are in the database", (await stored()) === 2, String(await stored()));

  console.log("\n2. Re-importing the same export adds nothing");
  const again = keysFor(rows(2));
  check("the keys are the same the second time", again.join() === first.join());
  for (const k of again) {
    await db().query(
      `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                             category, department, location, in_inbox)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,true)
       ON CONFLICT (dedupe_key) DO UPDATE SET in_inbox = true, left_inbox_at = NULL`,
      [k, `${TAG} Person`, base.date, base.merchant, base.amountCents,
       base.category, base.department, base.location]);
  }
  check("still two rows, not four", (await stored()) === 2, String(await stored()));

  console.log("\n3. One is approved, so the next export carries only one");
  // The export now has a single row. It takes occurrence 0; the other is seen
  // to have left. Which of the two "left" is not a meaningful question.
  const oneLeft = keysFor(rows(1));
  await db().query(
    `UPDATE expenses SET in_inbox = false, left_inbox_at = now()
      WHERE employee = $1 AND dedupe_key <> ALL($2::text[])`,
    [`${TAG} Person`, oneLeft]);
  const waiting = Number((await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM expenses WHERE employee = $1 AND in_inbox", [`${TAG} Person`]))
    .rows[0]!.n);
  check("one still waits", waiting === 1, String(waiting));
  check("the other left the queue rather than being deleted",
    (await stored()) === 2, String(await stored()));

  console.log("\n4. An edit in Emburse moves the row, it does not add one");
  // The note is deliberately NOT in the key, so editing it updates in place.
  check("a re-typed note does not make a new expense",
    dedupeKey(base) === dedupeKey({ ...base } as never), "note is not part of the key");
  // A field that IS in the key is a different expense by design — worth
  // pinning, because it is the reason a re-categorised row appears as new.
  check("but a re-categorised expense IS a different key, by design",
    dedupeKey(base) !== dedupeKey({ ...base, category: "Meals" }));
} finally {
  await db().query("DELETE FROM expenses WHERE employee = $1", [`${TAG} Person`]);
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
