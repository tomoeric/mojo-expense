import { db, ensureSchema } from "../db.js";

/**
 * Dutch Miller settings.
 *
 * A small key-value table, because these are a handful of singleton
 * values an administrator edits by hand — not something that grows per
 * day or per person, which would want a real table with an index on it.
 * Each key gets a typed accessor here rather than callers reaching in
 * with a string, so a rename is a compile error instead of a silently
 * empty setting.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text        NOT NULL DEFAULT ''
);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

async function read<T>(key: string, fallback: T): Promise<T> {
  await ensure();
  const { rows } = await db().query<{ value: T }>(
    "SELECT value FROM dm_settings WHERE key = $1", [key]);
  return rows[0]?.value ?? fallback;
}

async function write<T>(key: string, value: T, by: string): Promise<void> {
  await ensure();
  await db().query(
    `INSERT INTO dm_settings (key, value, updated_at, updated_by)
          VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), by]);
}

/* ------------------------------------------------------------------ *
 * Who hears about a new signup
 * ------------------------------------------------------------------ */

const NOTIFY_KEY = "signup_notify";

export type SignupNotify = {
  /** Where the notification goes. Empty means nowhere, whatever `enabled` says. */
  recipients: string[];
  /** Off without clearing the list, so turning it back on does not mean retyping it. */
  enabled: boolean;
  /** Also send to whoever submitted it, as their own receipt. */
  copySubmitter: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Accept whatever somebody pastes in.
 *
 * Commas, semicolons, newlines, spaces, and `Name <a@b.com>` from a copied
 * address book entry. Anything that is not an address comes back in
 * `rejected` so the page can say which one, rather than dropping it and
 * leaving somebody wondering why they get no mail.
 */
export function parseRecipients(raw: unknown): { ok: string[]; rejected: string[] } {
  const parts = String(raw ?? "")
    .split(/[,;\n\r]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const ok: string[] = [];
  const rejected: string[] = [];
  for (const part of parts) {
    // "Dana Reyes <dana@example.com>" — take what is in the brackets.
    const angled = /<([^>]+)>/.exec(part);
    const candidate = (angled?.[1] ?? part).trim().toLowerCase();
    if (EMAIL_RE.test(candidate)) {
      if (!ok.includes(candidate)) ok.push(candidate);
    } else {
      rejected.push(part);
    }
  }
  return { ok, rejected };
}

export async function getSignupNotify(): Promise<SignupNotify> {
  const stored = await read<Partial<SignupNotify> | null>(NOTIFY_KEY, null);
  const { rows } = await db().query<{ updated_at: Date; updated_by: string }>(
    "SELECT updated_at, updated_by FROM dm_settings WHERE key = $1", [NOTIFY_KEY]);
  return {
    recipients: Array.isArray(stored?.recipients)
      ? stored!.recipients.filter((r) => typeof r === "string" && EMAIL_RE.test(r))
      : [],
    enabled: stored?.enabled !== false && Boolean(stored),
    copySubmitter: stored?.copySubmitter === true,
    updatedAt: rows[0]?.updated_at.toISOString() ?? null,
    updatedBy: rows[0]?.updated_by ?? null,
  };
}

export async function setSignupNotify(
  opts: { recipients: string[]; enabled: boolean; copySubmitter: boolean },
  by: string,
): Promise<SignupNotify> {
  await write(NOTIFY_KEY, {
    recipients: opts.recipients,
    enabled: opts.enabled,
    copySubmitter: opts.copySubmitter,
  }, by);
  return getSignupNotify();
}

/**
 * Everybody who should hear about one signup.
 *
 * Switched off, or an empty list, means nobody — `enabled` on its own is
 * not a reason to send, and neither is a submitter copy with notification
 * off. The submitter is deduplicated against the list so nobody gets two.
 */
export async function recipientsFor(submittedBy: string): Promise<string[]> {
  const s = await getSignupNotify();
  if (!s.enabled || s.recipients.length === 0) return [];
  const out = [...s.recipients];
  const me = submittedBy.trim().toLowerCase();
  if (s.copySubmitter && EMAIL_RE.test(me) && !out.includes(me)) out.push(me);
  return out;
}

/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

const REMIND_KEY = "signup_reminders";

/** 0 = Monday … 6 = Sunday, which is how the UI lists them. */
export const DAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
] as const;

export type Reminders = {
  enabled: boolean;
  /**
   * `day` means "on each of these days"; `week` means "once a week, on
   * this one". They are the same mechanism — the difference is only
   * how many days may be chosen, which the server enforces so a stale
   * page cannot save five days against a weekly setting.
   */
  frequency: "day" | "week";
  /** Indexes into DAY_NAMES. Exactly one when the frequency is weekly. */
  days: number[];
  /** As shown: 1–12, with a meridiem, in the app's configured zone. */
  hour: number;
  minute: number;
  meridiem: "AM" | "PM";
  /** When one last went out, so a restart does not send it twice. */
  lastSentAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

const DEFAULT_REMINDERS: Omit<Reminders, "updatedAt" | "updatedBy"> = {
  enabled: false,
  frequency: "week",
  days: [0],
  hour: 8,
  minute: 0,
  meridiem: "AM",
  lastSentAt: null,
};

/** 8 AM → 8; 12 AM → 0; 12 PM → 12. The two noon/midnight cases are the trap. */
export function hour24(hour: number, meridiem: "AM" | "PM"): number {
  const h = Math.min(12, Math.max(1, Math.round(hour)));
  if (meridiem === "AM") return h === 12 ? 0 : h;
  return h === 12 ? 12 : h + 12;
}

export async function getReminders(): Promise<Reminders> {
  const stored = await read<Partial<Reminders> | null>(REMIND_KEY, null);
  const { rows } = await db().query<{ updated_at: Date; updated_by: string }>(
    "SELECT updated_at, updated_by FROM dm_settings WHERE key = $1", [REMIND_KEY]);
  const days = Array.isArray(stored?.days)
    ? [...new Set(stored!.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : DEFAULT_REMINDERS.days;
  const frequency = stored?.frequency === "day" ? "day" : "week";
  return {
    enabled: stored?.enabled === true,
    frequency,
    // Weekly means one day, whatever is in the row.
    days: frequency === "week" ? days.slice(0, 1) : days,
    hour: Number(stored?.hour) >= 1 && Number(stored?.hour) <= 12
      ? Number(stored!.hour) : DEFAULT_REMINDERS.hour,
    minute: Number.isInteger(stored?.minute) && stored!.minute! >= 0 && stored!.minute! <= 59
      ? stored!.minute! : 0,
    meridiem: stored?.meridiem === "PM" ? "PM" : "AM",
    lastSentAt: typeof stored?.lastSentAt === "string" ? stored.lastSentAt : null,
    updatedAt: rows[0]?.updated_at.toISOString() ?? null,
    updatedBy: rows[0]?.updated_by ?? null,
  };
}

export async function setReminders(
  opts: Omit<Reminders, "lastSentAt" | "updatedAt" | "updatedBy">,
  by: string,
): Promise<Reminders> {
  const current = await getReminders();
  const days = [...new Set(opts.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    .sort((a, b) => a - b);
  if (opts.enabled && days.length === 0) throw new Error("Choose at least one day.");
  if (opts.frequency === "week" && days.length > 1) {
    throw new Error("A weekly reminder goes out on one day. Choose Daily for more than one.");
  }
  await write(REMIND_KEY, {
    enabled: opts.enabled,
    frequency: opts.frequency,
    days,
    hour: opts.hour,
    minute: opts.minute,
    meridiem: opts.meridiem,
    // Carried over rather than cleared: changing the wording of a
    // reminder should not make today's go out a second time.
    lastSentAt: current.lastSentAt,
  }, by);
  return getReminders();
}

/** Only the scheduler writes this. */
export async function noteReminderSent(stamp: string): Promise<void> {
  const current = await getReminders();
  await write(REMIND_KEY, {
    enabled: current.enabled,
    frequency: current.frequency,
    days: current.days,
    hour: current.hour,
    minute: current.minute,
    meridiem: current.meridiem,
    lastSentAt: stamp,
  }, "scheduler");
}
