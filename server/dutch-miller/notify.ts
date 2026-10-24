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

const row = (label: string, value: string | null): string =>
  `<tr>
     <td style="padding:4px 14px 4px 0;color:#71717a;white-space:nowrap;vertical-align:top">
       ${escapeHtml(label)}</td>
     <td style="padding:4px 0;font-weight:600">${escapeHtml(value || "—")}</td>
   </tr>`;

const bucket = (title: string, rows: string): string =>
  `<p style="margin:18px 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;
      color:#71717a">${escapeHtml(title)}</p>
   <table style="border-collapse:collapse;font-size:14px;width:100%">${rows}</table>`;

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
    `${opts.sample ? `<p style="margin:0 0 14px;padding:8px 12px;background:#fef3c7;
         border-radius:6px;font-size:13px;color:#78350f">
         A sample, sent to you only. No member was created and no RFID was used.</p>` : ""}
     <p style="margin:0;font-size:15px">
       <strong>${escapeHtml(name)}</strong> was signed up by
       ${escapeHtml(s.submittedBy || "a dealer user")}.</p>

     ${bucket("Dealer", [
       row("DLW Contract ID", s.dealer.dlwContractId),
       row("Deal #", s.dealer.dealNumber),
       row("Customer ID #", s.dealer.customerId),
     ].join(""))}

     ${bucket("Customer", [
       row("First name", s.customer.firstName),
       row("Last name", s.customer.lastName),
       row("Plate (DLW)", s.customer.plateDlw),
       row("Vehicle", [s.customer.vehicleYear, s.customer.vehicleMake, s.customer.vehicleModel]
         .filter(Boolean).join(" ") || null),
       row("Color", s.customer.vehicleColor),
       row("RFID", s.customer.rfid),
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
