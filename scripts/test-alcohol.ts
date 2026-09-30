/**
 * What counts as alcohol, and what emphatically does not.
 *
 *   pnpm exec tsx scripts/test-alcohol.ts     (needs DATABASE_URL)
 *
 * "What is being flagged as alcohol?" Red Bull. Two fuel-stop receipts,
 * both flagged "Receipt shows alcohol is yes", and the only drinks on
 * either were water, a brownie and several Red Bulls — under four
 * different spellings, because receipts abbreviate: RDBUL APL ED 12Z,
 * NATL RED BULL 12Z, RED BULL SUDACHI LIME 12, MM 71 Red Bull 12oz.
 *
 * The prompt named ginger beer and root beer as things that sound
 * alcoholic and are not, and said nothing whatever about energy drinks.
 *
 * Fixed in two places, because a model is a model: the prompt now says it,
 * and a short list of products that are never alcohol under any spelling
 * overrides the judgement outright. The list is narrow on purpose — it
 * holds only cases where there is no judgement to make, so it cannot hide
 * a real drink.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db, ensureSchema } = await import("../server/db.js");
const items = await import("../server/emburse/receipt-items.js");
const store = await import("../server/rules/store.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
await items.ensureReceiptItems();

const TAG = `zz-alc-${Date.now()}`;
const clean = async () => {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_items WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`]);
};
await clean();

/** Store items exactly as extractReceipt does, through the same decision. */
async function store1(
  sha: string, key: string, lines: { description: string; alcohol: boolean }[],
): Promise<void> {
  await db().query(
    `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
     VALUES ($1,'image/jpeg',1,'\\x00'::bytea) ON CONFLICT DO NOTHING`, [sha]);
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, legible, total_cents, itemised)
     VALUES ($1,'test',true,1551,true) ON CONFLICT (sha256) DO NOTHING`, [sha]);
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-23','CIRCLE K',1551,'Meals','Operations and Field','Site',
             'Lunch','Corporate Card',true)`, [key, `${TAG} Person`]);
  await db().query(
    "INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [key, sha]);
  let n = 0;
  for (const l of lines) {
    await db().query(
      `INSERT INTO receipt_items (sha256, line_no, description, alcohol)
       VALUES ($1,$2,$3,$4)`,
      [sha, ++n, l.description, items.isAlcohol(l.description, l.alcohol)]);
  }
}

try {
  // Exactly the Circle K and Kwik Trip receipts, with the model saying
  // "alcohol" on every Red Bull — which is what it was doing.
  await store1(`${TAG}-circlek`, `${TAG}-a`, [
    { description: "FIJI WATER 1.5LTR", alcohol: false },
    { description: "2 RDBUL APL ED 12Z", alcohol: true },
    { description: "BBELL CKS N CRM 1.94Z", alcohol: false },
    { description: "NATL RED BULL 12Z 2F", alcohol: true },
  ]);
  await store1(`${TAG}-kwik`, `${TAG}-b`, [
    { description: "ZENWTR 23.7OZ", alcohol: false },
    { description: "RED BULL SUDACHI LIME 12", alcohol: true },
    { description: "RED BULL WHITE PEACH 120", alcohol: true },
    { description: "MM 71 Red Bull 12oz 2 FO", alcohol: true },
    { description: "BUILT PUFF BROWNIE BATTE", alcohol: false },
  ]);
  // And a receipt that really does have drink on it, to prove the override
  // is not just switching the check off.
  await store1(`${TAG}-bar`, `${TAG}-c`, [
    { description: "LAGUNITAS IPA 6PK", alcohol: true },
    { description: "FIJI WATER 1.5LTR", alcohol: false },
  ]);

  console.log("\n1. Red Bull, under every spelling a receipt gives it");
  const alcoholOn = async (sha: string): Promise<string[]> => {
    const { rows } = await db().query<{ description: string }>(
      "SELECT description FROM receipt_items WHERE sha256 = $1 AND alcohol ORDER BY line_no", [sha]);
    return rows.map((r) => r.description);
  };
  check("nothing on the Circle K receipt is alcohol",
    (await alcoholOn(`${TAG}-circlek`)).length === 0,
    (await alcoholOn(`${TAG}-circlek`)).join(", "));
  check("…nor on the Kwik Trip one",
    (await alcoholOn(`${TAG}-kwik`)).length === 0,
    (await alcoholOn(`${TAG}-kwik`)).join(", "));

  console.log("\n2. Real drink is still real drink");
  check("the IPA is still alcohol",
    (await alcoholOn(`${TAG}-bar`)).join(", ") === "LAGUNITAS IPA 6PK",
    (await alcoholOn(`${TAG}-bar`)).join(", "));

  console.log("\n3. What a rule about alcohol now sees");
  const says = async (key: string) => (await store.subjects(db(), [key]))[0]!.receiptAlcohol;
  check("the fuel stop answers no", await says(`${TAG}-a`) === false, String(await says(`${TAG}-a`)));
  check("…and so does the other", await says(`${TAG}-b`) === false);
  check("…while the one with beer on it answers yes", await says(`${TAG}-c`) === true);

  console.log("\n4. The decision itself, spelling by spelling");
  for (const d of ["RDBUL APL ED 12Z", "NATL RED BULL 12Z 2F", "RED BULL SUDACHI LIME 12",
                   "MM 71 Red Bull 12oz 2 FO", "MONSTER ENERGY 16Z", "CELSIUS RASPBERRY"]) {
    check(`“${d}” is not alcohol`, items.isAlcohol(d, true) === false);
  }
  for (const d of ["LAGUNITAS IPA 6PK", "MODELO ESP 12PK", "CAB SAUV GLS", "TITOS 750ML"]) {
    check(`“${d}” still is`, items.isAlcohol(d, true) === true);
  }
  // The override only ever removes. A line the model called clean stays
  // clean, or this would start inventing drink nobody saw.
  check("and it never ADDS alcohol the model did not see",
    items.isAlcohol("LAGUNITAS IPA 6PK", false) === false);

  console.log("\n5. Fountain drinks are not alcohol either");
  // Chipotle, Sep 23: Chicken Quesadilla, White Rice, Chips, "22 fl oz
  // Soda/Iced Tea" — and the expense came back flagged for alcohol.
  for (const d of ["22 FL OZ SODA/ICED TEA", "FOUNTAIN DRINK LG", "SWEET TEA",
                   "LEMONADE", "GATORADE 20OZ", "DR PEPPER 2L", "ICED COFFEE",
                   "OJ JUICE", "BOTTLED WATER"]) {
    check(`“${d}” is not alcohol`, items.isAlcohol(d, true) === false);
  }
  // Widening the floor must not excuse the thing the rule is FOR. Each of
  // these contains a word from the list above and is still a drink.
  for (const d of ["VODKA SODA", "HARD ICED TEA", "TWISTED TEA 6PK",
                   "SPIKED LEMONADE", "WHITE CLAW SELTZER", "HARD CIDER",
                   "IRISH COFFEE", "RUM & COLA"]) {
    check(`“${d}” still is`, items.isAlcohol(d, true) === true);
  }

  console.log("\n6. The reader was bumped, so stored readings are done again");
  check("reader version is 6", items.READER_VERSION === 6, String(items.READER_VERSION));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
