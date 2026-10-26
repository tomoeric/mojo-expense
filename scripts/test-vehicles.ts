/**
 * Years, makes and models for the signup form.
 *
 *   pnpm exec tsx scripts/test-vehicles.ts
 *
 * The point of these fields is that one dealership stops recording
 * Chevy, Chevrolet, CHEVY and chev for the same marque. The point of
 * the tests is that the cure is not worse than the disease:
 *
 *   A form field must never wait on somebody else's website, and must
 *   never stop working when that website does.
 *
 *   Nothing may be REFUSED for being off the list. A kit car, a fleet
 *   body or next spring's model has to be enterable.
 *
 * The catalogue is not reachable from the test container, which is
 * exactly the condition the fallbacks exist for — so these run
 * against the offline path deliberately, and the cache path is
 * exercised by seeding a row by hand.
 */
import {
  SEED_MAKES, listMakes, listModels, modelYears, titleCase,
} from "../server/dutch-miller/vehicles.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

try {
  console.log("1. Years are arithmetic, not a lookup");
  const years = modelYears(new Date("2026-10-26T00:00:00Z"));
  check("newest first", years[0] === "2027", years[0]);
  // Dealerships sell next year's cars from the autumn before.
  check("…including next year", years.includes("2027"));
  check("…back to the first 17-character VIN", years[years.length - 1] === "1981");
  check("…with no gaps", years.length === 2027 - 1981 + 1, String(years.length));
  check("they need no network at all", years.length > 40);

  console.log("\n2. Makes work with no catalogue");
  // The container cannot reach vPIC, which is the interesting case:
  // a deployment behind a firewall must still get a usable field.
  const makes = await listMakes();
  check("there are makes", makes.makes.length >= SEED_MAKES.length,
    String(makes.makes.length));
  check("…the ones that actually drive through a wash",
    ["Ford", "Chevrolet", "Honda", "Toyota", "Jeep"].every((m) => makes.makes.includes(m)));
  check("…sorted", makes.makes.join(",") === [...makes.makes].sort((a, b) => a.localeCompare(b)).join(","));
  check("…with no duplicates", new Set(makes.makes).size === makes.makes.length);

  console.log("\n3. A model lookup that cannot run says so, quietly");
  const models = await listModels("Honda", "2024");
  check("it does not throw", Array.isArray(models.models));
  check("…and reports the source", typeof models.source === "string", models.source);
  // Nonsense in, empty out — never a request to the catalogue.
  check("a missing make asks nothing", (await listModels("", "2024")).source === "unavailable");
  check("…and so does a missing year",
    (await listModels("Honda", "")).source === "unavailable");
  check("…and a year that is not one",
    (await listModels("Honda", "sometime")).source === "unavailable");

  console.log("\n4. A cached answer is served, and a stale one still is");
  await db().query(
    `INSERT INTO dm_vehicle_lookup (key, value, fetched_at)
          VALUES ('models:honda:2024', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()`,
    [JSON.stringify(["Accord", "Civic", "CR-V"])]);
  const fresh = await listModels("Honda", "2024");
  check("the cache answers", fresh.models.includes("Civic"), fresh.models.join(","));
  check("…without going out", fresh.source === "cache");

  // Age it past the TTL. The fetch will fail here, and the right
  // answer is last year's list rather than nothing: an old list of
  // Honda models is enormously better than an empty one.
  await db().query(
    `UPDATE dm_vehicle_lookup SET fetched_at = now() - interval '400 days'
      WHERE key = 'models:honda:2024'`);
  const stale = await listModels("Honda", "2024");
  check("a stale list is still served when the fetch fails",
    stale.models.includes("Civic"), stale.models.join(","));
  check("…and is marked as cache rather than catalogue", stale.source === "cache");

  console.log("\n5. The catalogue shouts; people do not");
  check("HONDA reads as Honda", titleCase("HONDA") === "Honda");
  check("…and MERCEDES-BENZ keeps its hyphen",
    titleCase("MERCEDES-BENZ") === "Mercedes-Benz", titleCase("MERCEDES-BENZ"));
  // The acronyms a title-caser gets wrong.
  check("BMW stays BMW", titleCase("BMW") === "BMW");
  check("GMC stays GMC", titleCase("GMC") === "GMC");
  // Already mixed case is left alone, or MINI becomes Mini.
  check("MINI is not mangled", titleCase("MINI") === "MINI", titleCase("MINI"));
  check("a name already written properly is untouched",
    titleCase("Land Rover") === "Land Rover");
  check("…and surrounding space goes", titleCase("  FORD  ") === "Ford");
} finally {
  await db().query(
    "DELETE FROM dm_vehicle_lookup WHERE key IN ('models:honda:2024','makes:car')")
    .catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
