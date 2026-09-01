import * as oidc from "openid-client";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  SESSION_TTL_MS,
  clearSessionCookie,
  readSession,
  setSessionCookie,
  type SessionUser,
} from "./session.js";

/**
 * Microsoft SSO via Entra ID (OpenID Connect + PKCE), matching how
 * ninja-live-status authenticates — same app registration variables, same
 * tenant-scoped issuer, same authorization-code-with-PKCE flow.
 */

const tenantId = () => (process.env.AZURE_TENANT_ID ?? "").trim();
const clientId = () => (process.env.AZURE_CLIENT_ID ?? "").trim();
const clientSecret = () => (process.env.AZURE_CLIENT_SECRET ?? "").trim();

/** Sign-in is available only once the Entra app registration is configured. */
export function isAuthConfigured(): boolean {
  return Boolean(tenantId() && clientId() && clientSecret());
}

/**
 * Optional allow-list, on top of the tenant restriction the issuer already
 * enforces. Emails and/or domains:
 *   AUTH_ALLOWED=ap@mojocarwash.com, eric.s@mojocarwash.com
 *   AUTH_ALLOWED=mojocarwash.com
 * Empty (the default) means anyone in the tenant may sign in.
 *
 * Parsing is deliberately forgiving, because this is typed into a Secrets box
 * by hand: entries may be separated by commas, spaces or newlines; surrounding
 * quotes are stripped (pasting `"a@b.com"` should not silently lock everyone
 * out); and a domain written `@mojocarwash.com` is accepted as well as bare.
 */
function allowList(): string[] {
  return (process.env.AUTH_ALLOWED ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^["']|["']$/g, ""))
    .map((s) => (s.startsWith("@") ? s.slice(1) : s))
    .filter(Boolean);
}

/** Entry count, for the boot log — never the addresses themselves. */
export function allowListSize(): number {
  return allowList().length;
}

export function isAllowed(email: string): boolean {
  const list = allowList();
  if (list.length === 0) return true;
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1] ?? "";
  return list.includes(lower) || list.includes(domain);
}

let configPromise: Promise<oidc.Configuration> | null = null;

function getOidcConfig(): Promise<oidc.Configuration> {
  // Tenant-scoped issuer: only accounts in this Entra tenant can sign in.
  configPromise ??= oidc.discovery(
    new URL(`https://login.microsoftonline.com/${tenantId()}/v2.0`),
    clientId(),
    clientSecret(),
  );
  return configPromise;
}

function origin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "localhost";
  return `${proto}://${host}`;
}

/** Only same-site paths — never an absolute or protocol-relative URL. */
function safeReturnTo(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

const TRANSIENT_TTL_MS = 10 * 60 * 1000;

function setTransient(res: Response, name: string, value: string): void {
  res.cookie(name, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TRANSIENT_TTL_MS,
  });
}

const TRANSIENT = ["code_verifier", "nonce", "state", "return_to"] as const;

function clearTransient(res: Response): void {
  for (const name of TRANSIENT) res.clearCookie(name, { path: "/" });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

/** Populates `req.user` from the session cookie. Never rejects. */
export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const user = readSession(req);
  if (user) req.user = user;
  next();
}

/**
 * Guards a route. When sign-in is not configured the guard is open — a fresh
 * import is explorable — but `routes.ts` refuses to serve real Emburse data in
 * that state, so open never means exposed.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthConfigured() || req.user) {
    next();
    return;
  }
  res.status(401).json({ error: "Not signed in", loginUrl: "/api/login" });
}

export const authRouter: IRouter = Router();

authRouter.get("/auth/user", (req: Request, res: Response) => {
  res.json({
    user: req.user ?? null,
    authConfigured: isAuthConfigured(),
  });
});

authRouter.get("/login", async (req: Request, res: Response) => {
  if (!isAuthConfigured()) {
    res.status(503).json({
      error: "Microsoft sign-in is not configured.",
      missing: ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"].filter(
        (k) => !(process.env[k] ?? "").trim(),
      ),
    });
    return;
  }

  try {
    const config = await getOidcConfig();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

    const redirectTo = oidc.buildAuthorizationUrl(config, {
      redirect_uri: `${origin(req)}/api/callback`,
      scope: "openid email profile",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_type: "code",
      state,
      nonce,
    });

    setTransient(res, "code_verifier", codeVerifier);
    setTransient(res, "nonce", nonce);
    setTransient(res, "state", state);
    setTransient(res, "return_to", safeReturnTo(req.query.returnTo));

    res.redirect(redirectTo.href);
  } catch (err) {
    console.error("OIDC login error:", err);
    res.status(502).json({ error: "Could not reach Microsoft sign-in." });
  }
});

authRouter.get("/callback", async (req: Request, res: Response) => {
  const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
  const { code_verifier: codeVerifier, nonce, state: expectedState } = cookies;
  const returnTo = safeReturnTo(cookies.return_to);

  if (!codeVerifier || !expectedState) {
    res.redirect("/api/login");
    return;
  }

  try {
    const config = await getOidcConfig();
    const callbackUrl = `${origin(req)}/api/callback`;
    const currentUrl = new URL(
      `${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`,
    );

    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims?.sub) {
      clearTransient(res);
      res.redirect("/api/login");
      return;
    }

    const email = String(claims.email ?? claims.preferred_username ?? "");
    clearTransient(res);

    if (!isAllowed(email)) {
      // Authenticated in the tenant, but not on this app's allow-list.
      res.status(403).type("html").send(deniedPage(email));
      return;
    }

    const user: SessionUser = {
      id: String(claims.oid ?? claims.sub),
      email,
      name: String(claims.name ?? email),
      exp: Date.now() + SESSION_TTL_MS,
    };

    setSessionCookie(res, user);
    res.redirect(returnTo);
  } catch (err) {
    console.error("OIDC callback error:", err);
    clearTransient(res);
    res.status(401).type("html").send(errorPage());
  }
});

authRouter.get("/logout", (_req: Request, res: Response) => {
  clearSessionCookie(res);
  // Local sign-out only — deliberately not a tenant-wide Entra sign-out, which
  // would also sign the user out of Outlook, Teams and every other M365 app.
  res.redirect("/");
});

const shell = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · MOJO Expense</title>
<style>
  body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
       display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#18181b}
  .card{max-width:26rem;padding:2rem;border:1px solid #e4e4e7;border-radius:.75rem;background:#fff;text-align:center}
  h1{font-size:1.1rem;margin:0 0 .5rem}
  p{color:#52525b;font-size:.9rem;line-height:1.5;margin:0 0 1.25rem}
  a{display:inline-block;background:#18181b;color:#fff;text-decoration:none;
    padding:.55rem 1.1rem;border-radius:.5rem;font-size:.875rem;font-weight:600}
</style></head><body><div class="card">${body}</div></body></html>`;

const deniedPage = (email: string): string =>
  shell(
    "Access denied",
    `<h1>Access denied</h1><p>${escapeHtml(email)} is not on the access list for MOJO Expense.
     Ask an administrator to add you to <code>AUTH_ALLOWED</code>.</p>
     <a href="/api/logout">Sign out</a>`,
  );

const errorPage = (): string =>
  shell(
    "Sign-in failed",
    `<h1>Sign-in failed</h1><p>The Microsoft sign-in could not be completed. This is usually a
     stale link or an expired attempt — starting again normally fixes it.</p>
     <a href="/api/login">Try again</a>`,
  );

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
