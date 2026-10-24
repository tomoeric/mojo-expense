import { STATES, validateSignup, type SignupInput } from "./signups.js";

/**
 * Bulk member signups, from a spreadsheet.
 *
 * ALL OR NOTHING. A file with a bad row imports nothing at all and
 * comes back saying which row and which column, for the person to fix
 * and upload again. Half-importing would be worse than it sounds: each
 * accepted row takes an RFID tag out of the pool permanently, so a
 * partial run leaves tags spent against members who are not there,
 * and no way to tell which half was done except by reading both.
 *
 * The file does not name tags. Whoever fills it in cannot know which
 * are free, and by the time they upload it some will not be — so each
 * row gets whichever tag is next, claimed one at a time (see
 * `assignAnyRfid` in `signups.ts`).
 */

/** The columns, in the order the template writes them. */
export const BULK_COLUMNS = [
  { key: "dlwContractId", header: "DLW Contract ID", required: true,
    note: "The dealer's contract reference." },
  { key: "dealNumber", header: "Deal #", required: false, note: "Optional." },
  { key: "customerId", header: "Customer ID #", required: false, note: "Optional." },
  { key: "firstName", header: "First Name", required: true, note: "" },
  { key: "lastName", header: "Last Name", required: true, note: "" },
  { key: "plateDlw", header: "Plate", required: false, note: "Optional." },
  { key: "plateState", header: "State", required: false,
    note: "Two letters, e.g. WV. Optional." },
  { key: "vehicleYear", header: "Vehicle Year", required: false, note: "Four digits. Optional." },
  { key: "vehicleMake", header: "Vehicle Make", required: false, note: "Optional." },
  { key: "vehicleModel", header: "Vehicle Model", required: false, note: "Optional." },
  { key: "vehicleColor", header: "Vehicle Color", required: false, note: "Optional." },
  {
    key: "stickerAttached", header: "Sticker Attached", required: true,
    note: "YES once the sticker is on the windshield, bottom-left, driver's side. "
      + "A row without it is not imported.",
  },
] as const;

export type BulkColumnKey = (typeof BULK_COLUMNS)[number]["key"];

/** What the download gives them: the headers, and one filled-in example. */
export function templateCsv(): string {
  const head = BULK_COLUMNS.map((c) => c.header).join(",");
  const example = [
    "0041", "00712", "C-9", "Dana", "Reyes", "ABC 1234", "WV",
    "2024", "Ford", "Bronco", "Blue", "YES",
  ].join(",");
  return `${head}\r\n${example}\r\n`;
}

export type BulkRow = {
  /** 1-based, counting the header, so it matches what the spreadsheet shows. */
  line: number;
  values: Record<BulkColumnKey, string>;
  /** Column header → what is wrong with it. */
  errors: Record<string, string>;
};

export type BulkParse = {
  ok: boolean;
  rows: BulkRow[];
  /** Problems with the FILE rather than a row — a missing column, no rows at all. */
  fileErrors: string[];
  headers: string[];
};

/**
 * Split one CSV line.
 *
 * Handles quoted fields and doubled quotes inside them, which is what
 * Excel writes the moment a value contains a comma — a vehicle colour
 * of "Blue, Metallic" would otherwise shift every later column by one
 * and produce a confident, wrong import.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
      } else { cur += c; }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

const norm = (h: string) =>
  h.replace(/^﻿/, "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Read the file and check every row.
 *
 * Nothing is written and no tag is touched. The answer is either "this
 * is all fine, here is what it says" or "here is what is wrong with
 * it" — never a partial import.
 */
export function parseBulk(text: string): BulkParse {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim() !== "");
  const fileErrors: string[] = [];

  if (lines.length === 0) {
    return { ok: false, rows: [], headers: [], fileErrors: ["That file is empty."] };
  }

  const headers = splitCsvLine(lines[0]!).map((h) => h.trim());
  const wanted = new Map(BULK_COLUMNS.map((c) => [norm(c.header), c.key]));
  const columnAt = new Map<BulkColumnKey, number>();
  headers.forEach((h, i) => {
    const key = wanted.get(norm(h));
    // First one wins, so a duplicated column does not silently shadow.
    if (key && !columnAt.has(key)) columnAt.set(key, i);
  });

  for (const c of BULK_COLUMNS) {
    if (c.required && !columnAt.has(c.key)) {
      fileErrors.push(`The file has no "${c.header}" column.`);
    }
  }
  if (lines.length < 2) fileErrors.push("The file has headers but no rows.");
  if (fileErrors.length > 0) return { ok: false, rows: [], headers, fileErrors };

  const rows: BulkRow[] = [];
  const seenPlates = new Map<string, number>();

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const values = Object.fromEntries(
      BULK_COLUMNS.map((c) => {
        const at = columnAt.get(c.key);
        return [c.key, (at === undefined ? "" : (cells[at] ?? "")).trim()];
      }),
    ) as Record<BulkColumnKey, string>;
    values.plateState = values.plateState.toUpperCase();

    /*
     * The attestation, in whatever a spreadsheet writes for "yes".
     * Anything else is NOT taken as yes — a blank, a dash or the word
     * "pending" must not be read as somebody confirming the sticker is
     * on a windshield.
     */
    const said = values.stickerAttached.trim().toLowerCase();
    const yes = ["yes", "y", "true", "1", "x", "done", "attached"].includes(said);

    // The same checks the form applies, so a file cannot put in
    // anything a person could not have typed.
    const { errors: base } = validateSignup(
      { ...values, stickerAttached: yes } as Partial<SignupInput>,
      { rfidOptional: true });

    const errors: Record<string, string> = {};
    for (const c of BULK_COLUMNS) {
      const msg = base[c.key];
      if (msg) errors[c.header] = msg;
    }
    if (values.plateState !== "" && !(STATES as readonly string[]).includes(values.plateState)) {
      errors.State = `"${values.plateState}" is not a state abbreviation.`;
    }
    if (!yes) {
      errors["Sticker Attached"] = said === ""
        ? "Required — put YES once the sticker is on the windshield."
        : `"${values.stickerAttached}" is not YES.`;
    } else {
      values.stickerAttached = "YES";
    }
    // Two rows for one plate is nearly always the same car entered
    // twice, and catching it here costs nothing while catching it
    // afterwards costs a tag.
    if (values.plateDlw !== "") {
      const seenAt = seenPlates.get(`${values.plateState}|${values.plateDlw.toUpperCase()}`);
      if (seenAt) errors.Plate = `The same plate is on row ${seenAt}.`;
      else seenPlates.set(`${values.plateState}|${values.plateDlw.toUpperCase()}`, i + 1);
    }

    rows.push({ line: i + 1, values, errors });
  }

  return { ok: rows.every((r) => Object.keys(r.errors).length === 0), rows, headers, fileErrors };
}
