/**
 * Watching the browser while it works.
 *
 * "Able to have a toggle that shows the browser?" Not literally — this runs
 * headless on a VM with no display, and the honest alternatives were
 * weighed: a headful Chromium behind Xvfb and VNC is a new system package
 * tree, a WebSocket path and a second auth surface in front of a live
 * finance session; `recordVideo` only yields a file after the context
 * closes, so on a twenty-minute run there is nothing to look at until it is
 * over, which is exactly backwards; tracing stores whole API response
 * bodies, which for a $29k grid means the queue's contents in a zip.
 *
 * What is left is the cheap one that actually answers the question: hand
 * out a picture of the page the run is on, when somebody asks for it.
 *
 * Two things keep it affordable on one vCPU. It is PULL — no frames are
 * taken unless a person is looking. And it is rate-limited HERE rather than
 * trusted to the page: a 1600x1000 encode is real CPU in the same Chromium
 * that is driving Emburse, so a tab left open, or two, must not be able to
 * tax the run it is watching.
 */

import type { Page } from "playwright";

/** The page a run is driving right now, if one is. */
let live: { page: Page; what: string; who: string } | null = null;

/** The last frame and when it was taken, so lookers share one capture. */
let last: { png: Buffer; at: number; what: string } | null = null;

/**
 * No more than one capture every two seconds, however many are watching.
 *
 * Slow enough to cost the run almost nothing, quick enough to read as live
 * — the steps it is illustrating take seconds at best.
 */
const MIN_GAP_MS = 2_000;

/** A frame older than this is not worth showing as "now". */
const STALE_MS = 30_000;

/** Note the page a run is working on, for as long as it is working. */
export function watching(page: Page, what: string, who: string): () => void {
  live = { page, what, who };
  return () => {
    if (live?.page === page) live = null;
    // The last frame outlives the run deliberately: the interesting moment
    // is often the one just before it finished, and a viewer whose poll
    // lands a second late should see that rather than a blank.
    };
}

export type LiveFrame = {
  png: Buffer;
  /** The step, or what the run is doing, for a caption. */
  what: string;
  /** Milliseconds since the frame was taken. */
  ageMs: number;
  /** Whether a run is still going. A last frame can outlive it. */
  running: boolean;
};

/**
 * A picture of what the browser is looking at.
 *
 * Returns the cached frame when one was taken moments ago — that is the
 * rate limit, and it is also what makes several watchers cost the same as
 * one. Never throws: a page that has navigated away mid-capture, or died,
 * is a reason to show the previous frame, not to fail the request.
 */
export async function liveFrame(): Promise<LiveFrame | null> {
  const now = Date.now();
  const fresh = last && now - last.at < MIN_GAP_MS;
  if (!fresh && live) {
    try {
      const png = await live.page.screenshot({ fullPage: false, timeout: 5_000 });
      last = { png, at: Date.now(), what: live.what };
    } catch {
      // Keep whatever we had. A screenshot that times out is a busy page,
      // not a broken one, and failing here would make the viewer think the
      // run had died.
    }
  }
  if (!last) return null;
  if (!live && now - last.at > STALE_MS) return null;
  return { png: last.png, what: last.what, ageMs: now - last.at, running: live !== null };
}

/** Who the running browser is signed in as, for the caption. */
export function liveWho(): string | null {
  return live?.who ?? null;
}

/** Called as each step starts, so the caption says what is on screen. */
export function nowDoing(what: string): void {
  if (live) live.what = what;
}
