import { db, ensureSchema } from "../db.js";

/**
 * What the daily Emburse export is supposed to contain.
 *
 * This is not configuration the app acts on — the export is produced by a Power
 * Automate flow on a laptop that cannot read this. It is a **statement of
 * intent**, and its value is in being checked: every export PDF prints the
 * search it came from on page 1,
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
  /** Emburse Section chips expected in the export dialog. */
  sections: string[];
  /** Whether the Receipts: true filter is expected. */
  receiptsOnly: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS export_settings (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  sections     text[]      NOT NULL,
  receipts_only boolean    NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
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
  }>("SELECT sections, receipts_only, updated_at, updated_by FROM export_settings WHERE id");

  const row = rows[0];
  if (!row) {
    return { sections: DEFAULT_SECTIONS, receiptsOnly: true, updatedAt: null, updatedBy: null };
  }
  return {
    sections: row.sections,
    receiptsOnly: row.receipts_only,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export async function writeSettings(
  sections: string[],
  receiptsOnly: boolean,
  updatedBy: string,
): Promise<ExportSettings> {
  await ensure();
  // Store in the dialog's own order so a round-trip never reshuffles the UI.
  const ordered = ALL_SECTIONS.filter((s) => sections.includes(s));
  await db().query(
    `INSERT INTO export_settings (id, sections, receipts_only, updated_at, updated_by)
     VALUES (true, $1, $2, now(), $3)
     ON CONFLICT (id) DO UPDATE SET
       sections = EXCLUDED.sections, receipts_only = EXCLUDED.receipts_only,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [ordered, receiptsOnly, updatedBy],
  );
  return readSettings();
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
    if (want.sections.length > 0) {
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
