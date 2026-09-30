/**
 * When the browser cannot load a page, whose fault is it?
 *
 *   pnpm exec tsx scripts/test-reachable.ts
 *
 * The 6:29am export failed with "spend.emburse.com did not load within 90s,
 * twice" while a manual run hours later opened the same URL in under two
 * seconds. From inside Playwright those two causes look identical:
 *
 *   - the container has no route out (network, DNS, a VM one minute old)
 *   - the container has a route and the BROWSER cannot use it (a corrupt
 *     profile, a leftover process, memory)
 *
 *   - the container has a route, and it is DREADFUL
 *
 * They have nothing in common as fixes, and the message used to assert the
 * first one every time. A plain fetch needs no browser, no profile and no
 * rendering, so it answers the question outright.
 *
 * The third was missing, and its absence was a misdiagnosis with a cost:
 * any successful probe read as "the network is fine", so twenty-five
 * decisions that died on a link taking fourteen seconds per redirect were
 * all filed under "look at Chromium: a corrupt profile, a leftover
 * process, or memory on this VM" — sending somebody to rebuild a browser
 * that was working perfectly.
 */

export {};

import { createServer } from "node:http";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

process.env.SESSION_SECRET ||= "test-secret";
const { reachableForTest } = await import("../server/emburse/auto-export.js");

/** Milliseconds this host waits before answering, so "slow" can be staged. */
let delayMs = 0;
const server = createServer((_req, res) => {
  setTimeout(() => { res.writeHead(204); res.end(); }, delayMs);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

try {
  console.log("\nA host that answers");
  const up = await reachableForTest(`http://127.0.0.1:${port}/`);
  check("says the network is fine", /network is fine/.test(up), up);
  check("…and points at the browser as the remaining suspect",
    /BROWSER is what could not load/.test(up) && /Chromium/.test(up), up);
  check("…with the round trip, so 'fine' is not just a claim",
    /in \d+ms/.test(up), up);

  console.log("\nA host that answers, eventually");
  // Above the threshold, a successful probe is evidence AGAINST the browser
  // rather than for it: a page that fetches dozens of things cannot finish
  // in ninety seconds over a link like this, however healthy Chromium is.
  delayMs = 3_500;
  const slow = await reachableForTest(`http://127.0.0.1:${port}/`);
  delayMs = 0;
  check("says the egress is slow, not that the browser is broken",
    /egress being very slow/.test(slow) && !/network is fine/.test(slow), slow);
  check("…and does not send anybody to look at Chromium",
    !/Chromium/.test(slow) && !/corrupt profile/.test(slow), slow);
  check("…quoting how long one redirect took, so it can be judged",
    /took \d+\.\ds for a single redirect/.test(slow), slow);
  check("…and says plainly that nothing here needs fixing",
    /Nothing here needs fixing/.test(slow), slow);

  console.log("\nA host that does not");
  // Port 1 on localhost: nothing listens, and the refusal is instant, so
  // this does not sit out the 15s budget.
  const down = await reachableForTest("http://127.0.0.1:1/");
  check("says the container has no route, rather than blaming a selector",
    /no route to Emburse/.test(down), down);
  check("…and names what actually went wrong", /ECONNREFUSED|fetch failed/i.test(down), down);

  console.log("\nIt must never throw into the failure it is explaining");
  const junk = await reachableForTest("not-a-url");
  check("a nonsense URL is reported, not raised", typeof junk === "string" && junk.length > 0, junk);
} finally {
  server.close();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
