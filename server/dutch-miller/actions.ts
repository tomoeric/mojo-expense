import { DM_PAGE_KEYS, type DmPageKey } from "./pages.js";

/**
 * What a role can DO, as against what it can OPEN.
 *
 * Two different questions that a list of pages answers only one of.
 * "Can a service writer approve a membership?" is not visible anywhere
 * in a set of page tick-boxes, and the honest answer to it today is
 * "no, and not because of the tick-boxes".
 *
 * Everything here is DERIVED and read-only. That is deliberate and is
 * the whole point of the module: these permissions are not stored per
 * role, so showing them as editable checkboxes would be a lie that
 * silently broadens access the first time somebody saves one. What
 * they are is a faithful printout of the rules the server already
 * enforces, with the source of each one named.
 *
 * Approving in particular stays exactly where it was: the built-in CSC
 * role, plus the pinned super administrator, and nothing else. See
 * `roles.ts`, where the catalogue asserts it on every boot.
 */

export type ActionKey =
  | "member.submit" | "member.import" | "member.review" | "member.approve"
  | "member.export" | "member.delete"
  | "rfid.upload" | "rfid.manage" | "rfid.delete"
  | "users.manage" | "roles.manage" | "notifications.manage"
  | "security.view" | "audit.view";

export type ActionDef = {
  key: ActionKey;
  label: string;
  /** Where the permission comes from, in words a person can check. */
  source: string;
};

export const ACTIONS: ActionDef[] = [
  { key: "member.submit", label: "Submit a member",
    source: "Member Signups — Add New" },
  { key: "member.import", label: "Import members from a file",
    source: "Member Signups — Add New" },
  { key: "member.review", label: "Open and review a member record",
    source: "Member Signups — Review Existing" },
  {
    key: "member.approve",
    label: "Approve a membership",
    source: "The built-in CSC role only, plus the pinned super administrator. "
      + "Not granted by administering, and not editable on any role.",
  },
  { key: "member.export", label: "Export member records",
    source: "Member Signups — Review Existing" },
  { key: "member.delete", label: "Delete a member record",
    source: "Granted per role, plus the super administrator" },
  { key: "rfid.upload", label: "Upload RFID numbers",
    source: "RFID Inventory page access" },
  { key: "rfid.manage", label: "Hold back or release RFID numbers",
    source: "RFID Inventory page access" },
  { key: "rfid.delete", label: "Remove RFID numbers from the pool",
    source: "Granted per role, plus the super administrator" },
  { key: "users.manage", label: "Invite people and set their roles",
    source: "Administering. Making somebody an ADMIN is super only." },
  { key: "roles.manage", label: "Create and edit roles",
    source: "Super administrator only" },
  { key: "notifications.manage", label: "Change notification recipients and reminders",
    source: "Administering" },
  { key: "security.view", label: "Read the security workspace",
    source: "Administering" },
  { key: "audit.view", label: "Read Audit History",
    source: "Administering" },
];

export type EffectiveActions = Record<ActionKey, boolean>;

/**
 * What this role can actually do, computed the way the guards decide.
 *
 * One function, so the role editor's printout and the server's
 * refusals cannot drift: if a rule changes, both change together or
 * neither does.
 */
export function actionsFor(a: {
  pages: readonly DmPageKey[];
  administers: boolean;
  approves: boolean;
  deletesSignups?: boolean;
  deletesRfid?: boolean;
  /** The pinned super administrator. Holds everything by configuration. */
  pinnedSuper?: boolean;
}): EffectiveActions {
  const sup = a.pinnedSuper === true;
  // Administering means every page, whatever the tick-boxes say — the
  // same rule `dmAccessFor` applies.
  const pages: readonly DmPageKey[] = sup || a.administers ? DM_PAGE_KEYS : a.pages;
  const has = (p: DmPageKey) => pages.includes(p);
  const admin = sup || a.administers;

  return {
    // Two grants now, because enrolling and reviewing are different
    // jobs: a front desk enrols and never approves, and somebody at
    // MOJO reads the queue without ever typing a member in.
    "member.submit": has("member-signups-add"),
    "member.import": has("member-signups-add"),
    "member.review": has("member-signups"),
    // The one that is NOT a consequence of anything else.
    "member.approve": sup || a.approves,
    "member.export": has("member-signups"),
    // Grantable per role now, and still never implied by administering.
    "member.delete": sup || a.deletesSignups === true,
    "rfid.upload": has("rfid-review"),
    "rfid.manage": has("rfid-review"),
    "rfid.delete": sup || a.deletesRfid === true,
    "users.manage": admin,
    "roles.manage": sup,
    "notifications.manage": admin,
    "security.view": admin,
    "audit.view": admin,
  };
}
