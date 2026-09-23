import type { NextFunction, Request, Response } from "express";
import { isAdmin, isAuthConfigured } from "./index.js";

/**
 * Seeing the app as somebody else, to work out why it is not working for them.
 *
 * READ ONLY, and deliberately so. A decision reaches a real Emburse record and
 * carries the decider's name there; an admin clicking Approve while wearing
 * somebody else's face would put that person's name on a financial approval
 * they did not make. So impersonation changes what is SHOWN and nothing else —
 * every write goes back through the real session, and is refused while this is
 * on.
 *
 * What it is for: "do Brian's buttons appear", "is he being asked for a code",
 * "is a failed decision stranding his queue". Those are all reads, and they
 * are what actually needs answering.
 *
 * The cookie carries only a name, never authority. Whether it is honoured is
 * re-decided on every request from the REAL session's admin status, so setting
 * it by hand as a non-admin achieves nothing.
 */

export const VIEW_AS_COOKIE = "mojo_view_as";

/** Non-GET requests that are safe while viewing as somebody else. */
const HARMLESS_WRITES = [
  /^\/api\/view-as$/,
  // A dry run: it drives Emburse under the decider's login and reports each
  // step without deciding anything. It is the entire point of the feature.
  /^\/api\/decisions\/\d+\/test$/,
];

export type ViewingAs = { real: string; as: string };

export function readViewAs(req: Request): string | null {
  const raw = (req.cookies as Record<string, unknown> | undefined)?.[VIEW_AS_COOKIE];
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

export function setViewAs(res: Response, email: string): void {
  res.cookie(VIEW_AS_COOKIE, email.trim().toLowerCase(), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60 * 1000,
  });
}

export function clearViewAs(res: Response): void {
  res.clearCookie(VIEW_AS_COOKIE, { path: "/" });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set only while an admin is looking through somebody else's eyes. */
      viewingAs?: ViewingAs;
    }
  }
}

/**
 * Swap the identity a request READS with.
 *
 * Runs after authMiddleware, so `req.user` is the real signed-in person when
 * this decides whether to honour the cookie.
 */
export function viewAsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const target = readViewAs(req);
  if (!target) return next();

  const real = req.user;
  // Only an admin may do this, and never as themselves — a no-op "view as me"
  // would leave a banner up saying something untrue.
  if (!real || (isAuthConfigured() && !isAdmin(real.email)) || real.email.toLowerCase() === target) {
    clearViewAs(res);
    return next();
  }

  req.viewingAs = { real: real.email, as: target };
  req.user = { ...real, email: target, name: target, id: `view-as:${target}` };
  next();
}

/** 403 for anything that would write while wearing somebody else's face. */
export function refuseWritesWhileViewingAs(req: Request, res: Response, next: NextFunction): void {
  if (!req.viewingAs || req.method === "GET" || req.method === "HEAD") return next();
  if (HARMLESS_WRITES.some((re) => re.test(req.path))) return next();

  res.status(403).json({
    error:
      `You are viewing as ${req.viewingAs.as}. This is a read-only view — a decision made here would ` +
      `put their name on a real approval in Emburse. Stop viewing as them to act as yourself.`,
  });
}
