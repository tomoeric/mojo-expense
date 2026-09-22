/**
 * One browser, one user at a time.
 *
 *   pnpm exec tsx scripts/test-browser-lock.ts
 *
 * The export and a batch of decisions drive the same Chromium profile, and
 * Chromium takes an exclusive lock on it. Two at once is not slow, it is a
 * crash — and before this existed the 6am export could start while somebody
 * was mid-decision, with whichever lost the race failing on a lock error that
 * said nothing about the real cause.
 */

import { browserQueue, whyWaiting, withBrowser } from "../server/emburse/browser-lock.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\n1. Two runs do not overlap");
const order: string[] = [];
const a = withBrowser("the export", async () => {
  order.push("a:start");
  await wait(300);
  order.push("a:end");
});
const b = withBrowser("applying 3 decision(s)", async () => {
  order.push("b:start");
  await wait(50);
  order.push("b:end");
});
// Give the first one a moment to take the lock before looking.
await wait(80);
check("the second is told what it is waiting for",
  /the export has the browser/.test(whyWaiting() ?? ""), whyWaiting() ?? "nothing holds it");
check("…and the queue names it", browserQueue().holder?.label === "the export",
  browserQueue().holder?.label ?? "none");

await Promise.all([a, b]);
check("they ran one after the other, not together",
  order.join(" ") === "a:start a:end b:start b:end", order.join(" "));
check("nothing holds the browser afterwards", browserQueue().holder === null);

console.log("\n2. A run that throws does not block the next one");
const boom = withBrowser("a run that fails", async () => {
  throw new Error("browser fell over");
}).catch((e) => (e as Error).message);
check("the failure reaches its caller", (await boom) === "browser fell over");

let after = false;
await withBrowser("the next run", async () => {
  after = true;
});
check("…and the next run still gets the browser", after);
check("…with nothing left holding it", browserQueue().holder === null);

console.log("\n3. Order is the order asked");
const seen: number[] = [];
await Promise.all(
  [1, 2, 3, 4].map((n) =>
    withBrowser(`run ${n}`, async () => {
      seen.push(n);
      await wait(20);
    }),
  ),
);
check("first asked, first served", seen.join(",") === "1,2,3,4", seen.join(","));

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
