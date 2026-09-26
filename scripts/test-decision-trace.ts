/**
 * The step-by-step trace of an approve or deny.
 *
 *   pnpm exec tsx scripts/test-decision-trace.ts     (needs DATABASE_URL)
 *
 * A failed decision used to be one sentence. "It did not go through" covered
 * a wrong password, a device check, an account with no team view, and a
 * renamed button — four causes with four different fixes and one message.
 * The steps are the difference, and the browser run already produced them;
 * they were simply thrown away except for the first failing line.
 *
 * Three things to hold:
 *
 *   1. off by default, and off means nothing is stored — the switch has to
 *      actually do something or it is decoration
 *   2. a success is traced too. "It worked, and here is how" is what makes
 *      the next failure readable by comparison
 *   3. a missing trace reads as NOT RECORDED, never as "there were no steps"
 */

export {};

process.env.SESSION_SECRET ||= "test-secret";

const { db } = await import("../server/db.js");
const { getFlag, setFlag, allFlags, FLAGS } = await import("../server/flags.js");
const { queueDecision, settleDecision, decisionsFor } = await import("../server/emburse/decisions.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const KEY = `zz-trace-${Date.now()}`;
const target = {
  employee: "Test Person", merchant: "MERCHANT", amount: 10, date: "2026-09-22",
};
const steps = [
  { name: "open Emburse", ok: true, detail: "loaded", ms: 1200 },
  { name: "sign in", ok: true, detail: "already signed in", ms: 800 },
  { name: "switch to the team view", ok: true, detail: "clicked the team-wide tab", ms: 300 },
  { name: "search for the expense", ok: false, detail: "the search returned no rows", ms: 4100 },
];

const clean = async () => {
  // Tolerant: on a database that has never had these, the first run creates
  // them a moment later and there is nothing to clear.
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE $1", [`${KEY}%`])
    .catch(() => undefined);
  await db().query("DELETE FROM app_flags WHERE key = 'traceDecisions'").catch(() => undefined);
};

const only = async (k: string) => (await decisionsFor([k])).get(k);

try {
  await clean();

  console.log("\nThe switch itself");
  check("it is off until somebody turns it on", (await getFlag("traceDecisions")) === false);
  check("…which is what the shipped default says", FLAGS.traceDecisions === false);
  await setFlag("traceDecisions", true, "tester@example.invalid");
  check("turning it on sticks", (await getFlag("traceDecisions")) === true);
  check("and it is listed with the rest", (await allFlags()).traceDecisions === true);
  await setFlag("traceDecisions", false, "tester@example.invalid");
  check("turning it off sticks too", (await getFlag("traceDecisions")) === false);

  console.log("\nOff: nothing is kept");
  const offKey = `${KEY}-off`;
  await queueDecision({
    dedupeKey: offKey, decision: "approve", reason: "",
    decidedBy: "tester@example.invalid", target,
  });
  // The worker passes null when the flag is off, which is the behaviour here.
  await settleDecision((await only(offKey))!.id, { ok: false, error: "did not go through" }, null);
  const off = await only(offKey);
  check("no trace is stored", off?.steps === null, JSON.stringify(off?.steps));
  // The distinction that matters on screen: absent means NOT RECORDED. If this
  // ever came back as [] the UI would be entitled to say "no steps", which is
  // a claim about the run rather than about the setting.
  check("…and it is null rather than an empty list", off?.steps !== undefined && off?.steps === null);
  check("the one-line reason still works", off?.error === "did not go through", off?.error ?? "");

  console.log("\nOn: the run is kept, stage by stage");
  await setFlag("traceDecisions", true, "tester@example.invalid");
  const onKey = `${KEY}-on`;
  await queueDecision({
    dedupeKey: onKey, decision: "deny", reason: "Wrong category",
    decidedBy: "tester@example.invalid", target,
  });
  await settleDecision((await only(onKey))!.id, { ok: false, error: steps[3]!.detail }, steps);
  const on = await only(onKey);
  check("every stage is there", on?.steps?.length === 4, String(on?.steps?.length));
  check("…in the order they ran",
    on?.steps?.map((s) => s.name).join(" → ") ===
      "open Emburse → sign in → switch to the team view → search for the expense",
    on?.steps?.map((s) => s.name).join(" → ") ?? "");
  check("…saying which one stopped it",
    on?.steps?.filter((s) => !s.ok).map((s) => s.name).join() === "search for the expense");
  check("…and how long each took, so a timeout is visible as one",
    on?.steps?.[3]?.ms === 4100, String(on?.steps?.[3]?.ms));

  console.log("\nA success is traced too");
  const okKey = `${KEY}-ok`;
  await queueDecision({
    dedupeKey: okKey, decision: "approve", reason: "",
    decidedBy: "tester@example.invalid", target,
  });
  const good = steps.slice(0, 3).concat({ name: "approve", ok: true, detail: "approved in Emburse", ms: 1500 });
  await settleDecision((await only(okKey))!.id, { ok: true, matchedRow: "row text" }, good);
  const applied = await only(okKey);
  check("it applied", applied?.state === "applied", applied?.state ?? "");
  check("…and kept the run that worked, for comparison next time",
    applied?.steps?.length === 4 && applied.steps.every((s) => s.ok));

  console.log("\nA retry does not lose the trace it already had");
  // settleDecision COALESCEs, so a later settle with no steps must not wipe
  // a trace recorded earlier — otherwise turning the switch off mid-retry
  // erases the evidence you turned it on to collect.
  await settleDecision((await only(onKey))!.id, { ok: false, error: "again" }, null);
  check("the earlier trace survives", (await only(onKey))?.steps?.length === 4,
    String((await only(onKey))?.steps?.length));
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
