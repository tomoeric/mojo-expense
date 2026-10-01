/**
 * Two people's queues, one cache.
 *
 *   pnpm exec tsx scripts/test-reports-cache.ts
 *
 * Two faults, both only visible once the app had two reviewers.
 *
 * It held exactly ONE entry. Two people polling every few seconds evict
 * each other on every request: each poll misses, re-queries and stores an
 * entry the next poll throws away. It never served the wrong person's data
 * — the key is checked — it just stopped being a cache, silently, at the
 * moment the load doubled.
 *
 * And nothing could tell it the numbers had changed. Eric's import brought
 * 158 expenses at 5:31pm and his Review Queue went on saying "0 expenses
 * awaiting a decision · updated 5:29 PM" for the rest of the five-minute
 * window — which, in the middle of separating two reviewers' queues, reads
 * exactly like the separation having taken his away from him.
 */

import { TtlCache } from "../server/cache.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const cache = new TtlCache<string>(60_000);
let loads = 0;
const load = (v: string) => async () => { loads++; return v; };

console.log("\nEach person's queue is kept, not just the last one asked for");
await cache.get("eric", load("eric's 158"));
await cache.get("brian", load("brian's 306"));
{
  const before = loads;
  const eric = await cache.get("eric", load("SHOULD NOT RELOAD"));
  // The line this exists for: Brian asking must not cost Eric his entry.
  check("Eric's is still cached after Brian asked", loads === before, `${loads - before} reload(s)`);
  check("…and it is his", eric === "eric's 158", eric);
  const brian = await cache.get("brian", load("SHOULD NOT RELOAD"));
  check("Brian's is cached too", brian === "brian's 306" && loads === before);
}

console.log("\nIt never serves one person's data under another's key");
{
  const fresh = new TtlCache<string>(60_000);
  await fresh.get("eric", load("eric's"));
  const brian = await fresh.get("brian", load("brian's"));
  check("a new key loads rather than reusing what is there", brian === "brian's");
}

console.log("\nAn import can say the numbers changed");
{
  const before = loads;
  cache.clear();
  const eric = await cache.get("eric", load("eric's 158 after the import"));
  check("the next read goes to the database", loads === before + 1);
  check("…and sees what the import brought", eric === "eric's 158 after the import", eric);
}

console.log("\nTwo callers racing share one load, not two");
{
  const slow = new TtlCache<string>(60_000);
  let runs = 0;
  const together = await Promise.all([
    slow.get("same", async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return "x"; }),
    slow.get("same", async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return "x"; }),
  ]);
  check("the database was asked once", runs === 1, String(runs));
  check("…and both callers got the answer", together.every((v) => v === "x"));
}

console.log("\nIt does not grow without limit");
{
  const small = new TtlCache<string>(60_000, 4);
  for (const k of ["a", "b", "c", "d", "e", "f"]) await small.get(k, load(k));
  // The newest four survive, newest first so a reload cannot evict one of
  // the others and make this read as a smaller cache than it is.
  let kept = 0;
  for (const k of ["f", "e", "d", "c"]) {
    const n = loads;
    await small.get(k, load(k));
    if (loads === n) kept++;
  }
  check("the newest four are still there", kept === 4, `${kept} of 4`);
  const n = loads;
  await small.get("a", load("a"));
  check("…and the oldest was dropped", loads === n + 1);
}

console.log("\nAnd an expired entry is not served");
{
  const brief = new TtlCache<string>(10);
  await brief.get("k", load("old"));
  await new Promise((r) => setTimeout(r, 25));
  const v = await brief.get("k", load("new"));
  check("it reloads", v === "new", v);
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
