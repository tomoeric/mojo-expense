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
  // Nowhere to go: leave the gateway alone. Disowning it is only ever useful
  // as "switch to the direct key", and doing it with no key to switch to just
  // blinds the app — `aiVia()` then returns null, every later call reports
  // "No Anthropic credential is set" (which is false, the secrets are right
  // there), and the sidecar is never tried again for the life of the process.
  // So attaching the integration afterwards changed nothing until a restart,
  // which is exactly the loop this was supposed to get people out of.
  if (!direct()) return false;
  gatewayDisowned = true;
  client = null;
  via = null;
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
 * Enough of a key to recognise, never enough to use.
 *
 * A rejected key is almost always a damaged copy rather than a wrong one, and
 * every way it gets damaged is invisible in a Secrets box: a trailing newline
 * from a paste, surrounding quotes typed in by hand, a truncation from a
 * half-selected copy. Reading the length and both ends back tells you which
 * of those happened in one glance, and matches what console.anthropic.com
 * shows beside each key.
 *
 * `direct()` has already trimmed, so the whitespace and quote notes describe
 * the RAW secret — the whole point is to surface what trimming hid.
 */
function fingerprint(key: string): string {
  const raw = process.env.ANTHROPIC_API_KEY ?? "";
  if (!key) return "empty";
  const notes: string[] = [];
  if (raw !== key) notes.push("has whitespace around it");
  // Stripped before the prefix check, so a quoted key is reported as quoted
  // rather than as two separate faults — the quote IS why it does not start
  // sk-ant-, and saying both reads as two problems to chase.
  const bare = key.replace(/^["']|["']$/g, "");
  if (bare !== key) notes.push("is wrapped in quotes, which become part of the key");
  else if (!bare.startsWith("sk-ant-")) notes.push("does not start sk-ant-");
  if (/\s/.test(bare)) notes.push("has a space or newline inside it");

  const shape = `${key.slice(0, 14)}…${key.slice(-4)}, ${key.length} characters`;
  if (notes.length === 0) return shape;
  const last = notes.pop()!;
  return `${shape} — and it ${notes.length > 0 ? `${notes.join("; ")}; and ${last}` : last}`;
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
    // Which credential was rejected is the whole question, and the bare
    // "ANTHROPIC_API_KEY was rejected" named the one that may not even be in
    // use. A 401 also rules out the configuration faults above: something
    // received the call and turned it down.
    if (aiVia() === "replit") {
      return "Replit's AI sidecar rejected the call (401). The integration is attached but is not accepting it — " +
        "re-connect Anthropic under Setup → Integrations, check it is enabled for the deployment, and republish.";
    }
    // "It reached Anthropic" is only true when nothing sits in front of
    // api.anthropic.com. With ANTHROPIC_BASE_URL set — a leftover from
    // another project, or a sidecar address copied across — the 401 came from
    // whatever is at that URL instead, and sending somebody off to rotate a
    // perfectly good key is the wrong answer entirely.
    const where = directUrl();
    return (
      (where
        ? `The direct ANTHROPIC_API_KEY was rejected (401) by ${where} — ANTHROPIC_BASE_URL is set, so the call ` +
          `went there rather than to api.anthropic.com. Either that proxy does not accept this key, or the ` +
          `variable is a leftover and should be unset. `
        : "The direct ANTHROPIC_API_KEY was rejected (401). The key reached Anthropic and was turned down, so it " +
          "is wrong rather than missing. ") +
      `The key in use is ${fingerprint(direct())} — check that against console.anthropic.com for a stray space, ` +
      "quote or truncation, and that it has not been revoked. Note an admin key (sk-ant-admin…) also starts " +
      "sk-ant- and is rejected here: this needs an ordinary API key."
    );
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return aiVia() === "replit"
      ? "Replit's AI sidecar refused the call (403). Check the Anthropic integration is enabled for the deployment."
      : "ANTHROPIC_API_KEY was refused (403) — the key is valid but not allowed to use this model.";
  }
  return null;
}

export type AiCheck = {
  ok: boolean;
  /** Which credential was used, as the app sees it right now. */
  via: Via;
  /** Where the sidecar is, when one is configured — the thing that cannot be copied. */
  gatewayUrl: string;
  model: string;
  /** Present on success: what actually answered. */
  served?: string;
  /** Present on failure: a sentence with the fix in it. */
  error?: string;
};

/**
 * Ask Anthropic one trivial question and report what happened.
 *
 * Until this existed the only way to find out whether the credential worked
 * was to open an expense, find one with a receipt, and press Check — three
 * steps away from the setting being changed, with an error that could mean
 * four different things. Configuration should be testable where it is set.
 *
 * A real `messages.create` rather than a cheaper metadata call: the point is to
 * exercise the path the receipt reader uses, including whichever proxy sits in
 * front of it, and a gateway can serve `/v1/models` while refusing the model.
 */
export async function checkAi(model = env.audit.model): Promise<AiCheck> {
  // Start clean every time. Somebody pressing this has just changed something
  // — attached the integration, pasted a new key — and is asking whether it
  // worked now. Answering from a client chosen minutes ago, or from a gateway
  // disowned by an earlier failure, makes the button report the past and look
  // broken. It is one four-token call; rebuilding the client costs nothing.
  resetAiClient();

  const base: AiCheck = { ok: false, via: aiVia(), gatewayUrl: gateway().url, model };

  if (!aiVia()) {
    return { ...base, error: "No Anthropic credential is set, so receipt reading and checking are off." };
  }

  try {
    const response = await callAnthropic((c) =>
      c.messages.create({
        model,
        // Four tokens: this is a connectivity check, not a question.
        max_tokens: 4,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    );
    return { ...base, ok: true, via: aiVia(), served: response.model };
  } catch (err) {
    return {
      ...base,
      via: aiVia(),
      error:
        describeAiConfig(err) ??
        (err instanceof Anthropic.NotFoundError
          ? `The credential works, but “${model}” was not found. Set RECEIPT_AUDIT_MODEL to a model this ` +
            `gateway serves — ninja-live-status uses claude-sonnet-4-6.`
          : err instanceof Anthropic.APIError
            ? `The call failed (HTTP ${err.status}): ${err.message.slice(0, 200)}`
            : err instanceof Error
              ? err.message.slice(0, 300)
              : "The call failed."),
    };
  }
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
