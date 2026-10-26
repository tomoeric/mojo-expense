import express, {
  Router, type IRouter, type NextFunction, type Request, type Response,
} from "express";
import { parseRfidFile } from "./rfid-parse.js";
import {
  addRfids, deleteRfids, listRfids, rfidCounts, setRfidActive, setRfidTestOnly, useRfid,
} from "./rfid.js";
import {
  DISPLAY_TZ, confirmSticker, createSignup, deleteSignup, getSignup, listSignups,
  markOpened, newHandle, setComplete, type SignupInput, type SignupRow,
} from "./signups.js";
import {
  DM_GRANTS, DM_PAGES, assertEmail, canAdminister, checkReviewer, dmAccessFor,
  getDmUser, isDmPage, isStaff,
  isSuperEmail, listDmUsers, removeDmUser, revokeDmSessions, saveDmUser, superEmails,
  setDmUserEnabled, staffDomainList,
  type DmPageKey, type DmRole, type StoredRole,
} from "./users.js";
import {
  LOCKOUT, audit, collectionHealth, listAudit, listEvents, listSecurityLog,
  listViewAsSessions, requestMeta, securitySummary,
  type AuditAction, type EventCategory, type Outcome, type Severity,
} from "./audit.js";
import { EVENT_META, OUTCOMES, SEVERITIES } from "./event-catalog.js";
import { THRESHOLDS, concerns, coverage } from "./detect.js";
import {
  CLASSIFICATIONS, INVESTIGATION_STATUSES, getInvestigation, investigationCounts,
  listInvestigations, openInvestigation, updateInvestigation,
  type Classification, type InvestigationStatus,
} from "./investigations.js";
import { BULK_COLUMNS, parseBulk, templateCsv } from "./bulk.js";
import { CSC_ROLE, DEFAULT_ROLE, listRoles, removeRole, saveRole } from "./roles.js";
import { ACTIONS, actionsFor } from "./actions.js";
import { dutchMillerNamed } from "../auth/apps.js";
import { publicOrigin } from "../origin.js";
import { listMakes, listModels, modelYears } from "./vehicles.js";
import {
  VENDOR_LABEL, approvalBlockers, decideVendor, deleteVendor, getVendor,
  listVendors, proposeVendor,
} from "./vendors.js";
import { emitChange, streamChanges } from "../events.js";
import {
  DAY_NAMES, getAccountState, getPlacement, getReminders, getSignupNotify,
  isPlacement, parseRecipients, setAccountState, setPlacement, setReminders,
  setSignupNotify,
} from "./settings.js";
import { runReminders } from "./reminders.js";
import { notifyApproved, notifySignup, signupEmail } from "./notify.js";
import { RETRY, deliveriesFor } from "./delivery.js";
import { inviteUser } from "./dealer-auth.js";
import {
  isMailConfigured, layout, mailAppIsSeparate, mailFrom, mailProblem, sendMail,
} from "../mail.js";
import { forgetEpoch } from "../auth/index.js";
import {
  BLOCK_PAGES, HEIGHTS, PAGE_LABEL, WIDTHS, archiveBlock, essentialOn, isBlockPage,
  accountsArranging, itemsOn, layoutFor, listBlocks, resetLayout, saveBaseLayout,
  saveBlock, saveLayout,
  type BlockPage,
} from "./blocks.js";
import {
  DUTCH_MILLER, PLATFORM_NAME, RESERVED_SLUGS, TEMPLATE_VERSION, type Account,
  accountLine, accountsFor, assignedAccounts, createAccount, forgetAccountAccess,
  holdersOf, listAccounts, renameAccount, setAccountStatus,
  setAssignedAccounts, slugFrom, slugProblem,
} from "./accounts.js";

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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The partner account this request is acting in, once resolved. */
      account?: Account;
      /** Every account the person may open, in the order they are offered. */
      accountScope?: Account[];
    }
  }
}

/**
 * Which partner account this request is in, and may it be.
 *
 * ONE middleware ahead of every route in this file, so a route added
 * later is scoped by being here rather than by somebody remembering.
 * That is the same reasoning as the app guard above it, and it matters
 * more: forgetting to check the app shows one product's page to the
 * other product's user, and forgetting to check the account shows one
 * partner's members to another partner.
 *
 * The account is named by a header the shell sets from the path. A
 * header rather than a path segment because every one of these routes
 * is already mounted under /api/dutch-miller and re-rooting them would
 * break every link, bookmark and emailed URL in existence. It is NOT a
 * grant: it is read only to choose between accounts the person already
 * holds, exactly like the app cookie, and one naming an account they do
 * not hold is refused outright rather than ignored — because unlike the
 * app cookie, this one is how somebody would go looking.
 *
 * Judged on the REAL person. A view shows somebody else's pages; it has
 * never been a way to reach data the viewer could not reach themselves.
 */
dutchMillerRouter.use(async (req: Request, res: Response, next: NextFunction) => {
  const real = req.viewingAs?.real ?? req.user;
  const email = real?.email ?? "";
  const access = await dmAccessFor(email).catch(() => null);
  const row = await getDmUser(email).catch(() => null);
  const scope = await accountsFor({
    email,
    isAccountAdmin: isSuperEmail(email),
    allAccounts: row?.allAccounts === true,
  }).catch(() => [] as Account[]);
  req.accountScope = scope;

  const asked = String(
    req.get("x-partner-account") ?? req.query.account ?? "",
  ).trim().toLowerCase();

  if (asked) {
    const want = scope.find((a) => a.slug === asked || a.id === asked);
    if (!want) {
      // Not "no such account" and not "not yours" — the same answer for
      // both. Which accounts exist is not this person's business, and an
      // error that distinguishes them is a way to enumerate partners.
      denied(req, `account ${asked}`);
      res.status(403).json({ error: "That partner account is not available to you." });
      return;
    }
    req.account = want;
  } else {
    // No account named: the one they hold, or the first of several.
    // An active one in preference to a dormant one, so somebody with
    // a deactivated partner and a live one lands in the live one.
    req.account = scope.find((a) => a.status === "active") ?? scope[0];
  }

  /*
   * A deactivated account is closed to everybody but the people who
   * can reopen it.
   *
   * Not the same switch as the partner-access one below, and the
   * difference is the point. Partner access pauses the emailed-link
   * door and leaves MOJO working inside the account; deactivation
   * closes the account itself. Both keep every record.
   */
  if (req.account && req.account.status === "inactive" && !isSuperEmail(email)) {
    void audit({
      action: "access.denied", app: "dutch-miller", accountId: req.account.id,
      subject: email, detail: "account is deactivated", ...requestMeta(req),
    });
    res.status(403).json({
      error: `${req.account.name} has been deactivated.`
        + (req.account.deactivateReason ? ` ${req.account.deactivateReason}` : "")
        + " Contact MOJO if you think this is wrong.",
      accountOff: true,
    });
    return;
  }

  void access;
  next();
});

/**
 * The partner account's own door, open or shut.
 *
 * Per account now, so pausing one partner's dealers says nothing
 * about another's. It refuses the EMAILED-LINK door only: MOJO staff
 * keep working, because they are the people who would switch it
 * back on and locking them out to lock out a partner turns a pause
 * into an outage.
 *
 * Judged on the door, never the address — an invited account on a
 * mojocarwash.com address is still an invited account.
 *
 * Reads as well as writes. A dealer left with a working page and
 * failing buttons has been told nothing; 403 on the shell's first
 * request is what puts the message on screen.
 */
dutchMillerRouter.use(async (req: Request, res: Response, next: NextFunction) => {
  const via = req.viewingAs?.real.via ?? req.user?.via ?? "microsoft";
  if (via !== "link") { next(); return; }
  const account = req.account;
  if (!account) { next(); return; }
  const state = await getAccountState(account.id)
    .catch(() => ({ active: true, reason: "" }));
  if (state.active) { next(); return; }
  void audit({
    action: "access.denied", app: "dutch-miller", accountId: account.id,
    subject: req.user?.email ?? "",
    detail: "partner access is switched off",
    ...requestMeta(req),
  });
  res.status(403).json({
    error: `${account.name} partner access is switched off.`
      + (state.reason ? ` ${state.reason}` : "")
      + " Contact MOJO if you think this is wrong.",
    accountOff: true,
  });
});

/**
 * The account this request is in, or a 403 that says why there is none.
 *
 * Everything that touches a member, a tag or a vendor goes through
 * here. Somebody signed in but assigned to no partner is a real and
 * ordinary state — a new MOJO starter before anybody gives them an
 * account — and it reads better as "you are not in any partner
 * account" than as an empty list of members that looks like a bug.
 */
/**
 * Which accounts' history this reader may see, or null for all of them.
 *
 * An account administrator reads the whole platform, which is what the
 * role is. Everybody else reads the partners they hold plus the
 * platform-wide events — sign-ins, refusals, user changes — which
 * belong to nobody's account and are the half of a security page that
 * is actually about security.
 */
function historyScope(req: Request): string[] | null {
  const email = req.viewingAs?.real.email ?? req.user?.email ?? "";
  if (isSuperEmail(email)) return null;
  return (req.accountScope ?? []).map((a) => a.id);
}

function accountOf(req: Request, res: Response): Account | null {
  if (req.account) return req.account;
  denied(req, "no partner account");
  res.status(403).json({
    error: "You are not assigned to a partner account. Ask an account administrator.",
    noAccount: true,
  });
  return null;
}

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
    allGrants: DM_GRANTS,
    // Whether the person whose view this is counts as MOJO staff. Inside a
    // view that is the VIEWED person — showing the viewer's own staff
    // controls would make the view a lie about what they can see. Writes
    // are refused while viewing regardless.
    staff: req.viewingAs
      ? row?.authMethod === "microsoft" && staffDomainList().includes(email.split("@")[1] ?? "")
      : isStaff(real),
    via: req.viewingAs ? (row?.authMethod ?? "link") : (real?.via ?? "microsoft"),
    viewingAs: req.viewingAs ? { real: req.viewingAs.real.email, viewed: email } : null,
    // Inside the glass or outside it. Served with the rest of the
    // shell's first read so the instructions page and the signup
    // form never render one wording and then swap to the other.
    stickerPlacement: req.account
      ? (await getPlacement(req.account.id)).placement
      : "inside",
    /*
     * The platform, and the partner inside it.
     *
     * Served with the rest of the shell's first read so the header
     * never renders one partner's name and then swaps. `accounts` is
     * what the switcher offers and is the REAL person's — a view
     * changes whose pages are on screen, never which partners the
     * viewer holds.
     */
    platform: PLATFORM_NAME,
    account: req.account
      ? {
        id: req.account.id, slug: req.account.slug, name: req.account.name,
        affiliation: req.account.affiliation, line: accountLine(req.account),
        status: req.account.status,
      }
      : null,
    accounts: (req.accountScope ?? []).map((a) => ({
      id: a.id, slug: a.slug, name: a.name, affiliation: a.affiliation,
      line: accountLine(a), status: a.status,
    })),
    /** Creating and deactivating partners. The pinned list, nobody else. */
    isAccountAdmin: isSuperEmail(req.viewingAs?.real.email ?? real?.email ?? ""),
  });
});

/**
 * 403 unless this person may open that page.
 *
 * Judged on the VIEWED person, so a view is faithful: an account admin
 * looking at somebody's app is refused exactly what that person is
 * refused. Safe because nothing can be written while viewing — the
 * view-as middleware rejects every non-GET before this runs.
 */
function requirePage(page: DmPageKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const access = await dmAccessFor(req.user?.email ?? "");
    if (canAdminister(access) || access.pages.includes(page)) { next(); return; }
    denied(req, `page ${page}`);
    res.status(403).json({ error: "You do not have access to that page." });
  };
}

/**
 * 403 unless this person administers Dutch Miller.
 *
 * Judged on the VIEWED person, like `requirePage`, so a view is
 * faithful: an administrator looking at a dealer's app is refused
 * the administration pages exactly as that dealer is, rather than
 * reading Users and Roles while wearing their name. Safe because
 * everything behind this is a read and every write is already
 * refused while viewing.
 */
async function requireDmAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const email = req.user?.email ?? "";
  if (canAdminister(await dmAccessFor(email))) { next(); return; }
  denied(req, "administrator only");
  res.status(403).json({ error: "Only a Dutch Miller administrator can do that." });
}

/**
 * May this person approve a membership?
 *
 * Two conditions, and both matter. The CSC ROLE, because approving is
 * a job rather than a level — an administrator manages who can use the
 * app, which is a different thing from deciding a member may wash. And
 * MOJO's own door, because the mark says MOJO has dealt with it, so a
 * dealer account handed the CSC role still cannot make it.
 */
async function canApprove(req: Request): Promise<boolean> {
  const real = req.viewingAs?.real ?? req.user;
  if (!isStaff(real)) return false;
  return (await dmAccessFor(real?.email ?? "")).approves;
}

/**
 * What the person whose app this IS can do.
 *
 * The VIEWED person inside a view, and yourself outside one — which
 * is the opposite of the guards, deliberately. A guard asks "may this
 * request go through", and the answer must be about whoever is really
 * at the keyboard. These flags answer "what buttons belong on this
 * page", and inside a view the whole point is to see somebody else's
 * app: an account administrator's Delete sitting under a dealer's name
 * is the view lying about the thing it exists to show.
 *
 * Safe because nothing can be written while viewing — every non-GET
 * is already refused by the view-as middleware — so a button shown
 * here can never become an action taken.
 */
const shownFor = async (req: Request): Promise<{
  deletesSignups: boolean; deletesRfid: boolean; approves: boolean;
  isSuper: boolean; rfidReadOnly: boolean;
}> => {
  const email = req.user?.email ?? "";
  const a = await dmAccessFor(email);
  const isSuper = a.role === "super";
  return {
    deletesSignups: a.deletesSignups,
    deletesRfid: a.deletesRfid && !a.rfidReadOnly,
    approves: a.approves,
    isSuper,
    rfidReadOnly: !isSuper && a.rfidReadOnly,
  };
};

/**
 * 403 unless this person may CHANGE the RFID pool.
 *
 * Opening the page and changing it are different permissions now:
 * most people who need RFID Inventory need it to answer a question —
 * which tag went on that car, how many are left — and a page that
 * could only be granted whole meant answering it came with the
 * ability to spend tags.
 *
 * Judged on the real person, like every other write guard.
 */
async function requireRfidWrite(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  const real = req.viewingAs?.real ?? req.user;
  const a = await dmAccessFor(real?.email ?? "");
  if (a.role === "super" || !a.rfidReadOnly) { next(); return; }
  denied(req, "rfid read-only role");
  res.status(403).json({
    error: "Your role can read RFID Inventory but not change it. A super "
      + "administrator can lift that under Roles & Permissions.",
  });
}

/** The role this app is being shown as — the viewed person inside a view. */
const roleOf = async (req: Request): Promise<DmRole> =>
  (await dmAccessFor(req.user?.email ?? "")).role;

const actor = (req: Request): string => req.viewingAs?.real.email ?? req.user?.email ?? "";

/**
 * Everything an event needs about who and where, in one place.
 *
 * `actor` is the EFFECTIVE identity and `actorReal` the person at the
 * keyboard — the same outside a view, different inside one. Spread into
 * every `audit()` call under here so a new route cannot record less
 * than the others, or quietly drop the real actor.
 */
const who = (req: Request): {
  app: string; accountId: string; actor: string; actorReal: string; ip: string;
  userAgent: string; path: string; forwarded: string;
} => ({
  // Everything written from this file is the partner platform's. The
  // other product's security log does not carry it, and vice versa.
  app: "dutch-miller",
  // Which partner it happened in, when the request resolved one. Taken
  // from here rather than passed by each caller, for the same reason
  // the IP is: a route added later records as much as the others
  // without anybody remembering to make it.
  accountId: req.account?.id ?? "",
  actor: req.user?.email ?? "",
  actorReal: req.viewingAs?.real.email ?? req.user?.email ?? "",
  ...requestMeta(req),
});

/** A refusal, recorded. One line per denial, with the route it was for. */
const denied = (req: Request, why: string): void => {
  void audit({ action: "access.denied", subject: req.user?.email ?? "", detail: why,
    ...who(req) });
};

dutchMillerRouter.get("/users", requireDmAdmin, async (req: Request, res: Response) => {
  const [users, roles, accounts] = await Promise.all([
    listDmUsers(), listRoles(), listAccounts(),
  ]);
  const byKey = new Map(roles.map((r) => [r.key, r.name]));
  /*
   * Which partners each person holds, in one query rather than one
   * per row. The list is small, but the shape matters more than the
   * cost: a per-row read here is a page that gets slower every time
   * somebody is added, which is the one direction it will only ever go.
   */
  const scope = new Map<string, string[]>();
  for (const u of users) scope.set(u.email, []);
  for (const a of accounts) {
    for (const email of await holdersOf(a.id)) {
      if (scope.has(email)) scope.get(email)!.push(a.id);
    }
  }
  res.json({
    // The role NAME is attached here rather than in the row shape: the
    // key is what anything is decided on, and a name read off a stale
    // copy is how a renamed role starts showing two different labels.
    users: users.map((u) => ({
      ...u,
      roleName: byKey.get(u.roleKey) ?? u.roleKey,
      // Every account for somebody marked all-accounts, so the row
      // reads as what they actually hold rather than as the empty
      // assignment list underneath the mark.
      accounts: u.allAccounts ? accounts.map((a) => a.id) : (scope.get(u.email) ?? []),
    })),
    accounts: accounts.map((a) => ({
      id: a.id, slug: a.slug, name: a.name, affiliation: a.affiliation,
      line: accountLine(a), status: a.status,
    })),
    roles,
    allPages: DM_PAGES,
    allGrants: DM_GRANTS,
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
 *   the pinned account administrators (`DM_SUPER_ADMINS`)
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
dutchMillerRouter.get("/people", requireDmAdmin, async (req: Request, res: Response) => {
  // An account administrator is only visible to another one. An ordinary
  // admin cannot edit, disable or remove the account anyway, so listing
  // it would do nothing except advertise which address holds the keys —
  // and this list is the first thing a compromised admin session reads.
  // The viewed person's answer, so a view shows their list and not
  // the viewer's — an administrator being viewed must not be shown
  // the account administrator they cannot normally see.
  const iAmSuper = (await shownFor(req)).isSuper;
  const users = (await listDmUsers()).filter((u) => iAmSuper || !isSuperEmail(u.email));
  const configured = new Map(users.map((u) => [u.email, u]));

  // Which partners each person holds, so the list can say so without
  // a read per row. Explicit assignments only — somebody marked
  // all-accounts holds every one of them through the mark.
  const partners = await listAccounts();
  const scope = new Map<string, string[]>();
  for (const a of partners) {
    for (const email of await holdersOf(a.id)) {
      scope.set(email, [...(scope.get(email) ?? []), a.id]);
    }
  }
  const holds = (u: (typeof users)[number] | null): string[] =>
    !u ? [] : u.allAccounts ? partners.map((a) => a.id) : (scope.get(u.email) ?? []);

  type Row = {
    email: string; name: string; business: string | null;
    source: "microsoft" | "invited";
    pinnedSuper: boolean;
    user: (typeof users)[number] | null;
    /** Partner ids this person may open. Every one for a pinned admin. */
    accounts: string[];
    allAccounts: boolean;
  };
  const rows = new Map<string, Row>();
  const add = (r: Row) => { if (!rows.has(r.email)) rows.set(r.email, r); };

  const named = iAmSuper
    ? [...superEmails(), ...dutchMillerNamed()]
    : dutchMillerNamed().filter((e) => !isSuperEmail(e));
  for (const email of named) {
    add({
      email, name: email, business: null, source: "microsoft",
      pinnedSuper: isSuperEmail(email), user: configured.get(email) ?? null,
      accounts: isSuperEmail(email)
        ? partners.map((a) => a.id)
        : holds(configured.get(email) ?? null),
      allAccounts: isSuperEmail(email)
        || configured.get(email)?.allAccounts === true,
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
      accounts: isSuperEmail(u.email) ? partners.map((a) => a.id) : holds(u),
      allAccounts: isSuperEmail(u.email) || u.allAccounts,
    });
  }

  res.json({
    people: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    accounts: partners.map((a) => ({
      id: a.id, name: a.name, affiliation: a.affiliation,
      line: accountLine(a), status: a.status,
    })),
    iAmAccountAdmin: iAmSuper,
    roles: await listRoles(),
    mailConfigured: isMailConfigured(),
    mailFrom: mailFrom(),
    mailProblem: mailProblem(),
  });
});

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

/**
 * 403 unless this person is the account administrator.
 *
 * `isStaff` as well as the address, because the pin is an address and a
 * door is not: an invited account that somehow reached this address must
 * not inherit the keys with it.
 */
function requireSuperTo(what: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const real = req.viewingAs?.real ?? req.user;
    if (isStaff(real) && isSuperEmail(real?.email ?? "")) { next(); return; }
    denied(req, `account administrator only — ${what}`);
    res.status(403).json({ error: `Only an account administrator can ${what}.` });
  };
}

const requireSuper = requireSuperTo("change roles");

/**
 * May this person delete, now that a role can grant it?
 *
 * Super, or a role that has been handed the one in question. Judged
 * on the REAL person, like every other authority here: a view changes
 * whose data is on screen, never who is acting.
 */
function requireDelete(what: "signups" | "rfid") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const real = req.viewingAs?.real ?? req.user;
    const access = await dmAccessFor(real?.email ?? "");
    const may = what === "signups"
      ? access.deletesSignups
      // A view-only role does not delete, whatever else it was given.
      : access.deletesRfid && (access.role === "super" || !access.rfidReadOnly);
    if (may) { next(); return; }
    denied(req, `delete ${what}`);
    res.status(403).json({
      error: what === "signups"
        ? "Your role cannot delete a member record. An account administrator can "
          + "grant it under Roles & Permissions."
        : "Your role cannot remove RFID numbers. An account administrator can "
          + "grant it under Roles & Permissions.",
    });
  };
}

// Readable by any administrator — assigning one means seeing the list.
dutchMillerRouter.get("/roles", requireDmAdmin, async (_req: Request, res: Response) => {
  const roles = await listRoles();
  res.json({
    roles: roles.map((r) => ({ ...r, actions: actionsFor(r) })),
    allPages: DM_PAGES,
    allGrants: DM_GRANTS,
    // Page access and action permissions are different questions, and a
    // list of pages answers only one of them. These are DERIVED from the
    // rules the guards already apply — never stored per role — so the
    // editor shows them read-only rather than as checkboxes that would
    // broaden access the first time somebody saved one.
    allActions: ACTIONS,
    approvalPolicy: {
      roleKey: CSC_ROLE,
      note: "Approving a membership belongs to the built-in CSC role and to "
        + "nothing else. The pinned account administrator inherits it from "
        + "configuration — which is why approvals work even with nobody "
        + "holding CSC. It is asserted on every boot and cannot be granted "
        + "to another role.",
    },
    // The pinned owner is not a row, so it has no role to list. Shown
    // beside the roles because "who can approve?" is answered by both.
    superAdmin: { actions: actionsFor({ pages: [], administers: true, approves: true, pinnedSuper: true }) },
  });
});

// Creating and editing them is the account administrator's alone. A role is
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
      // Only an account administrator reaches this route, which is what
      // makes these safe to accept: a grant that removes things must
      // not be writable by somebody who could then grant it to
      // themselves.
      deletesSignups: body.deletesSignups === true,
      deletesRfid: body.deletesRfid === true,
      rfidReadOnly: body.rfidReadOnly === true,
      approvesVendors: body.approvesVendors === true,
      by: actor(req),
    });
    await audit({
      action: "role.saved", subject: role.key, resource: role.key, ...who(req),
      detail: `${role.name} · ${role.pages.length} page${role.pages.length === 1 ? "" : "s"}`
        + `${role.administers ? " · administers" : ""}`
        + `${role.deletesSignups ? " · deletes members" : ""}`
        + `${role.deletesRfid ? " · deletes RFIDs" : ""}`
        + `${role.rfidReadOnly ? " · RFID view only" : ""}`
        + `${role.approvesVendors ? " · approves vendors" : ""}`,
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
  // Their partner assignments go with them. A row left behind would
  // silently re-grant every one of them the day somebody with the
  // same address is invited back.
  await forgetAccountAccess(email);
  forgetEpoch(email);
  await audit({ action: "account.removed", subject: email, actor: actor(req) });
  res.json({ users: await listDmUsers() });
});

/* ------------------------------------------------------------------ *
 * Notification settings
 * ------------------------------------------------------------------ */

dutchMillerRouter.get("/settings/notifications", requireDmAdmin,
  async (_req: Request, res: Response) => {
    const notify = await getSignupNotify();
    res.json({
      notify,
      mailConfigured: isMailConfigured(),
      // Checked every time the page opens, not only when it is saved:
      // the reviewer can stop being able to approve long afterwards,
      // by somebody else changing their role.
      // One answer per reviewer. A list where one of them cannot
      // approve is exactly as broken as a single one who cannot, and
      // only saying so per person makes it findable.
      reviewerChecks: await Promise.all(notify.reviewers.map(checkReviewer)),
    });
  });

dutchMillerRouter.post("/settings/notifications", requireDmAdmin,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Both fields arrive as raw text, because that is what somebody
    // pastes. The server decides what an address is and says which
    // entries it refused rather than quietly dropping them.
    const reviewer = parseRecipients(body.reviewers ?? body.reviewer);
    if (reviewer.rejected.length > 0) {
      res.status(400).json({
        error: `Not an email address: ${reviewer.rejected.slice(0, 3).join(", ")}`,
        rejected: reviewer.rejected,
      });
      return;
    }
    const notifiers = parseRecipients(body.notifiers);
    if (notifiers.rejected.length > 0) {
      res.status(400).json({
        error: `Not an email address: ${notifiers.rejected.slice(0, 5).join(", ")}`,
        rejected: notifiers.rejected,
      });
      return;
    }
    try {
      const notify = await setSignupNotify({
        reviewers: reviewer.ok,
        notifiers: notifiers.ok,
        enabled: body.enabled !== false,
        copySubmitter: body.copySubmitter === true,
      }, actor(req));
      await audit({
        action: "notify.changed", ...who(req),
        detail: notify.enabled
          ? `${notify.reviewers.length} reviewer(s) · ${notify.notifiers.length} notified`
          : "off",
      });
      // Saved either way, and reported. An administrator may have a
      // reason to point notifications at somebody while a role is being
      // sorted out; refusing the save would leave the OLD reviewer in
      // place with nothing on screen saying so.
      res.json({
        notify,
        reviewerChecks: await Promise.all(notify.reviewers.map(checkReviewer)),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

dutchMillerRouter.get("/settings/reminders", requireDmAdmin,
  async (_req: Request, res: Response) => {
    res.json({ reminders: await getReminders(), days: DAY_NAMES, timezone: DISPLAY_TZ });
  });

dutchMillerRouter.post("/settings/reminders", requireDmAdmin,
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const reminders = await setReminders({
        enabled: b.enabled === true,
        frequency: b.frequency === "day" ? "day" : "week",
        days: Array.isArray(b.days) ? b.days.map(Number) : [],
        hour: Number(b.hour) || 8,
        minute: Number(b.minute) || 0,
        meridiem: b.meridiem === "PM" ? "PM" : "AM",
      }, actor(req));
      await audit({
        action: "reminder.changed", actor: actor(req),
        detail: reminders.enabled
          ? `${reminders.frequency} · ${reminders.days.map((d) => DAY_NAMES[d]).join(", ")} `
            + `· ${reminders.hour}:${String(reminders.minute).padStart(2, "0")} ${reminders.meridiem}`
          : "off",
      });
      res.json({ reminders });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

/** Send one now, to see what it looks like and that it works. */
dutchMillerRouter.post("/settings/reminders/run", requireDmAdmin,
  async (_req: Request, res: Response) => {
    const out = await runReminders(true);
    res.json(out);
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
    const recent = req.account
      ? (await listSignups({ account: req.account.id, limit: 1 })).rows[0]
      : undefined;
    const sample: SignupRow = recent ?? {
      guid: "00000000-0000-4000-8000-000000000000",
      createdAt: new Date().toISOString(),
      displayTimezone: DISPLAY_TZ,
      dealer: { dlwContractId: "0041", dealNumber: "00712", customerId: "C-9" },
      customer: {
        firstName: "Sample", lastName: "Member",
        phone: "(304) 555-0133", email: "member@example.invalid", plateDlw: "ABC 1234", plateState: "WV",
        vehicleMake: "Ford", vehicleModel: "Bronco", vehicleYear: "2024",
        vehicleColor: "Blue", rfid: "00000+000000", stickerAttached: true,
        stickerState: "confirmed",
        stickerConfirmedAt: new Date().toISOString(),
        stickerConfirmedBy: "sample@mojocarwash.com",
      },
      submittedAt: new Date().toISOString(),
      submittedBy: to,
      notifiedAt: null,
      openedAt: null,
      openedBy: null,
      completedAt: null,
      completedBy: null,
      deletedAt: null,
      deletedBy: null,
      deleteNote: null,
      tagReleased: false,
    };
    const { subject, html } = signupEmail(sample, {
      sample: true, origin: publicOrigin(req),
      partner: req.account
        ? { name: req.account.name, slug: req.account.slug }
        : undefined,
    });
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
 * The security log: attempts that failed, and anything worth a look.
 *
 * Separate from the audit trail on purpose. The trail is a record of
 * what was DONE — invites sent, roles changed, accounts disabled — and
 * it is mostly ordinary. This is only the things that did not work:
 * addresses nobody invited asking for links, spent and expired links
 * being replayed, wrong codes, lockouts, sessions presented after the
 * account behind them stopped being valid. Four real attempts buried
 * in nine hundred ordinary lines is how they get missed.
 */
dutchMillerRouter.get("/security", requireDmAdmin, async (req: Request, res: Response) => {
  const days = Number(req.query.days ?? 30);
  const [events, summary] = await Promise.all([
    listSecurityLog({
      days, limit: Number(req.query.limit ?? 300), accounts: historyScope(req),
    }),
    securitySummary(days),
  ]);
  res.json({ events, ...summary, days, lockout: LOCKOUT });
});

/**
 * The triage view: patterns, not single events.
 *
 * Read-only and computed on request. Nothing here opens a case, sends
 * anything, or writes a classification — a concern is a reason for a
 * person to look, and that is all it is allowed to be.
 */
dutchMillerRouter.get("/security/concerns", requireDmAdmin,
  async (_req: Request, res: Response) => {
    res.json({
      concerns: await concerns(),
      thresholds: THRESHOLDS,
      counts: await investigationCounts(),
    });
  });

/** What this app can and cannot see. Stated, because the gap matters. */
dutchMillerRouter.get("/security/coverage", requireDmAdmin,
  async (_req: Request, res: Response) => {
    res.json({ sources: coverage(), health: await collectionHealth() });
  });

const asCategory = (v: unknown): EventCategory | "all" | undefined => {
  const s = String(v ?? "");
  return s === "security" || s === "access" || s === "business" || s === "all"
    ? s : undefined;
};

/**
 * Every event, filtered.
 *
 * The one read behind Security, Sign-ins and Audit History alike —
 * three views of one table rather than three logs, because the first
 * question an investigator asks is "what else happened around then"
 * and separate tables cannot answer it.
 */
/*
 * `/event-log`, not `/events`.
 *
 * `/events` is the live SSE stream, registered above, and Express
 * takes the first match — so this route was silently shadowed and the
 * whole security workspace read an event stream instead of its data.
 * Caught by booting the server and curling it; worth remembering that
 * a typecheck cannot see a route collision.
 */
dutchMillerRouter.get("/event-log", requireDmAdmin, async (req: Request, res: Response) => {
  const q = req.query;
  const preset = q.preset === "signins" || q.preset === "suspicious"
    || q.preset === "viewas" ? q.preset : undefined;
  const outcome = (OUTCOMES as readonly string[]).includes(String(q.outcome ?? ""))
    ? (String(q.outcome) as Outcome) : undefined;
  const minSeverity = (SEVERITIES as readonly string[]).includes(String(q.minSeverity ?? ""))
    ? (String(q.minSeverity) as Severity) : undefined;
  res.json({
    ...(await listEvents({
      category: asCategory(q.category),
      preset,
      who: String(q.who ?? ""),
      ip: String(q.ip ?? ""),
      action: (EVENT_META as Record<string, unknown>)[String(q.action ?? "")]
        ? String(q.action) : undefined,
      outcome,
      minSeverity,
      resource: String(q.resource ?? ""),
      search: String(q.search ?? ""),
      days: Number(q.days ?? 90),
      limit: Number(q.limit ?? 200),
      offset: Number(q.offset ?? 0),
      accounts: historyScope(req),
    })),
    // So the filter dropdowns are built from the catalogue rather than
    // from a second copy in the UI that can drift from it.
    actions: Object.entries(EVENT_META).map(([key, m]) => ({
      key, label: m.label, category: m.category,
      outcome: m.outcome, severity: m.severity,
    })),
  });
});

/**
 * The audit trail.
 *
 * Admin-only, and read-only: there is no route that edits or deletes a
 * line, deliberately. A log somebody can tidy up is not evidence of
 * anything. Per-account History is this same read with a subject, not
 * a second implementation.
 */
dutchMillerRouter.get("/audit", requireDmAdmin, async (req: Request, res: Response) => {
  res.json({
    entries: await listAudit({
      subject: String(req.query.subject ?? ""),
      resource: String(req.query.resource ?? ""),
      limit: Number(req.query.limit ?? 200),
      accounts: historyScope(req),
    }),
  });
});

/**
 * View-as sessions, start paired with end.
 *
 * Its own read because it answers a different question from the event
 * list: not "what happened" but "who was wearing whose identity, and
 * for how long". Paired on the session id both events carry, so two
 * views of the same person in one afternoon do not get muddled, and a
 * start with no end is reported as exactly that rather than given an
 * invented one.
 */
dutchMillerRouter.get("/view-as-sessions", requireDmAdmin,
  async (req: Request, res: Response) => {
    res.json({
      sessions: await listViewAsSessions({
        who: String(req.query.who ?? ""),
        days: Number(req.query.days ?? 90),
        limit: Number(req.query.limit ?? 200),
      }),
    });
  });

/* ------------------------------------------------------------------ *
 * Investigations
 * ------------------------------------------------------------------ */

const asStatus = (v: unknown): InvestigationStatus | undefined =>
  (INVESTIGATION_STATUSES as readonly string[]).includes(String(v ?? ""))
    ? (String(v) as InvestigationStatus) : undefined;
const asClassification = (v: unknown): Classification | undefined =>
  (CLASSIFICATIONS as readonly string[]).includes(String(v ?? ""))
    ? (String(v) as Classification) : undefined;

dutchMillerRouter.get("/investigations", requireDmAdmin,
  async (req: Request, res: Response) => {
    res.json({
      cases: await listInvestigations({
        status: asStatus(req.query.status) ?? "all",
        limit: Number(req.query.limit ?? 100),
      }),
      counts: await investigationCounts(),
      statuses: INVESTIGATION_STATUSES,
      classifications: CLASSIFICATIONS,
    });
  });

dutchMillerRouter.get("/investigations/:id", requireDmAdmin,
  async (req: Request, res: Response) => {
    const row = await getInvestigation(String(req.params.id ?? ""));
    if (!row) { res.status(404).json({ error: "No such investigation." }); return; }
    // The events it points at, read fresh from the trail rather than
    // copied into the case: the case holds ids, never evidence.
    const events = row.eventIds.length > 0
      ? (await listEvents({ days: 3650, limit: 500 })).rows
        .filter((e) => row.eventIds.includes(e.id))
      : [];
    res.json({ case: row, events });
  });

dutchMillerRouter.post("/investigations", requireDmAdmin,
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as {
      title?: unknown; eventIds?: unknown; evidence?: unknown; note?: unknown;
    };
    try {
      const made = await openInvestigation({
        title: String(b.title ?? ""),
        by: actor(req),
        eventIds: Array.isArray(b.eventIds) ? b.eventIds.map(String) : [],
        evidence: String(b.evidence ?? ""),
        note: String(b.note ?? ""),
      });
      await audit({
        action: "investigation.opened", resource: made.id, ...who(req),
        detail: made.title,
      });
      res.json({ case: made });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

dutchMillerRouter.post("/investigations/:id", requireDmAdmin,
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as {
      status?: unknown; classification?: unknown; assignee?: unknown;
      resolution?: unknown; note?: unknown; addEventIds?: unknown;
    };
    const out = await updateInvestigation({
      id: String(req.params.id ?? ""),
      by: actor(req),
      status: asStatus(b.status),
      classification: asClassification(b.classification),
      assignee: b.assignee === undefined ? undefined : String(b.assignee),
      resolution: b.resolution === undefined ? undefined : String(b.resolution),
      note: String(b.note ?? ""),
      addEventIds: Array.isArray(b.addEventIds) ? b.addEventIds.map(String) : [],
    });
    if (!out.ok) { res.status(400).json({ error: out.reason }); return; }
    await audit({
      action: "investigation.updated", resource: out.row.id, ...who(req),
      detail: `${out.row.title} · ${out.row.status} · ${out.row.classification}`,
    });
    res.json({ case: out.row });
  });

/**
 * Record that data left the app.
 *
 * The export itself is built in the browser from rows it already has,
 * so there is no download route to hang this on — and an export that
 * leaves no trace is exactly the one worth tracing. The page posts
 * here as it downloads. Best-effort by nature: it records the exports
 * the app performs, and nothing stops somebody copying a table by
 * hand, which the Coverage view says out loud.
 */
dutchMillerRouter.post("/exported", async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { kind?: unknown; rows?: unknown; detail?: unknown };
  const kind = String(b.kind ?? "");
  const action: AuditAction = kind === "rfid" ? "export.rfid"
    : kind === "security" ? "export.security" : "export.members";
  const rows = Math.max(0, Math.min(Number(b.rows) || 0, 1_000_000));
  await audit({
    action, ...who(req),
    detail: `${rows} row(s)${b.detail ? ` · ${String(b.detail).slice(0, 120)}` : ""}`,
  });
  res.json({ ok: true });
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
  requireRfidWrite,
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

      /*
       * ALL OR NOTHING, as with the member upload and for the same
       * reason: a tag is a physical thing, and a pool half-loaded from
       * a file somebody has since corrected leaves nobody able to say
       * which numbers are in it. One unreadable number refuses the
       * file, named, and the person fixes it and uploads again.
       *
       * Repeats and numbers already held are NOT errors — those are
       * two copies of a correct number, which costs nothing. They are
       * reported, not refused.
       */
      if (parsed.rejected.length > 0) {
        res.status(400).json({
          refused: true,
          error: `Nothing was added. ${parsed.rejected.length} `
            + `number${parsed.rejected.length === 1 ? "" : "s"} could not be read.`,
          rejected: parsed.rejected,
          cells: parsed.cells,
          readable: parsed.numbers.length,
        });
        return;
      }
      if (parsed.numbers.length === 0) {
        res.status(400).json({
          refused: true,
          error: "No RFID numbers were found in that file.",
          rejected: [],
          cells: parsed.cells,
          readable: 0,
        });
        return;
      }

      const account = accountOf(req, res);
      if (!account) return;
      const result = await addRfids(
        parsed.numbers, parsed.rejected, parsed.cells, req.user?.email ?? "",
        account.id);
      void audit({
        action: "rfid.uploaded", ...who(req),
        detail: `${result.added} added from ${parsed.numbers.length} readable `
          + `of ${parsed.cells} cells`,
      });
      emitChange("rfid");
      res.json({ ...result, counts: await rfidCounts(account.id) });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/** The layout, so nobody has to guess at it before uploading. */
dutchMillerRouter.get("/rfid/format", requirePage("rfid-review"),
  (_req: Request, res: Response) => {
    res.json({
      pattern: "nnnnn+nnnnnn",
      rules: [
        "Eleven digits as five, a plus, then six — 12345+678901.",
        "Every cell of every sheet is read, so no column needs naming and "
          + "headers or notes are ignored.",
        "Eleven digits with no separator are accepted and the plus is added.",
        "A dash in place of the plus is accepted.",
        "Ten digits are refused — that is Excel dropping a leading zero. "
          + "Format the column as text before saving.",
        "A number already in the pool is reported, not added twice.",
      ],
      csv: "RFID\r\n12345+678901\r\n23456+789012\r\n",
    });
  });

dutchMillerRouter.get("/rfid", requirePage("rfid-review"), async (req: Request, res: Response) => {
  const account = accountOf(req, res);
  if (!account) return;
  const status = String(req.query.status ?? "all");
  res.json({
    ...(await listRfids({
      account: account.id,
      status: status === "active" || status === "inactive" || status === "used"
        || status === "deleted" || status === "test" ? status : "all",
      search: String(req.query.search ?? ""),
      limit: Number(req.query.limit ?? 100),
      offset: Number(req.query.offset ?? 0),
    })),
    counts: await rfidCounts(account.id),
    // What THIS app's owner can do — the viewed person inside a view.
    // The routes below decide again, on the real person.
    canDelete: (await shownFor(req)).deletesRfid,
    canTest: (await shownFor(req)).isSuper,
    // Whether the buttons belong on the page at all.
    canManage: !(await shownFor(req)).rfidReadOnly,
  });
});

/**
 * Keep numbers back for testing, or release them into ordinary use.
 *
 * The owner's alone, like issuing one: the whole value of a test tag
 * is that exactly one person can put it on a vehicle, and a mark
 * anybody could clear would be a label rather than a rule.
 */
dutchMillerRouter.post(
  "/rfid/test-only",
  requirePage("rfid-review"),
  requireRfidWrite,
  requireSuperTo("keep RFID numbers back for testing"),
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { numbers?: unknown; testOnly?: unknown };
    const numbers = Array.isArray(body.numbers) ? body.numbers.map(String) : [];
    const on = body.testOnly === true;
    const account = accountOf(req, res);
    if (!account) return;
    const out = await setRfidTestOnly(numbers, on, account.id);
    await audit({
      action: "rfid.held", ...who(req),
      detail: `${out.changed} ${on ? "kept back for testing" : "released from testing"}`,
    });
    emitChange("rfid");
    res.json({ ...out, counts: await rfidCounts(account.id) });
  },
);

/**
 * Remove numbers from the pool. Account Administrator only, note required.
 *
 * The same shape as deleting a member record, and for the same reason:
 * the row stays, marked, with the reason attached. Unlike holding a tag
 * back, this is not something an administrator can do — a tag leaving the
 * pool for good is the kind of decision that should have exactly one
 * person's name on it.
 */
dutchMillerRouter.post(
  "/rfid/delete",
  requirePage("rfid-review"),
  requireRfidWrite,
  requireDelete("rfid"),
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { numbers?: unknown; note?: unknown };
    const numbers = Array.isArray(body.numbers) ? body.numbers.map(String) : [];
    const account = accountOf(req, res);
    if (!account) return;
    const out = await deleteRfids({
      numbers, note: String(body.note ?? ""), by: actor(req), account: account.id,
    });
    if ("error" in out) { res.status(400).json({ error: out.error }); return; }
    await audit({
      action: "rfid.deleted",
      detail: `${out.deleted} removed · ${String(body.note ?? "").trim().slice(0, 200)}`,
      ...who(req),
    });
    emitChange("rfid");
    res.json({ ...out, counts: await rfidCounts(account.id) });
  },
);

/** Issue one. The server decides, once; see `useRfid`. */
dutchMillerRouter.post("/rfid/use", requirePage("rfid-review"), requireRfidWrite,
  async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { number?: unknown; usedFor?: unknown };
  const account = accountOf(req, res);
  if (!account) return;
  const out = await useRfid(
    String(body.number ?? ""), req.user?.email ?? "", String(body.usedFor ?? ""),
    account.id);
  if (!out.ok) { res.status(409).json({ error: out.reason }); return; }
  res.json({ row: out.row, counts: await rfidCounts(account.id) });
});

/** Hold back, or put back in play. Never a used one. */
dutchMillerRouter.post("/rfid/active", requirePage("rfid-review"), requireRfidWrite,
  async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { numbers?: unknown; active?: unknown };
  const numbers = Array.isArray(body.numbers) ? body.numbers.map(String) : [];
  const account = accountOf(req, res);
  if (!account) return;
  const out = await setRfidActive(numbers, body.active !== false, account.id);
  void audit({
    action: "rfid.held", ...who(req),
    detail: `${out.changed} ${body.active !== false ? "released into" : "held back from"} `
      + "the pool",
  });
  emitChange("rfid");
  res.json({ ...out, counts: await rfidCounts(account.id) });
});

/* ------------------------------------------------------------------ *
 * Member signups
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The shared template, and each account's arrangement of it
 * ------------------------------------------------------------------ */

const asPage = (v: unknown): BlockPage | null =>
  (isBlockPage(v) ? v : null);

/**
 * One page's layout, as this account actually sees it.
 *
 * Open to anybody who can open the page, because this IS the page —
 * refusing it to a non-administrator would mean a blank screen
 * rather than a screen they cannot rearrange. What they may CHANGE
 * is a separate answer, returned alongside and decided again on the
 * save below.
 */
dutchMillerRouter.get("/blocks/:page", async (req: Request, res: Response) => {
  const page = asPage(req.params.page);
  if (!page) { res.status(404).json({ error: "No such page." }); return; }
  const account = accountOf(req, res);
  if (!account) return;
  // The grant that opens the page this layout is for. A layout is not
  // a separate permission — it is the shape of something they can
  // already read, or cannot.
  const grant: DmPageKey = page === "member-signups-add" ? "member-signups-add"
    : page === "member-signups-review" ? "member-signups"
      : page === "rfid-instructions" ? "rfid-instructions" : "rfid-review";
  const access = await dmAccessFor(req.user?.email ?? "");
  if (!canAdminister(access) && !access.pages.includes(grant)) {
    denied(req, `page ${grant}`);
    res.status(403).json({ error: "You do not have access to that page." });
    return;
  }
  res.json({
    page,
    label: PAGE_LABEL[page],
    account: { id: account.id, name: account.name },
    layout: await layoutFor(account.id, page),
    /** The catalogue, so the editor can offer what is not placed yet. */
    available: (await listBlocks(page)).filter((b) => b.archivedAt === null),
    items: itemsOn(page),
    essential: essentialOn(page),
    widths: WIDTHS,
    heights: HEIGHTS,
    /* Arranging an account's own page is administering that account.
       It is shown here and decided again on the write. */
    canArrange: canAdminister(await dmAccessFor(
      req.viewingAs?.real.email ?? req.user?.email ?? "")),
  });
});

/**
 * Save this account's arrangement of one page.
 *
 * Administering THIS account is enough — it is their own page, and
 * nothing here reaches another partner. Changing the shared bucket
 * underneath is a different route and a different permission.
 */
dutchMillerRouter.post("/blocks/:page/layout", requireDmAdmin,
  async (req: Request, res: Response) => {
    const page = asPage(req.params.page);
    if (!page) { res.status(404).json({ error: "No such page." }); return; }
    const account = accountOf(req, res);
    if (!account) return;
    const body = (req.body ?? {}) as { layout?: unknown };
    const rows = Array.isArray(body.layout)
      ? (body.layout as Record<string, unknown>[]).map((r) => ({
        blockId: String(r.blockId ?? ""),
        position: Number(r.position),
        width: Number(r.width),
        height: String(r.height ?? "auto"),
        hidden: r.hidden === true,
        items: Array.isArray(r.items) ? (r.items as unknown[]).map(String) : null,
      }))
      : [];
    const out = await saveLayout(account.id, page, rows, actor(req));
    if (!out.ok) { res.status(400).json({ error: out.problem }); return; }
    await audit({
      action: "layout.saved", ...who(req), resource: page,
      detail: `${PAGE_LABEL[page]} — ${rows.length} bucket(s) arranged`,
    });
    emitChange("settings");
    res.json({ layout: out.layout });
  });

/** Back to the base layout. Deleting the overrides, not copying the base. */
dutchMillerRouter.post("/blocks/:page/reset", requireDmAdmin,
  async (req: Request, res: Response) => {
    const page = asPage(req.params.page);
    if (!page) { res.status(404).json({ error: "No such page." }); return; }
    const account = accountOf(req, res);
    if (!account) return;
    const layout = await resetLayout(account.id, page);
    await audit({
      action: "layout.reset", ...who(req), resource: page,
      detail: `${PAGE_LABEL[page]} — back to the shared layout`,
    });
    emitChange("settings");
    res.json({ layout });
  });

/**
 * The catalogue itself.
 *
 * Readable by any administrator, because knowing what a bucket holds
 * is how you decide whether to place it. Writable only by an account
 * administrator: a bucket is shared, so changing one changes every
 * partner's page at once.
 */
dutchMillerRouter.get("/template/blocks", requireDmAdmin,
  async (_req: Request, res: Response) => {
    res.json({
      pages: await Promise.all(BLOCK_PAGES.map(async (p) => ({
        key: p,
        label: PAGE_LABEL[p],
        items: itemsOn(p),
        essential: essentialOn(p),
        blocks: await listBlocks(p),
        /* Which partners have arranged this page for themselves, so
           the editor can say how many layouts a change will meet
           rather than letting somebody find out afterwards. */
        arranging: (await accountsArranging(p)).length,
      }))),
    });
  });

dutchMillerRouter.post("/template/blocks",
  requireSuperTo("change the shared template"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as {
      id?: unknown; page?: unknown; name?: unknown; items?: unknown; columns?: unknown;
    };
    const page = asPage(b.page);
    if (!page) { res.status(400).json({ error: "Choose a page." }); return; }
    const out = await saveBlock({
      id: typeof b.id === "string" && b.id ? b.id : undefined,
      page,
      name: String(b.name ?? ""),
      items: Array.isArray(b.items) ? (b.items as unknown[]).map(String) : [],
      columns: Number(b.columns),
    }, actor(req));
    if (!out.ok) { res.status(400).json({ error: out.problem }); return; }
    await audit({
      action: out.created ? "template.block.created" : "template.block.changed",
      ...who(req), resource: out.block.id,
      detail: `${PAGE_LABEL[page]} — ${out.block.name} (${out.block.items.length} item(s))`,
    });
    emitChange("settings");
    res.json({ block: out.block, created: out.created });
  });

dutchMillerRouter.post("/template/blocks/:id/archive",
  requireSuperTo("retire a shared bucket"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { archived?: unknown };
    const archived = b.archived !== false;
    const out = await archiveBlock(String(req.params.id ?? ""), archived);
    if (!out.ok) { res.status(400).json({ error: out.problem }); return; }
    await audit({
      action: "template.block.changed", ...who(req),
      resource: String(req.params.id ?? ""),
      detail: archived ? "retired from the catalogue" : "brought back into the catalogue",
    });
    emitChange("settings");
    res.json({ ok: true });
  });

/** The base layout a new account starts on, and an untouched page follows. */
dutchMillerRouter.post("/template/layout/:page",
  requireSuperTo("change the shared layout"),
  async (req: Request, res: Response) => {
    const page = asPage(req.params.page);
    if (!page) { res.status(404).json({ error: "No such page." }); return; }
    const body = (req.body ?? {}) as { layout?: unknown };
    const rows = Array.isArray(body.layout)
      ? (body.layout as Record<string, unknown>[]).map((r) => ({
        blockId: String(r.blockId ?? ""),
        position: Number(r.position),
        width: Number(r.width),
        height: String(r.height ?? "auto"),
      }))
      : [];
    const out = await saveBaseLayout(page, rows);
    if (!out.ok) { res.status(400).json({ error: out.problem }); return; }
    await audit({
      action: "template.layout.changed", ...who(req), resource: page,
      detail: `${PAGE_LABEL[page]} — base layout set, ${rows.length} bucket(s)`,
    });
    emitChange("settings");
    res.json({ ok: true });
  });

/* ------------------------------------------------------------------ *
 * Partner accounts
 * ------------------------------------------------------------------ */

/**
 * Every partner this person may open.
 *
 * The switcher's list, and the account administrator's management
 * view, from one read — they differ in what is in the list rather
 * than in what the list is. An administrator holding one partner
 * gets one row back and no create button; the pinned account
 * administrator gets every partner including the deactivated ones,
 * which are the whole reason a management view exists.
 *
 * Counts are attached for an account administrator only, because
 * they are the one person who needs to compare partners and they
 * cost a query each. Nobody else is shown another partner's size.
 */
dutchMillerRouter.get("/accounts", async (req: Request, res: Response) => {
  const email = req.viewingAs?.real.email ?? req.user?.email ?? "";
  const isAccountAdmin = isSuperEmail(email);
  const mine = req.accountScope ?? [];
  const rows = await Promise.all(mine.map(async (a) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    affiliation: a.affiliation,
    line: accountLine(a),
    status: a.status,
    templateVersion: a.templateVersion,
    createdAt: a.createdAt,
    createdBy: a.createdBy,
    deactivatedAt: a.deactivatedAt,
    deactivatedBy: a.deactivatedBy,
    deactivateReason: a.deactivateReason,
    counts: isAccountAdmin
      ? {
        members: (await listSignups({ account: a.id, limit: 1 })).counts.total,
        tags: (await rfidCounts(a.id)).total,
        vendors: (await listVendors({ account: a.id, status: "all" })).counts.total,
      }
      : null,
  })));
  res.json({
    platform: PLATFORM_NAME,
    accounts: rows,
    current: req.account?.id ?? null,
    isAccountAdmin,
    templateVersion: TEMPLATE_VERSION,
    /** So the create form can refuse a reserved path before submitting. */
    reserved: isAccountAdmin ? RESERVED_SLUGS : [],
  });
});

/**
 * Provision a partner.
 *
 * A NAME is the whole requirement; the path is suggested from it and
 * can be overridden. Nothing else is invented — no reviewers, no
 * stock, no integrations — because an account that claims a reviewer
 * it does not have is worse than one that plainly has none.
 *
 * Idempotent on the path, so a double-click or a retried request
 * returns the account that is already there rather than a twin.
 */
dutchMillerRouter.post("/accounts", requireSuperTo("create a partner account"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { name?: unknown; slug?: unknown; affiliation?: unknown };
    const out = await createAccount({
      name: String(b.name ?? ""),
      slug: b.slug === undefined ? undefined : String(b.slug),
      affiliation: String(b.affiliation ?? ""),
    }, actor(req));
    if (!out.ok) { res.status(400).json({ error: out.problem }); return; }
    if (out.created) {
      await audit({
        action: "partner.created", ...who(req), accountId: out.account.id,
        subject: out.account.slug,
        detail: `partner account created — ${accountLine(out.account)}`
          + ` · template v${out.account.templateVersion}`,
      });
    }
    res.json({ account: out.account, created: out.created });
  });

/** Suggest a path from a name, so the form can show one before saving. */
dutchMillerRouter.get("/accounts/suggest", requireSuperTo("create a partner account"),
  (req: Request, res: Response) => {
    const slug = slugFrom(String(req.query.name ?? ""));
    res.json({ slug, problem: slug ? slugProblem(slug) : null });
  });

/** Rename, or set the wash it runs under. The id and the path do not move. */
dutchMillerRouter.post("/accounts/:id", requireSuperTo("change a partner account"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { name?: unknown; affiliation?: unknown };
    const out = await renameAccount(String(req.params.id ?? ""), {
      name: b.name === undefined ? undefined : String(b.name),
      affiliation: b.affiliation === undefined ? undefined : String(b.affiliation),
    }, actor(req));
    if ("problem" in out) { res.status(400).json({ error: out.problem }); return; }
    await audit({
      action: "partner.updated", ...who(req), accountId: out.id, subject: out.slug,
      detail: `partner account renamed — ${accountLine(out)}`,
    });
    res.json({ account: out });
  });

/**
 * Deactivate a partner, or bring one back.
 *
 * Keeps everything. Records, tags, invitations, roles and history
 * stay exactly where they are; what stops is operational access,
 * refused by the middleware above so a deep link or a stale tab
 * cannot walk past it. Account administrators keep the management
 * view, which is the point of keeping the account at all.
 *
 * NOT the partner-access switch. That one pauses the emailed-link
 * door and leaves MOJO working inside the account.
 */
dutchMillerRouter.post("/accounts/:id/status",
  requireSuperTo("deactivate a partner account"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { active?: unknown; reason?: unknown };
    const want = b.active === true ? "active" : "inactive";
    const out = await setAccountStatus(
      String(req.params.id ?? ""), want, actor(req), String(b.reason ?? ""));
    if ("problem" in out) { res.status(400).json({ error: out.problem }); return; }
    await audit({
      action: out.status === "active" ? "partner.reactivated" : "partner.deactivated",
      ...who(req), accountId: out.id, subject: out.slug,
      detail: out.status === "active"
        ? `partner account ${out.name} reactivated`
        : `partner account ${out.name} DEACTIVATED — ${out.deactivateReason}`,
    });
    // Every open page in that account is about to be refused.
    emitChange("signups");
    res.json({ account: out });
  });

/**
 * Which partners somebody may open.
 *
 * The account administrator's alone, and for the same reason roles
 * are: scope is a grant, so an administrator who could widen it
 * could widen their own. Whole-list rather than add and remove,
 * because the form shows every account with a tick beside some of
 * them and reconciling that into two streams of calls is how a
 * half-applied change happens.
 */
dutchMillerRouter.post("/users/:email/accounts",
  requireSuperTo("change which partners somebody can open"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { accounts?: unknown; allAccounts?: unknown };
    const target = String(req.params.email ?? "").trim().toLowerCase();
    if (isSuperEmail(target)) {
      res.status(400).json({
        error: "An account administrator already holds every partner account.",
      });
      return;
    }
    const row = await getDmUser(target);
    if (!row) { res.status(404).json({ error: "No such person." }); return; }
    const ids = Array.isArray(b.accounts) ? b.accounts.map(String) : [];
    const all = b.allAccounts === true;
    try {
      await saveDmUser({
        email: target, roleKey: row.roleKey, by: actor(req),
        byRole: await roleOf(req), allAccounts: all,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const kept = await setAssignedAccounts(target, ids, actor(req));
    const names = (await listAccounts())
      .filter((a) => kept.includes(a.id)).map((a) => a.name);
    await audit({
      action: "partner.scope", ...who(req), subject: target,
      detail: all
        ? "given EVERY partner account, current and future"
        : `partner accounts set to ${names.length > 0 ? names.join(", ") : "none"}`,
    });
    forgetEpoch(target);
    emitChange("users");
    res.json({ accounts: kept, allAccounts: all });
  });

/** Which partners this person currently holds, for the form that sets them. */
dutchMillerRouter.get("/users/:email/accounts", requireDmAdmin,
  async (req: Request, res: Response) => {
    const target = String(req.params.email ?? "").trim().toLowerCase();
    const row = await getDmUser(target);
    res.json({
      assigned: await assignedAccounts(target),
      allAccounts: isSuperEmail(target) || row?.allAccounts === true,
      pinned: isSuperEmail(target),
      accounts: (await listAccounts()).map((a) => ({
        id: a.id, name: a.name, affiliation: a.affiliation,
        line: accountLine(a), status: a.status,
      })),
    });
  });

/* ------------------------------------------------------------------ *
 * The partner account, and vendors
 * ------------------------------------------------------------------ */

/**
 * The account administrator's, to read as well as to change.
 *
 * Not merely hidden from the menu: an ordinary administrator asking
 * directly is refused too, so "who can close the partner account" has
 * one answer rather than one answer and a loophole.
 */
dutchMillerRouter.get("/account", requireSuperTo("see the partner account switch"),
  async (req: Request, res: Response) => {
    const account = accountOf(req, res);
    if (!account) return;
    res.json({
      ...await getAccountState(account.id),
      account: {
        id: account.id, slug: account.slug, name: account.name,
        affiliation: account.affiliation, status: account.status,
        deactivatedAt: account.deactivatedAt, deactivatedBy: account.deactivatedBy,
        deactivateReason: account.deactivateReason,
        templateVersion: account.templateVersion,
      },
    });
  });

dutchMillerRouter.post("/account", requireSuperTo("switch partner access"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { active?: unknown; reason?: unknown };
    const account = accountOf(req, res);
    if (!account) return;
    try {
      const out = await setAccountState(
        b.active === true, String(b.reason ?? ""), actor(req), account.id);
      await audit({
        action: "account.updated", ...who(req),
        subject: `${account.slug}-partner-access`,
        detail: out.active
          ? "partner access switched ON"
          : `partner access switched OFF — ${out.reason}`,
      });
      // Every dealer's next request is refused, so tell the pages.
      emitChange("signups");
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

/** May this person sign a vendor off? Granted per role, plus the owner. */
async function canApproveVendors(req: Request): Promise<boolean> {
  const real = req.viewingAs?.real ?? req.user;
  const a = await dmAccessFor(real?.email ?? "");
  return a.role === "super" || a.approvesVendors;
}

dutchMillerRouter.get("/vendors", requirePage("vendors"),
  async (req: Request, res: Response) => {
    const account = accountOf(req, res);
    if (!account) return;
    const status = String(req.query.status ?? "all");
    const ok = ["all", "pending", "approved", "rejected", "inactive", "awaiting"];
    res.json({
      ...(await listVendors({
        account: account.id,
        status: ok.includes(status) ? (status as never) : "all",
        search: String(req.query.search ?? ""),
      })),
      // Shown for the viewed person, decided again on the write.
      canApprove: (await dmAccessFor(req.user?.email ?? "")).approvesVendors
        || (await dmAccessFor(req.user?.email ?? "")).role === "super",
      canDelete: (await shownFor(req)).isSuper,
    });
  });

dutchMillerRouter.get("/vendors/:id", requirePage("vendors"),
  async (req: Request, res: Response) => {
    const account = accountOf(req, res);
    if (!account) return;
    const v = await getVendor(String(req.params.id ?? ""), account.id);
    if (!v) { res.status(404).json({ error: "No such vendor." }); return; }
    res.json({
      vendor: v,
      // What stops a reviewer approving, as opposed to what stopped
      // somebody submitting. Reported, never enforced.
      blockers: approvalBlockers(v.pending?.fields ?? v),
      labels: VENDOR_LABEL,
    });
  });

/**
 * Propose a vendor, or a change to one.
 *
 * The same route for both, because creating and editing go through
 * identical review — there is deliberately no path that writes a
 * vendor without one.
 */
dutchMillerRouter.post("/vendors", requirePage("vendors"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { id?: unknown; note?: unknown } & Record<string, unknown>;
    const account = accountOf(req, res);
    if (!account) return;
    const out = await proposeVendor({
      id: typeof b.id === "string" && b.id ? b.id : undefined,
      account: account.id,
      raw: b as never,
      by: actor(req),
      note: String(b.note ?? ""),
    });
    if (!out.ok) {
      res.status(400).json("errors" in out ? { errors: out.errors } : { error: out.reason });
      return;
    }
    await audit({
      action: out.created ? "vendor.proposed" : "vendor.changed",
      resource: out.vendor.id, ...who(req),
      detail: `${out.vendor.pending?.fields.companyName ?? ""}`
        + (out.created ? " · new" : ` · ${out.vendor.pending?.changed.join(", ")}`)
        + (out.superseded ? " · replaced an earlier submission" : ""),
    });
    emitChange("vendors");
    res.json({ vendor: out.vendor, created: out.created, superseded: out.superseded });
  });

dutchMillerRouter.post("/vendors/:id/decide", requirePage("vendors"),
  async (req: Request, res: Response) => {
    if (!(await canApproveVendors(req))) {
      denied(req, "vendor approval");
      res.status(403).json({
        error: "Your role cannot approve a vendor. An account administrator can "
          + "grant it under Roles & Permissions.",
      });
      return;
    }
    const b = (req.body ?? {}) as {
      revisionId?: unknown; approve?: unknown; note?: unknown;
    };
    const account = accountOf(req, res);
    if (!account) return;
    const out = await decideVendor({
      id: String(req.params.id ?? ""),
      account: account.id,
      revisionId: String(b.revisionId ?? ""),
      approve: b.approve === true,
      by: actor(req),
      note: String(b.note ?? ""),
    });
    if (!out.ok) { res.status(400).json({ error: out.reason }); return; }
    await audit({
      action: b.approve === true ? "vendor.approved" : "vendor.rejected",
      resource: out.vendor.id, ...who(req),
      detail: `${out.vendor.companyName}${b.note ? ` · ${String(b.note).slice(0, 200)}` : ""}`,
    });
    emitChange("vendors");
    res.json({ vendor: out.vendor });
  });

dutchMillerRouter.post("/vendors/:id/delete", requirePage("vendors"),
  requireSuperTo("remove a vendor"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { note?: unknown };
    const account = accountOf(req, res);
    if (!account) return;
    const out = await deleteVendor({
      id: String(req.params.id ?? ""), account: account.id,
      note: String(b.note ?? ""), by: actor(req),
    });
    if (!out.ok) { res.status(400).json({ error: out.reason }); return; }
    await audit({
      action: "vendor.deleted", resource: String(req.params.id ?? ""), ...who(req),
      detail: String(b.note ?? "").slice(0, 200),
    });
    emitChange("vendors");
    res.json({ ok: true });
  });

/* ------------------------------------------------------------------ *
 * Vehicle years, makes and models
 * ------------------------------------------------------------------ */

/**
 * The lists behind the three vehicle fields.
 *
 * Fetched server-side rather than from the browser, for two reasons:
 * the answers are cached once for everybody instead of once per
 * person, and a dealer's browser never talks to a third party on this
 * app's behalf.
 *
 * Years need no source at all — they are arithmetic — so they come
 * back even when the catalogue cannot be reached.
 */
dutchMillerRouter.get(
  "/vehicles",
  requirePage("member-signups-add"),
  async (_req: Request, res: Response) => {
    const makes = await listMakes();
    res.json({ years: modelYears(), ...makes });
  },
);

dutchMillerRouter.get(
  "/vehicles/models",
  requirePage("member-signups-add"),
  async (req: Request, res: Response) => {
    res.json(await listModels(
      String(req.query.make ?? ""), String(req.query.year ?? "")));
  },
);

/** A blank entry's generated values, minted and signed by the server. */
dutchMillerRouter.post(
  "/signups/new",
  requirePage("member-signups-add"),
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
  requirePage("member-signups-add"),
  async (req: Request, res: Response) => {
    const sup = (await shownFor(req)).isSuper;
    const account = accountOf(req, res);
    if (!account) return;
    const { rows } = await listRfids({ account: account.id, status: "active", limit: 500 });
    // A test tag is offered to the one person who may issue it, and
    // marked, so it cannot be picked by mistake from a list of
    // ordinary numbers.
    const usable = sup ? rows : rows.filter((r) => !r.testOnly);
    res.json({
      options: usable.map((r) => r.number),
      testOnly: usable.filter((r) => r.testOnly).map((r) => r.number),
    });
  },
);

dutchMillerRouter.get(
  "/signups",
  requirePage("member-signups"),
  async (req: Request, res: Response) => {
    const account = accountOf(req, res);
    if (!account) return;
    const status = String(req.query.status ?? "all");
    res.json({
      ...(await listSignups({
        account: account.id,
        status: status === "new" || status === "review" || status === "complete"
          || status === "deleted" ? status : "all",
        search: String(req.query.search ?? ""),
        limit: Number(req.query.limit ?? 100),
        offset: Number(req.query.offset ?? 0),
      })),
      // Whether the person whose app this is may set the MOJO-side
      // mark. The button follows this; the route below decides it
      // again, on whoever is really at the keyboard.
      canComplete: (await shownFor(req)).approves && isStaff(req.user),
      canDelete: (await shownFor(req)).deletesSignups,
    });
  },
);

dutchMillerRouter.get(
  "/signups/:guid",
  requirePage("member-signups"),
  async (req: Request, res: Response) => {
    const account = accountOf(req, res);
    if (!account) return;
    const row = await getSignup(String(req.params.guid ?? ""), account.id);
    if (!row) { res.status(404).json({ error: "No such signup." }); return; }
    res.json({ row, deliveries: await deliveriesFor(row.guid) });
  },
);

/**
 * What was attempted about this member, and how it went.
 *
 * Beside the record rather than only in the log, because the question
 * is always asked here: a grey "email sent" step with no explanation
 * is the thing somebody rings up about. It reports ACCEPTANCE by
 * Microsoft, which is the last fact this application has — delivery
 * and reading are not observable from here, and the page says so.
 */
dutchMillerRouter.get(
  "/signups/:guid/deliveries",
  requirePage("member-signups"),
  async (req: Request, res: Response) => {
    res.json({
      deliveries: await deliveriesFor(String(req.params.guid ?? "")),
      retry: RETRY,
    });
  },
);

/** Confirm & Submit. One member, one tag, one transaction — see `createSignup`. */
dutchMillerRouter.post(
  "/signups",
  requirePage("member-signups-add"),
  async (req: Request, res: Response) => {
    const account = accountOf(req, res);
    if (!account) return;
    const out = await createSignup(
      (req.body ?? {}) as Partial<SignupInput>, req.user?.email ?? "",
      {
        account: account.id,
        // Judged on the REAL person: naming a test tag is the owner's,
        // and a view must never be a way to borrow that.
        mayUseTestTags: isSuperEmail(
          req.viewingAs?.real.email ?? req.user?.email ?? ""),
      });
    if (out.ok) {
      // Not awaited, and not inside the transaction: the member exists and
      // the tag is claimed by now, so a bounced email must not tell the
      // dealer their signup failed. Outcomes land in the audit trail.
      if (!out.alreadyExisted) {
        void notifySignup(out.row, publicOrigin(req),
          { name: account.name, slug: account.slug });
        void audit({
          action: "signup.created", resource: out.row.guid, ...who(req),
          detail: `${out.row.customer.firstName} ${out.row.customer.lastName} · `
            + `RFID ${out.row.customer.rfid}`,
        });
      }
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

/* ------------------------------------------------------------------ *
 * Bulk upload
 * ------------------------------------------------------------------ */

/** The layout and an example, so nobody has to guess at the headers. */
dutchMillerRouter.get(
  "/signups/bulk/template",
  requirePage("member-signups-add"),
  (_req: Request, res: Response) => {
    res.json({ columns: BULK_COLUMNS, csv: templateCsv() });
  },
);

/**
 * Read a file and check it. Writes nothing, claims no tag.
 *
 * All or nothing: one bad row and the whole file is refused, named row
 * by row and column by column. A partial import would spend tags on
 * the half that worked and leave no way to tell which half that was.
 */
dutchMillerRouter.post(
  "/signups/bulk/check",
  requirePage("member-signups-add"),
  express.raw({ type: ["text/csv", "text/plain", "application/octet-stream"], limit: "8mb" }),
  async (req: Request, res: Response) => {
    const file = req.body as Buffer;
    if (!Buffer.isBuffer(file) || file.length === 0) {
      res.status(400).json({ error: "No file arrived." });
      return;
    }
    const account = accountOf(req, res);
    if (!account) return;
    const parsed = parseBulk(file.toString("utf8"));
    const pool = await rfidCounts(account.id);
    await audit({
      action: "bulk.uploaded",
      actor: actor(req),
      detail: `${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"} · `
        + `${parsed.ok ? "valid" : "refused"}`,
    });
    res.json({
      ...parsed,
      // Checked here as well as shown, because a file can be valid and
      // still be unimportable: there has to be a tag for every row.
      available: pool.active,
      enoughTags: pool.active >= parsed.rows.length,
    });
  },
);

/**
 * Commit one row.
 *
 * One row per request, because that is one member, one tag and one
 * transaction — the same path a typed signup takes, with the tag
 * chosen by the pool instead of by a person. It also means the review
 * mode and the straight-through mode are the same code, differing only
 * in whether the page waits for somebody between rows.
 */
dutchMillerRouter.post(
  "/signups/bulk/commit",
  requirePage("member-signups-add"),
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { row?: Record<string, unknown>; batch?: unknown };
    const account = accountOf(req, res);
    if (!account) return;
    const out = await createSignup(
      {
        ...(body.row ?? {}),
        ...newHandle(),
        rfid: "",
        // Satisfies the shared validator and claims nothing: the tag is
        // allocated below, so `createSignup` writes the record PENDING
        // and somebody confirms the sticker against the manifest.
        stickerAttached: true,
      } as Partial<SignupInput>,
      actor(req),
      { account: account.id, assignAnyRfid: true },
    );
    if (!out.ok) {
      res.status(out.kind === "validation" ? 400 : 409).json(
        out.kind === "validation" ? { errors: out.errors } : { error: out.reason });
      return;
    }
    if (!out.alreadyExisted) void notifySignup(out.row, publicOrigin(req),
          { name: account.name, slug: account.slug });
    emitChange("signups");
    res.json({ row: out.row });
  },
);

/**
 * The assignment manifest: which tag belongs on which vehicle.
 *
 * The piece that makes an import honest. The server chose the numbers,
 * one at a time, after the file was written — so without this, the
 * person holding a sheet of stickers has no way to match them to cars,
 * and the only way to "confirm" anything would be to tick a box and
 * hope. One row per member, with the exact number.
 */
dutchMillerRouter.post(
  "/signups/bulk/manifest",
  requirePage("member-signups-add"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { guids?: unknown };
    const guids = Array.isArray(b.guids) ? b.guids.map(String).slice(0, 2000) : [];
    const account = accountOf(req, res);
    if (!account) return;
    const rows: SignupRow[] = [];
    for (const g of guids) {
      const row = await getSignup(g, account.id);
      if (row) rows.push(row);
    }
    void audit({
      action: "export.members", ...who(req),
      detail: `${rows.length} row(s) · assignment manifest`,
    });
    res.json({
      columns: [
        "First Name", "Last Name", "Plate", "State", "Vehicle Year", "Vehicle Make",
        "Vehicle Model", "Vehicle Color", "RFID", "Sticker Confirmed", "Reference",
      ],
      rows: rows.map((r) => [
        r.customer.firstName, r.customer.lastName,
        r.customer.plateDlw ?? "", r.customer.plateState ?? "",
        r.customer.vehicleYear ?? "", r.customer.vehicleMake ?? "",
        r.customer.vehicleModel ?? "", r.customer.vehicleColor ?? "",
        r.customer.rfid,
        r.customer.stickerState === "confirmed" ? "Yes" : "Not yet",
        r.guid,
      ]),
    });
  },
);

/** The run is over: what went in, how, and who did it. */
dutchMillerRouter.post(
  "/signups/bulk/done",
  requirePage("member-signups-add"),
  async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { added?: unknown; failed?: unknown; reviewed?: unknown };
    const added = Number(b.added) || 0;
    const failed = Number(b.failed) || 0;
    await audit({
      action: "bulk.committed",
      actor: actor(req),
      detail: `${added} added, ${failed} failed · `
        + (b.reviewed === true ? "reviewed one by one" : "submitted without review"),
    });
    res.json({ ok: true });
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
    // Opening is recorded for whoever would act on it, which is the
    // same person who could approve it.
    const reader = req.viewingAs?.real.email ?? req.user?.email ?? "";
    if (!(await canApprove(req))) { res.json({ row: null }); return; }
    const account = accountOf(req, res);
    if (!account) return;
    const row = await markOpened(String(req.params.guid ?? ""), reader, account.id);
    if (row) {
      void audit({ action: "signup.opened", resource: row.guid, ...who(req) });
      emitChange("signups");
    }
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
    const approver = real?.email ?? "";
    if (!(await canApprove(req))) {
      res.status(403).json({
        error: "Only the CSC role can approve a membership. "
          + "Ask an account administrator to assign it.",
      });
      return;
    }
    const account = accountOf(req, res);
    if (!account) return;
    const out = await setComplete(String(req.params.guid ?? ""), approver, account.id);
    if (!out.ok) {
      res.status(out.reason === "not-found" ? 404 : 409).json({
        error: out.reason === "not-found"
          ? "No such signup."
          : out.reason === "already"
            ? "That signup is already complete, and completing is final."
            : out.reason === "deleted"
              ? "That member record has been deleted."
              : out.reason === "sticker-unconfirmed"
                ? "Nobody has confirmed the sticker is on this vehicle yet. "
                  + "Approving says the member can drive up and wash, which only "
                  + "works once the tag is on the glass."
                : "Open the signup and read it before marking it complete.",
      });
      return;
    }
    // The one message the dealer actually wants: their member can
    // wash. Not awaited — the approval is already recorded, and a
    // bounced email must not make it look otherwise.
    void notifyApproved(out.row, publicOrigin(req));
    void audit({
      action: "signup.completed", resource: out.row.guid, ...who(req),
      detail: `${out.row.customer.firstName} ${out.row.customer.lastName}`,
    });
    emitChange("signups");
    res.json({ row: out.row });
  },
);

/**
 * Where the sticker goes: inside the glass, or outside it.
 *
 * Readable by anybody who can open the instructions, because the page
 * IS this setting. Writable by an administrator only — it rewrites
 * what everybody is told to do at the vehicle, and getting it wrong
 * means tags applied with the wrong adhesive on the wrong face.
 */
dutchMillerRouter.get(
  "/settings/placement",
  requirePage("rfid-instructions"),
  async (req: Request, res: Response) => {
    const account = accountOf(req, res);
    if (!account) return;
    res.json(await getPlacement(account.id));
  },
);

dutchMillerRouter.post("/settings/placement", requireDmAdmin,
  async (req: Request, res: Response) => {
    const want = (req.body as { placement?: unknown } | undefined)?.placement;
    if (!isPlacement(want)) {
      res.status(400).json({ error: "Choose inside or outside." });
      return;
    }
    const account = accountOf(req, res);
    if (!account) return;
    const out = await setPlacement(want, actor(req), account.id);
    await audit({
      action: "notify.changed", ...who(req),
      detail: `RFID placement set to ${out.placement} the glass`,
    });
    // The instructions page, the signup form's confirmation and the
    // member records' wording all read this. Push it rather than wait
    // for somebody to reload the one they happen to be looking at.
    emitChange("signups");
    res.json(out);
  });

/**
 * Somebody has checked that the sticker is on this vehicle.
 *
 * Open to anybody who can use Member Signups, which is deliberate: it
 * is usually the dealer who applied it, working from the import's
 * manifest, and making MOJO confirm a thing only the dealership can
 * see would be theatre. Who confirmed it is recorded either way.
 */
dutchMillerRouter.post(
  "/signups/:guid/sticker",
  requirePage("member-signups"),
  async (req: Request, res: Response) => {
    const account = accountOf(req, res);
    if (!account) return;
    const out = await confirmSticker(
      String(req.params.guid ?? ""), actor(req), account.id);
    if (!out.ok) {
      res.status(out.reason === "not-found" ? 404 : 409).json({
        error: out.reason === "not-found" ? "No such signup."
          : out.reason === "deleted" ? "That member record has been deleted."
            : "That sticker is already confirmed.",
      });
      return;
    }
    void audit({
      action: "sticker.confirmed", resource: out.row.guid, ...who(req),
      detail: `RFID ${out.row.customer.rfid} on `
        + `${out.row.customer.firstName} ${out.row.customer.lastName}'s vehicle`,
    });
    emitChange("signups");
    res.json({ row: out.row });
  },
);

/**
 * Delete a member record. Account Administrator only, and never really.
 *
 * "Delete" here means marked deleted and kept: the row stays in the list,
 * struck through, carrying the note whoever removed it had to write. A
 * membership that simply vanished is one nobody can answer questions
 * about afterwards — not the dealer who submitted it, not the person
 * holding the tag, and not whoever is asked six months later why that
 * vehicle is on the plan.
 *
 * The note is required by `deleteSignup`, not by the form, so a direct
 * request cannot skip it.
 *
 * The tag goes back to the pool only if asked. Both answers are right
 * sometimes — a duplicate entry should give its number back, a member
 * who left with the sticker on the windscreen should not — and guessing
 * either way silently is how a tag ends up on two vehicles.
 */
dutchMillerRouter.post(
  "/signups/:guid/delete",
  requirePage("member-signups"),
  requireDelete("signups"),
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { note?: unknown; releaseTag?: unknown };
    const account = accountOf(req, res);
    if (!account) return;
    const out = await deleteSignup({
      guid: String(req.params.guid ?? ""),
      account: account.id,
      note: String(body.note ?? ""),
      by: actor(req),
      releaseTag: body.releaseTag === true,
    });
    if (!out.ok) {
      res.status(out.reason === "not-found" ? 404 : 400).json({
        error: out.reason === "not-found"
          ? "No such signup."
          : out.reason === "already"
            ? "That record is already deleted."
            : "Say why this record is being deleted — a few words at least.",
      });
      return;
    }
    await audit({
      action: "signup.deleted",
      subject: out.row.submittedBy,
      resource: out.row.guid,
      detail: `${out.row.customer.firstName} ${out.row.customer.lastName} · `
        + `RFID ${out.row.customer.rfid}${out.tagReleased ? " (released)" : ""} · `
        + `${out.row.deleteNote ?? ""}`,
      ...who(req),
    });
    emitChange("signups");
    emitChange("rfid");
    res.json({ row: out.row, tagReleased: out.tagReleased });
  },
);
