import { button, escapeHtml, isMailConfigured, layout, sendMail } from "../mail.js";
import { publicOrigin, signupUrl } from "../origin.js";
import { audit } from "./audit.js";
import { RETRY, sendOnce } from "./delivery.js";
import { recipientsFor } from "./settings.js";
import { DISPLAY_TZ, markNotified, type SignupRow } from "./signups.js";
import { emitChange } from "../events.js";

/**
 * Telling somebody at MOJO that a member was signed up.
 *
 * Deliberately NOT part of the submission transaction. A tag has already
 * left the pool and a member record exists by the time this runs; failing
 * the request because an email bounced would tell the dealer their signup
 * did not work when it did, and there is no way for them to retry it
 * without burning a second tag. So this is fire-and-forget, and every
 * outcome lands in the audit trail instead — a notification nobody got is
 * then visible rather than silent.
 */

/**
 * Always in the configured zone, never the server's.
 *
 * Spelled out in components rather than `dateStyle`/`timeStyle`, which
 * cannot be combined with `timeZoneName` — Intl throws rather than
 * ignoring it, and in here that throw would be swallowed and every
 * notification would quietly become an audit line saying it failed.
 */
const stamp = (iso: string): string => {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ, year: "numeric", month: "short", day: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ, hour: "numeric", minute: "2-digit",
    hour12: true, timeZoneName: "short",
  }).format(d);
  return `${date}, ${time}`;
};

/**
 * One label/value pair.
 *
 * The label column is a FIXED width, not `auto` and not `1%`. Auto lets
 * a full-width table share the spare space between the columns, which
 * pushes every value against the right margin with a corridor of
 * nothing in the middle. Shrink-to-fit cures that but sizes each table
 * to its own longest label, so the three sections line their values up
 * in three different places. One fixed width is the only one of the
 * three that reads as a single list.
 */
const row = (label: string, value: string | null): string =>
  `<tr>
     <td style="width:132px;padding:5px 16px 5px 0;color:#71717a;
                vertical-align:top;font-size:14px">${escapeHtml(label)}</td>
     <td style="padding:5px 0;vertical-align:top;font-size:14px;color:#18181b">
       ${escapeHtml(value || "—")}</td>
   </tr>`;

const bucket = (title: string, rows: string): string =>
  `<p style="margin:24px 0 2px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;
      color:#a1a1aa;font-weight:600">${escapeHtml(title)}</p>
   <table style="border-collapse:collapse;width:100%;border-top:1px solid #e4e4e7;
      margin-top:6px">${rows}</table>`;

/** The same three buckets the app shows, in the same order. */
export function signupEmail(s: SignupRow, opts: {
  sample?: boolean;
  origin?: string;
  /**
   * Who it is for, which decides whether the button works.
   *
   * The reviewer gets a link straight to the record because acting on
   * it is their job. Everybody else gets the same details with the
   * button greyed out and a line saying so — a working button on a
   * message that is for information invites four people to open a
   * record that one of them owns, and "opened" stops meaning anything.
   */
  as?: "reviewer" | "notifier" | "submitter";
} = {}): {
  subject: string;
  html: string;
} {
  const as = opts.as ?? "reviewer";
  // Straight to the record, so marking it complete does not start with
  // finding it. Omitted rather than guessed when there is no origin to
  // build from — a broken button is worse than none.
  const link = as === "reviewer" ? signupUrl(opts.origin ?? publicOrigin(), s.guid) : "";
  const name = `${s.customer.firstName} ${s.customer.lastName}`.trim();
  const subject = opts.sample
    ? "Sample — new member signup"
    // The reviewer's inbox should say it is theirs before they open it.
    : `${as === "reviewer" ? "To review" : "FYI"}: new member signup — ${name} · ${s.customer.rfid}`;

  const html = layout(
    opts.sample ? "Sample notification" : "New member signup",
    `${opts.sample ? `<p style="margin:0 0 16px;padding:10px 14px;background:#fef3c7;
         border-radius:8px;font-size:13px;color:#78350f">
         A sample, sent to you only. No member was created and no RFID was used.</p>` : ""}
     <table style="border-collapse:collapse;width:100%;background:#f4f4f5;border-radius:8px">
       <tr><td style="padding:14px 16px">
         <span style="display:block;font-size:17px;font-weight:700;color:#18181b">
           ${escapeHtml(name)}</span>
         <span style="display:block;margin-top:3px;font-size:14px;color:#52525b">
           RFID ${escapeHtml(s.customer.rfid)}</span>
         <span style="display:block;margin-top:3px;font-size:13px;color:#71717a">
           Submitted by ${escapeHtml(s.submittedBy || "a dealer user")}</span>
       </td></tr>
     </table>

     ${bucket("Dealer", [
       row("DLW Contract ID", s.dealer.dlwContractId),
       row("Deal #", s.dealer.dealNumber),
       row("Customer ID #", s.dealer.customerId),
     ].join(""))}

     ${bucket("Customer", [
       row("Name", `${s.customer.firstName} ${s.customer.lastName}`.trim()),
       row("Plate (DLW)", [s.customer.plateDlw, s.customer.plateState]
         .filter(Boolean).join("  ·  ") || null),
       row("Vehicle", [s.customer.vehicleYear, s.customer.vehicleMake, s.customer.vehicleModel]
         .filter(Boolean).join(" ") || null),
       row("Color", s.customer.vehicleColor),
     ].join(""))}

     ${link ? `<div style="margin:22px 0 0">${button(link, "Open in MOJO")}</div>` : ""}
     ${as === "reviewer" ? "" : `
       <div style="margin:22px 0 0">
         <p style="margin:0 0 10px">
           <span style="display:inline-block;background:#e4e4e7;color:#a1a1aa;
                        padding:11px 20px;border-radius:8px;font-weight:600;font-size:15px">
             Open in MOJO</span></p>
         <p style="margin:0;font-size:13px;color:#71717a">
           ${as === "submitter"
            ? "You are copied on this because you submitted it. "
            : "You are copied on this for information — the review is not yours. "}
           Sign in to the portal to see where it has got to.</p>
       </div>`}

     ${bucket("Entry", [
       row("Created", stamp(s.createdAt)),
       row("Submitted", stamp(s.submittedAt)),
       row("Reference", s.guid),
     ].join(""))}`,
    as === "reviewer"
      ? "Sent to you as the CSC Reviewer for Dutch Miller signups."
      : "Sent for information. Change who receives these under Email Settings.",
  );

  return { subject, html };
}

/**
 * Send it, to whoever is configured, without ever throwing at the caller.
 *
 * One message per recipient rather than one with several addressees: a
 * single bad address in a `toRecipients` array can take the whole send
 * with it, and these are internal notifications where who else got it is
 * nobody's business anyway.
 */
export async function notifySignup(s: SignupRow, origin?: string): Promise<void> {
  try {
    const to = await recipientsFor(s.submittedBy);
    if (to.length === 0) return;
    if (!isMailConfigured()) {
      await audit({
        app: "dutch-miller",
        action: "notify.failed", subject: s.customer.rfid,
        detail: "email is not configured",
      });
      return;
    }

    // One message each, built for its reader. Also one SEND each,
    // independently: a single bad address in a combined
    // `toRecipients` can take the whole thing with it, and the
    // reviewer must still get theirs when a notifier's mailbox is
    // gone. `sendOnce` adds the bounded retry and makes a second call
    // for the same message a no-op.
    const results = await Promise.allSettled(to.map((r) => {
      const { subject, html } = signupEmail(s, { origin, as: r.as });
      return sendOnce({
        resource: s.guid, kind: "signup", email: r.email, audience: r.as,
        subject, html,
      });
    }));
    const failed = results
      .map((r, i) => (
        r.status === "rejected" || r.value.state === "failed" ? to[i]!.email : null))
      .filter((a): a is string => a !== null);

    if (failed.length < to.length) {
      await markNotified(s.guid);
      // The page that submitted this is still open and still showing
      // the step as grey. This is what turns it green without a reload.
      emitChange("signups");
      await audit({
        app: "dutch-miller",
        action: "notify.sent", subject: s.guid, resource: s.guid, actor: s.submittedBy,
        detail: `${to.length - failed.length} of ${to.length} accepted for delivery`,
      });
    }
    if (failed.length > 0) {
      await audit({
        app: "dutch-miller",
        action: "notify.failed", subject: s.guid, resource: s.guid, actor: s.submittedBy,
        detail: `gave up after ${RETRY.maxAttempts} attempts: ${failed.join(", ")}`,
      });
    }
  } catch (err) {
    // The signup itself is already saved and the tag already claimed.
    // This is the one place that must swallow rather than propagate.
    console.error("signup notification failed:", err);
    await audit({
      app: "dutch-miller",
      action: "notify.failed", subject: s.guid,
      detail: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
  }
}


/* ------------------------------------------------------------------ *
 * Approved
 * ------------------------------------------------------------------ */

/**
 * Told to the dealer who submitted it, when MOJO finishes with it.
 *
 * This is the only message in the whole flow that the dealer actually
 * wants. Everything before it is MOJO's internal progress; this one
 * answers the question they have been holding since they pressed
 * submit — can this person wash their car yet. So it leads with that
 * and in those words, rather than with a status name.
 */
export function approvedEmail(s: SignupRow, opts: { origin?: string } = {}): {
  subject: string;
  html: string;
} {
  const name = `${s.customer.firstName} ${s.customer.lastName}`.trim();
  const vehicle = [s.customer.vehicleYear, s.customer.vehicleMake, s.customer.vehicleModel]
    .filter(Boolean).join(" ");
  const plate = [s.customer.plateDlw, s.customer.plateState].filter(Boolean).join("  ");

  return {
    subject: `Approved — ${name} is set up and can wash`,
    html: layout(
      "Membership approved",
      `<table style="border-collapse:collapse;width:100%;background:#ecfdf5;border-radius:8px">
         <tr><td style="padding:16px 18px">
           <span style="display:block;font-size:17px;font-weight:700;color:#065f46">
             ${escapeHtml(name)} can now wash their vehicle.</span>
           <span style="display:block;margin-top:4px;font-size:14px;color:#047857">
             MOJO has reviewed and approved the membership. The tag is active.</span>
         </td></tr>
       </table>

       ${bucket("Membership", [
        row("Member", name),
        row("RFID tag", s.customer.rfid),
        row("Vehicle", vehicle || null),
        row("Plate", plate || null),
      ].join(""))}

       ${bucket("Your reference", [
        row("DLW Contract ID", s.dealer.dlwContractId),
        row("Deal #", s.dealer.dealNumber || null),
        row("Customer ID #", s.dealer.customerId || null),
        row("Submitted", stamp(s.submittedAt)),
        row("Approved", s.completedAt ? stamp(s.completedAt) : "—"),
      ].join(""))}

       <p style="margin:22px 0 0;font-size:14px;color:#52525b">
         Hand the tag to the member and they are ready to go. If anything here is wrong,
         reply to this message rather than submitting them again — a second signup would
         take a second tag.</p>

       ${opts.origin
        ? `<div style="margin:20px 0 0">${button(
          `${opts.origin}/#/member-signups/review`, "See your signups")}</div>`
        : ""}`,
      "Sent because this address submitted the signup.",
    ),
  };
}

/**
 * Send it. Never throws at the caller.
 *
 * The approval is already recorded by the time this runs, exactly as
 * with the submission notification: failing the request because an
 * email bounced would tell somebody the approval did not happen when
 * it did.
 */
export async function notifyApproved(s: SignupRow, origin?: string): Promise<void> {
  try {
    const to = s.submittedBy.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return;
    if (!isMailConfigured()) {
      await audit({ app: "dutch-miller", action: "approved.failed", subject: s.guid, detail: "email is not configured" });
      return;
    }
    const { subject, html } = approvedEmail(s, { origin });
    const out = await sendOnce({
      resource: s.guid, kind: "approved", email: to, audience: "submitter",
      subject, html,
    });
    // Approval is final, so this message is too: `sendOnce` keyed on
    // the signup means a retry anywhere cannot tell the dealer twice
    // that their member may now wash.
    if (out.state === "failed") {
      await audit({
        app: "dutch-miller",
        action: "approved.failed", subject: s.guid, resource: s.guid,
        detail: `${to} · ${out.attempts} attempt(s) · ${out.error}`,
      });
      return;
    }
    await audit({
      app: "dutch-miller",
      action: "approved.sent", subject: s.guid, resource: s.guid,
      detail: out.duplicate ? `${to} (already sent)` : to,
    });
  } catch (err) {
    console.error("approval email failed:", err);
    await audit({
      app: "dutch-miller",
      action: "approved.failed", subject: s.guid,
      detail: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
  }
}
