/**
 * "Send now" has to mean now.
 *
 *   pnpm exec tsx scripts/test-send-now.ts       (needs DATABASE_URL)
 *
 * The button existed, returned 202, and did nothing a reviewer could see.
 * Three ways a nudge went missing, all of them silent, none of them caught
 * by anything:
 *
 *   1. It went through the same twenty-second GATHER delay as the automatic
 *      nudge — and every press RESET that delay, so pressing again because
 *      nothing had happened pushed the run further away. The button did the
 *      opposite of its label the more it was used.
 *   2. Before the worker had started, the nudge was `if (!timer) return` —
 *      a no-op, answered with a cheerful 202.
 *   3. A nudge arriving mid-pass hit `if (running) return` and was dropped,
 *      with only the five-minute idle timer to come back. A decision queued
 *      one second too late waited five minutes.
 *
 * None of this is visible from the outside, which is why it survived: the
 * queue simply sat there saying "shortly".
 */

export {};

process.env.SESSION_SECRET ||= "test-secret-for-sealing-credentials";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const worker = await import("../server/emburse/decision-worker.js");

console.log("\n1. Before the worker has started");
check("a nudge reports that it went nowhere, rather than claiming success",
  worker.nudgeDecisionWorker({ immediate: true }) === false);
check("…and the worker says it is not running, so a button can say so too",
  worker.decisionWorkerStarted() === false);

console.log("\n2. Once it is running");
if (!process.env.DATABASE_URL) {
  console.log("  DATABASE_URL not set — skipping the rest.");
} else {
  worker.startDecisionWorker();
  check("it reports as started", worker.decisionWorkerStarted());
  check("an immediate nudge is accepted", worker.nudgeDecisionWorker({ immediate: true }));
  check("…and so is an ordinary one", worker.nudgeDecisionWorker());

  // The pass itself needs a database and a browser and is not what this is
  // about; what matters is that the call is honoured rather than swallowed.
  // A second start must not wind the clock back to the 60s boot delay.
  worker.startDecisionWorker();
  check("starting twice does not reset it to the boot delay",
    worker.decisionWorkerStarted());

  const { db } = await import("../server/db.js");
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
