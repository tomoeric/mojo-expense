/**
 * Stop this run has to actually stop the run.
 *
 *   pnpm exec tsx scripts/test-stop-run.ts
 *
 * "Reimbursement seems stuck. The stop this run button doesn't work."
 *
 * It did not. The stop set a flag that was read BETWEEN steps, and the step
 * that strands a run is the first one: "open Emburse" retries a 90-second
 * navigation three times, so a run sits inside one step for six minutes
 * with the flag set and nothing reading it. The button returned 200 and
 * nothing happened, which is worse than having no button.
 *
 * Closing the browser is what makes it stop: whatever the run is waiting
 * on — a navigation, a selector, Emburse building a file — fails at once,
 * and the run records itself as a failure like any other.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret-stop";
process.env.EMBURSE_PROFILE_DIR = `/tmp/mojo-stop-${Date.now()}`;
process.env.EMBURSE_OPEN_TIMEOUT_MS ||= "60000";
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "60000";

const { openBrowser, openEmburse } = await import("../server/emburse/auto-export.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

console.log("\nClosing the browser ends a navigation that would otherwise hang");
{
  // A port with nothing listening: the goto hangs until its timeout, which
  // is exactly the shape of the stuck run — one step, minutes long, with
  // the stop flag set and unread.
  const nowhere = "http://127.0.0.1:9/";
  const opened = await openBrowser("stop-test@test.invalid");
  const page = await opened.context.newPage();

  const started = Date.now();
  const run = openEmburse(page, nowhere).then(
    () => "finished",
    (e: unknown) => `threw: ${(e as Error).message.slice(0, 60)}`,
  );

  // What stopRun does now, half a second in: shut the browser.
  await new Promise((r) => setTimeout(r, 500));
  await opened.close().catch(() => {});

  const outcome = await run;
  const took = Date.now() - started;

  check("the navigation ended", typeof outcome === "string", outcome);
  check("…promptly, not at its own timeout", took < 30_000, `${(took / 1000).toFixed(1)}s`);
  check("…and it ended as a failure, not a success",
    outcome.startsWith("threw:"), outcome);
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
