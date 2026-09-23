import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";

/**
 * The one Anthropic client, and what to say when it will not work.
 *
 * Credentials come in two shapes and the difference matters, because one of
 * them fails in a way that looks like a bug in this app:
 *
 *   1. Replit's Anthropic integration. This is NOT a key. Replit injects
 *      AI_INTEGRATIONS_ANTHROPIC_API_KEY=_DUMMY_API_KEY_ and points
 *      AI_INTEGRATIONS_ANTHROPIC_BASE_URL at a sidecar on localhost — today
 *      `http://localhost:1106/modelfarm/anthropic` — which holds the real
 *      credential and forwards the call. So the secrets look filled in on the
 *      Secrets page whether or not the integration behind them exists, and
 *      there is no way to tell from the outside: the sidecar answers
 *      `404 Replit AI Integrations is not configured` when nothing is
 *      connected to it, which is a normal HTTP failure from a URL that is
 *      plainly present.
 *   2. A direct key from console.anthropic.com, billed separately.
 *
 * The integration is preferred because it puts the cost on the Replit bill.
 * But a 404 from the sidecar used to be fatal even with a direct key sitting
 * right there in the environment, unused, because the integration won on
 * precedence and nothing ever reconsidered. So the sidecar gets one chance:
 * if it says it is not configured — or is not listening at all, which is what
 * a deployment without the integration looks like — and a direct key exists,
 * the client is rebuilt on the direct key and stays that way for the life of
 * the process.
 */

type Via = "replit" | "direct" | null;

const direct = (): string => process.env.ANTHROPIC_API_KEY?.trim() ?? "";
/** Only for a proxy in front of api.anthropic.com; normally unset. */
const directUrl = (): string => process.env.ANTHROPIC_BASE_URL?.trim() ?? "";
const gateway = (): { key: string; url: string } => ({
  key: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY?.trim() ?? "",
  url: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL?.trim() ?? "",
});

let client: Anthropic | null = null;
let via: Via = null;
/** Set once the gateway has told us it is not provisioned for this Repl. */
let gatewayDisowned = false;

/** Tests only: forget which credential was chosen. */
export function resetAiClient(): void {
  client = null;
  via = null;
  gatewayDisowned = false;
}

/**
 * Which credential is in play. Read off the environment rather than off the
 * `env` snapshot: `env` is frozen at import, and this has to stay right after
 * the gateway has been disowned mid-process.
 */
export function aiVia(): Via {
  if (via) return via;
  if (!gatewayDisowned && gateway().key) return "replit";
  if (direct()) return "direct";
  return null;
}

export function anthropic(): Anthropic {
  if (client) return client;
  const g = gateway();
  if (!gatewayDisowned && g.key) {
    via = "replit";
    client = new Anthropic({ apiKey: g.key, ...(g.url ? { baseURL: g.url } : {}) });
  } else if (direct()) {
    via = "direct";
    // Without ANTHROPIC_BASE_URL the SDK's own default is api.anthropic.com.
    client = new Anthropic({ apiKey: direct(), ...(directUrl() ? { baseURL: directUrl() } : {}) });
  } else {
    // No usable credential. A client is still handed back so callers fail on
    // the call with an auth error rather than on a missing object; the guard
    // that should have stopped them is `isAuditConfigured()`.
    via = null;
    client = new Anthropic({ apiKey: env.audit.apiKey });
  }
  return client;
}

/**
 * True when the failure was the Replit gateway disowning this Repl, in which
 * case the client has been rebuilt and the call is worth trying once more.
 */
export function retryOnDirectKey(err: unknown): boolean {
  if (gatewayDisowned || via !== "replit") return false;
  if (!isGatewayUnconfigured(err)) return false;
  gatewayDisowned = true;
  client = null;
  via = null;
  if (!direct()) return false;
  console.warn(
    "ai: the Replit Anthropic integration answered 'not configured' — falling back to ANTHROPIC_API_KEY.",
  );
  anthropic();
  return true;
}

/**
 * Two ways the sidecar says it cannot help, and they mean the same thing:
 * no Anthropic integration is attached to this app.
 *
 *   - 404 "Replit AI Integrations is not configured" — it is listening, with
 *     nothing behind it.
 *   - a connection error — it is not running at all, which is what a
 *     deployment gets when the integration was only enabled for the workspace.
 */
function isGatewayUnconfigured(err: unknown): boolean {
  if (err instanceof Anthropic.APIError && err.status === 404) {
    return /not configured/i.test(err.message ?? "");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return /localhost|127\.0\.0\.1/i.test(gateway().url);
  }
  return false;
}

/** Run an Anthropic call, retrying once on a direct key if the gateway disowns us. */
export async function callAnthropic<T>(fn: (c: Anthropic) => Promise<T>): Promise<T> {
  try {
    return await fn(anthropic());
  } catch (err) {
    if (!retryOnDirectKey(err)) throw err;
    return await fn(anthropic());
  }
}

/**
 * A sentence a reviewer can act on, for the failures that are configuration
 * rather than a bad receipt. Returns null for everything else, so callers keep
 * their own wording for real errors.
 */
export function describeAiConfig(err: unknown): string | null {
  if (isGatewayUnconfigured(err)) {
    return direct()
      ? "No Anthropic integration is attached to this app, and the direct ANTHROPIC_API_KEY was not accepted either."
      : "No Anthropic integration is attached to this app. The AI_INTEGRATIONS_ANTHROPIC_* secrets always look filled in — " +
        "the key is a placeholder and the URL points at a Replit sidecar that holds the real credential — so a complete " +
        "Secrets page proves nothing. Connect Anthropic under Setup → Integrations, make sure it is enabled for the " +
        "deployment and not just the workspace, and republish. Or set ANTHROPIC_API_KEY to a direct key from " +
        "console.anthropic.com, which bypasses Replit entirely.";
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return via === "replit"
      ? "Replit's AI sidecar rejected the call. Re-connect Anthropic under Setup → Integrations and republish."
      : "ANTHROPIC_API_KEY was rejected.";
  }
  return null;
}

/** One line at boot saying which credential is in play, so a 404 later is not a mystery. */
export function logAiCredential(): void {
  const v = aiVia();
  if (!v) {
    console.log("ai: no Anthropic credential — receipt reading and checking are off.");
  } else if (v === "replit") {
    console.log(
      `ai: routing through Replit's AI sidecar at ${gateway().url || "(no base URL set)"} — ` +
      "the key here is a placeholder, so this only works if an Anthropic integration is attached to this app.",
    );
  } else {
    console.log(`ai: using a direct ANTHROPIC_API_KEY${directUrl() ? ` via ${directUrl()}` : ""}.`);
  }
}
