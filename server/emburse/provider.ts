import { env, isEmburseConfigured } from "../env.js";
import { ProfessionalProvider } from "./professional.js";
import { OAuthProvider } from "./oauth.js";
import { DemoProvider } from "./demo.js";
import type { EmburseProvider } from "./types.js";

/**
 * Pick the provider for the configured product. With no credentials we fall
 * back to demo data so the app is fully explorable before Emburse access lands
 * — the response is marked `demo: true` so the UI can say so plainly.
 */
export function resolveProvider(): { provider: EmburseProvider; demo: boolean } {
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
