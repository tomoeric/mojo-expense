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
export const signupUrl = (origin: string, guid: string): string =>
  origin ? `${origin}/#/member-signups/review?open=${encodeURIComponent(guid)}` : "";
