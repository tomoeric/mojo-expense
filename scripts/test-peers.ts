/**
 * The two sides of the ambiguity guard have to mean the same thing.
 *
 * The guard reads: several rows in Emburse match this expense equally well;
 * may the automation take one? It may when our queue holds a decision for
 * every matching row, because then each decision takes a row and all of them
 * are actioned. It may not when we hold fewer.
 *
 * That only works if "matching row" and "one like it" are the same relation.
 * They were not. The browser accepts a row when any long word of the
 * merchant appears in it; peersFor counted our own expenses alike only when
 * the merchant strings were identical. So Paul Deaux II's three $29.99 car
 * washes on 28 August — BUSY BEE CARWASH - KENDA…, PITSTOP CARWASH -
 * FAIRHO…, PITSTOP CARWASH - GULFPO…, every Mammoth descriptor sharing the
 * word "holdings" besides — were three rows on one side and one peer on the
 * other, and all three sat refused for ever.
 *
 * Needs DATABASE_URL. Cleans up after itself.
 */

import { db } from "../server/db.js";
import { merchantAlike } from "../server/emburse/decide.js";
import { peersFor } from "../server/emburse/decisions.js";

const TAG = `zz-peers-${Date.now()}`;
let failures = 0;
function check(label: string, got: unknown, want: unknown): void {
  const ok = Object.is(got, want);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${String(got)}, want ${String(want)}`}`);
  if (!ok) failures++;
}

console.log("\nThe relation itself");
{
  const BUSY = "BUSY BEE CARWASH - KENDAMAMMOTH HOLDINGS, LLC";
  const FAIRHO = "PITSTOP CARWASH - FAIRHOMAMMOTH HOLDINGS LLC";
  const GULFPO = "PITSTOP CARWASH - GULFPOMAMMOTH HOLDINGS LLC";
  const SUDS = "SUDS CAR WASH - ASHLANDMAMMOTH HOLDINGS LLC";
  // These are what the GRID treats as alike, so they are what "one like it"
  // has to mean. Not an endorsement that they are the same purchase — the
  // vendor scoring picks the closest row where it can, and this rule only
  // decides whether the queue accounts for the ones left tied.
  check("two sites of one brand are alike", merchantAlike(FAIRHO, GULFPO), true);
  check("two brands sharing a word are alike", merchantAlike(BUSY, FAIRHO), true);
  check("and so are the ones sharing only the holding company",
    merchantAlike(SUDS, FAIRHO), true);
  check("a different vendor entirely is not",
    merchantAlike(FAIRHO, "FIREHOUSE SUBS #1149SIOUX CITY FHS 1 LLC"), false);
  // Symmetric: the grid reads the row for the expense and the expense for
  // the row, and one direction accepting while the other refuses is how two
  // counts of the same thing disagree.
  check("it reads the same both ways",
    merchantAlike("ACE HARDWARE HELM, LLC", "ACE HARDWARE #18"),
    merchantAlike("ACE HARDWARE #18", "ACE HARDWARE HELM, LLC"));
}

if (!process.env.DATABASE_URL && !process.env.NEON_DATABASE_URL
    && !process.env.EXTERNAL_DATABASE_URL) {
  console.log("\n  --   skipped the queue half: no DATABASE_URL");
} else {
  const clean = async (): Promise<void> => {
    await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  };
  const add = (key: string, merchant: string, cents: number, date: string): Promise<unknown> =>
    db().query(
      `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                             category, department, location, note, method, in_inbox)
       VALUES ($1,'Paul Deaux II',$2,$3,$4,'Auto Fee & Fuel','Maintenance','Site','','Corporate Card',true)`,
      [key, date, merchant, cents]);

  try {
    await clean();
    console.log("\nWhat the queue holds");
    await add(`${TAG}-busy`, "BUSY BEE CARWASH - KENDAMAMMOTH HOLDINGS, LLC", 2999, "2026-08-28");
    await add(`${TAG}-fair`, "PITSTOP CARWASH - FAIRHOMAMMOTH HOLDINGS LLC", 2999, "2026-08-28");
    await add(`${TAG}-gulf`, "PITSTOP CARWASH - GULFPOMAMMOTH HOLDINGS LLC", 2999, "2026-08-28");
    // Same person and day, a different amount: not one of these.
    await add(`${TAG}-other`, "PITSTOP CARWASH - WAVELAMAMMOTH HOLDINGS LLC", 2799, "2026-08-28");
    // Same person and amount, a different day.
    await add(`${TAG}-day`, "PITSTOP CARWASH - FAIRHOMAMMOTH HOLDINGS LLC", 2999, "2026-08-27");
    // Same everything but a vendor sharing no word at all.
    await add(`${TAG}-subs`, "FIREHOUSE SUBS #1149SIOUX CITY FHS 1 LLC", 2999, "2026-08-28");

    const peers = await peersFor([`${TAG}-busy`, `${TAG}-fair`, `${TAG}-subs`, `${TAG}-day`]);
    check("the three $29.99 car washes account for each other",
      peers.get(`${TAG}-busy`), 3);
    check("…read from any of them", peers.get(`${TAG}-fair`), 3);
    // Everything the grid would not have matched either.
    check("a different amount, day or vendor is not one of them",
      peers.get(`${TAG}-subs`), 1);
    check("…nor is the same expense on another day", peers.get(`${TAG}-day`), 1);
    // The guard must never read zero: an expense is always one of its own.
    const unknown = await peersFor(["no-such-expense"]);
    check("an expense we know nothing about still counts as one",
      unknown.get("no-such-expense"), 1);
  } finally {
    await clean();
    await db().end();
  }
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
