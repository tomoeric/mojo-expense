import { escapeHtml, isMailConfigured, layout, sendMail } from "../mail.js";
import { audit } from "./audit.js";
import { recipientsFor } from "./settings.js";
import { DISPLAY_TZ, type SignupRow } from "./signups.js";

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
export function signupEmail(s: SignupRow, opts: { sample?: boolean } = {}): {
  subject: string;
  html: string;
} {
  const name = `${s.customer.firstName} ${s.customer.lastName}`.trim();
  const subject = opts.sample
    ? "Sample — new member signup"
    : `New member signup — ${name} · ${s.customer.rfid}`;

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
       row("Plate (DLW)", s.customer.plateDlw),
       row("Vehicle", [s.customer.vehicleYear, s.customer.vehicleMake, s.customer.vehicleModel]
         .filter(Boolean).join(" ") || null),
       row("Color", s.customer.vehicleColor),
     ].join(""))}

     ${bucket("Entry", [
       row("Created", stamp(s.createdAt)),
       row("Submitted", stamp(s.submittedAt)),
       row("Reference", s.guid),
     ].join(""))}`,
    "Sent because this address is on the Dutch Miller signup notification list.",
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
export async function notifySignup(s: SignupRow): Promise<void> {
  try {
    const to = await recipientsFor(s.submittedBy);
    if (to.length === 0) return;
    if (!isMailConfigured()) {
      await audit({
        action: "notify.failed", subject: s.customer.rfid,
        detail: "email is not configured",
      });
      return;
    }
    const { subject, html } = signupEmail(s);
    const results = await Promise.allSettled(to.map((a) => sendMail(a, subject, html)));
    const failed = results
      .map((r, i) => (r.status === "rejected" ? to[i]! : null))
      .filter((a): a is string => a !== null);

    if (failed.length < to.length) {
      await audit({
        action: "notify.sent", subject: s.guid, actor: s.submittedBy,
        detail: `${to.length - failed.length} of ${to.length}`,
      });
    }
    if (failed.length > 0) {
      await audit({
        action: "notify.failed", subject: s.guid, actor: s.submittedBy,
        detail: `could not reach ${failed.join(", ")}`,
      });
    }
  } catch (err) {
    // The signup itself is already saved and the tag already claimed. This
    // is the one place that must swallow rather than propagate.
    console.error("signup notification failed:", err);
    await audit({
      action: "notify.failed", subject: s.guid,
      detail: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
  }
}
