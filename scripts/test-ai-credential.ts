/**
 * Which Anthropic credential gets used, and what happens when Replit's
 * gateway disowns the app.
 *
 *   pnpm exec tsx scripts/test-ai-credential.ts     (no key or network needed)
 *
 * This exists because the failure it covers is indistinguishable from a
 * working setup right up to the first call. AI_INTEGRATIONS_ANTHROPIC_API_KEY
 * and AI_INTEGRATIONS_ANTHROPIC_BASE_URL copied from another Repl look
 * complete in the secrets list, pass every "is it configured" check, and then
 * answer every request with `404 Replit AI Integrations is not configured` —
 * while a perfectly good ANTHROPIC_API_KEY sits unused beside them because the
 * integration wins on precedence.
 */

import http from "node:http";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A stand-in for both endpoints: /gw plays Replit's unprovisioned gateway,
// /direct plays api.anthropic.com.
let gatewayCalls = 0;
let directCalls = 0;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/gw")) {
    gatewayCalls++;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: "Replit AI Integrations is not configured" },
    }));
    return;
  }
  directCalls++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
});
await new Promise<void>((r) => server.listen(5406, "127.0.0.1", r));
const base = "http://127.0.0.1:5406";

const ask = (c: { messages: { create: (b: never) => Promise<unknown> } }) =>
  c.messages.create({
    model: "claude-opus-5", max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  } as never);

try {
  // 1. Gateway alone, unprovisioned, with no direct key to fall back to.
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "replit-key";
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = `${base}/gw`;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;

  const ai = await import("../server/ai.js");
  ai.resetAiClient();

  console.log("\nThe integration is preferred");
  check("the Replit integration is chosen when it is present", ai.aiVia() === "replit", String(ai.aiVia()));

  console.log("\nAn unprovisioned gateway with nothing to fall back to");
  let err: unknown = null;
  try {
    await ai.callAnthropic(ask);
  } catch (e) {
    err = e;
  }
  check("the call fails rather than hanging", err !== null);
  const said = ai.describeAiConfig(err);
  check("the failure names the fix, not the status code",
    Boolean(said && /Setup → Integrations/.test(said) && !/HTTP 404/.test(said)),
    said ?? "(nothing)");
  check("it says a copied key is the likely cause",
    Boolean(said && /different Repl/i.test(said)));

  // 2. Same gateway, but a direct key is available.
  console.log("\nAn unprovisioned gateway WITH a direct key");
  gatewayCalls = 0;
  directCalls = 0;
  process.env.ANTHROPIC_API_KEY = "direct-key";
  process.env.ANTHROPIC_BASE_URL = `${base}/direct`;
  ai.resetAiClient();

  const out = await ai.callAnthropic(ask);
  check("the call succeeds on the direct key", Boolean(out));
  check("the gateway was tried first", gatewayCalls === 1, `gateway=${gatewayCalls}`);
  check("and the direct endpoint served it", directCalls === 1, `direct=${directCalls}`);
  check("the client stays on the direct key", ai.aiVia() === "direct", String(ai.aiVia()));

  // Once disowned, the gateway must not be retried on every subsequent call —
  // that would double the latency of every receipt for the rest of the day.
  await ai.callAnthropic(ask);
  check("the dead gateway is not tried again", gatewayCalls === 1, `gateway=${gatewayCalls}`);
  check("the second call went direct too", directCalls === 2, `direct=${directCalls}`);

  // 3. A direct key on its own.
  console.log("\nA direct key on its own");
  delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  delete process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  ai.resetAiClient();
  check("it is used without touching any gateway", ai.aiVia() === "direct", String(ai.aiVia()));

  // 4. Nothing at all.
  console.log("\nNo credential at all");
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  ai.resetAiClient();
  check("says so rather than pretending", ai.aiVia() === null, String(ai.aiVia()));
} finally {
  server.close();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
