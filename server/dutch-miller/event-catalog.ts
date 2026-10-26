/**
 * What each recorded action MEANS.
 *
 * One table, read at display time rather than written into every row.
 * That is deliberate and is the only reason the whole existing trail —
 * every line written before any of this existed — arrives classified:
 * the action name was always there, so category, outcome and severity
 * can be derived from it with no migration, no backfill, and no risk of
 * rewriting evidence to fit a newer schema.
 *
 * Three honest distinctions, which the rest of the security workspace
 * is built on:
 *
 *   OUTCOME is what happened — attempted, blocked, succeeded, unknown.
 *   It is a fact about the request.
 *
 *   SEVERITY is how much it matters on its own. Nearly everything here
 *   is informational or low: one expired link is not an attack, and a
 *   catalogue that says otherwise trains people to ignore it.
 *
 *   A CONCERN is a pattern across several events, decided in
 *   `detect.ts`, never a single row. Nothing in this file is allowed to
 *   call anything a confirmed incident — only an investigator can, and
 *   that lives in `investigations.ts`.
 */

export const EVENT_CATEGORIES = ["security", "access", "business"] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const OUTCOMES = ["attempted", "blocked", "succeeded", "unknown"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0, low: 1, medium: 2, high: 3, critical: 4,
};

export type EventMeta = {
  category: EventCategory;
  outcome: Outcome;
  severity: Severity;
  /** One line, in words somebody who does not know the codebase can read. */
  label: string;
  /**
   * Also belongs on the security feed, although its category is not
   * security. Role changes are access events; they are also the thing
   * an investigator wants beside a run of refusals.
   */
  alsoSecurity?: boolean;
};

const M = (
  category: EventCategory, outcome: Outcome, severity: Severity,
  label: string, alsoSecurity = false,
): EventMeta => ({ category, outcome, severity, label, alsoSecurity });

export const EVENT_META = {
  /* ---- Getting in, and being refused ---- */
  "signin.ok": M("access", "succeeded", "info", "Signed in with Microsoft"),
  "signin.denied": M("security", "blocked", "medium",
    "Signed in to the tenant, but not on this app's list"),
  "login.requested": M("access", "attempted", "info", "Asked for a sign-in link"),
  "login.sent": M("access", "succeeded", "info", "Sign-in link sent"),
  "login.redeemed": M("access", "succeeded", "info", "Sign-in link used"),
  "login.ok": M("access", "succeeded", "info", "Signed in with an emailed link"),
  "login.rejected": M("security", "blocked", "low",
    "A sign-in link was refused — expired, already used, or for a closed account"),
  "login.unknown": M("security", "blocked", "medium",
    "A link was asked for by an address that was never invited"),
  "code.sent": M("access", "succeeded", "info", "Confirmation code sent"),
  "code.verified": M("access", "succeeded", "info", "Confirmation code accepted"),
  "code.failed": M("security", "blocked", "low", "Wrong confirmation code"),
  "locked.out": M("security", "blocked", "medium",
    "Too many failures in the window — the address is refused for a while"),
  "session.rejected": M("security", "blocked", "medium",
    "A session cookie was presented that no longer matches its account"),
  "session.ended": M("access", "succeeded", "info", "Signed out"),
  "access.denied": M("security", "blocked", "low",
    "A page or API route was refused to a signed-in account"),

  /* ---- Devices ---- */
  "device.trusted": M("access", "succeeded", "info", "A device was remembered"),
  "device.forgotten": M("access", "succeeded", "low", "Remembered devices were cleared", true),

  /* ---- Who may do what ---- */
  "invite.sent": M("access", "succeeded", "low", "Invitation sent", true),
  "invite.resent": M("access", "succeeded", "info", "Invitation sent again"),
  "invite.redeemed": M("access", "succeeded", "info", "Invitation accepted"),
  "invite.expired": M("access", "blocked", "info", "An invitation had already expired"),
  "account.activated": M("access", "succeeded", "info", "Account set up"),
  "account.created": M("access", "succeeded", "low", "Account created", true),
  "account.updated": M("access", "succeeded", "low", "Account changed", true),
  "account.disabled": M("access", "succeeded", "medium", "Access disabled", true),
  "account.enabled": M("access", "succeeded", "medium", "Access restored", true),
  "account.removed": M("access", "succeeded", "medium", "Account removed", true),
  "sessions.revoked": M("access", "succeeded", "medium", "Sessions revoked", true),
  "role.saved": M("access", "succeeded", "medium", "A role's permissions changed", true),
  "role.removed": M("access", "succeeded", "medium", "A role was deleted", true),

  /* ---- Partner accounts ----
   *
   * Deliberately NOT the account.* family above, which has always
   * meant a person's account. A platform with partners in it and a
   * log that calls both of them "account" is a log nobody can search.
   */
  "partner.created": M("access", "succeeded", "medium", "A partner account was created", true),
  "partner.updated": M("access", "succeeded", "low", "A partner account was changed", true),
  "partner.deactivated": M("access", "succeeded", "high",
    "A partner account was deactivated", true),
  "partner.reactivated": M("access", "succeeded", "medium",
    "A partner account was brought back", true),
  "partner.scope": M("access", "succeeded", "medium",
    "Which partner accounts somebody can open was changed", true),

  /* ---- Looking through somebody else's eyes ---- */
  "viewas.started": M("access", "succeeded", "medium",
    "An administrator started viewing the app as somebody else", true),
  "viewas.ended": M("access", "succeeded", "info", "Viewing as somebody else ended", true),

  /* ---- Taking data out ---- */
  "export.members": M("business", "succeeded", "low", "Member records exported", true),
  "export.rfid": M("business", "succeeded", "low", "RFID numbers exported", true),
  "export.security": M("security", "succeeded", "medium", "Security events exported"),

  /* ---- The actual work ---- */
  "signup.created": M("business", "succeeded", "info", "A member was submitted"),
  "signup.opened": M("business", "succeeded", "info", "A member record was opened by MOJO"),
  "signup.completed": M("business", "succeeded", "info", "A membership was approved"),
  "signup.deleted": M("business", "succeeded", "medium", "A member record was deleted", true),
  "sticker.confirmed": M("business", "succeeded", "info",
    "The sticker was confirmed on the windshield"),
  "bulk.uploaded": M("business", "attempted", "info", "A member file was checked"),
  "bulk.committed": M("business", "succeeded", "low", "A member file was imported"),
  "rfid.uploaded": M("business", "succeeded", "info", "RFID numbers were added"),
  "rfid.held": M("business", "succeeded", "info", "RFID numbers were held back or released"),
  "rfid.deleted": M("business", "succeeded", "medium", "RFID numbers were removed", true),

  /* ---- Vendors, which are approved rather than merely entered ---- */
  "vendor.proposed": M("business", "attempted", "info", "A vendor was submitted for review"),
  "vendor.changed": M("business", "attempted", "low",
    "A change to an approved vendor was submitted for review"),
  "vendor.approved": M("business", "succeeded", "medium", "A vendor was approved", true),
  "vendor.rejected": M("business", "blocked", "low", "A vendor submission was sent back"),
  "vendor.deleted": M("business", "succeeded", "medium", "A vendor was removed", true),

  /* ---- Telling people ---- */
  "notify.sent": M("business", "succeeded", "info", "A notification was accepted for delivery"),
  "notify.failed": M("business", "blocked", "low", "A notification could not be sent"),
  "notify.changed": M("access", "succeeded", "low", "Notification recipients changed", true),
  "approved.sent": M("business", "succeeded", "info", "An approval email was accepted"),
  "approved.failed": M("business", "blocked", "low", "An approval email could not be sent"),
  "reminder.sent": M("business", "succeeded", "info", "A reminder was accepted for delivery"),
  "reminder.failed": M("business", "blocked", "low", "A reminder could not be sent"),
  "reminder.changed": M("access", "succeeded", "info", "The reminder schedule changed"),

  /* ---- The investigation record itself ---- */
  "investigation.opened": M("security", "succeeded", "info", "An investigation was opened"),
  "investigation.updated": M("security", "succeeded", "info", "An investigation was updated"),
} as const satisfies Record<string, EventMeta>;

export type AuditAction = keyof typeof EVENT_META;
export const AUDIT_ACTIONS = Object.keys(EVENT_META) as AuditAction[];

/**
 * An action with no entry.
 *
 * Reachable only for a row written by a version that knew an action this
 * one does not — a rollback, mostly. Unknown rather than invented: the
 * row is real and still worth showing, and guessing a severity for it
 * would be the one thing this file exists to avoid.
 */
const UNKNOWN: EventMeta = {
  category: "security", outcome: "unknown", severity: "info",
  label: "An action this version does not recognise",
};

export const metaFor = (action: string): EventMeta =>
  (EVENT_META as Record<string, EventMeta>)[action] ?? UNKNOWN;

/** Actions belonging to one view. `security` picks up the borrowed ones too. */
export function actionsIn(category: EventCategory): AuditAction[] {
  return AUDIT_ACTIONS.filter((a) => {
    const m = metaFor(a);
    return m.category === category || (category === "security" && m.alsoSecurity === true);
  });
}

/**
 * The ones a failed-attempt feed is made of.
 *
 * Blocked security events only. A successful sign-in is recorded and
 * searchable — the brief is explicit that it must be — but it does not
 * belong in a triage feed, where nine hundred ordinary ones would bury
 * the four that matter.
 */
export const SUSPICIOUS: AuditAction[] = AUDIT_ACTIONS.filter((a) => {
  const m = metaFor(a);
  return m.category === "security" && m.outcome === "blocked";
});

/** Sign-in related, successful or not — the Sign-ins view. */
export const SIGNIN_ACTIONS: AuditAction[] = [
  "signin.ok", "signin.denied", "login.ok", "login.requested", "login.sent",
  "login.redeemed", "login.rejected", "login.unknown", "code.sent", "code.verified",
  "code.failed", "locked.out", "session.rejected", "session.ended",
];
