/**
 * Fixing a fuel category by itself, and refusing to when unsure.
 *
 *   pnpm exec tsx scripts/test-auto-category.ts   (needs DATABASE_URL)
 *
 * "Want to automate changing category on receipts flagged by gas category
 * rule. Need to verify the receipt is from gas station or shows gas and
 * that notes show gas. If true the automation changes category and submits
 * to Emburse."
 *
 * Nine of the ten under that flag on one morning were the same thing, each
 * needing somebody to choose the category the rule had already named. This
 * does it — and because it edits a finance record with nobody watching,
 * most of what is checked here is what it REFUSES.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret-auto-category";

const { db, ensureSchema } = await import("../server/db.js");
const store = await import("../server/rules/store.js");
const { runRules } = await import("../server/rules/run.js");
const { ensureReceiptItems } = await import("../server/emburse/receipt-items.js");
const { fuelFixes, categoryRules } = await import("../server/rules/auto-category.js");
const { saveCredential, deleteCredential } = await import("../server/emburse/credentials.js");

const RULE = "Gas Category (auto-cat test)";
const ERIC = "eric.s@autocat.invalid";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM category_corrections WHERE dedupe_key LIKE 'ac-%'");
  await db().query("DELETE FROM expense_receipts WHERE dedupe_key LIKE 'ac-%'");
  await db().query("DELETE FROM receipt_items WHERE sha256 LIKE 'ac-%'");
  await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE 'ac-%'");
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE 'ac-%'");
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'ac-%'");
  await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${RULE}%`]);
  await deleteCredential(ERIC).catch(() => false);
};

/** One expense, with an optional receipt carrying the given lines. */
async function expense(opts: {
  key: string; merchant: string; note: string; category: string;
  receiptMerchant?: string; lines?: string[];
}): Promise<void> {
  await db().query(
    `INSERT INTO expenses (dedupe_key, reviewer, employee, merchant, amount_cents,
                           expense_date, category, note)
     VALUES ($1,$2,'Josh Yankiver',$3,4663,'2026-09-22',$4,$5)`,
    [opts.key, ERIC, opts.merchant, opts.category, opts.note]);
  if (!opts.receiptMerchant && !opts.lines) return;
  const sha = `ac-${opts.key}`;
  await db().query(
    `INSERT INTO receipt_blobs (sha256, bytes, byte_size, content_type)
     VALUES ($1,'\\x00'::bytea,1,'image/png') ON CONFLICT DO NOTHING`, [sha]);
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, legible, merchant, total_cents)
     VALUES ($1,'test',true,$2,4663) ON CONFLICT (sha256) DO NOTHING`,
    [sha, opts.receiptMerchant ?? null]);
  await db().query(
    "INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [opts.key, sha]);
  let n = 1;
  for (const line of opts.lines ?? []) {
    await db().query(
      `INSERT INTO receipt_items (sha256, line_no, description, amount_cents)
       VALUES ($1,$2,$3,100) ON CONFLICT DO NOTHING`, [sha, n++, line]);
  }
}

const picked = (all: { dedupeKey: string }[], key: string) =>
  all.some((f) => f.dedupeKey === key);

await ensureSchema();
await store.ensureRules();
await ensureReceiptItems();

try {
  await clean();
  await saveCredential(ERIC, ERIC, ERIC, "pw");

  const saved = await store.saveRule({
    name: RULE, enabled: true, match: "all",
    when: [{ field: "category", op: "is_not", value: "Auto Fee & Fuel" }],
    must: { field: "category", op: "is", value: "Auto Fee & Fuel" },
    action: "flag", message: "Fuel Category Is Wrong",
  }, "test");
  check("the rule saved", saved.ok, saved.ok ? "" : saved.error);

  console.log("\n1. The rule names the right answer, so nothing here has to");
  {
    const rules = await categoryRules();
    const mine = rules.find((r) => r.name === RULE);
    check("the rule is recognised as naming a category", mine !== undefined);
    check("…and the target comes from the rule itself", mine?.to === "Auto Fee & Fuel",
      mine?.to);
  }

  console.log("\n1b. Both ways a rule can name it");
  /*
   * The card said "no rule names a category as its expectation" over a
   * Gas Category rule that was flagging nine expenses. Reading only
   * `must: category is X` missed the other half: a rule that flags WHEN
   * the category is not X has named X just as plainly, from the other
   * side, and that is how the real one was written.
   */
  {
    const onlyWhen = await store.saveRule({
      name: `${RULE} (when only)`, enabled: true, match: "all",
      when: [{ field: "category", op: "is_not", value: "Auto Fee & Fuel" },
             { field: "note", op: "contains", value: "gas" }],
      must: null, action: "flag", message: "Fuel Category Is Wrong",
    }, "test");
    check("a when-only rule saves", onlyWhen.ok, onlyWhen.ok ? "" : onlyWhen.error);

    const { rulesConsidered } = await import("../server/rules/auto-category.js");
    const seen = (await rulesConsidered()).find((r) => r.name === `${RULE} (when only)`);
    check("…is recognised too", seen?.to === "Auto Fee & Fuel", JSON.stringify(seen));
    check("…and says why", /category is not/.test(seen?.why ?? ""), seen?.why);

    // And a rule that names no category is reported, not silently dropped.
    const noneNamed = await store.saveRule({
      name: `${RULE} (no category)`, enabled: true, match: "all",
      when: [{ field: "merchant", op: "contains", value: "shell" }],
      must: { field: "amount", op: "lt", value: "100" },
      action: "flag", message: "Big fuel stop",
    }, "test");
    check("a rule naming no category saves", noneNamed.ok, noneNamed.ok ? "" : noneNamed.error);
    const other = (await rulesConsidered()).find((r) => r.name === `${RULE} (no category)`);
    check("…is listed with a reason rather than dropped",
      other !== undefined && other.to === null && other.why.length > 0, JSON.stringify(other));

    // A rule that is switched OFF must still be explained. The card's
    // whole job is "why did no rule match", and dropping the disabled
    // ones meant the likeliest answer was the one it could not give.
    const off = await store.saveRule({
      name: `${RULE} (switched off)`, enabled: false, match: "all",
      when: [{ field: "category", op: "is_not", value: "Auto Fee & Fuel" }],
      must: null, action: "flag", message: "Fuel Category Is Wrong",
    }, "test");
    check("a switched-off rule saves", off.ok, off.ok ? "" : off.error);
    const hidden = (await rulesConsidered()).find((r) => r.name === `${RULE} (switched off)`);
    check("…is still listed", hidden !== undefined);
    check("…saying it is off rather than nothing", /switched off/.test(hidden?.why ?? ""),
      hidden?.why);
    check("…and is not acted on", hidden?.to === null, String(hidden?.to));

    await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${RULE} (%`]);
  }

  console.log("\n2. Two witnesses agree — it qualifies");
  // The real rows: a fuel merchant, and a note saying what it was for.
  await expense({ key: "ac-shell", merchant: "Shell Oil", note: "Gas for travel",
    category: "Travel - Mileage & Ground Transportation" });
  // Not a fuel merchant, but the receipt has a pump line — the Lowe's case,
  // "Gas for leaf blower" on a Small Tools expense.
  await expense({ key: "ac-lowes", merchant: "Lowe's Home Centers, LLC",
    note: "Gas for leaf blower", category: "Small Tools",
    receiptMerchant: "Lowe's", lines: ["UNLEADED 2.050 GAL", "SHOP TOWEL"] });
  await runRules({ keys: ["ac-shell", "ac-lowes"], decide: false });
  {
    const all = await fuelFixes();
    check("a fuel merchant with a fuel note qualifies", picked(all, "ac-shell"));
    check("…and a fuel LINE on a non-fuel merchant does too", picked(all, "ac-lowes"));
    const one = all.find((f) => f.dedupeKey === "ac-shell");
    check("…changing to what the rule demands", one?.to === "Auto Fee & Fuel", one?.to);
    check("…under the reviewer whose queue it is", one?.reviewer === ERIC, one?.reviewer);
    check("…and saying why", /note says/.test(one?.because ?? ""), one?.because);
  }

  console.log("\n3. One witness is not enough");
  // A forecourt receipt with no fuel note: a sandwich at a Circle K.
  await expense({ key: "ac-snack", merchant: "CIRCLE K #7265", note: "Lunch on the road",
    category: "Meals" });
  // A note saying gas against something that sells no fuel and shows none.
  await expense({ key: "ac-hotel", merchant: "Fairfield Inn & Suites", note: "gas",
    category: "Travel - Lodging", receiptMerchant: "Fairfield Inn",
    lines: ["ROOM CHARGE", "STATE TAX"] });
  await runRules({ keys: ["ac-snack", "ac-hotel"], decide: false });
  {
    const all = await fuelFixes();
    check("a fuel merchant with no fuel note is left alone", !picked(all, "ac-snack"));
    check("…and a fuel note with no fuel anywhere else is too", !picked(all, "ac-hotel"));
  }

  console.log("\n4. It never re-sends, and never touches what is already right");
  {
    const { queueCorrection } = await import("../server/emburse/corrections.js");
    await queueCorrection({ dedupeKey: "ac-shell", from: "Travel", to: "Auto Fee & Fuel",
      requestedBy: ERIC });
    check("one already on its way is not sent again",
      !picked(await fuelFixes(), "ac-shell"));

    await db().query(
      "UPDATE expenses SET category = 'Auto Fee & Fuel' WHERE dedupe_key = 'ac-lowes'");
    check("one already in the right category is not sent",
      !picked(await fuelFixes(), "ac-lowes"));
  }

  console.log("\n5. Switched off, it does nothing at all");
  {
    const { sweepFuelCategories } = await import("../server/rules/auto-category.js");
    const out = await sweepFuelCategories();
    check("nothing is queued while the switch is off", out.queued === 0, String(out.queued));
  }
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
