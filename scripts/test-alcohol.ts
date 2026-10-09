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

  console.log("\n6. The floor reaches readings already stored");
  // A Kwik Trip run flagged for alcohol on three Red Bulls, read by reader
  // v4 and sitting behind three hundred other images in the re-read queue.
  // Bumping the reader gets there eventually; eventually is one vision call
  // per receipt and hours of them. The floor is a pure function of the
  // line's own text, so it can simply be re-applied.
  const SHA = `${TAG}-floor`;
  await db().query(
    `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
     VALUES ($1,'image/jpeg',1,'\\x00'::bytea) ON CONFLICT DO NOTHING`, [SHA]);
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, legible, itemised, reader_version)
     VALUES ($1,'test',true,true,4) ON CONFLICT (sha256) DO NOTHING`, [SHA]);
  await db().query(
    `INSERT INTO receipt_items (sha256, line_no, description, amount_cents, alcohol)
     VALUES ($1,1,'RED BULL SUDACHI LIME 12',1197,true),
            ($1,2,'MM 71 Red Bull 12oz 2 FO',-396,true),
            ($1,3,'LAGUNITAS IPA 6PK',1299,true)
     ON CONFLICT DO NOTHING`, [SHA]);

  const cleared = await items.reapplyAlcoholFloor();
  check("the lines the floor covers are cleared", cleared >= 2, String(cleared));
  const after = await db().query<{ line_no: number; alcohol: boolean }>(
    "SELECT line_no, alcohol FROM receipt_items WHERE sha256 = $1 ORDER BY line_no", [SHA]);
  check("…the Red Bulls are no longer alcohol",
    after.rows[0]?.alcohol === false && after.rows[1]?.alcohol === false);
  // The half that matters more: it only ever CLEARS.
  check("…and the IPA still is", after.rows[2]?.alcohol === true);
  check("…running it again changes nothing", await items.reapplyAlcoholFloor() === 0);

  console.log("\n6b. The marked line comes back out of the database");
  /*
   * The flag read "Receipt shows alcohol yes is yes" over a list of a
   * dozen items with nothing saying which one, so the reviewer had to
   * read the receipt themselves to find the drink — the work the reader
   * had already done. It was stored per line from the start and simply
   * never selected.
   */
  {
    const { db } = await import("../server/db.js");
    const { receiptDetail } = await import("../server/emburse/receipt-items.js");
    const sha = `alc-line-${Date.now()}`;
    await db().query(
      `INSERT INTO receipt_blobs (sha256, bytes, byte_size, content_type)
       VALUES ($1,'\\x00'::bytea,1,'image/png') ON CONFLICT DO NOTHING`, [sha]);
    await db().query(
      `INSERT INTO receipt_readings (sha256, model, legible) VALUES ($1,'test',true)
       ON CONFLICT (sha256) DO NOTHING`, [sha]);
    await db().query(
      `INSERT INTO receipt_items (sha256, line_no, description, amount_cents, alcohol)
       VALUES ($1,1,'Minute Maid Lemonade',1400,false),
              ($1,2,'Pabst Blue Ribbon',1600,true)
       ON CONFLICT DO NOTHING`, [sha]);

    const got = await receiptDetail(sha);
    const beer = got?.items.find((i) => i.description.includes("Pabst"));
    const pop = got?.items.find((i) => i.description.includes("Lemonade"));
    check("the drink comes back marked", beer?.alcohol === true, String(beer?.alcohol));
    check("…and the soft drink does not", pop?.alcohol === false, String(pop?.alcohol));

    await db().query("DELETE FROM receipt_items WHERE sha256 = $1", [sha]);
    await db().query("DELETE FROM receipt_readings WHERE sha256 = $1", [sha]);
    await db().query("DELETE FROM receipt_blobs WHERE sha256 = $1", [sha]);
  }

  console.log("\n7. The reader was bumped, so stored readings are done again");
  check("reader version is 7", items.READER_VERSION === 7, String(items.READER_VERSION));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
