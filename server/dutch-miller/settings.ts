import { db, ensureSchema } from "../db.js";
import { DUTCH_MILLER } from "./accounts.js";

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
/*
 * Which partner a setting belongs to, or none.
 *
 * SHARED is the empty string, and most settings are shared: who
 * reviews a new member, the reminder schedule, the email
 * configuration. Those are managed centrally for the whole platform
 * and changing one changes it everywhere, which is the point of
 * running one application rather than several.
 *
 * A few are genuinely the account's — where the sticker goes on the
 * glass is a property of the tags that partner was shipped, not a
 * platform policy — and those carry an account id.
 *
 * The key has to widen with it, or the second account to set a
 * placement overwrites the first one's. Dropped and replaced by a
 * unique index rather than a new primary key, because ADD PRIMARY
 * KEY has no IF NOT EXISTS and this statement runs on every boot.
 */
ALTER TABLE dm_settings ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT '';
ALTER TABLE dm_settings DROP CONSTRAINT IF EXISTS dm_settings_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS dm_settings_scope ON dm_settings (account_id, key);
/*
 * The two account-scoped settings, moved to the account that set
 * them. Everything written before partner accounts was Dutch
 * Miller's. Runs once: nothing matches afterwards.
 */
UPDATE dm_settings SET account_id = '${DUTCH_MILLER}'
 WHERE account_id = '' AND key IN ('sticker_placement', 'dealer_account_active');
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

/**
 * The scope a setting is read and written in.
 *
 * `SHARED` for the platform's own settings and an account id for the
 * few that belong to one partner. An explicit argument rather than a
 * default, on the keys that have one, so that adding a setting makes
 * somebody answer the question instead of inheriting an answer.
 */
export const SHARED = "";

async function read<T>(key: string, fallback: T, scope = SHARED): Promise<T> {
  await ensure();
  const { rows } = await db().query<{ value: T }>(
    "SELECT value FROM dm_settings WHERE key = $1 AND account_id = $2", [key, scope]);
  return rows[0]?.value ?? fallback;
}

async function meta(key: string, scope = SHARED): Promise<{
  updatedAt: string | null; updatedBy: string | null;
}> {
  await ensure();
  const { rows } = await db().query<{ updated_at: Date; updated_by: string }>(
    "SELECT updated_at, updated_by FROM dm_settings WHERE key = $1 AND account_id = $2",
    [key, scope]);
  return {
    updatedAt: rows[0]?.updated_at.toISOString() ?? null,
    updatedBy: rows[0]?.updated_by ?? null,
  };
}

async function write<T>(key: string, value: T, by: string, scope = SHARED): Promise<void> {
  await ensure();
  await db().query(
    `INSERT INTO dm_settings (key, value, updated_at, updated_by, account_id)
          VALUES ($1, $2::jsonb, now(), $3, $4)
     ON CONFLICT (account_id, key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), by, scope]);
}

/* ------------------------------------------------------------------ *
 * Who hears about a new signup
 * ------------------------------------------------------------------ */

const NOTIFY_KEY = "signup_notify";

export type SignupNotify = {
  /**
   * The people whose job this is. Each gets the actionable link.
   *
   * It used to be exactly one, on the reasoning that "who is
   * reviewing this?" should have a single answer — a shared list
   * being a list where everyone assumes somebody else has it. That
   * holds right up until the one person is on holiday, and a queue
   * nobody can approve is worse than one two people might both look
   * at. Approving is already safe to share: it is one-way and
   * first-come, so a second reviewer opening an approved record is
   * told it is done rather than doing it twice.
   */
  reviewers: string[];
  /** Everybody else who wants to see them. No action expected. */
  notifiers: string[];
  /** Off without clearing either list, so turning it back on is not a retype. */
  enabled: boolean;
  /** Also send to whoever submitted it, as their own receipt. */
  copySubmitter: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** Who a message is for, which decides what it says. */
export type Audience = "reviewer" | "notifier" | "submitter";

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
  const stored = await read<Record<string, unknown> | null>(NOTIFY_KEY, null);
  const { rows } = await db().query<{ updated_at: Date; updated_by: string }>(
    "SELECT updated_at, updated_by FROM dm_settings WHERE key = $1", [NOTIFY_KEY]);

  const clean = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const list = (v: unknown) => (Array.isArray(v) ? v.map(clean).filter((a) => EMAIL_RE.test(a)) : []);

  /*
   * An older setting held one flat `recipients` list. Read it as the
   * first being the reviewer and the rest notifiers, rather than
   * dropping it and silently sending nobody anything.
   */
  const legacy = list(stored?.recipients);
  /*
   * Two older shapes, both still read.
   *
   * A flat `recipients` list came first; then a single `reviewer`
   * with notifiers beside it. Either is turned into the list without
   * anybody retyping anything, because the alternative to reading an
   * old setting is silently sending nobody anything.
   */
  const stored_reviewers = Array.isArray(stored?.reviewers)
    ? list(stored.reviewers)
    : EMAIL_RE.test(clean(stored?.reviewer))
      ? [clean(stored?.reviewer)]
      : legacy.slice(0, 1);
  const reviewers = [...new Set(stored_reviewers)];
  const notifiers = stored?.notifiers !== undefined
    ? list(stored.notifiers)
    : legacy.slice(1);

  return {
    reviewers,
    notifiers: [...new Set(notifiers)].filter((a) => !reviewers.includes(a)),
    enabled: stored?.enabled !== false && Boolean(stored),
    copySubmitter: stored?.copySubmitter === true,
    updatedAt: rows[0]?.updated_at.toISOString() ?? null,
    updatedBy: rows[0]?.updated_by ?? null,
  };
}

export async function setSignupNotify(
  opts: {
    reviewers: string[]; notifiers: string[]; enabled: boolean; copySubmitter: boolean;
  },
  by: string,
): Promise<SignupNotify> {
  const reviewers = [...new Set(
    opts.reviewers.map((r) => r.trim().toLowerCase()).filter((r) => r !== ""))];
  const bad = reviewers.find((r) => !EMAIL_RE.test(r));
  if (bad) throw new Error(`Not an email address: ${bad}`);
  if (opts.enabled && reviewers.length === 0) {
    throw new Error("Set at least one CSC Reviewer, or switch notifications off.");
  }
  await write(NOTIFY_KEY, {
    reviewers,
    // Never both: one address in two roles would get two copies saying
    // different things about whose job it is.
    notifiers: [...new Set(opts.notifiers)].filter((a) => !reviewers.includes(a)),
    enabled: opts.enabled,
    copySubmitter: opts.copySubmitter,
  }, by);
  return getSignupNotify();
}

/**
 * Everybody who should hear about one signup, and in what capacity.
 *
 * Switched off, or no reviewer at all, means nobody — a notifier
 * list on its own would send a crowd of people a message telling
 * each of them it is not their job. The submitter's copy is last and
 * deduplicated, so nobody receives two.
 */
export async function recipientsFor(
  submittedBy: string,
): Promise<{ email: string; as: Audience }[]> {
  const s = await getSignupNotify();
  if (!s.enabled || s.reviewers.length === 0) return [];

  const out: { email: string; as: Audience }[] = s.reviewers.map((email) => ({
    email, as: "reviewer" as const,
  }));
  for (const email of s.notifiers) {
    if (!out.some((r) => r.email === email)) out.push({ email, as: "notifier" });
  }
  const me = submittedBy.trim().toLowerCase();
  if (s.copySubmitter && EMAIL_RE.test(me) && !out.some((r) => r.email === me)) {
    out.push({ email: me, as: "submitter" });
  }
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

/* ------------------------------------------------------------------ *
 * Where the sticker goes
 * ------------------------------------------------------------------ */

/**
 * Inside the glass, or outside it.
 *
 * A property of the TAGS, not of a preference: an adhesive meant for
 * the inside fails on the outside and the reverse, so this follows
 * whichever stock MOJO is issuing. It changes three things that must
 * never disagree with each other — the instructions somebody reads at
 * the vehicle, the wording of the confirmation they tick, and the
 * caption on the diagram — which is why it is one stored value rather
 * than three pieces of copy to keep in step by hand.
 *
 * Default INSIDE, because that is what every tag issued so far was
 * applied under and a setting appearing must not silently rewrite the
 * instructions under somebody holding a sticker.
 */
export const PLACEMENTS = ["inside", "outside"] as const;
export type Placement = (typeof PLACEMENTS)[number];
export const isPlacement = (v: unknown): v is Placement =>
  typeof v === "string" && (PLACEMENTS as readonly string[]).includes(v);

const PLACEMENT_KEY = "sticker_placement";

export type PlacementSetting = {
  placement: Placement;
  updatedAt: string | null;
  updatedBy: string | null;
};

export async function getPlacement(account: string): Promise<PlacementSetting> {
  const stored = await read<unknown>(PLACEMENT_KEY, null, account);
  return {
    placement: isPlacement(stored) ? stored : "inside",
    ...await meta(PLACEMENT_KEY, account),
  };
}

export async function setPlacement(
  placement: Placement, by: string, account: string,
): Promise<PlacementSetting> {
  if (!isPlacement(placement)) throw new Error("That is not a placement.");
  await write(PLACEMENT_KEY, placement, by, account);
  return getPlacement(account);
}

/* ------------------------------------------------------------------ *
 * The dealer door, open or shut
 * ------------------------------------------------------------------ */

/**
 * One switch that closes Dutch Miller to everybody outside MOJO.
 *
 * Not the same as disabling people one at a time, which is what
 * `dm_users.status` is for. This is the whole partner account: the
 * dealership's agreement ends, or something has to stop right now,
 * and nobody wants to be clicking through thirty rows while it does.
 *
 * It shuts the EMAILED-LINK door only. MOJO staff keep working —
 * they are the people who would be switching it back on, and locking
 * them out of their own app to lock out a partner is how a pause
 * becomes an outage. That is judged on the DOOR somebody came
 * through, never on their address: the whole point of the second
 * door is that an address stopped being proof of anything.
 *
 * Open by default, and it takes effect on the next request rather
 * than at the next sign-in — a dealer already signed in is refused
 * immediately, not in eight hours.
 */
const ACCOUNT_KEY = "dealer_account_active";

export type AccountState = {
  active: boolean;
  /** Why it was switched off, shown to the dealer who tries. */
  reason: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

export async function getAccountState(account: string): Promise<AccountState> {
  const stored = await read<Record<string, unknown> | null>(ACCOUNT_KEY, null, account);
  return {
    // Absent means open. A setting appearing must not shut a door.
    active: stored === null ? true : stored.active !== false,
    reason: String(stored?.reason ?? ""),
    ...await meta(ACCOUNT_KEY, account),
  };
}

export async function setAccountState(
  active: boolean, reason: string, by: string, account: string,
): Promise<AccountState> {
  const why = reason.trim();
  // Switching OFF needs a reason: it is the one that somebody rings
  // up about, and "no access" with nothing attached is unanswerable.
  if (!active && why.length < 5) {
    throw new Error("Say why partner access is being switched off.");
  }
  await write(ACCOUNT_KEY, { active, reason: active ? "" : why.slice(0, 500) }, by, account);
  return getAccountState(account);
}
