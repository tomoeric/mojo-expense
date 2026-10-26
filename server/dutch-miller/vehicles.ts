import { db, ensureSchema } from "../db.js";
import { getJson } from "../http.js";

/**
 * Years, makes and models for the signup form.
 *
 * Three fields that were free text, which is how one dealership's
 * records end up holding "Chevy", "Chevrolet", "CHEVY" and "chev" for
 * the same marque — and why nobody can answer "how many Silverados
 * are on the plan" afterwards.
 *
 * The source is NHTSA's vPIC catalogue, which is the US government's
 * own vehicle product list: free, public, no key, and the thing every
 * VIN decoder is built on. It is fetched server-side and CACHED,
 * because a form field must not wait on somebody else's website and
 * must not stop working when that website does.
 *
 * Three deliberate softnesses, each covering a way this could
 * otherwise make the form worse than the free text it replaces:
 *
 *   A SEED LIST of makes is bundled, so the field is useful on a
 *   deployment that cannot reach the internet at all. The catalogue
 *   adds to it; it never replaces it.
 *
 *   Nothing is REFUSED for being off the list. These are suggestions
 *   on a combo box, not an enumeration — a kit car, a fleet truck or
 *   next year's model must not be unenterable because a catalogue
 *   has not caught up.
 *
 *   A failed lookup returns an empty list and says so, rather than
 *   throwing. The field falls back to what it has always been.
 */

const VPIC = "https://vpic.nhtsa.dot.gov/api/vehicles";

/** How long a catalogue answer stays good. Makes and models barely move. */
const TTL_DAYS = 30;

/**
 * The first year of the 17-character VIN, and so of anything this
 * catalogue can speak about. Older vehicles are typed in by hand,
 * which they would have to be anyway.
 */
const FIRST_YEAR = 1981;

/**
 * Model years, newest first.
 *
 * Next year is included because dealerships sell next year's cars
 * from roughly the autumn before, and a member signing one up in
 * October should not have to leave the field blank.
 */
export function modelYears(now = new Date()): string[] {
  const latest = now.getUTCFullYear() + 1;
  const out: string[] = [];
  for (let y = latest; y >= FIRST_YEAR; y--) out.push(String(y));
  return out;
}

/**
 * Makes that are worth offering with no network at all.
 *
 * Not a complete list and not meant to be — the catalogue has
 * thousands, most of them trailer and bus manufacturers. This is what
 * actually drives through a car wash in West Virginia, so the field
 * is useful on its own and better once the catalogue loads.
 */
export const SEED_MAKES: string[] = [
  "Acura", "Alfa Romeo", "Audi", "BMW", "Buick", "Cadillac", "Chevrolet",
  "Chrysler", "Dodge", "Fiat", "Ford", "Genesis", "GMC", "Honda", "Hyundai",
  "Infiniti", "Jaguar", "Jeep", "Kia", "Land Rover", "Lexus", "Lincoln",
  "Mazda", "Mercedes-Benz", "Mercury", "MINI", "Mitsubishi", "Nissan",
  "Pontiac", "Porsche", "Ram", "Rivian", "Saturn", "Scion", "Subaru",
  "Tesla", "Toyota", "Volkswagen", "Volvo",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_vehicle_lookup (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

/**
 * A cached catalogue answer.
 *
 * A STALE one is still served when the fetch fails. An old list of
 * Honda models is enormously better than an empty one, and the only
 * thing that changes in a year is the newest model — which somebody
 * can type.
 */
async function cached(key: string, fetcher: () => Promise<string[]>): Promise<{
  values: string[]; fresh: boolean; source: "catalogue" | "cache" | "unavailable";
}> {
  await ensure();
  const got = await db().query<{ value: unknown; fetched_at: Date }>(
    "SELECT value, fetched_at FROM dm_vehicle_lookup WHERE key = $1", [key]);
  const row = got.rows[0];
  const age = row ? (Date.now() - row.fetched_at.getTime()) / 86_400_000 : Infinity;
  const held = Array.isArray(row?.value)
    ? (row!.value as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (row && age < TTL_DAYS) return { values: held, fresh: true, source: "cache" };

  try {
    const fetched = await fetcher();
    if (fetched.length > 0) {
      await db().query(
        `INSERT INTO dm_vehicle_lookup (key, value, fetched_at)
              VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()`,
        [key, JSON.stringify(fetched)]);
      return { values: fetched, fresh: true, source: "catalogue" };
    }
  } catch {
    // Deliberately swallowed. A vehicle field is not worth an outage,
    // and the caller has a sensible answer either way.
  }
  return {
    values: held,
    fresh: false,
    source: held.length > 0 ? "cache" : "unavailable",
  };
}

/** vPIC shouts its names. People do not. */
export function titleCase(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  if (trimmed === "") return "";
  // Left alone when it is already mixed case: the catalogue has
  // BMW, GMC and MINI, and "Bmw" would be worse than shouting.
  if (/[a-z]/.test(trimmed)) return trimmed;
  return trimmed.toLowerCase().replace(/(^|[\s\-/])([a-z])/g, (_m, p, c) => p + c.toUpperCase())
    // The acronyms the rule above gets wrong.
    .replace(/\bBmw\b/g, "BMW").replace(/\bGmc\b/g, "GMC")
    .replace(/\bMini\b/g, "MINI").replace(/\bRam\b/g, "RAM")
    .replace(/\bKia\b/g, "Kia").replace(/\bBpa\b/g, "BPA");
}

type VpicList = { Results?: { Make_Name?: string; Model_Name?: string }[] };

/**
 * Every make the catalogue lists as making cars, plus the seed.
 *
 * Merged rather than replaced, so a deployment that cannot reach the
 * internet still offers the forty marques that matter, and one that
 * can offers everything.
 */
export async function listMakes(): Promise<{
  makes: string[]; source: string;
}> {
  const got = await cached("makes:car", async () => {
    const body = await getJson<VpicList>(
      `${VPIC}/GetMakesForVehicleType/car?format=json`, { timeoutMs: 8000 });
    return (body.Results ?? [])
      .map((r) => titleCase(String(r.Make_Name ?? "")))
      .filter((n) => n.length > 1);
  });
  const all = new Set<string>([...SEED_MAKES, ...got.values]);
  return {
    makes: [...all].sort((a, b) => a.localeCompare(b)),
    source: got.source,
  };
}

/**
 * Models for one make and year.
 *
 * Both are needed: the catalogue's answer for Honda in 2024 is a
 * dozen names, and its answer for Honda across all years is hundreds
 * including everything discontinued since 1981.
 */
export async function listModels(make: string, year: string): Promise<{
  models: string[]; source: string;
}> {
  const m = titleCase(make);
  const y = /^(19|20)\d{2}$/.test(year.trim()) ? year.trim() : "";
  if (m === "" || y === "") return { models: [], source: "unavailable" };

  const got = await cached(`models:${m.toLowerCase()}:${y}`, async () => {
    const body = await getJson<VpicList>(
      `${VPIC}/GetModelsForMakeYear/make/${encodeURIComponent(m)}/modelyear/${y}?format=json`,
      { timeoutMs: 8000 });
    return (body.Results ?? [])
      .map((r) => titleCase(String(r.Model_Name ?? "")))
      .filter((n) => n.length > 0);
  });
  return {
    models: [...new Set(got.values)].sort((a, b) => a.localeCompare(b)),
    source: got.source,
  };
}
