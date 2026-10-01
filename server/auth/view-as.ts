/**
 * Seeing the app as somebody else, without being able to act as them.
 *
 * "I need to be able to monitor imports, automation, and errors on his end
 * when I get him to log in." Half the app is shaped by who is asking — which
 * admin controls appear, whether there is an Emburse login stored and so
 * whether anything can be decided, which failures are yours, what the
 * automation did while you were away. Describing that down a phone line does
 * not work; looking at it does.
 *
 * The whole design is one rule: **nothing may be WRITTEN while viewing as
 * somebody else.** Every write in this app is stamped with `req.user.email` —
 * `decidedBy` on a decision, who saved a rule, who flipped a flag — and an
 * Emburse approval is applied under the decider's own login and carries
 * their name in the finance system permanently. A view that could write
 * would be a way to act as another person, which is exactly the thing the
 * credential handling exists to make impossible. So this swaps the identity
 * for reads and refuses everything else outright, rather than trying to
 * enumerate which writes would be harmless.
 *
 * Admin-only, checked against the REAL signed-in user on every request, so a
 * cookie kept after someone's admin rights are removed stops working on the
 * next request rather than at the next sign-in.
 */

import type { NextFunction, Request, Response } from "express";
import { isAdmin, isAuthConfigured } from "./index.js";
import type { SessionUser } from "./session.js";

export const VIEW_AS_COOKIE = "view_as";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set only while an admin is looking through somebody else's eyes. */
      viewingAs?: { real: SessionUser; viewed: string };
    }
  }
}

/** The two routes that turn the mode on and off, judged on the REAL user. */
const CONTROLS = /^\/api\/auth\/view-as$/;

/**
 * Methods that cannot change anything.
 *
 * An allow-list, not a block-list. A new write route added next month is
 * refused by default, which is the right way round for a rule whose failure
 * mode is one person's name on another person's approval.
 */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export function viewAsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const wanted = (req.cookies?.[VIEW_AS_COOKIE] as string | undefined)?.trim().toLowerCase();
  if (!wanted) return next();

  const real = req.user;
  // No identity, or not an admin: the cookie means nothing. Not an error —
  // it is cleared below so it cannot keep being offered.
  if (!real || (isAuthConfigured() && !isAdmin(real.email))) {
    res.clearCookie(VIEW_AS_COOKIE, { path: "/" });
    return next();
  }
  if (wanted === real.email.trim().toLowerCase()) {
    res.clearCookie(VIEW_AS_COOKIE, { path: "/" });
    return next();
  }

  req.viewingAs = { real, viewed: wanted };
  // Everything downstream reads req.user, so this is the whole swap. Name and
  // id come along so a page that greets somebody greets the right person.
  req.user = { ...real, email: wanted, name: wanted, id: `view-as:${wanted}` };

  if (READS.has(req.method) || CONTROLS.test(req.path)) return next();
  res.status(403).json({
    error:
      `You are viewing the app as ${wanted}. Nothing can be changed while viewing as ` +
      `somebody else — an approval, a rule or a setting has to carry the name of the ` +
      `person who actually made it. Stop viewing as them and try again.`,
  });
}
