import express, {
  Router, type IRouter, type NextFunction, type Request, type Response,
} from "express";
import { parseRfidFile } from "./rfid-parse.js";
import { addRfids, listRfids, rfidCounts, setRfidActive, useRfid } from "./rfid.js";
import {
  DISPLAY_TZ, createSignup, getSignup, listSignups, markOpened, newHandle, setComplete,
  type SignupInput, type SignupRow,
} from "./signups.js";
import {
  DM_PAGES, assertEmail, canAdminister, dmAccessFor, getDmUser, isDmPage, isStaff,
  isSuperEmail, listDmUsers, removeDmUser, revokeDmSessions, saveDmUser, superEmails,
  setDmUserEnabled, staffDomainList,
  type DmPageKey, type DmRole, type StoredRole,
} from "./users.js";
import { audit, listAudit } from "./audit.js";
import { DEFAULT_ROLE, listRoles, removeRole, saveRole } from "./roles.js";
import { dutchMillerNamed } from "../auth/apps.js";
import { publicOrigin } from "../origin.js";
import { emitChange, streamChanges } from "../events.js";
import { getSignupNotify, parseRecipients, setSignupNotify } from "./settings.js";
import { notifySignup, signupEmail } from "./notify.js";
import { inviteUser } from "./dealer-auth.js";
import {
  isMailConfigured, layout, mailAppIsSeparate, mailFrom, mailProblem, sendMail,
} from "../mail.js";
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
 * The live stream every open page listens to.
 *
 * Behind the same app guard as everything else here, so it is only
 * reachable by somebody who may use Dutch Miller at all.
 */
dutchMillerRouter.get("/events", (req: Request, res: Response) => {
  streamChanges(req, res);
});

/**
 * What the person signing in may see.
 *
 * The shell asks once and builds its rail from the answer, so a page
 * somebody cannot open is never offered. The guards below are what make
 * that true rather than cosmetic.
 */
dutchMillerRouter.get("/me", async (req: Request, res: Response) => {
  // `req.user` is the VIEWED person inside a view; `viewingAs.real` is who
  // is actually at the keyboard. The rail is built from the viewed person,
  // or the view shows the viewer's own app with somebody else's name on it.
  const real = req.viewingAs?.real ?? req.user;
  const email = req.user?.email ?? "";
  const access = await dmAccessFor(email);
  const row = req.viewingAs ? await getDmUser(email) : null;
  res.json({
    ...access,
    email,
    allPages: DM_PAGES,
    // Whether the person whose view this is counts as MOJO staff. Inside a
    // view that is the VIEWED person — showing the viewer's own staff
    // controls would make the view a lie about what they can see. Writes
    // are refused while viewing regardless.
    staff: req.viewingAs
      ? row?.authMethod === "microsoft" && staffDomainList().includes(email.split("@")[1] ?? "")
      : isStaff(real),
    via: req.viewingAs ? (row?.authMethod ?? "link") : (real?.via ?? "microsoft"),
    viewingAs: req.viewingAs ? { real: req.viewingAs.real.email, viewed: email } : null,
    // Judged on the REAL person, so the way out never disappears.
    canViewAs: isStaff(real) && isSuperEmail(real?.email ?? ""),
  });
});

/**
 * 403 unless this person may open that page.
 *
 * Judged on the VIEWED person, so a view is faithful: a super admin
 * looking at somebody's app is refused exactly what that person is
 * refused. Safe because nothing can be written while viewing — the
 * view-as middleware rejects every non-GET before this runs.
 */
function requirePage(page: DmPageKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const access = await dmAccessFor(req.user?.email ?? "");
    if (canAdminister(access) || access.pages.includes(page)) { next(); return; }
    res.status(403).json({ error: "You do not have access to that page." });
  };
}

/**
 * Everybody a super admin can look at.
 *
 * The Dutch Miller roll, plus nothing else: this is not a way to view as
 * an arbitrary address. Invited-but-not-set-up accounts are included
 * deliberately — "what does this person see?" is most often asked about
 * somebody who has just been added and cannot find something.
 */
dutchMillerRouter.get("/view-as/people", async (req: Request, res: Response) => {
  const real = req.viewingAs?.real ?? req.user;
  if (!isStaff(real) || !isSuperEmail(real?.email ?? "")) {
    res.status(403).json({ error: "Only a super administrator can view as somebody else." });
    return;
  }
  const people = (await listDmUsers()).map((u) => ({
    email: u.email,
    name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email,
    role: u.role,
    status: u.status,
    authMethod: u.authMethod,
    business: u.business,
    pages: u.role === "user" ? u.pages.length : DM_PAGES.length,
  }));
  res.json({ people });
});

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
  const [users, roles] = await Promise.all([listDmUsers(), listRoles()]);
  const byKey = new Map(roles.map((r) => [r.key, r.name]));
  res.json({
    // The role NAME is attached here rather than in the row shape: the
    // key is what anything is decided on, and a name read off a stale
    // copy is how a renamed role starts showing two different labels.
    users: users.map((u) => ({ ...u, roleName: byKey.get(u.roleKey) ?? u.roleKey })),
    roles,
    allPages: DM_PAGES,
    myRole: await roleOf(req),
    mailConfigured: isMailConfigured(),
    mailFrom: mailFrom(),
    mailProblem: mailProblem(),
    mailAppIsSeparate: mailAppIsSeparate(),
  });
});

/**
 * Everybody we could add: the staff directory, and anybody already here.
 *
 * One list rather than two, with each row saying whether it is already
 * configured, because "is Dana already set up?" is the question somebody
 * is actually holding when they open it.
 */
/**
 * Everybody who can reach Dutch Miller.
 *
 * Three sources, and between them they are the complete answer:
 *
 *   the pinned super administrators (`DM_SUPER_ADMINS`)
 *   the addresses the `DUTCH_MILLER_ALLOWED` secret lets in
 *   anybody with a row — every invited dealer, and every staff account
 *   that has been given a role
 *
 * There is deliberately no directory lookup. The secret IS the list of
 * Microsoft accounts that may use this app, so reading the whole tenant
 * would only add hundreds of people who cannot sign in, and would make
 * the dialog depend on a Graph permission to answer a question
 * configuration already answers.
 */
dutchMillerRouter.get("/people", requireDmAdmin, async (_req: Request, res: Response) => {
  const users = await listDmUsers();
  const configured = new Map(users.map((u) => [u.email, u]));

  type Row = {
    email: string; name: string; business: string | null;
    source: "microsoft" | "invited";
    pinnedSuper: boolean;
    user: (typeof users)[number] | null;
  };
  const rows = new Map<string, Row>();
  const add = (r: Row) => { if (!rows.has(r.email)) rows.set(r.email, r); };

  for (const email of [...superEmails(), ...dutchMillerNamed()]) {
    add({
      email, name: email, business: null, source: "microsoft",
      pinnedSuper: isSuperEmail(email), user: configured.get(email) ?? null,
    });
  }
  for (const u of users) {
    add({
      email: u.email,
      name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email,
      business: u.business,
      source: u.authMethod === "link" ? "invited" : "microsoft",
      pinnedSuper: isSuperEmail(u.email),
      user: u,
    });
  }

  res.json({
    people: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    roles: await listRoles(),
    mailConfigured: isMailConfigured(),
    mailFrom: mailFrom(),
    mailProblem: mailProblem(),
  });
});

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

/** 403 unless this person is the super administrator. */
async function requireSuper(req: Request, res: Response, next: NextFunction): Promise<void> {
  const real = req.viewingAs?.real ?? req.user;
  if (isStaff(real) && isSuperEmail(real?.email ?? "")) { next(); return; }
  res.status(403).json({ error: "Only a super administrator can change roles." });
}

// Readable by any administrator — assigning one means seeing the list.
dutchMillerRouter.get("/roles", requireDmAdmin, async (_req: Request, res: Response) => {
  res.json({ roles: await listRoles(), allPages: DM_PAGES });
});

// Creating and editing them is the super administrator's alone. A role is
// a grant of access, so an admin who could write one could write themselves
// a better one.
dutchMillerRouter.post("/roles", requireSuper, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const role = await saveRole({
      key: typeof body.key === "string" && body.key ? body.key : undefined,
      name: String(body.name ?? ""),
      pages: Array.isArray(body.pages) ? body.pages.filter(isDmPage) : [],
      administers: body.administers === true,
      by: actor(req),
    });
    await audit({
      action: "role.saved", subject: role.key, actor: actor(req),
      detail: `${role.name} · ${role.pages.length} page${role.pages.length === 1 ? "" : "s"}`
        + `${role.administers ? " · administers" : ""}`,
    });
    emitChange("roles");
    res.json({ role, roles: await listRoles() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

dutchMillerRouter.delete("/roles/:key", requireSuper, async (req: Request, res: Response) => {
  const key = String(req.params.key ?? "");
  const out = await removeRole(key);
  if (!out.ok) { res.status(409).json({ error: out.reason }); return; }
  await audit({ action: "role.removed", subject: key, actor: actor(req) });
  res.json({ roles: await listRoles() });
});

/**
 * Add somebody, or change the role they hold.
 *
 * `invite: true` with an address outside our own domains creates a dealer
 * account and emails a one-time link. There is no other way in for an
 * outside address: nobody can sign themselves up, and this route is
 * behind the admin guard.
 */
dutchMillerRouter.post("/users", requireDmAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: unknown; roleKey?: unknown; invite?: unknown };
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
    if (!invite && !ours && !(await getDmUser(email))) {
      res.status(400).json({
        error: "An outside address can only be added by inviting it, so the person "
          + "confirms their own email before the account goes live.",
      });
      return;
    }

    const user = await saveDmUser({
      email,
      roleKey: String(body.roleKey ?? DEFAULT_ROLE),
      by,
      byRole: await roleOf(req),
      ...(invite ? { authMethod: "link" as const, status: "invited" as const } : {}),
    });
    await audit({
      action: "account.updated", subject: email, actor: by,
      detail: `${user.roleKey}${invite ? " · invited" : ""}`,
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
    emitChange("users");
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
    emitChange("users");
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
  emitChange("users");
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

/* ------------------------------------------------------------------ *
 * Notification settings
 * ------------------------------------------------------------------ */

dutchMillerRouter.get("/settings/notifications", requireDmAdmin,
  async (_req: Request, res: Response) => {
    res.json({ notify: await getSignupNotify(), mailConfigured: isMailConfigured() });
  });

dutchMillerRouter.post("/settings/notifications", requireDmAdmin,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // The page sends raw text, because that is what somebody pastes. The
    // server decides what an address is, and says which entries it refused
    // rather than quietly dropping them.
    const { ok, rejected } = parseRecipients(body.recipients);
    if (rejected.length > 0) {
      res.status(400).json({
        error: `Not an email address: ${rejected.slice(0, 5).join(", ")}`,
        rejected,
      });
      return;
    }
    const notify = await setSignupNotify({
      recipients: ok,
      enabled: body.enabled !== false,
      copySubmitter: body.copySubmitter === true,
    }, actor(req));
    await audit({
      action: "notify.changed", actor: actor(req),
      detail: `${ok.length} recipient${ok.length === 1 ? "" : "s"}`
        + `${notify.enabled ? "" : " · off"}`,
    });
    emitChange("settings");
    res.json({ notify });
  });

/**
 * A sample of the notification, to the administrator asking and nobody else.
 *
 * Not to the configured list: checking the wording should not mail the
 * finance team. It uses the most recent real signup when there is one, so
 * what you see is what they will get, and falls back to an obviously
 * made-up record when the table is empty.
 */
dutchMillerRouter.post("/settings/notifications/sample", requireDmAdmin,
  async (req: Request, res: Response) => {
    const to = actor(req);
    if (!isMailConfigured()) {
      res.status(400).json({ error: `Email is not configured. ${mailProblem()}` });
      return;
    }
    const recent = (await listSignups({ limit: 1 })).rows[0];
    const sample: SignupRow = recent ?? {
      guid: "00000000-0000-4000-8000-000000000000",
      createdAt: new Date().toISOString(),
      displayTimezone: DISPLAY_TZ,
      dealer: { dlwContractId: "0041", dealNumber: "00712", customerId: "C-9" },
      customer: {
        firstName: "Sample", lastName: "Member", plateDlw: "ABC 1234", plateState: "WV",
        vehicleMake: "Ford", vehicleModel: "Bronco", vehicleYear: "2024",
        vehicleColor: "Blue", rfid: "00000+000000",
      },
      submittedAt: new Date().toISOString(),
      submittedBy: to,
      notifiedAt: null,
      openedAt: null,
      openedBy: null,
      completedAt: null,
      completedBy: null,
    };
    const { subject, html } = signupEmail(sample, { sample: true, origin: publicOrigin(req) });
    try {
      await sendMail(to, subject, html);
      res.json({ ok: true, to, usedRealSignup: Boolean(recent) });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

/**
 * Prove the mail setup works, without spending an invite on a real person.
 *
 * Sends only to the person asking, so it cannot be turned into a way to
 * mail arbitrary addresses from a MOJO mailbox. The Graph error is passed
 * through verbatim, because during setup the status code IS the answer —
 * 403 is the access policy or missing consent, 401 an expired secret, 404
 * a mailbox that does not exist.
 */
dutchMillerRouter.post("/mail-test", requireDmAdmin, async (req: Request, res: Response) => {
  const to = actor(req);
  if (!to) { res.status(400).json({ error: "No address to send to." }); return; }
  if (!isMailConfigured()) {
    res.status(400).json({ error: "MAIL_FROM is not set, so there is nothing to test." });
    return;
  }
  try {
    await sendMail(to, "MOJO Expense — test message", layout(
      "Mail is working",
      `<p style="margin:0 0 12px;font-size:15px">If you are reading this, Dutch Miller can
         send invitations and sign-in links.</p>
       <p style="margin:0;font-size:13px;color:#71717a">Sent from ${mailFrom()} using the
         ${mailAppIsSeparate() ? "dedicated mail" : "shared sign-in"} app registration.</p>`,
      "A test message, sent by you from the Users page.",
    ));
    await audit({ action: "code.sent", subject: to, actor: to, detail: "mail test" });
    res.json({ ok: true, to, from: mailFrom() });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
      emitChange("rfid");
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
  emitChange("rfid");
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
        status: status === "new" || status === "review" || status === "complete"
          ? status : "all",
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
    if (out.ok) {
      // Not awaited, and not inside the transaction: the member exists and
      // the tag is claimed by now, so a bounced email must not tell the
      // dealer their signup failed. Outcomes land in the audit trail.
      if (!out.alreadyExisted) void notifySignup(out.row, publicOrigin(req));
      emitChange("signups");
      res.json({ row: out.row, alreadyExisted: out.alreadyExisted });
      return;
    }
    if (out.kind === "validation") { res.status(400).json({ errors: out.errors }); return; }
    // 409: the entered data is fine and worth keeping — the form says so and
    // asks for a different tag rather than throwing the entry away.
    res.status(409).json({ error: out.reason, kind: out.kind });
  },
);

/**
 * Record that somebody at MOJO has looked at this.
 *
 * A POST rather than a side effect of reading, so it is refused while
 * viewing as somebody else — an admin checking a dealer's screen has
 * not dealt with the signup, and the tracker would be lying if it said
 * they had.
 */
dutchMillerRouter.post(
  "/signups/:guid/opened",
  requirePage("member-signups"),
  async (req: Request, res: Response) => {
    const who = req.viewingAs?.real.email ?? req.user?.email ?? "";
    if (!isStaff(req.viewingAs?.real ?? req.user)) { res.json({ row: null }); return; }
    const row = await markOpened(String(req.params.guid ?? ""), who);
    if (row) emitChange("signups");
    res.json({ row });
  },
);

/**
 * The MOJO-side mark, which is one-way and ordered.
 *
 * Not an administrator's privilege: being an administrator of Dutch
 * Miller says nothing about working at MOJO, and this mark is MOJO
 * saying it has dealt with the signup. Nor is it available before
 * somebody has opened the record — "completed" means a person read this
 * one, so marking it off a list without reading it is exactly what the
 * mark must not permit. `setComplete` enforces both; a button is only a
 * suggestion.
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
    const out = await setComplete(String(req.params.guid ?? ""), who);
    if (!out.ok) {
      res.status(out.reason === "not-found" ? 404 : 409).json({
        error: out.reason === "not-found"
          ? "No such signup."
          : out.reason === "already"
            ? "That signup is already complete, and completing is final."
            : "Open the signup and read it before marking it complete.",
      });
      return;
    }
    emitChange("signups");
    res.json({ row: out.row });
  },
);
