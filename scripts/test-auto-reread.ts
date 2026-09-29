/**
 * A flagged receipt is read a second time by itself — once.
 *
 *   pnpm exec tsx scripts/test-auto-reread.ts     (needs DATABASE_URL)
 *
 * Nearly every "Amounts Off" that turned out to be wrong was the reader
 * having taken the wrong line off the image, and pressing Read again fixed
 * it on the spot. That is work the app can do, and was charging a person
 * for: open the row, press the button, watch the flag disappear.
 *
 * Four things are pinned. A flagged mismatch gets re-read. A corrected
 * total takes the flag with it, with nobody involved. A mismatch that
 * SURVIVES the re-read keeps its flag — the flag is the point. And it
 * happens exactly once per image, including when the read throws, because
 * "keep trying until it matches" over a real overclaim is both expensive
 * and precisely the wrong instinct.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";
process.env.ANTHROPIC_API_KEY ||= "sk-ant-test-not-a-real-key";

const { db, ensureSchema } = await import("../server/db.js");
const store = await import("../server/rules/store.js");
const { runRules } = await import("../server/rules/run.js");
const items = await import("../server/emburse/receipt-items.js");
const { rereadMismatched } = await import("../server/emburse/reread-mismatched.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();
await store.ensureRules();
await items.ensureReceiptItems();

const TAG = `zz-rr-${Date.now()}`;
const FIXED  = `${TAG}-fixed`;   // the re-read corrects it
const REAL   = `${TAG}-real`;    // the re-read agrees: a genuine mismatch
const THROWS = `${TAG}-throws`;  // the re-read blows up
const OK     = `${TAG}-ok`;      // matches already; must not be touched

const clean = async () => {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_readings WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM receipt_blobs WHERE sha256 LIKE $1", [`${TAG}%`]);
  await db().query("DELETE FROM expense_rules WHERE name LIKE $1", [`${TAG}%`]);
};
await clean();

const addExpense = (key: string, cents: number) =>
  db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox)
     VALUES ($1,$2,'2026-09-24','MENARDS 3114',$3,'Repairs','Maintenance','Arbor Point',
             'GFCI outlet','Corporate card',true)`,
    [key, `${TAG} Person`, cents]);

async function addReceipt(key: string, sha: string, cents: number): Promise<void> {
  await db().query(
    `INSERT INTO receipt_blobs (sha256, content_type, byte_size, bytes)
     VALUES ($1,'image/jpeg',1,'\\x00'::bytea) ON CONFLICT DO NOTHING`, [sha]);
  await db().query(
    "INSERT INTO expense_receipts (dedupe_key, sha256) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [key, sha]);
  await db().query(
    `INSERT INTO receipt_readings (sha256, model, legible, total_cents, itemised)
     VALUES ($1,'test',true,$2,true) ON CONFLICT (sha256) DO UPDATE
       SET total_cents = EXCLUDED.total_cents`, [sha, cents]);
}

/**
 * Stand in for the vision call.
 *
 * The pass is being tested, not the model, so the reading each image comes
 * back with is decided here — including one that throws, which is the case
 * that decides whether "once" survives a failure.
 */
const readsAs = new Map<string, number | "throw">();
const read = async (sha: string): Promise<unknown> => {
  const want = readsAs.get(sha);
  if (want === "throw") throw new Error("the model was unreachable");
  if (want !== undefined) {
    await db().query(
      "UPDATE receipt_readings SET total_cents = $2, extracted_at = now() WHERE sha256 = $1",
      [sha, want]);
  }
  return items.receiptDetail(sha);
};
const pass1 = () => rereadMismatched({ read });

const flagged = async (key: string): Promise<boolean> =>
  (await store.hitsFor([key])).has(key);
const rereadAt = async (sha: string): Promise<string | null> => {
  const { rows } = await db().query<{ t: Date | null }>(
    "SELECT auto_reread_at AS t FROM receipt_readings WHERE sha256 = $1", [sha]);
  return rows[0]?.t?.toISOString() ?? null;
};

try {
  // The Menards slip: the reader took 12.49 off it, the card was charged 13.54.
  await addExpense(FIXED, 1354);
  await addReceipt(FIXED, `${TAG}-fix`, 1249);
  readsAs.set(`${TAG}-fix`, 1354);

  await addExpense(REAL, 19793);
  await addReceipt(REAL, `${TAG}-rea`, 6698);
  readsAs.set(`${TAG}-rea`, 6698);   // reads the same: the receipt really is $66.98

  await addExpense(THROWS, 5000);
  await addReceipt(THROWS, `${TAG}-thr`, 1000);
  readsAs.set(`${TAG}-thr`, "throw");

  await addExpense(OK, 1418);
  await addReceipt(OK, `${TAG}-fine`, 1418);

  const saved = await store.saveRule({
    name: `${TAG} Amounts Off`, enabled: true, match: "all",
    when: [{ field: "receiptTotal", op: "is_not", value: "", compare: "amount" }],
    must: null, action: "flag", message: "",
  }, "tester@example.invalid");
  if (!saved.ok) throw new Error(saved.error);
  await runRules({ keys: [FIXED, REAL, THROWS, OK], decide: false });

  console.log("\n1. Before the pass");
  check("the bad read is flagged", await flagged(FIXED));
  check("the real mismatch is flagged", await flagged(REAL));
  check("…and the one that matches is not", !await flagged(OK));

  console.log("\n2. The pass runs with nobody pressing anything");
  const pass = await pass1();
  check("it found the flagged mismatches", pass.mismatched === 3, String(pass.mismatched));
  check("…re-read the ones it could", pass.reread === 2, String(pass.reread));
  check("…and reports what came out of the flag", pass.cleared === 1, String(pass.cleared));

  console.log("\n3. What it did to each");
  check("the corrected one is out of the flag", !await flagged(FIXED));
  check("…with the total now right", (await items.receiptDetail(`${TAG}-fix`))?.total === 13.54);
  check("the genuine mismatch KEEPS its flag", await flagged(REAL));
  check("…and the one that matched was never touched",
    await rereadAt(`${TAG}-fine`) === null);

  console.log("\n4. Once means once");
  check("a re-read image is marked", await rereadAt(`${TAG}-rea`) !== null);
  // The one that threw is the case that matters: without the mark going on
  // BEFORE the read, a reliably-failing image is retried on every pass, for
  // ever, at a vision call each.
  check("…and so is one whose read threw", await rereadAt(`${TAG}-thr`) !== null);

  readsAs.set(`${TAG}-rea`, 19793);   // it would match now — but it gets no second go
  const again = await pass1();
  check("a second pass re-reads nothing", again.reread === 0, String(again.reread));
  check("…and the genuine mismatch is still flagged", await flagged(REAL));

  console.log("\n5. A new mismatch still gets its turn");
  const LATER = `${TAG}-later`;
  await addExpense(LATER, 2500);
  await addReceipt(LATER, `${TAG}-lat`, 900);
  readsAs.set(`${TAG}-lat`, 2500);
  await runRules({ keys: [LATER], decide: false });
  check("it arrives flagged", await flagged(LATER));
  const third = await pass1();
  check("…is re-read", third.reread === 1, String(third.reread));
  check("…and clears", !await flagged(LATER));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
