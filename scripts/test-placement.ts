/**
 * Which face of the glass, and the one place it is stored.
 *
 *   pnpm exec tsx scripts/test-placement.ts
 *
 * The failure worth preventing is not a crash. It is the instructions
 * page saying one thing and the confirmation a dealer ticks saying
 * the other — which is what happens the moment this becomes two
 * pieces of copy instead of one stored value. Somebody is standing at
 * a vehicle with a sticker and an adhesive that only works on one
 * side of the glass.
 *
 * Default INSIDE, because every tag issued so far went on under that
 * instruction and a setting appearing must not quietly rewrite what
 * people are told.
 */
import {
  getAccountState, getPlacement, isPlacement, setAccountState, setPlacement,
} from "../server/dutch-miller/settings.js";
import { DUTCH_MILLER } from "../server/dutch-miller/accounts.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};
const refused = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return ""; } catch (e) { return (e as Error).message; }
};

const BY = "boss@example.invalid";

try {
  await db().query("DELETE FROM dm_settings WHERE key = 'sticker_placement'")
    .catch(() => {});

  console.log("1. Inside until somebody says otherwise");
  const fresh = await getPlacement(DUTCH_MILLER);
  check("the default is inside", fresh.placement === "inside", fresh.placement);
  check("…and nothing claims to have set it", fresh.updatedAt === null);

  console.log("\n2. Switching it");
  const out = await setPlacement("outside", BY, DUTCH_MILLER);
  check("it takes", out.placement === "outside");
  check("…recording who", out.updatedBy === BY);
  check("…and when", Boolean(out.updatedAt));
  check("…and it reads back", (await getPlacement(DUTCH_MILLER)).placement === "outside");
  const back = await setPlacement("inside", BY, DUTCH_MILLER);
  check("and back again", back.placement === "inside");

  console.log("\n3. Only the two real answers");
  check("inside is one", isPlacement("inside"));
  check("outside is the other", isPlacement("outside"));
  check("anything else is not", !isPlacement("windscreen"));
  check("…nor is a blank", !isPlacement(""));
  const bad = await refused(() => setPlacement("bonnet" as never, BY, DUTCH_MILLER));
  check("saving nonsense is refused", bad.includes("not a placement"), bad);
  // A refused save must leave the real answer standing, or a typo in a
  // request silently rewrites what everybody is told to do.
  check("…and the setting is untouched", (await getPlacement(DUTCH_MILLER)).placement === "inside");

  console.log("\n4. A corrupt stored value falls back rather than breaking");
  // Somebody editing the row by hand, or a rollback from a version
  // that knew a third value. The page must still render something
  // true rather than an empty instruction.
  await db().query(
    `INSERT INTO dm_settings (key, value, updated_by, account_id)
          VALUES ('sticker_placement', $1, $2, $3)
     ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify("sideways"), BY, DUTCH_MILLER]);
  check("it reads as inside", (await getPlacement(DUTCH_MILLER)).placement === "inside");
  console.log("\n5. The partner account, open or shut");
  /*
   * One switch that closes Dutch Miller to everybody outside MOJO.
   * Open by default, because a setting appearing must not shut a
   * door — and switching it off needs a reason, since that is the
   * thing a dealer rings up about.
   */
  await db().query(
    `DELETE FROM dm_settings
      WHERE key = 'dealer_account_active' AND account_id = $1`, [DUTCH_MILLER])
    .catch(() => {});
  check("it is open until somebody shuts it", (await getAccountState(DUTCH_MILLER)).active);
  const noReason = await refused(() => setAccountState(false, "", BY, DUTCH_MILLER));
  check("switching off with no reason is refused",
    noReason.includes("why partner access"), noReason);
  check("…and it is still open", (await getAccountState(DUTCH_MILLER)).active);
  const shut = await setAccountState(false, "Partner agreement under review.", BY, DUTCH_MILLER);
  check("it shuts", shut.active === false);
  check("…carrying the reason a dealer will see",
    shut.reason.startsWith("Partner agreement"));
  check("…and who shut it", shut.updatedBy === BY);
  const open = await setAccountState(true, "", BY, DUTCH_MILLER);
  check("switching back on needs no reason", open.active === true);
  check("…and clears the old one", open.reason === "");

} finally {
  await db().query("DELETE FROM dm_settings WHERE key = 'dealer_account_active'")
    .catch(() => {});
  await db().query("DELETE FROM dm_settings WHERE key = 'sticker_placement'")
    .catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
