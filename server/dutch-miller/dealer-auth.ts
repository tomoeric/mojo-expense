import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { env } from "../env.js";
import { publicOrigin } from "../origin.js";
import { SESSION_TTL_MS, setSessionCookie, type SessionUser } from "../auth/session.js";
import { button, isMailConfigured, layout, sendMail } from "../mail.js";
import { LOCKOUT, audit, lockState, minutesLeft, requestMeta } from "./audit.js";
import {
  CODE_TTL_MINUTES, LOGIN_TTL_MINUTES, issueCode, issueToken, peekToken, redeemToken,
  verifyCode,
} from "./invites.js";
import { activateDmUser, getDmUser, isSuperEmail, markInvited } from "./users.js";
import { DEVICE_COOKIE, TRUST_DAYS, deviceLabel, isTrusted, trustDevice } from "./devices.js";

/**
 * The second door: dealer staff, signing in with an emailed one-time link.
 *
 * Mounted OUTSIDE the app guards, because nobody using it is signed in
 * yet. That makes it the most exposed surface in the product, so the rules
 * here are deliberately blunt:
 *
 *   THERE IS NO SELF-SIGNUP. An address only exists here because an
 *   administrator invited it. `/request` will happily take any address and
 *   will send nothing to one it does not know.
 *
 *   EVERY ANSWER IS THE SAME. Known, unknown, invited, disabled — the reply
 *   is always "if that address has access, check your email". Anything
 *   else turns this endpoint into a way to find out who has an account.
 *
 *   FAILURES ARE COUNTED AND THEN REFUSED. See `audit.ts`: the lockout is
 *   derived from the trail, per address, over a rolling window.
 */

export const dealerAuthRouter: IRouter = Router();

/**
 * The browser that asked for a login link.
 *
 * Kept only so a link opened where it was requested can skip the code on
 * the SAME visit. Durable trust is a separate thing — see `devices.ts`:
 * the first sign-in from a browser asks for a code, and that browser is
 * then trusted for two weeks.
 */
const NONCE_COOKIE = "dm_link";
/** A half-finished sign-in: redeemed the link, still owes a code. */
const PENDING_COOKIE = "dm_pending";
const PENDING_TTL_MS = 20 * 60 * 1000;

/**
 * Where a request came from, for the security log.
 *
 * Everything here goes through one helper so a route added later
 * cannot quietly record less than the others.
 */
const from = (req: Request) => requestMeta(req as never);

const origin = (req: Request): string => publicOrigin(req);

const secure = () => process.env.NODE_ENV === "production";

/* ------------------------------------------------------------------ *
 * The half-finished sign-in
 * ------------------------------------------------------------------ */

type Pending = {
  email: string;
  kind: "invite" | "login";
  /**
   * The link itself, still unspent, until the person confirms.
   *
   * Safe to park here: the cookie is httpOnly and signed, so it never
   * reaches page scripts and cannot be forged. It is dropped the moment
   * the token is spent.
   */
  token?: string;
  exp: number;
};

const sign = (payload: string): string =>
  createHmac("sha256", env.sessionSecret || "mojo-expense").update(payload).digest("base64url");

function setPending(res: Response, p: Pending): void {
  const payload = Buffer.from(JSON.stringify(p)).toString("base64url");
  res.cookie(PENDING_COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: PENDING_TTL_MS,
  });
}

function readPending(req: Request): Pending | null {
  const raw = (req.cookies as Record<string, unknown> | undefined)?.[PENDING_COOKIE];
  if (typeof raw !== "string" || !raw.includes(".")) return null;
  const i = raw.lastIndexOf(".");
  const payload = raw.slice(0, i);
  const mac = Buffer.from(raw.slice(i + 1));
  const want = Buffer.from(sign(payload));
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as Pending;
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

const clearPending = (res: Response) => res.clearCookie(PENDING_COOKIE, { path: "/" });

/* ------------------------------------------------------------------ *
 * Minting a session
 * ------------------------------------------------------------------ */

/**
 * Sign somebody in through the link door.
 *
 * `via: "link"` is the load-bearing part. Everything that asks "is this
 * MOJO staff" reads it, so an invited account can never be mistaken for
 * one of ours however its address is spelled. The epoch is copied from the
 * row, so revoking later invalidates this cookie without waiting for it to
 * expire.
 */
/** Remember this browser for two weeks, so the next sign-in needs no code. */
async function rememberDevice(req: Request, res: Response, email: string): Promise<void> {
  const { secret, maxAgeMs } = await trustDevice(email, deviceLabel(req.headers["user-agent"]));
  res.cookie(DEVICE_COOKIE, secret, {
    httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: maxAgeMs,
  });
}

const deviceSecret = (req: Request): string | undefined =>
  (req.cookies as Record<string, string | undefined> | undefined)?.[DEVICE_COOKIE];

async function signIn(res: Response, email: string): Promise<SessionUser | null> {
  const row = await getDmUser(email);
  if (!row || row.status !== "active") return null;
  const name = [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email;
  const user: SessionUser = {
    id: row.email,
    email: row.email,
    name,
    exp: Date.now() + SESSION_TTL_MS,
    via: "link",
    epoch: row.sessionEpoch,
  };
  setSessionCookie(res, user);
  clearPending(res);
  return user;
}

/* ------------------------------------------------------------------ *
 * Mail
 * ------------------------------------------------------------------ */

async function sendInvite(req: Request, email: string, token: string): Promise<void> {
  const url = `${origin(req)}/api/dm-auth/redeem?token=${encodeURIComponent(token)}`;
  await sendMail(email, "Your Dutch Miller access", layout(
    "You have been given access",
    `<p style="margin:0 0 18px;font-size:15px;line-height:1.55">
       A MOJO administrator has set up an account for this address on the Dutch Miller
       portal. Use the button below to finish setting it up — it takes a minute, and
       you will be asked to confirm a short code we send you at that point.</p>
     ${button(url, "Set up my account")}
     <p style="margin:0;font-size:13px;color:#71717a">This link works once, and expires in 3 days. Ask your MOJO contact for another if it runs out.</p>`,
    "If you were not expecting this, ignore it — nothing happens until the link is used.",
  ));
}

async function sendLoginLink(
  req: Request, email: string, token: string, code: string,
): Promise<void> {
  const url = `${origin(req)}/api/dm-auth/redeem?token=${encodeURIComponent(token)}`;
  await sendMail(email, "Your Dutch Miller sign-in link", layout(
    "Sign in to Dutch Miller",
    `${button(url, "Sign in")}
     <p style="margin:0 0 6px;font-size:15px">If you open the link on a different device
       from the one you asked on, it will ask for this code:</p>
     <p style="margin:0 0 18px;font-size:30px;font-weight:700;letter-spacing:.18em">${code}</p>
     <p style="margin:0;font-size:13px;color:#71717a">
       The link works once and expires in ${LOGIN_TTL_MINUTES} minutes.</p>`,
    "If you did not ask to sign in, ignore this — nobody can use the link without this email.",
  ));
}

async function sendCode(email: string, code: string): Promise<void> {
  await sendMail(email, "Your Dutch Miller confirmation code", layout(
    "Confirm your email address",
    `<p style="margin:0 0 10px;font-size:15px">Enter this code to finish setting up your account:</p>
     <p style="margin:0 0 18px;font-size:30px;font-weight:700;letter-spacing:.18em">${code}</p>
     <p style="margin:0;font-size:13px;color:#71717a">
       It expires in ${CODE_TTL_MINUTES} minutes.</p>`,
    "If you were not setting up an account, ignore this.",
  ));
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/** Whether the dealer door is open at all — the sign-in page asks. */
dealerAuthRouter.get("/config", (_req: Request, res: Response) => {
  res.json({ enabled: isMailConfigured() });
});

/**
 * Ask for a sign-in link.
 *
 * Always answers the same thing. The work behind it differs — an unknown
 * or disabled address gets no email — but the caller cannot tell, which is
 * the point.
 */
dealerAuthRouter.post("/request", async (req: Request, res: Response) => {
  const email = String((req.body as { email?: unknown })?.email ?? "").trim().toLowerCase();
  const same = { sent: true } as const;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Enter an email address." });
    return;
  }

  const lock = await lockState(email);
  if (lock.locked) {
    await audit({ action: "locked.out", subject: email, ...from(req), detail: "link request" });
    res.status(429).json({
      error: `Too many attempts. Try again in ${minutesLeft(lock.until)} minutes.`,
    });
    return;
  }
  await audit({ action: "login.requested", subject: email, ...from(req) });

  const row = await getDmUser(email);
  // A super admin and any staff account belong at the Microsoft door; so
  // does an address that was never invited. All three get the same
  // silence — but an address nobody has ever invited is recorded
  // separately, because somebody working through a list of guesses
  // looks exactly like this and nothing else does.
  if (!row || row.authMethod !== "link" || isSuperEmail(email)) {
    if (!row) await audit({ action: "login.unknown", subject: email, ...from(req) });
    res.json(same);
    return;
  }
  if (row.status === "disabled") {
    await audit({ action: "login.rejected", subject: email, ...from(req), detail: "disabled" });
    res.json(same);
    return;
  }

  try {
    if (row.status === "invited") {
      const t = await issueToken({ email, kind: "invite", ...from(req), bindBrowser: false });
      await sendInvite(req, email, t.token);
      await audit({ action: "invite.resent", subject: email, ...from(req) });
    } else {
      const t = await issueToken({ email, kind: "login", ...from(req) });
      const code = await issueCode(email);
      await sendLoginLink(req, email, t.token, code);
      if (t.browserNonce) {
        res.cookie(NONCE_COOKIE, t.browserNonce, {
          httpOnly: true, secure: secure(), sameSite: "lax", path: "/",
          maxAge: LOGIN_TTL_MINUTES * 60_000,
        });
      }
      await audit({ action: "login.sent", subject: email, ...from(req) });
      await audit({ action: "code.sent", subject: email, ...from(req) });
    }
  } catch (err) {
    // A mail failure is ours, not theirs, and saying "sent" when nothing
    // was sent leaves somebody waiting on an email that is not coming.
    console.error("dealer login mail failed:", err);
    res.status(500).json({ error: "We could not send the email. Tell your MOJO contact." });
    return;
  }
  res.json(same);
});

/**
 * Open a link — WITHOUT spending it.
 *
 * Mail providers scan incoming messages by fetching the URLs inside
 * them. A GET that redeemed the token therefore burned the invite on
 * delivery and emailed a confirmation code to somebody who had not done
 * anything yet; both were reported from the real world within a day of
 * shipping. Nothing here changes a row or sends an email.
 *
 * The link is parked in the signed, httpOnly pending cookie and spent by
 * `POST /continue` below, which a scanner does not issue.
 */
dealerAuthRouter.get("/redeem", async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  const out = await peekToken(token);

  if (!out.ok) {
    await audit({ action: "login.rejected", ...from(req), detail: `link ${out.reason}` });
    res.redirect(`/#/signin?link=${out.reason}`);
    return;
  }
  setPending(res, {
    email: out.email, kind: out.kind, token, exp: Date.now() + PENDING_TTL_MS,
  });
  res.redirect(out.kind === "invite" ? "/#/welcome" : "/#/continue");
});

/**
 * Spend it, now that a person has asked.
 *
 * The claim is still a single conditional UPDATE, so two clicks or a
 * double submission cannot both succeed — all that moved is WHEN it
 * happens, from the fetch to the press.
 */
dealerAuthRouter.post("/continue", async (req: Request, res: Response) => {
  const p = readPending(req);
  if (!p?.token) {
    res.status(400).json({ error: "That link has expired. Ask for a new one.", reason: "expired" });
    return;
  }
  const nonce = (req.cookies as Record<string, string | undefined> | undefined)?.[NONCE_COOKIE];
  const out = await redeemToken(p.token, nonce);
  if (!out.ok) {
    clearPending(res);
    await audit({ action: "login.rejected", subject: p.email, ...from(req), detail: `link ${out.reason}` });
    res.status(400).json({ error: linkMessage(out.reason), reason: out.reason });
    return;
  }

  res.clearCookie(NONCE_COOKIE, { path: "/" });
  // Spent. Keep the pending cookie for the step that follows, without the
  // token in it.
  setPending(res, { email: out.email, kind: out.kind, exp: Date.now() + PENDING_TTL_MS });

  if (out.kind === "invite") {
    await audit({ action: "invite.redeemed", subject: out.email, ...from(req) });
    res.json({ kind: "invite", email: out.email });
    return;
  }

  // A code is asked for on the FIRST sign-in from a browser, and not
  // again for two weeks. `sameBrowser` lets somebody who asked and
  // clicked in one sitting through on their very first go; after that it
  // is the trusted-device row that decides.
  const trusted = await isTrusted(out.email, deviceSecret(req));
  if (trusted || out.sameBrowser) {
    const user = await signIn(res, out.email);
    await audit({
      action: user ? "login.redeemed" : "login.rejected",
      subject: out.email, ...from(req),
      detail: user ? (trusted ? "trusted device" : "same browser") : "not active",
    });
    if (!user) { res.status(403).json({ error: "That account is not active." }); return; }
    // Same-browser but not yet trusted: start the two weeks now, so the
    // next sign-in from here is the one that skips the code.
    if (!trusted) await rememberDevice(req, res, out.email);
    res.json({ kind: "login", signedIn: true });
    return;
  }

  await audit({
    action: "login.redeemed", subject: out.email, ...from(req),
    detail: "new device — code required",
  });
  res.json({ kind: "login", signedIn: false, needsCode: true, trustDays: TRUST_DAYS });
});

function linkMessage(reason: string): string {
  if (reason === "used") return "That link has already been used. Ask for a new one.";
  if (reason === "expired") return "That link has expired. Ask for a new one.";
  return "That link is not valid. Ask for a new one.";
}

/** What the half-finished sign-in is waiting for. Drives the two screens. */
dealerAuthRouter.get("/pending", (req: Request, res: Response) => {
  const p = readPending(req);
  res.json(p ? { email: p.email, kind: p.kind } : { email: null, kind: null });
});

/** Finish a cross-device sign-in with the code from the email. */
dealerAuthRouter.post("/verify", async (req: Request, res: Response) => {
  const p = readPending(req);
  if (!p || p.kind !== "login") {
    res.status(400).json({ error: "That sign-in has expired. Ask for a new link." });
    return;
  }
  const lock = await lockState(p.email);
  if (lock.locked) {
    res.status(429).json({ error: `Too many attempts. Try again in ${minutesLeft(lock.until)} minutes.` });
    return;
  }
  const check = await verifyCode(p.email, String((req.body as { code?: unknown })?.code ?? ""));
  if (!check.ok) {
    await audit({ action: "code.failed", subject: p.email, ...from(req), detail: check.reason });
    res.status(400).json({ error: codeMessage(check.reason, check.attemptsLeft) });
    return;
  }
  const user = await signIn(res, p.email);
  if (!user) {
    res.status(403).json({ error: "That account is not active." });
    return;
  }
  await rememberDevice(req, res, p.email);
  await audit({
    action: "code.verified", subject: p.email, ...from(req),
    detail: `device trusted for ${TRUST_DAYS} days`,
  });
  res.json({ ok: true, trustDays: TRUST_DAYS });
});

/** The details somebody enters about themselves, checked the same way twice. */
function detailErrors(body: Record<string, unknown>): Record<string, string> {
  const t = (k: string) => String(body[k] ?? "").trim();
  const errors: Record<string, string> = {};
  if (t("firstName") === "") errors.firstName = "First name is required.";
  if (t("lastName") === "") errors.lastName = "Last name is required.";
  if (t("business") === "") errors.business = "Business affiliation is required.";
  // Ten digits somewhere in there — formatting is the person's business.
  if ((t("phone").match(/\d/g) ?? []).length < 10) {
    errors.phone = "Enter a contact number with at least 10 digits.";
  }
  return errors;
}

/**
 * Finish setting up an invited account.
 *
 * NO CONFIRMATION CODE. Opening a one-time link that was emailed to this
 * address already proves whoever is here can read that inbox, and a code
 * sent to the same inbox proves exactly the same thing a second time. It
 * was in an earlier version of this flow and it was theatre — two
 * secrets, one mailbox, one real check.
 *
 * What covers the gap a code would have covered is the link itself being
 * single use and short lived: see `INVITE_TTL_MINUTES`. A code still
 * earns its place on SIGN-IN, where it answers a different question —
 * whether the link was opened on the machine that asked for it.
 *
 * Role and page access are not in the payload and are not read from it.
 * An onboarding form that could grant its own permissions would make the
 * invite email the entire security boundary.
 */
dealerAuthRouter.post("/onboard", async (req: Request, res: Response) => {
  const p = readPending(req);
  if (!p || p.kind !== "invite") {
    res.status(400).json({ error: "That invite has expired. Ask your MOJO contact for a new one." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const t = (k: string) => String(body[k] ?? "").trim();

  const errors = detailErrors(body);
  if (Object.keys(errors).length > 0) { res.status(400).json({ errors }); return; }

  const row = await activateDmUser({
    email: p.email,
    firstName: t("firstName"),
    lastName: t("lastName"),
    business: t("business"),
    phone: t("phone"),
  });
  if (!row) {
    res.status(409).json({ error: "This account has already been set up. Ask for a sign-in link." });
    return;
  }
  await audit({ action: "account.activated", subject: p.email, ...from(req), detail: t("business") });
  await signIn(res, p.email);
  res.json({ ok: true });
});

/** Ask for a fresh code on the sign-in step that needs one. */
dealerAuthRouter.post("/resend-code", async (req: Request, res: Response) => {
  const p = readPending(req);
  if (!p || p.kind !== "login") {
    res.status(400).json({ error: "That has expired. Start again." });
    return;
  }
  const lock = await lockState(p.email);
  if (lock.locked) {
    res.status(429).json({ error: `Too many attempts. Try again in ${minutesLeft(lock.until)} minutes.` });
    return;
  }
  try {
    await sendCode(p.email, await issueCode(p.email));
    await audit({ action: "code.sent", subject: p.email, ...from(req), detail: "resend" });
  } catch {
    res.status(500).json({ error: "We could not send the email. Tell your MOJO contact." });
    return;
  }
  res.json({ ok: true });
});

function codeMessage(reason: string, left: number): string {
  if (reason === "expired") return "That code has expired. Ask for a new one.";
  if (reason === "none") return "There is no code waiting. Ask for a new one.";
  if (reason === "too-many") return "Too many wrong codes. Ask for a new one.";
  return left > 0
    ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`
    : "That code is not right. Ask for a new one.";
}

/** Everything an admin needs to send an invite, used by the Users page. */
export async function inviteUser(req: Request, email: string, by: string): Promise<void> {
  const t = await issueToken({ email, kind: "invite", by, ...from(req), bindBrowser: false });
  await sendInvite(req, email, t.token);
  await markInvited(email, by);
  await audit({ action: "invite.sent", subject: email, actor: by, ...from(req) });
}

export { LOCKOUT };
