import crypto from "node:crypto";
import type { Request, Response } from "express";

/**
 * Stateless, signed session cookies.
 *
 * ninja-live-status keeps sessions in Postgres; this app has no database, so a
 * session is an HMAC-signed JSON payload in an httpOnly cookie instead. That
 * keeps the app single-process and DB-free.
 *
 * Deliberately NOT stored: the access and refresh tokens. We only need the
 * user's identity, and a refresh token in a cookie is a credential sitting on
 * the client. When the session lapses the user is redirected back through
 * Entra, which is silent while their Microsoft SSO session is alive.
 */

export const SESSION_COOKIE = "mojo_sid";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h — a working day.

export type SessionUser = {
  /** Entra object id (the `sub`/`oid` claim). */
  id: string;
  email: string;
  name: string;
  /** Epoch ms. */
  exp: number;
};

let cachedSecret: string | null = null;

/**
 * The signing key. In production `SESSION_SECRET` is required — without it a
 * restart would silently invalidate every session, and worse, a predictable
 * key would let anyone forge one. In development we generate an ephemeral key
 * and say so.
 */
function secret(): string {
  if (cachedSecret) return cachedSecret;

  const fromEnv = (process.env.SESSION_SECRET ?? "").trim();
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error("SESSION_SECRET must be at least 32 characters.");
    }
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is required in production. Generate one with: openssl rand -hex 32",
    );
  }

  cachedSecret = crypto.randomBytes(32).toString("hex");
  console.warn("SESSION_SECRET not set — using an ephemeral dev key; sessions end on restart.");
  return cachedSecret;
}

const b64url = (b: Buffer): string => b.toString("base64url");

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function serialize(user: SessionUser): string {
  const payload = b64url(Buffer.from(JSON.stringify(user)));
  return `${payload}.${sign(payload)}`;
}

/** Returns null for anything malformed, mis-signed, or expired. */
export function deserialize(raw: unknown): SessionUser | null {
  if (typeof raw !== "string" || !raw.includes(".")) return null;

  const idx = raw.lastIndexOf(".");
  const payload = raw.slice(0, idx);
  const mac = raw.slice(idx + 1);

  const expected = sign(payload);
  // Constant-time compare — a length mismatch alone would leak via early exit.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionUser;
    if (!user?.id || typeof user.exp !== "number" || Date.now() > user.exp) return null;
    return user;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, user: SessionUser): void {
  res.cookie(SESSION_COOKIE, serialize(user), {
    httpOnly: true,
    // Replit terminates TLS in front of the app, so cookies are always https
    // in production. Left off in dev so localhost works over plain http.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function readSession(req: Request): SessionUser | null {
  return deserialize((req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE]);
}
