import { env, isEmburseConfigured } from "../env.js";
import { ProfessionalProvider } from "./professional.js";
import { OAuthProvider } from "./oauth.js";
import { DemoProvider } from "./demo.js";
import { NeonProvider } from "./neon.js";
import { isDbConfigured } from "../db.js";
import type { EmburseProvider } from "./types.js";

/**
 * Pick the provider for the configured product. With no credentials we fall
 * back to demo data so the app is fully explorable before Emburse access lands
 * — the response is marked `demo: true` so the UI can say so plainly.
 */
export function resolveProvider(): { provider: EmburseProvider; demo: boolean } {
  // Imported data is the real source now: Emburse Spend's API is provisioning
  // only and cannot serve expenses. A configured database therefore wins over
  // every API provider below.
  if (isDbConfigured()) return { provider: new NeonProvider(), demo: false };
  if (!isEmburseConfigured()) return { provider: new DemoProvider(), demo: true };

  switch (env.emburse.product) {
    case "enterprise":
      return { provider: new OAuthProvider("enterprise", "Emburse Enterprise"), demo: false };
    case "spend":
      return { provider: new OAuthProvider("spend", "Emburse Spend"), demo: false };
    case "professional":
    default:
      return { provider: new ProfessionalProvider(), demo: false };
  }
}
