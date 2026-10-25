import { button, escapeHtml, isMailConfigured, layout, sendMail } from "../mail.js";
import { publicOrigin } from "../origin.js";
import { audit } from "./audit.js";
import {
  DAY_NAMES, getReminders, hour24, noteReminderSent, recipientsFor,
} from "./settings.js";
import { DISPLAY_TZ, listSignups, type SignupRow } from "./signups.js";

/**
 * The reminder: what is still sitting here waiting for MOJO.
 *
 * A signup that nobody completes is invisible — the dealer has done
 * their part and has no way to chase it, and at MOJO it is one row in
 * a list nobody has a reason to open. The notification covers the
 * moment it arrives; this covers the fortnight afterwards.
 *
 * NOTHING IS SENT WHEN THERE IS NOTHING OUTSTANDING. A reminder that
 * arrives every week saying "nothing to do" is one people stop reading,
 * and then they stop reading the one that matters too.
 */

/** Where the clock is read. Everything below is in this zone, not the server's. */
const TZ = DISPLAY_TZ;

type Now = { dayIndex: number; hour: number; minute: number; stamp: string };

/**
 * The wall clock in the configured zone.
 *
 * Via `Intl` rather than date arithmetic, so daylight saving is the
 * platform's problem. The stamp is the minute slot, which is what makes
 * sending idempotent across a restart: the same minute cannot be sent
 * twice because the slot is already recorded.
 */
export function wallClock(at: Date = new Date()): Now {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit",
    year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  // `hour12: false` gives 24 for midnight in some engines.
  const hour = Number(get("hour")) % 24;
  return {
    dayIndex: order.indexOf(get("weekday")),
    hour,
    minute: Number(get("minute")),
    stamp: `${get("year")}-${get("month")}-${get("day")} ${String(hour).padStart(2, "0")}:${get("minute")}`,
  };
}

/** Is a reminder due right now, and has this exact minute already gone out? */
export function isDue(
  r: { enabled: boolean; days: number[]; hour: number; meridiem: "AM" | "PM"; minute: number;
    lastSentAt: string | null },
  now: Now,
): boolean {
  if (!r.enabled || r.days.length === 0) return false;
  if (!r.days.includes(now.dayIndex)) return false;
  if (hour24(r.hour, r.meridiem) !== now.hour || r.minute !== now.minute) return false;
  return r.lastSentAt !== now.stamp;
}

const age = (iso: string): number =>
  Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

function digest(rows: SignupRow[], origin: string): { subject: string; html: string } {
  const oldest = rows.reduce((m, r) => Math.min(m, new Date(r.submittedAt).getTime()),
    Date.now());
  const days = Math.floor((Date.now() - oldest) / 86_400_000);

  const list = rows.slice(0, 50).map((r) => {
    const waiting = age(r.submittedAt);
    return `<tr>
      <td style="padding:6px 16px 6px 0;vertical-align:top;font-size:14px">
        <strong>${escapeHtml(`${r.customer.firstName} ${r.customer.lastName}`.trim())}</strong>
        <span style="display:block;color:#71717a;font-size:13px">
          ${escapeHtml(r.customer.rfid)} · ${escapeHtml(r.dealer.dlwContractId)}</span>
      </td>
      <td style="padding:6px 0;vertical-align:top;font-size:13px;color:#71717a;white-space:nowrap">
        ${waiting === 0 ? "today" : `${waiting} day${waiting === 1 ? "" : "s"}`}
        <span style="display:block">${r.openedAt ? "under review" : "not opened"}</span>
      </td>
    </tr>`;
  }).join("");

  return {
    subject: `${rows.length} member signup${rows.length === 1 ? "" : "s"} awaiting MOJO`,
    html: layout(
      `${rows.length} signup${rows.length === 1 ? "" : "s"} still open`,
      `<p style="margin:0 0 16px;font-size:15px">
         The oldest has been waiting ${days === 0 ? "since today" : `${days} day${days === 1 ? "" : "s"}`}.</p>
       <table style="border-collapse:collapse;width:100%;border-top:1px solid #e4e4e7">
         ${list}</table>
       ${rows.length > 50
        ? `<p style="margin:14px 0 0;font-size:13px;color:#71717a">
             …and ${rows.length - 50} more.</p>`
        : ""}
       ${origin ? `<div style="margin:22px 0 0">${button(`${origin}/#/member-signups/review`, "Open the review list")}</div>` : ""}`,
      "A scheduled reminder. Change or switch it off under Email Settings.",
    ),
  };
}

/**
 * Send one if one is due.
 *
 * Separate from the timer so it can be called directly — by the Send
 * now button, and by a test — without waiting for a minute to tick.
 */
export async function runReminders(force = false): Promise<{
  sent: boolean;
  reason: string;
  outstanding: number;
}> {
  const r = await getReminders();
  const now = wallClock();
  if (!force && !isDue(r, now)) return { sent: false, reason: "not due", outstanding: 0 };

  const open = await listSignups({ status: "all", limit: 500 });
  const rows = open.rows.filter((s) => !s.completedAt);
  if (rows.length === 0) {
    // Recorded even though nothing went out, so the slot is spent and
    // the next minute does not try again.
    if (!force) await noteReminderSent(now.stamp);
    return { sent: false, reason: "nothing outstanding", outstanding: 0 };
  }
  if (!isMailConfigured()) {
    return { sent: false, reason: "email is not configured", outstanding: rows.length };
  }

  const to = await recipientsFor("");
  if (to.length === 0) {
    if (!force) await noteReminderSent(now.stamp);
    return { sent: false, reason: "no recipients", outstanding: rows.length };
  }

  // The reminder is a list, not a record, so everybody gets the same
  // one — the reviewer/notifier distinction is about who acts on a
  // single signup, and this is the standing "these are still open".
  const { subject, html } = digest(rows, publicOrigin());
  const results = await Promise.allSettled(to.map((r) => sendMail(r.email, subject, html)));
  const failed = results.filter((x) => x.status === "rejected").length;
  if (!force) await noteReminderSent(now.stamp);
  await audit({
    app: "dutch-miller",
    action: failed === to.length ? "reminder.failed" : "reminder.sent",
    detail: `${rows.length} outstanding · ${to.length - failed} of ${to.length} sent`
      + (force ? " · sent by hand" : ""),
  });
  return {
    sent: failed < to.length,
    reason: failed > 0 ? `${failed} could not be sent` : "",
    outstanding: rows.length,
  };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Check every minute.
 *
 * A minute is the resolution the settings offer, and the work when
 * nothing is due is one small read. Anything cleverer — computing the
 * next fire time and sleeping to it — has to be recomputed whenever
 * the settings change or the clock shifts, and gets that wrong twice a
 * year.
 */
export function startReminders(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runReminders().catch((err) => {
      console.error("reminder run failed:", err instanceof Error ? err.message : err);
    });
  }, 60_000);
  // Not unref'd: this is the one thing in the process that must keep
  // running when nobody is using the app.
}

export { DAY_NAMES };
