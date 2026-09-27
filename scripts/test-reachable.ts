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
 * They have nothing in common as fixes, and the message used to assert the
 * first one every time. A plain fetch needs no browser, no profile and no
 * rendering, so it answers the question outright.
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

const server = createServer((_req, res) => { res.writeHead(204); res.end(); });
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
