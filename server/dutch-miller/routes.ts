import express, {
  Router, type IRouter, type NextFunction, type Request, type Response,
} from "express";
import { parseRfidFile } from "./rfid-parse.js";
import { addRfids, listRfids, rfidCounts, setRfidActive, useRfid } from "./rfid.js";
import {
  DISPLAY_TZ, createSignup, getSignup, listSignups, newHandle, setComplete,
  type SignupInput,
} from "./signups.js";
import {
  DM_PAGES, assertEmail, canAdminister, dmAccessFor, getDmUser, isDmPage, isStaff,
  listDmUsers, removeDmUser, revokeDmSessions, saveDmUser, setDmUserEnabled,
  staffDomainList, type DmPageKey, type DmRole, type StoredRole,
} from "./users.js";
import { audit, listAudit } from "./audit.js";
import { inviteUser } from "./dealer-auth.js";
import { isMailConfigured, mailFrom } from "../mail.js";
import { forgetEpoch } from "../auth/index.js";

/**
 * Dutch Miller — the second app on this deployment.
 *
 * A shell for now, deliberately. The split it sits behind is the part that
 * had to exist first: assignment by email, a server that refuses the other
 * product's routes rather than merely hiding them, and a switcher for the
 * one person who holds both. Configuration and the actual pages follow.
 *
 * Everything under here is mounted behind `requireApp("dutch-miller")`, so
 * a route added to this file is access-controlled by being here. Nothing
 * Dutch Miller needs should be hung off the Emburse routers instead.
 */
export const dutchMillerRouter: IRouter = Router();

/**
 * What the person signing in may see.
 *
 * The shell asks once and builds its rail from the answer, so a page
 * somebody cannot open is never offered. The guards below are what make
 * that true rather than cosmetic.
 */
dutchMillerRouter.get("/me", async (req: Request, res: Response) => {
  const who = req.viewingAs?.real ?? req.user;
  const email = who?.email ?? "";
  const access = await dmAccessFor(email);
  res.json({
    ...access,
    email,
    allPages: DM_PAGES,
    // Whether they are one of ours, which decides the MOJO-side controls.
    staff: isStaff(who),
    via: who?.via ?? "microsoft",
  });
});

/** 403 unless this person may open that page. */
function requirePage(page: DmPageKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const email = req.viewingAs?.real.email ?? req.user?.email ?? "";
    const access = await dmAccessFor(email);
    if (canAdminister(access) || access.pages.includes(page)) { next(); return; }
    res.status(403).json({ error: "You do not have access to that page." });
  };
}

/** 403 unless this person administers Dutch Miller. */
async function requireDmAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const email = req.viewingAs?.real.email ?? req.user?.email ?? "";
  if (canAdminister(await dmAccessFor(email))) { next(); return; }
  res.status(403).json({ error: "Only a Dutch Miller administrator can do that." });
}

/** The role of whoever is making the request — several rules turn on it. */
const roleOf = async (req: Request): Promise<DmRole> =>
  (await dmAccessFor(req.viewingAs?.real.email ?? req.user?.email ?? "")).role;

const actor = (req: Request): string => req.viewingAs?.real.email ?? req.user?.email ?? "";

dutchMillerRouter.get("/users", requireDmAdmin, async (req: Request, res: Response) => {
  res.json({
    users: await listDmUsers(),
    allPages: DM_PAGES,
    myRole: await roleOf(req),
    mailConfigured: isMailConfigured(),
    mailFrom: mailFrom(),
  });
});

/**
 * Add or change somebody.
 *
 * `invite: true` with an address outside our own domains creates a dealer
 * account and emails a one-time link. There is no other way in for an
 * outside address: nobody can sign themselves up, and this route is behind
 * the admin guard.
 */
dutchMillerRouter.post("/users", requireDmAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    email?: unknown; role?: unknown; pages?: unknown; invite?: unknown;
  };
  const role: StoredRole = body.role === "admin" ? "admin" : "user";
  const pages = Array.isArray(body.pages) ? body.pages.filter(isDmPage) : [];
  const invite = body.invite === true;
  const by = actor(req);

  try {
    const email = assertEmail(String(body.email ?? ""));
    const domain = email.split("@")[1] ?? "";
    const ours = staffDomainList().includes(domain);

    if (invite && ours) {
      res.status(400).json({
        error: "That is one of our own addresses — they sign in with the Microsoft "
          + "button, so there is nothing to invite. Add them without inviting.",
      });
      return;
    }
    if (!invite && !ours) {
      res.status(400).json({
        error: "An outside address can only be added by inviting it, so the person "
          + "confirms their own email before the account goes live.",
      });
      return;
    }

    const user = await saveDmUser({
      email, role, pages, by, byRole: await roleOf(req),
      authMethod: invite ? "link" : "microsoft",
      status: invite ? "invited" : "active",
    });
    await audit({
      action: "account.created", subject: email, actor: by,
      detail: `${role}${invite ? " · invited" : " · microsoft"}`,
    });

    if (invite) {
      if (!isMailConfigured()) {
        res.status(500).json({
          error: "The account was created, but email is not set up, so no invite was sent. "
            + "Set MAIL_FROM and grant the app Mail.Send, then use Resend invite.",
        });
        return;
      }
      await inviteUser(req, email, by);
    }
    res.json({ user: await getDmUser(email), users: await listDmUsers() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Send the invite again. The previous link stops working the moment this does. */
dutchMillerRouter.post("/users/:email/invite", requireDmAdmin, async (req: Request, res: Response) => {
  const email = String(req.params.email ?? "").toLowerCase();
  const row = await getDmUser(email);
  if (!row || row.authMethod !== "link") {
    res.status(400).json({ error: "That account does not sign in with a link." });
    return;
  }
  if (row.status === "active") {
    res.status(400).json({ error: "That account is already set up — they can ask for a sign-in link." });
    return;
  }
  try {
    await inviteUser(req, email, actor(req));
    res.json({ users: await listDmUsers() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Switch an account off or back on. Off also ends every open session. */
dutchMillerRouter.post("/users/:email/enabled", requireDmAdmin, async (req: Request, res: Response) => {
  const email = String(req.params.email ?? "").toLowerCase();
  const enabled = (req.body ?? {}).enabled === true;
  const out = await setDmUserEnabled(email, enabled, actor(req), await roleOf(req));
  if (!out.ok) { res.status(403).json({ error: out.reason }); return; }
  forgetEpoch(email);
  await audit({
    action: enabled ? "account.enabled" : "account.disabled",
    subject: email, actor: actor(req),
  });
  res.json({ users: await listDmUsers() });
});

/** Sign them out everywhere, without switching the account off. */
dutchMillerRouter.post("/users/:email/revoke", requireDmAdmin, async (req: Request, res: Response) => {
  const email = String(req.params.email ?? "").toLowerCase();
  await revokeDmSessions(email);
  forgetEpoch(email);
  await audit({ action: "sessions.revoked", subject: email, actor: actor(req) });
  res.json({ users: await listDmUsers() });
});

dutchMillerRouter.delete("/users/:email", requireDmAdmin, async (req: Request, res: Response) => {
  const email = String(req.params.email ?? "").toLowerCase();
  const out = await removeDmUser(email, await roleOf(req));
  if (!out.ok) { res.status(409).json({ error: out.reason }); return; }
  forgetEpoch(email);
  await audit({ action: "account.removed", subject: email, actor: actor(req) });
  res.json({ users: await listDmUsers() });
});

/**
 * The audit trail.
 *
 * Admin-only, and read-only: there is no route that edits or deletes a
 * line, deliberately. A log somebody can tidy up is not evidence of
 * anything.
 */
dutchMillerRouter.get("/audit", requireDmAdmin, async (req: Request, res: Response) => {
  res.json({
    entries: await listAudit({
      subject: String(req.query.subject ?? ""),
      limit: Number(req.query.limit ?? 200),
    }),
  });
});

/** 25 MB. A spreadsheet of a million numbers is about 12. */
const MAX_UPLOAD = 25 * 1024 * 1024;

/**
 * The file arrives as a raw body rather than multipart — one file, no
 * other fields, exactly as the Emburse PDF import does. Multipart would
 * add a dependency and a parser for a form with a single part in it.
 */
dutchMillerRouter.post(
  "/rfid/upload",
  requirePage("rfid-review"),
  express.raw({
    type: [
      "text/csv", "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ],
    limit: MAX_UPLOAD,
  }),
  async (req: Request, res: Response) => {
    const file = req.body as Buffer;
    if (!Buffer.isBuffer(file) || file.length === 0) {
      res.status(400).json({ error: "No file arrived." });
      return;
    }
    try {
      const parsed = parseRfidFile(file);
      const result = await addRfids(
        parsed.numbers, parsed.rejected, parsed.cells, req.user?.email ?? "");
      res.json({ ...result, counts: await rfidCounts() });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

dutchMillerRouter.get("/rfid", requirePage("rfid-review"), async (req: Request, res: Response) => {
  const status = String(req.query.status ?? "all");
  res.json({
    ...(await listRfids({
      status: status === "active" || status === "inactive" || status === "used"
        ? status : "all",
      search: String(req.query.search ?? ""),
      limit: Number(req.query.limit ?? 100),
      offset: Number(req.query.offset ?? 0),
    })),
    counts: await rfidCounts(),
  });
});

/** Issue one. The server decides, once; see `useRfid`. */
dutchMillerRouter.post("/rfid/use", requirePage("rfid-review"), async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { number?: unknown; usedFor?: unknown };
  const out = await useRfid(
    String(body.number ?? ""), req.user?.email ?? "", String(body.usedFor ?? ""));
  if (!out.ok) { res.status(409).json({ error: out.reason }); return; }
  res.json({ row: out.row, counts: await rfidCounts() });
});

/** Hold back, or put back in play. Never a used one. */
dutchMillerRouter.post("/rfid/active", requirePage("rfid-review"), async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { numbers?: unknown; active?: unknown };
  const numbers = Array.isArray(body.numbers) ? body.numbers.map(String) : [];
  const out = await setRfidActive(numbers, body.active !== false);
  res.json({ ...out, counts: await rfidCounts() });
});

/* ------------------------------------------------------------------ *
 * Member signups
 * ------------------------------------------------------------------ */

/** A blank entry's generated values, minted and signed by the server. */
dutchMillerRouter.post(
  "/signups/new",
  requirePage("member-signups"),
  (_req: Request, res: Response) => {
    res.json({ ...newHandle(), displayTimezone: DISPLAY_TZ });
  },
);

/**
 * The tags this form may offer.
 *
 * Served from here rather than the RFID page's own route so that somebody
 * given Member Signups and nothing else can still fill the dropdown — and
 * so it cannot return anything but an available tag.
 */
dutchMillerRouter.get(
  "/signups/rfid-options",
  requirePage("member-signups"),
  async (_req: Request, res: Response) => {
    const { rows } = await listRfids({ status: "active", limit: 500 });
    res.json({ options: rows.map((r) => r.number) });
  },
);

dutchMillerRouter.get(
  "/signups",
  requirePage("member-signups"),
  async (req: Request, res: Response) => {
    const status = String(req.query.status ?? "all");
    res.json({
      ...(await listSignups({
        status: status === "new" || status === "complete" ? status : "all",
        search: String(req.query.search ?? ""),
        limit: Number(req.query.limit ?? 100),
        offset: Number(req.query.offset ?? 0),
      })),
      // Whether the person reading may set the MOJO-side mark. The button
      // follows this; the route below decides it again regardless.
      canComplete: isStaff(req.viewingAs?.real ?? req.user),
    });
  },
);

dutchMillerRouter.get(
  "/signups/:guid",
  requirePage("member-signups"),
  async (req: Request, res: Response) => {
    const row = await getSignup(String(req.params.guid ?? ""));
    if (!row) { res.status(404).json({ error: "No such signup." }); return; }
    res.json({ row });
  },
);

/** Confirm & Submit. One member, one tag, one transaction — see `createSignup`. */
dutchMillerRouter.post(
  "/signups",
  requirePage("member-signups"),
  async (req: Request, res: Response) => {
    const out = await createSignup(
      (req.body ?? {}) as Partial<SignupInput>, req.user?.email ?? "");
    if (out.ok) { res.json({ row: out.row, alreadyExisted: out.alreadyExisted }); return; }
    if (out.kind === "validation") { res.status(400).json({ errors: out.errors }); return; }
    // 409: the entered data is fine and worth keeping — the form says so and
    // asks for a different tag rather than throwing the entry away.
    res.status(409).json({ error: out.reason, kind: out.kind });
  },
);

/**
 * The MOJO-side mark.
 *
 * Not an administrator's privilege: being an administrator of Dutch Miller
 * says nothing about working at MOJO, and this mark is MOJO saying it has
 * dealt with the signup.
 */
dutchMillerRouter.post(
  "/signups/:guid/complete",
  requirePage("member-signups"),
  async (req: Request, res: Response) => {
    const real = req.viewingAs?.real ?? req.user;
    const who = real?.email ?? "";
    if (!isStaff(real)) {
      res.status(403).json({ error: "Only a MOJO employee can mark a signup complete." });
      return;
    }
    const complete = (req.body ?? {}).complete !== false;
    const row = await setComplete(String(req.params.guid ?? ""), complete, who);
    if (!row) { res.status(404).json({ error: "No such signup." }); return; }
    res.json({ row });
  },
);
