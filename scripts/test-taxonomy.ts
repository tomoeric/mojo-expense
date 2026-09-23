/**
 * The permanent lists, and the parsing they are built from.
 *
 *   pnpm exec tsx scripts/test-taxonomy.ts        (the DB half needs DATABASE_URL)
 *
 * Two things are worth protecting here.
 *
 * The first is that Location / Site and Department are actually read off the
 * export. They come out of one wrapped Details cell as labelled pairs, and if
 * a label moves the field does not error — it comes back "" and every row
 * quietly loses its site. That is exactly the failure this file exists to
 * catch, and it can be caught without a PDF.
 *
 * The second is that the lists are permanent and additive: a name seen once
 * stays, a name seen again is not duplicated, and a name never seen before is
 * reported so somebody notices a new site or a mis-picked category.
 */

import { parseDetails } from "../server/import/parse-pdf.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

console.log("\nDetails cell → location + department");

// The shape the app has actually seen, both orders.
eq("location then department",
  parseDetails("Location / Site - Richland Department - Maintenance"),
  { location: "Richland", department: "Maintenance" });
eq("department then location",
  parseDetails("Department - Maintenance Location / Site - Richland"),
  { location: "Richland", department: "Maintenance" });

// Multi-word values, which is the normal case and the one a lazy
// "take the next word" parser gets wrong.
eq("multi-word values",
  parseDetails("Location / Site - Sioux Falls West Department - Field Operations"),
  { location: "Sioux Falls West", department: "Field Operations" });

// A hyphen inside the value must not be read as the label separator, and must
// not be trimmed off the middle.
eq("hyphen inside the value",
  parseDetails("Location / Site - Richland - North Department - Maintenance"),
  { location: "Richland - North", department: "Maintenance" });

// The cell wraps, and unwrap() joins the pieces with a single space before
// this runs. Extra whitespace must not survive into the stored name, or the
// same site becomes two entries on the list.
eq("collapses the whitespace wrapping leaves behind",
  parseDetails("Location / Site  -  Richland    Department  -  Maintenance"),
  { location: "Richland", department: "Maintenance" });

// One field configured and not the other.
eq("location only", parseDetails("Location / Site - Richland"),
  { location: "Richland", department: "" });
eq("department only", parseDetails("Department - Maintenance"),
  { location: "", department: "Maintenance" });
eq("neither", parseDetails(""), { location: "", department: "" });

// If Emburse renames a label this must come back empty rather than come back
// wrong — a blank site is visible on the Locations page, a wrong one is not.
eq("an unrecognised label yields nothing, not a guess",
  parseDetails("Site - Richland Team - Maintenance"),
  { location: "", department: "" });

if (!process.env.DATABASE_URL) {
  console.log("\nDATABASE_URL not set — skipping the list half.");
  console.log(failures === 0 ? "\nPASS (parsing only)" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

const { db, ensureSchema } = await import("../server/db.js");
const { ensureTaxonomy, recordTaxonomy, listTaxonomy, seedFromExpenses } =
  await import("../server/import/taxonomy.js");

await ensureSchema();
await ensureTaxonomy();

// Names nothing else would use, so the test cannot disturb real data.
const TAG = `zz-test-${Date.now()}`;
const cat = `${TAG} Parent › ${TAG} Leaf`;
const loc = `${TAG} Site`;
const dept = `${TAG} Dept`;

console.log("\nThe permanent lists");
try {
  const first = await recordTaxonomy(db(), [
    { category: cat, location: loc, department: dept },
    { category: cat, location: loc, department: dept },
    { category: "  ", location: "", department: undefined },
  ]);
  eq("a first sighting is reported as new, once", first.category, [cat]);
  check("blank values never reach the list",
    !first.location.includes("") && first.location.length === 1, JSON.stringify(first.location));

  const second = await recordTaxonomy(db(), [{ category: cat, location: loc, department: dept }]);
  check("seeing the same name again adds nothing",
    second.category.length === 0 && second.location.length === 0 && second.department.length === 0,
    JSON.stringify(second));

  const cats = await listTaxonomy("category");
  const mine = cats.entries.find((e) => e.name === cat);
  check("the name is on the list", Boolean(mine));
  eq("a nested category is split for display", mine && { parent: mine.parent, leaf: mine.leaf },
    { parent: `${TAG} Parent`, leaf: `${TAG} Leaf` });
  check("a name no expense uses still appears, with a zero count",
    mine?.uses === 0 && mine?.lastUsed === null, `uses=${mine?.uses}`);

  // The production database has months of imports behind it and no list. The
  // backfill is what makes those months appear, so it runs on every boot —
  // and it has to be able to find names that only exist on old expense rows.
  const key = `${TAG}-expense`;
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location)
     VALUES ($1, 'Test Person', '2026-01-02', 'Test Merchant', 1234, $2, $3, $4)`,
    [key, `${TAG} Backfilled Cat`, `${TAG} Backfilled Dept`, `${TAG} Backfilled Site`]);
  await db().query("DELETE FROM expense_taxonomy WHERE name LIKE $1", [`%${TAG} Backfilled%`]);
  await seedFromExpenses(db());
  const backfilled = await listTaxonomy("department");
  const entry = backfilled.entries.find((e) => e.name === `${TAG} Backfilled Dept`);
  check("a name that only exists on old expense rows is taken onto the list", Boolean(entry));
  check("its counts come from the expenses themselves",
    entry?.uses === 1 && entry?.totalCents === 1234 && entry?.lastUsed === "2026-01-02",
    JSON.stringify(entry));
  check("an expense still in the inbox is counted as waiting", entry?.waiting === 1, `waiting=${entry?.waiting}`);

  const locs = await listTaxonomy("location");
  eq("a flat name is left alone",
    locs.entries.find((e) => e.name === loc)?.leaf, loc);
  check("the list says how many expenses have no value for the field",
    typeof locs.blank === "number" && locs.blank <= locs.expenses,
    `${locs.blank} blank of ${locs.expenses}`);
} finally {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expense_taxonomy WHERE name LIKE $1", [`%${TAG}%`]);
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
