import type { Request } from "express";

/**
 * The address links in emails point at.
 *
 * `PUBLIC_ORIGIN` pins it; otherwise it follows the host the request
 * arrived on. Pin it whenever the app answers on more than one name:
 * cookies are per origin, so a link built on one hostname and opened on
 * another is a different site as far as the browser is concerned.
 */
export function publicOrigin(req?: Request): string {
  const pinned = (process.env.PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (pinned) return pinned;
  if (!req) return "";
  const proto = req.headers["x-forwarded-proto"] ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "localhost";
  return `${proto}://${host}`;
}

/** Where a signup lives in the app, for a link somebody clicks from email. */
/**
 * A link straight to one member record, in the partner it belongs to.
 *
 * The slug is part of the address, not a hint. A reviewer who works
 * across partners would otherwise land in whichever account their
 * browser happened to resolve first and be told the record does not
 * exist — which is exactly what the isolation rules do when they are
 * working, and would read as a broken link.
 *
 * Without a slug the link still works for anybody who holds one
 * account, which is every link sent before partners existed.
 */
export const signupUrl = (origin: string, guid: string, slug = ""): string =>
  (origin
    ? `${origin}/${slug}#/member-signups/review?open=${encodeURIComponent(guid)}`
    : "");
