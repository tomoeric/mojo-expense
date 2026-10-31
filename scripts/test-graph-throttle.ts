/**
 * Microsoft rate-limiting is waited out, not reported.
 *
 *   pnpm exec tsx scripts/test-graph-throttle.ts
 *
 * The card said *"Graph would not hand over the message (429)"*,
 * which is not a problem a person can act on: 429 is Graph asking
 * for a moment, with a `Retry-After` header saying how long. Three
 * call sites read that header in none of their code.
 *
 * Checked here without a network: `graphRead` takes its own sleep,
 * so a four-attempt back-off runs in microseconds and the waits can
 * be asserted exactly.
 */
import {
  clearGate, gateMs, graphRead, waitMs, MAX_WAIT_MS,
} from "../server/graph-read.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

/* Graph is never actually called: `fetch` is replaced for the test. */
type Reply = { status: number; retryAfter?: string };
let script: Reply[] = [];
const asked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  // The token call, which `graphRead` makes through `graphToken`.
  if (url.includes("login.microsoftonline.com")) {
    return new Response(
      JSON.stringify({ access_token: "t", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  asked.push(url);
  const next = script.shift() ?? { status: 200 };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (next.retryAfter !== undefined) headers["retry-after"] = next.retryAfter;
  return new Response(JSON.stringify({ ok: next.status === 200 }),
    { status: next.status, headers });
}) as typeof fetch;

process.env.AZURE_TENANT_ID ??= "t";
process.env.AZURE_CLIENT_ID ??= "c";
process.env.AZURE_CLIENT_SECRET ??= "s";

const slept: number[] = [];
const sleep = async (ms: number): Promise<void> => { slept.push(ms); };

console.log("1. Retry-After, read the two ways Graph writes it");
check("seconds are seconds", waitMs("12", 0) === 12_000, `${waitMs("12", 0)}`);
check("zero is honoured, not treated as absent", waitMs("0", 3) === 0);
check("a rude header is capped",
  waitMs("3600", 0) === MAX_WAIT_MS, `${waitMs("3600", 0)}`);
{
  const soon = new Date(Date.now() + 5_000).toUTCString();
  const ms = waitMs(soon, 0);
  check("an HTTP date becomes a duration", ms > 3_000 && ms <= 5_000, `${ms}`);
}
{
  const past = new Date(Date.now() - 60_000).toUTCString();
  check("a date already gone waits no time", waitMs(past, 0) === 0);
}
{
  // No header: exponential, and never two callers in step.
  const a = waitMs(null, 0);
  const b = waitMs(null, 2);
  check("no header backs off exponentially", a >= 1000 && a < 1300 && b >= 4000 && b < 4300,
    `${a} then ${b}`);
  const jitter = new Set([waitMs(null, 0), waitMs(null, 0), waitMs(null, 0),
    waitMs(null, 0), waitMs(null, 0), waitMs(null, 0)]);
  check("and is jittered, so parallel callers scatter", jitter.size > 1);
}
check("garbage is treated as no header at all", waitMs("soon-ish", 1) >= 2000);

console.log("2. A throttled read succeeds, and says nothing about it");
clearGate();
slept.length = 0; asked.length = 0;
script = [
  { status: 429, retryAfter: "2" },
  { status: 429, retryAfter: "1" },
  { status: 200 },
];
{
  const res = await graphRead("/users/a@b.com/messages/x", { sleep });
  check("the caller is handed a 200, not a 429", res.status === 200, `${res.status}`);
  check("it asked three times", asked.length === 3, `${asked.length}`);
  check("waiting exactly as long as Graph asked",
    slept.includes(2000) && slept.includes(1000), JSON.stringify(slept));
}

console.log("3. One 429 holds back every other Graph read in the process");
clearGate();
script = [{ status: 429, retryAfter: "8" }, { status: 200 }];
slept.length = 0;
await graphRead("/users/a@b.com/messages/y", { sleep });
check("the shared gate is set by the refusal",
  gateMs() > 6_000, `${gateMs()}ms left`);
{
  // The next caller waits behind it instead of spending its own budget.
  slept.length = 0;
  script = [{ status: 200 }];
  await graphRead("/users/a@b.com/messages/z", { sleep });
  check("the next read waits behind the gate before trying",
    slept.length === 1 && slept[0]! > 6_000, JSON.stringify(slept));
}

console.log("4. Still throttled after the whole budget: the status comes through");
clearGate();
script = [
  { status: 429, retryAfter: "1" }, { status: 429, retryAfter: "1" },
  { status: 429, retryAfter: "1" }, { status: 429, retryAfter: "1" },
  { status: 429, retryAfter: "1" },
];
asked.length = 0;
{
  const res = await graphRead("/users/a@b.com/messages/w", { sleep, tries: 3 });
  check("the budget is respected", asked.length === 3, `${asked.length}`);
  check("and the caller gets to say its own words about it", res.status === 429);
}

console.log("5. A 503 is throttling too; a 404 is not");
clearGate();
script = [{ status: 503, retryAfter: "1" }, { status: 200 }];
asked.length = 0;
check("503 is retried",
  (await graphRead("/x", { sleep })).status === 200 && asked.length === 2,
  `${asked.length} tries`);
clearGate();
script = [{ status: 404 }];
asked.length = 0;
check("404 comes straight back",
  (await graphRead("/x", { sleep })).status === 404 && asked.length === 1);

console.log("6. A 403 still gets one fresh token, as it always did");
clearGate();
script = [{ status: 403 }, { status: 200 }];
asked.length = 0;
{
  const res = await graphRead("/x", { sleep });
  check("the second attempt is on a new token", asked.length === 2, `${asked.length}`);
  check("and it succeeds", res.status === 200);
}

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nAll good." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
