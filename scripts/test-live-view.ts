/**
 * Watching the browser costs the run almost nothing.
 *
 *   pnpm exec tsx scripts/test-live-view.ts
 *
 * "Able to have a toggle that shows the browser?" Not literally — this is
 * headless on a VM with no display, and the alternatives were weighed and
 * rejected: a headful Chromium behind Xvfb and VNC is a system package
 * tree and a second auth surface in front of a live finance session;
 * recordVideo only yields a file once the context closes, so a
 * twenty-minute run has nothing to show until it is over.
 *
 * What is left is a frame on request. The thing that has to be true for it
 * to be safe on one vCPU is that LOOKING cannot tax the run: several
 * watchers must cost the same as one, and a page asking faster must not be
 * able to make it cost more. That is this test.
 */

import { liveFrame, nowDoing, watching } from "../server/emburse/live-view.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

/** A page that only counts how often it is asked for a picture. */
let shots = 0;
const fakePage = (bytes = "frame") => ({
  screenshot: async () => { shots++; return Buffer.from(bytes); },
} as never);

console.log("\nNothing is running, so there is nothing to show");
check("no frame", (await liveFrame()) === null);
check("…and nothing was photographed", shots === 0, String(shots));

console.log("\nWith a run going, a frame comes back");
const stop = watching(fakePage("one"), "open Emburse", "brian@test.invalid");
{
  const f = await liveFrame();
  check("there is a frame", f !== null);
  check("…captioned with the step", f?.what === "open Emburse", f?.what);
  check("…and marked as running", f?.running === true);
  check("…having taken exactly one picture", shots === 1, String(shots));
}

console.log("\nWatchers share one capture — this is the whole safety argument");
{
  const before = shots;
  // Five lookers, or one looker polling fast. Either way the run pays once.
  await Promise.all([liveFrame(), liveFrame(), liveFrame(), liveFrame(), liveFrame()]);
  check("no further captures inside the rate limit", shots === before, `${shots - before} extra`);
}

console.log("\nThe caption belongs to the FRAME, not to the clock");
nowDoing("read the item count");
{
  // Still inside the rate limit, so this is the old picture — and it must
  // keep the old caption. Relabelling a cached frame with the step that
  // started since would caption a photograph with something not in it,
  // which is worse than being two seconds behind.
  const stale = await liveFrame();
  check("a cached frame keeps its own caption", stale?.what === "open Emburse", stale?.what);

  await new Promise((r) => setTimeout(r, 2100));
  const fresh = await liveFrame();
  check("…and the next capture carries the new one",
    fresh?.what === "read the item count", fresh?.what);
}

console.log("\nA page that cannot be photographed keeps the last frame");
{
  const before = shots;
  stop();
  const angry = watching({
    screenshot: async () => { shots++; throw new Error("page is busy"); },
  } as never, "waiting for the export", "brian@test.invalid");
  // Past the rate limit, so it really tries.
  await new Promise((r) => setTimeout(r, 2100));
  const f = await liveFrame();
  check("it tried", shots > before);
  // Showing the previous frame beats showing an error: a screenshot that
  // times out means a busy page, and a viewer should not read that as the
  // run having died.
  check("…and still returns something", f !== null);
  angry();
}

console.log("\nThe last frame outlives the run, then goes stale");
{
  const f = await liveFrame();
  check("still available just after the run ends", f !== null);
  check("…but no longer claims to be running", f?.running === false);
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
