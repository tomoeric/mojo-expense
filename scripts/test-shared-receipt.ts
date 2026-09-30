/**
 * One receipt, divided across sites, is one purchase.
 *
 *   pnpm exec tsx scripts/test-shared-receipt.ts     (needs DATABASE_URL)
 *
 * Jessica buys lunch for seven sites on one card, attaches the SAME receipt
 * to seven expenses and divides the cost: six shares of $12.37 and one of
 * $12.38, which is $86.60 — the receipt, to the cent. Three rules fired on
 * every one of the seven, and all three were wrong about it:
 *
 *   "Receipt total $86.60 does not equal Amount $12.37" — of course not,
 *   $12.37 is a seventh of it, and the seven add up.
 *   "Matching expenses that day is at most 3 — found 7" — one meal, seven
 *   ledger rows.
 *   "Matching total that day is at most $75 — found $86.60" — true as
 *   arithmetic, and not what a personal daily limit is about.
 *
 * What keeps it honest is what it REFUSES. A split that does not add up
 * gets none of this. A split within one site gets none of it either — or a
 * large dinner could be divided into shares to walk under the limit.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const store = await import("../server/rules/store.js");
const { runRules } = await import("../server/rules/run.js");
const { ensureReceiptItems } = await import("../server/emburse/receipt-items.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
await store.ensureRules();
await ensureReceiptItems();

const TAG = `zz-shr-${Date.now()}`;
const clean = async () => {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${TAG}%`]);
};
await clean();

/** One receipt image, read at `totalCents`, shared by the given shares. */
async function split(
  sha: string, totalCents: number, who: string,
  shares: { key: string; cents: number; site: string }[],
): Promise<void> {
  await db().query(
    `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
     VALUES ($1,'image/jpeg',1,'\\x00'::bytea) ON CONFLICT DO NOTHING`, [sha]);
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, legible, total_cents, itemised)
     VALUES ($1,'test',true,$2,true) ON CONFLICT (sha256) DO UPDATE
       SET total_cents = EXCLUDED.total_cents`, [sha, totalCents]);
  for (const s of shares) {
    await db().query(
      `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                             category, department, location, note, method, in_inbox)
       VALUES ($1,$2,'2026-09-24','MENOS MEXICAN GRILL',$3,'Meals','Operations and Field',
               $4,'Nto lunch','Corporate Card',true)`,
      [s.key, who, s.cents, s.site]);
    await db().query(
      "INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [s.key, sha]);
  }
}

const sevenWays = (prefix: string, sites: string[]) =>
  sites.map((site, i) => ({ key: `${prefix}-${i}`, cents: i === 1 ? 1238 : 1237, site }));

const SITES = ["Temple Mall", "Killeen", "Harker", "Belton", "Copperas", "Nolanville", "Salado"];
const ONE_SITE = SITES.map(() => "Temple Mall");

const subjectFor = async (key: string) => (await store.subjects(db(), [key]))[0]!;
const flagsOn = async (key: string) =>
  ((await store.hitsFor([key])).get(key) ?? []).map((h) => h.ruleName).sort();

try {
  // The real one: seven shares, seven sites, adding to the receipt exactly.
  await split(`${TAG}-a`, 8660, `${TAG} Jessica`, sevenWays(`${TAG}-ok`, SITES));
  // The same money, all to ONE site. A split ledger entry, not a
  // distribution — the daily limits must still apply.
  await split(`${TAG}-b`, 8660, `${TAG} Single`, sevenWays(`${TAG}-one`, ONE_SITE));
  // Seven sites, but the shares do NOT add up: $86.60 receipt, $70 claimed.
  await split(`${TAG}-c`, 8660, `${TAG} Short`,
    SITES.map((site, i) => ({ key: `${TAG}-short-${i}`, cents: 1000, site })));

  console.log("\n1. What the rules see for each share");
  const ok = await subjectFor(`${TAG}-ok-0`);
  check("the split is recognised, by image hash", ok.receiptSharedWith === 7,
    String(ok.receiptSharedWith));
  check("…the shares are checked against the receipt", ok.receiptSplitAddsUp === true);
  check("…so the receipt total for THIS expense is its own share",
    ok.receiptTotalCents === 1237, String(ok.receiptTotalCents));
  check("…and it does not count towards the buyer's own day", ok.countsTowardsDay === false);

  const short = await subjectFor(`${TAG}-short-0`);
  check("a split that does not add up is not excused",
    short.receiptSplitAddsUp === false, String(short.receiptSplitAddsUp));
  check("…it keeps the WHOLE receipt total, so the mismatch still shows",
    short.receiptTotalCents === 8660, String(short.receiptTotalCents));
  check("…and still counts towards the day", short.countsTowardsDay === true);

  const oneSite = await subjectFor(`${TAG}-one-0`);
  check("a split within a single site adds up", oneSite.receiptSplitAddsUp === true);
  check("…but still counts towards the day, so a big bill cannot be divided under a limit",
    oneSite.countsTowardsDay === true);

  console.log("\n2. The three rules that were firing on all seven");
  const mk = async (name: string, body: Parameters<typeof store.saveRule>[0]) => {
    const r = await store.saveRule(body, "tester@example.invalid");
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
  };
  await mk("amounts", {
    name: `${TAG} Amounts Off`, enabled: true, match: "all",
    when: [{ field: "receiptTotal", op: "is_not", value: "", compare: "amount" }],
    must: null, action: "flag", message: "",
  });
  await mk("count", {
    name: `${TAG} Meal Count > 3`, enabled: true, match: "all",
    when: [{ field: "category", op: "is", value: "Meals" }],
    must: { field: "dayCount", op: "lte", value: "3" }, action: "flag", message: "",
  });
  await mk("limit", {
    name: `${TAG} Meal Day Limit`, enabled: true, match: "all",
    when: [{ field: "category", op: "is", value: "Meals" }],
    must: { field: "dayTotal", op: "lte", value: "75" }, action: "flag", message: "",
  });
  await runRules({ decide: false });

  check("the distributed purchase is not flagged at all",
    (await flagsOn(`${TAG}-ok-0`)).length === 0, (await flagsOn(`${TAG}-ok-0`)).join(", "));
  check("…nor any of its other six shares",
    (await flagsOn(`${TAG}-ok-6`)).length === 0, (await flagsOn(`${TAG}-ok-6`)).join(", "));

  console.log("\n3. And what must STILL be caught");
  const shortFlags = await flagsOn(`${TAG}-short-0`);
  check("a split that does not reconcile is flagged on the amounts",
    shortFlags.some((n) => /Amounts Off/.test(n)), shortFlags.join(", "));
  const oneFlags = await flagsOn(`${TAG}-one-0`);
  check("seven shares within one site still trip the day count",
    oneFlags.some((n) => /Meal Count/.test(n)), oneFlags.join(", "));
  check("…and the day limit", oneFlags.some((n) => /Day Limit/.test(n)), oneFlags.join(", "));
  check("…while its amounts reconcile, so that one is not flagged",
    !oneFlags.some((n) => /Amounts Off/.test(n)), oneFlags.join(", "));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
