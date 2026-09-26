/**
 * Which Anthropic credential gets used, and what happens when Replit's
 * gateway disowns the app.
 *
 *   pnpm exec tsx scripts/test-ai-credential.ts     (no key or network needed)
 *
 * This exists because the failure it covers is indistinguishable from a
 * working setup right up to the first call. Replit's integration is not a key:
 * it sets AI_INTEGRATIONS_ANTHROPIC_API_KEY to the literal string
 * `_DUMMY_API_KEY_` and points the base URL at a sidecar on localhost that
 * holds the real credential. Both secrets are therefore always present and
 * always look right, whether or not an Anthropic integration is attached — and
 * when none is, every call comes back `404 Replit AI Integrations is not
 * configured`, while a perfectly good ANTHROPIC_API_KEY sits unused beside
 * them because the integration wins on precedence.
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
/** Flips the stand-in from "not configured" to "here is a 401". */
let rejecting = false;
const server = http.createServer((req, res) => {
  if (rejecting) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    }));
    return;
  }
  if (req.url?.startsWith("/missing-model")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: "model: claude-opus-5" },
    }));
    return;
  }
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
  // Exactly what Replit injects, placeholder and all.
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "_DUMMY_API_KEY_";
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
  check("it says the filled-in secrets prove nothing",
    Boolean(said && /placeholder/i.test(said) && /proves nothing/i.test(said)));
  check("it covers the deployment-vs-workspace trap",
    Boolean(said && /deployment/i.test(said)));
  check("and offers the way out that does not involve Replit",
    Boolean(said && /console\.anthropic\.com/.test(said)));

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

  // 2b. The sidecar not listening at all — a deployment where the integration
  // was only ever enabled for the workspace. Same meaning, different error.
  console.log("\nThe sidecar not running at all");
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "http://127.0.0.1:5407/modelfarm/anthropic";
  directCalls = 0;
  ai.resetAiClient();
  const viaDead = await ai.callAnthropic(ask);
  check("a connection failure is read the same way as the 404", Boolean(viaDead));
  check("and it too lands on the direct key", ai.aiVia() === "direct", String(ai.aiVia()));
  check("the direct endpoint served it", directCalls === 1, `direct=${directCalls}`);

  // A 401 is a different failure from "not configured": something received the
  // call and turned it down. The message has to name WHICH credential, because
  // the old wording named ANTHROPIC_API_KEY even when the sidecar was in use.
  console.log("\nA credential that is present but rejected");
  rejecting = true;
  const reject = async (): Promise<string> => {
    ai.resetAiClient();
    try {
      await ai.callAnthropic(ask);
    } catch (e) {
      return ai.describeAiConfig(e) ?? "(no configuration message)";
    }
    return "(the call unexpectedly succeeded)";
  };

  // The direct key turned down. Nothing to re-provision — the key is wrong.
  delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  delete process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const direct401 = await reject();
  check("a rejected direct key says it is wrong rather than missing",
    /direct ANTHROPIC_API_KEY was rejected/.test(direct401) && /sk-ant-/.test(direct401), direct401);
  check("…and does not send you to Integrations for a key problem",
    !/Setup → Integrations/.test(direct401));

  // A rejected key is almost always a DAMAGED copy rather than a wrong one,
  // and every way it gets damaged is invisible in a Secrets box. The message
  // has to describe the key well enough to spot that — and not so well that
  // it hands the key to anybody who can read an error.
  console.log("\nWhat a rejected key says about itself");
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedUrl = process.env.ANTHROPIC_BASE_URL;

  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-REALSECRETMATERIAL0123456789abcdefXYZ";
  delete process.env.ANTHROPIC_BASE_URL;
  const shaped = await reject();
  check("it gives the length, so a truncated paste is obvious",
    /50 characters/.test(shaped), shaped);
  check("…and both ends, so it can be matched against the console",
    /sk-ant-api03-R/.test(shaped) && /fXYZ/.test(shaped));
  check("…but never the middle of the key",
    !shaped.includes("REALSECRETMATERIAL"), "the secret must not appear in an error");

  process.env.ANTHROPIC_API_KEY = '  "sk-ant-api03-quoted-and-padded-key"  ';
  const damaged = await reject();
  check("whitespace around the secret is called out",
    /whitespace around it/.test(damaged), damaged);
  check("…and so are quotes typed in by hand",
    /wrapped in quotes/.test(damaged));
  // A quoted key obviously does not start sk-ant- — but the quote is the one
  // thing to fix, and listing both reads as two problems to chase.
  check("…without also reporting the prefix it broke",
    !/does not start/.test(damaged), damaged);

  // The one claim the old message made without checking. With a base URL set
  // the 401 came from that proxy, and "the key reached Anthropic" is false —
  // sending somebody off to rotate a good key is the wrong answer entirely.
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-fine";
  process.env.ANTHROPIC_BASE_URL = `${base}/direct`;
  const proxied = await reject();
  check("a base URL is named rather than assuming Anthropic answered",
    /ANTHROPIC_BASE_URL is set/.test(proxied) && proxied.includes(`${base}/direct`), proxied);
  check("…and it does not claim the key reached Anthropic",
    !/reached Anthropic/.test(proxied));

  process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = savedUrl;

  // The sidecar turned it down. Same HTTP status, completely different fix —
  // and the old wording blamed ANTHROPIC_API_KEY for both.
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "_DUMMY_API_KEY_";
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = `${base}/gw`;
  const sidecar401 = await reject();
  check("a rejected sidecar call blames the sidecar, not the key",
    /sidecar rejected/.test(sidecar401) && !/sk-ant-/.test(sidecar401), sidecar401);
  check("…and sends you where the fix actually is",
    /Setup → Integrations/.test(sidecar401) && /deployment/.test(sidecar401));
  rejecting = false;

  // The button on the Configuration page. Its whole job is to turn each of the
  // states above into a sentence somebody can act on, in the place the setting
  // is changed — rather than three screens away as a failed receipt check.
  console.log("\nThe connection test");
  rejecting = false;
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "_DUMMY_API_KEY_";
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = `${base}/direct`;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  ai.resetAiClient();
  const good = await ai.checkAi("claude-opus-5");
  check("a working credential reports ok, and which one", good.ok && good.via === "replit",
    JSON.stringify(good));
  check("…and names what answered", good.served === "claude-opus-5", String(good.served));

  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = `${base}/gw`;
  ai.resetAiClient();
  const unconfigured = await ai.checkAi("claude-opus-5");
  check("an unattached integration reports the fix, not a status code",
    !unconfigured.ok && /Setup → Integrations/.test(unconfigured.error ?? ""), unconfigured.error);

  delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  delete process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  ai.resetAiClient();
  const none = await ai.checkAi("claude-opus-5");
  check("no credential at all says so plainly",
    !none.ok && none.via === null && /No Anthropic credential/.test(none.error ?? ""), none.error);

  // A credential that works against a gateway serving a different model is its
  // own failure, and "not found" on its own would read as a broken key.
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "_DUMMY_API_KEY_";
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = `${base}/missing-model`;
  ai.resetAiClient();
  const wrongModel = await ai.checkAi("claude-opus-5");
  check("a model the gateway does not serve is called out as a model problem",
    !wrongModel.ok && /RECEIPT_AUDIT_MODEL/.test(wrongModel.error ?? ""), wrongModel.error);

  // Put back what this block borrowed. The cases below assert on the direct
  // key, and a block that quietly leaves the environment changed makes the
  // next one fail for a reason that has nothing to do with it.
  process.env.ANTHROPIC_API_KEY = "direct-key";
  process.env.ANTHROPIC_BASE_URL = `${base}/direct`;

  // 3. A direct key on its own.
  console.log("\nA direct key on its own");
  delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  delete process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  ai.resetAiClient();
  check("it is used without touching any sidecar", ai.aiVia() === "direct", String(ai.aiVia()));

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
