import { env } from "../env.js";
import { ProfessionalProvider } from "./professional.js";

type Token = { value: string; expiresAt: number };

/**
 * Emburse Enterprise (Chrome River) and Emburse Spend both authenticate with
 * OAuth2 client credentials rather than a key/secret header pair. Everything
 * after the token exchange — paging, date filtering, row mapping — is identical
 * to Professional, so this subclasses it and swaps only the auth step.
 *
 * Point `EMBURSE_API_URL`, `EMBURSE_TOKEN_URL` and the `*_PATH` vars at the
 * tenant's Swagger; no code change is needed to move between the two products.
 */
export class OAuthProvider extends ProfessionalProvider {
  private token: Token | null = null;
  private inflight: Promise<Token> | null = null;

  constructor(
    override readonly id: string,
    override readonly label: string,
  ) {
    super();
  }

  /**
   * Synchronous by contract (it overrides `headers()`), so it can only use an
   * already-cached token. `fetchReports` primes the cache first.
   */
  protected override headers(): Record<string, string> {
    if (!this.token) throw new Error("OAuth token not acquired");
    return { authorization: `Bearer ${this.token.value}` };
  }

  private async ensureToken(): Promise<void> {
    // 60s of slack so a token cannot expire mid-page-walk.
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return;
    this.inflight ??= this.requestToken().finally(() => {
      this.inflight = null;
    });
    this.token = await this.inflight;
  }

  private async requestToken(): Promise<Token> {
    const e = env.emburse;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: e.clientId,
      client_secret: e.clientSecret,
    });
    if (e.scope) body.set("scope", e.scope);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), e.timeoutMs);
    try {
      const res = await fetch(e.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        // Never echo the response body — a failed token exchange can reflect
        // the submitted client_secret back in its error payload.
        throw new Error(`Token request failed: ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!json.access_token) throw new Error("Token response had no access_token");
      return {
        value: json.access_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  override async fetchReports(window: Parameters<ProfessionalProvider["fetchReports"]>[0]) {
    await this.ensureToken();
    return super.fetchReports(window);
  }
}
