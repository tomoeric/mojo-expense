import { db, ensureSchema } from "../db.js";
import { env } from "../env.js";
import { DEFAULT_SELECTORS, SUPERSEDED_SELECTORS } from "../emburse/auto-export.js";

/**
 * What the daily Emburse export is supposed to contain.
 *
 * The app both acts on this and checks itself against it. The runner uses these
 * sections and filters to drive Emburse; the importer then reads what actually
 * came back. Every export PDF prints the search it came from on page 1,
 *
 *   Exported results of search: Section: Inbox, Receipt: Receipts: True
 *
 * so an import can compare what arrived against what was asked for and say so
 * when they differ.
 *
 * That closes the one gap nothing else covers. A section chip toggled the wrong
 * way produces a valid PDF, of the wrong rows, that parses cleanly and
 * reconciles against its own printed total — every check the importer has would
 * pass. Only the header knows, and only if something is holding it to account.
 */

export type ExportSettings = {
  /**
   * Where Emburse lives for this tenant.
   *
   * Editable rather than an env var because it is a guess until somebody
   * checks their address bar, and a wrong guess should not need a redeploy to
   * correct — the default was wrong exactly once already.
   */
  emburseUrl: string;
  /**
   * Selectors the browser automation uses. Stored rather than compiled in
   * because Emburse's markup cannot be known from outside their tenant, and
   * correcting one after a failed run should not need a deploy.
   */
  selectors: Record<string, string>;
  /** Emburse Section chips expected in the export dialog. */
  sections: string[];
  /** Whether the Receipts: true filter is expected. */
  receiptsOnly: boolean;
  /**
   * When the server runs the export, and how it retries.
   *
   * Read by the scheduler on every tick rather than at boot, so a change here
   * takes effect without a restart — which is the whole reason it is a stored
   * setting and not an env var.
   */
  schedule: Schedule;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type Schedule = {
  timezone: string;
  /** First attempt, as "HH:MM" in `timezone`. */
  firstRun: string;
  retryHours: number;
  attemptsPerDay: number;
  /** Minutes to keep waiting after an attempt before calling it a miss. */
  graceMinutes: number;
};

/** Every section Emburse offers, in the order the dialog shows them. */
export const ALL_SECTIONS = [
  "Needs Review",
  "Needs Manager Review",
  "Pending Submission",
  "Denied",
  "Completed",
] as const;

const DEFAULT_SECTIONS = ["Needs Review", "Needs Manager Review"];

/** Env still supplies the starting point, so a fresh database is not blank. */
function envSchedule(): Schedule {
  const { timezone, firstRun, retryHours, attemptsPerDay, graceMinutes } = env.schedule;
  return {
    timezone,
    firstRun: `${String(firstRun.hour).padStart(2, "0")}:${String(firstRun.minute).padStart(2, "0")}`,
    retryHours, attemptsPerDay, graceMinutes,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS export_settings (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  sections     text[]      NOT NULL,
  receipts_only boolean    NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
ALTER TABLE export_settings ADD COLUMN IF NOT EXISTS timezone        text;
ALTER TABLE export_settings ADD COLUMN IF NOT EXISTS first_run       text;
ALTER TABLE export_settings ADD COLUMN IF NOT EXISTS retry_hours     integer;
ALTER TABLE export_settings ADD COLUMN IF NOT EXISTS attempts_per_day integer;
ALTER TABLE export_settings ADD COLUMN IF NOT EXISTS grace_minutes   integer;
ALTER TABLE export_settings ADD COLUMN IF NOT EXISTS selectors       jsonb;
ALTER TABLE export_settings ADD COLUMN IF NOT EXISTS emburse_url     text;
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => {
    await db().query(SCHEMA);
  }));

export async function readSettings(): Promise<ExportSettings> {
  await ensure();
  const { rows } = await db().query<{
    sections: string[]; receipts_only: boolean; updated_at: Date; updated_by: string | null;
    timezone: string | null; first_run: string | null;
    retry_hours: number | null; attempts_per_day: number | null; grace_minutes: number | null;
    selectors: Record<string, string> | null; emburse_url: string | null;
  }>(`SELECT sections, receipts_only, updated_at, updated_by,
             timezone, first_run, retry_hours, attempts_per_day, grace_minutes, selectors,
             emburse_url
        FROM export_settings WHERE id`);

  const row = rows[0];
  const fallback = envSchedule();
  if (!row) {
    return {
      sections: DEFAULT_SECTIONS, receiptsOnly: true, schedule: fallback,
      selectors: { ...DEFAULT_SELECTORS }, emburseUrl: env.emburseLogin.url,
      updatedAt: null, updatedBy: null,
    };
  }
  return {
    sections: row.sections,
    receiptsOnly: row.receipts_only,
    // Column by column, so a row written before the schedule existed still
    // answers with sensible values rather than nulls.
    schedule: {
      timezone: row.timezone ?? fallback.timezone,
      firstRun: row.first_run ?? fallback.firstRun,
      retryHours: row.retry_hours ?? fallback.retryHours,
      attemptsPerDay: row.attempts_per_day ?? fallback.attemptsPerDay,
      graceMinutes: row.grace_minutes ?? fallback.graceMinutes,
    },
    // Defaults first, then real overrides. A stored value that is merely an
    // old default is discarded, so an improvement ships to everyone who never
    // deliberately changed that field.
    selectors: { ...DEFAULT_SELECTORS, ...liveOverrides(row.selectors) },
    emburseUrl: row.emburse_url || env.emburseLogin.url,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export async function writeSettings(
  sections: string[],
  receiptsOnly: boolean,
  schedule: Schedule,
  selectors: Record<string, string>,
  emburseUrl: string,
  updatedBy: string,
): Promise<ExportSettings> {
  await ensure();
  // Store in the dialog's own order so a round-trip never reshuffles the UI.
  const ordered = ALL_SECTIONS.filter((s) => sections.includes(s));
  // Only what actually differs from the default. Writing the whole set is what
  // froze last week's guesses into the database in the first place.
  // Reuses the read-side rule so the two cannot disagree, and so a save also
  // tidies away anything superseded rather than carrying it forever.
  const overrides = liveOverrides(selectors);
  await db().query(
    `INSERT INTO export_settings (id, sections, receipts_only, timezone, first_run,
                                  retry_hours, attempts_per_day, grace_minutes, selectors,
                                  emburse_url, updated_at, updated_by)
     VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
     ON CONFLICT (id) DO UPDATE SET
       sections = EXCLUDED.sections, receipts_only = EXCLUDED.receipts_only,
       timezone = EXCLUDED.timezone, first_run = EXCLUDED.first_run,
       retry_hours = EXCLUDED.retry_hours, attempts_per_day = EXCLUDED.attempts_per_day,
       grace_minutes = EXCLUDED.grace_minutes, selectors = EXCLUDED.selectors,
       emburse_url = EXCLUDED.emburse_url,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [ordered, receiptsOnly, schedule.timezone, schedule.firstRun, schedule.retryHours,
     schedule.attemptsPerDay, schedule.graceMinutes, JSON.stringify(overrides),
     cleanUrl(emburseUrl, env.emburseLogin.url), updatedBy],
  );
  return readSettings();
}

/** A stored schedule can be edited to nonsense; clamp rather than trust. */
export function cleanSchedule(raw: Partial<Schedule> | undefined, base: Schedule): Schedule {
  const int = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const tz = typeof raw?.timezone === "string" ? raw.timezone : base.timezone;
  return {
    // A bad zone would throw inside Intl on every request, so prove it first.
    timezone: isZone(tz) ? tz : base.timezone,
    firstRun: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw?.firstRun)) ? String(raw!.firstRun) : base.firstRun,
    retryHours: int(raw?.retryHours, 1, 12, base.retryHours),
    attemptsPerDay: int(raw?.attemptsPerDay, 1, 8, base.attemptsPerDay),
    graceMinutes: int(raw?.graceMinutes, 0, 720, base.graceMinutes),
  };
}

export function isZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare the search line printed on page 1 against what was configured.
 *
 * Returns warnings, not errors. A mismatched export is still imported: the rows
 * in it are real, and refusing them would lose data over a configuration
 * disagreement. The point is that nobody discovers the disagreement a month
 * later while wondering where half the queue went.
 */
export function checkAgainstSettings(
  header: { sections: string[]; receiptFilter: string | null } | null,
  want: ExportSettings,
  opts: { sectionsVerified?: boolean } = {},
): string[] {
  if (!header) {
    return ["Could not read the search line from page 1, so the export's scope was not checked."];
  }

  const warnings: string[] = [];
  const norm = (s: string) => s.trim().toLowerCase();
  const got = new Set(header.sections.map(norm));
  const expected = new Set(want.sections.map(norm));

  // Emburse writes "Inbox" for the default unfiltered view rather than naming
  // the sections, so it cannot be compared member by member — say so plainly
  // instead of reporting five spurious differences.
  if (got.has("inbox")) {
    // "Inbox" is what Emburse prints for the grid's own search; the export
    // dialog's section chips never appear on this line at all. So when the run
    // that produced the file already read and verified those chips, there is
    // nothing here to disagree with — and saying so anyway would put an amber
    // warning on every successful export.
    if (want.sections.length > 0 && !opts.sectionsVerified) {
      warnings.push(
        `Exported from Section: Inbox, not the ${want.sections.length} configured ` +
          `section${want.sections.length === 1 ? "" : "s"} (${want.sections.join(", ")}).`,
      );
    }
  } else {
    const missing = want.sections.filter((s) => !got.has(norm(s)));
    const extra = header.sections.filter((s) => !expected.has(norm(s)));
    if (missing.length) warnings.push(`Export is missing configured section${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
    if (extra.length) warnings.push(`Export includes unconfigured section${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}.`);
  }

  const hadReceiptFilter = /receipts?\s*:\s*true/i.test(header.receiptFilter ?? "");
  if (want.receiptsOnly && !hadReceiptFilter) {
    warnings.push("Export was not filtered to Receipts: true.");
  } else if (!want.receiptsOnly && hadReceiptFilter) {
    warnings.push("Export was filtered to Receipts: true, but that filter is switched off in settings.");
  }

  return warnings;
}


/** Stored selectors, minus any that are just a default we have since replaced. */
function liveOverrides(stored: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(stored ?? {})) {
    // A selector that no longer exists is not an override, it is litter from a
    // step that was removed. Dropping it here means retiring a step also
    // retires whatever somebody once typed into it.
    if (!(k in DEFAULT_SELECTORS)) continue;
    if (v === DEFAULT_SELECTORS[k as keyof typeof DEFAULT_SELECTORS]) continue;
    if ((SUPERSEDED_SELECTORS[k] ?? []).includes(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Only an https URL, and only its origin — paths would break every goto. */
export function cleanUrl(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    const u = new URL(raw.trim().startsWith("http") ? raw.trim() : `https://${raw.trim()}`);
    return u.protocol === "https:" ? u.origin : fallback;
  } catch {
    return fallback;
  }
}
