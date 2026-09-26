/**
 * What the AI cost meter says, and the ways a meter like this lies.
 *
 *   pnpm exec tsx scripts/test-ai-usage.ts     (needs DATABASE_URL)
 *
 * The figure this produces will be trusted, which is the whole danger. Every
 * estimate of AI spend made before it existed was wrong — once by a factor of
 * fifty, because it rested on assumed token counts rather than reported ones.
 * A meter that is confidently wrong is worse than the guesswork it replaces.
 *
 * So four things are pinned:
 *
 *   1. money is worked out from stored token counts at read time, so a price
 *      correction never needs a backfill
 *   2. a model with no published price on file reports an UNKNOWN total, never
 *      a total that quietly omits it
 *   3. recording never throws into the call it is measuring
 *   4. the cheap model really is cheaper, which is the decision this informs
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db } = await import("../server/db.js");
const { recordAiUsage, aiSpend, costOf, ensureAiUsage, PRICES } =
  await import("../server/ai/usage.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureAiUsage();
const clean = () => db().query("DELETE FROM ai_usage");
await clean();

try {
  console.log("\nPricing one call");
  // A million in, a million out, on a $1/$5 model: $1 + $5.
  check("input and output are priced separately",
    costOf("claude-haiku-4-5", { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }) === 6,
    String(costOf("claude-haiku-4-5", { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 })));
  check("a cache read is a tenth of input",
    costOf("claude-haiku-4-5", { input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 }) === 0.1);
  check("a cache write is a quarter more than input",
    costOf("claude-haiku-4-5", { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6 }) === 1.25);

  // The decision this meter exists to inform. If this ever stops holding, the
  // advice to move receipt reading to Haiku was wrong.
  const same = { input: 1e6, output: 2e5, cacheRead: 0, cacheWrite: 0 };
  const haiku = costOf("claude-haiku-4-5", same)!;
  const opus = costOf("claude-opus-5", same)!;
  check("the model receipts use is materially cheaper than the one it replaced",
    haiku * 4 < opus, `haiku $${haiku.toFixed(2)} vs opus $${opus.toFixed(2)}`);

  console.log("\nA model nobody has priced");
  check("has no price rather than a made-up one",
    costOf("claude-from-the-future", { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }) === null);

  console.log("\nRecording calls");
  await recordAiUsage("claude-haiku-4-5", { input_tokens: 2000, output_tokens: 500 });
  await recordAiUsage("claude-haiku-4-5", { input_tokens: 2000, output_tokens: 500 });
  let spend = await aiSpend();
  check("both calls are counted", spend.total.calls === 2, String(spend.total.calls));
  check("today and all-time agree when nothing is older than today",
    spend.today.calls === 2 && spend.month.calls === 2);
  // 2 x (2000 in at $1/M + 500 out at $5/M) = 2 x $0.0045.
  check("the cost is the sum of the two", Math.abs((spend.total.cost ?? 0) - 0.009) < 1e-9,
    `$${(spend.total.cost ?? 0).toFixed(4)}`);
  check("and it reports a per-receipt average, which is the number people ask for",
    spend.perReceipt !== null && Math.abs(spend.perReceipt - 0.0045) < 1e-9,
    `$${(spend.perReceipt ?? 0).toFixed(5)}`);

  console.log("\nA call with nothing to meter");
  await recordAiUsage("claude-haiku-4-5", null);
  await recordAiUsage("claude-haiku-4-5", { input_tokens: 0, output_tokens: 0 });
  spend = await aiSpend();
  check("an empty usage block is not recorded as a call", spend.total.calls === 2,
    String(spend.total.calls));

  console.log("\nAn unpriced model in the mix");
  await recordAiUsage("claude-from-the-future", { input_tokens: 1000, output_tokens: 100 });
  spend = await aiSpend();
  // The dangerous alternative: silently adding $0 and reporting a total that
  // looks precise and is too low.
  check("the total goes UNKNOWN rather than quietly excluding it",
    spend.total.cost === null, String(spend.total.cost));
  check("…and the model is named so the dash is explained",
    spend.unpriced.includes("claude-from-the-future"), spend.unpriced.join(", "));
  check("…but its tokens are still counted", spend.total.calls === 3, String(spend.total.calls));
  check("…and the models that ARE priced still show their own cost",
    spend.byModel.find((m) => m.model === "claude-haiku-4-5")?.cost !== null);

  console.log("\nThe meter must never break the call it measures");
  const before = spend.total.calls;
  // A null byte is the one thing Postgres will not accept in a text column, so
  // this insert genuinely fails. A long string does not — text has no length
  // limit, which is why the first version of this check proved nothing.
  await recordAiUsage("bad\u0000model", { input_tokens: 1, output_tokens: 1 });
  check("a failed write is swallowed, not thrown at the caller", true, "did not throw");
  const after = (await aiSpend()).total.calls;
  check("…and the failed call is simply absent, not half-counted", after === before,
    `${before} → ${after}`);

  console.log("\nPrices on file");
  check("the receipt model has a price, or every figure above is a dash",
    Boolean(PRICES["claude-haiku-4-5"]));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
