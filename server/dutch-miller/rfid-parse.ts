import { unzipSync, strFromU8 } from "fflate";

/**
 * Pulling RFID numbers out of a file somebody exported.
 *
 * The format is `nnnnn+nnnnnn` — five digits, a plus, six digits, eleven
 * digits in all. Everything here exists because a spreadsheet is not a
 * data format: the same list arrives quoted, padded, with a header row, as
 * one column of many, and Excel rewrites values on its way out.
 */

/** The canonical form. Everything is stored and compared like this. */
export const RFID_RE = /^\d{5}\+\d{6}$/;

export type Reading = {
  /** The canonical number, when the cell held one. */
  number: string | null;
  /** What the cell actually said, for a reject anybody has to act on. */
  raw: string;
  /** Why it was not accepted. Null when it was. */
  problem: string | null;
};

/**
 * One cell, read as forgivingly as is safe.
 *
 * Accepts the canonical form and bare eleven digits, since a system that
 * exports the number without its separator is the common case and the
 * separator carries no information. Strips the punctuation a spreadsheet
 * adds — quotes, spaces, non-breaking spaces, a dash used in place of the
 * plus — because none of it is part of the number.
 *
 * What it will NOT do is guess at a number that has lost a digit. Ten
 * digits is the signature of Excel storing the column as a number and
 * dropping a leading zero, and left-padding it back would invent an RFID
 * that may belong to a different tag. It is rejected, and the message
 * says what happened, because that is a file to re-export rather than a
 * row to fix by hand.
 */
export function readCell(raw: string): Reading {
  const text = String(raw ?? "");
  const cleaned = text
    .replace(/[ \s]/g, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/[–—-]/g, "+");
  if (!cleaned) return { number: null, raw: text, problem: null };

  if (RFID_RE.test(cleaned)) return { number: cleaned, raw: text, problem: null };

  const digits = cleaned.replace(/\+/g, "");
  if (/^\d{11}$/.test(digits)) {
    return { number: `${digits.slice(0, 5)}+${digits.slice(5)}`, raw: text, problem: null };
  }
  if (/^\d{10}$/.test(digits)) {
    return {
      number: null,
      raw: text,
      problem:
        "10 digits — a leading zero is missing. Excel does this when the column is " +
        "stored as a number. Re-export with the column formatted as text.",
    };
  }
  if (/^\d+$/.test(digits)) {
    return { number: null, raw: text, problem: `${digits.length} digits — an RFID is 11.` };
  }
  /*
   * Only cells that were TRYING to be a number are rejects.
   *
   * Every cell in the sheet is read, which is what lets somebody upload
   * an export without naming a column. The cost is that a Notes column,
   * a header row and the sheet's own title all arrive here too, and
   * reporting each of them as a problem puts a thousand lines of
   * "Not an RFID number: first" in front of the two rows that actually
   * need fixing.
   *
   * Being made ONLY of digits and the separator is the test. "RFID",
   * "Vehicle 42" and "Issued 3/4" are furniture even though two of them
   * carry a digit; "12345+6789" is a tag somebody mistyped, and that is
   * worth saying. Anything with a letter in it was never a number.
   */
  if (!/^[\d+]+$/.test(cleaned)) return { number: null, raw: text, problem: null };
  return { number: null, raw: text, problem: "Not an RFID number." };
}

/** Every cell of a CSV, quotes and embedded commas handled. */
export function csvCells(text: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  const push = () => { out.push(field); field = ""; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === "," || c === ";" || c === "\t") { push(); continue; }
    if (c === "\n") { push(); continue; }
    if (c === "\r") continue;
    field += c;
  }
  push();
  return out;
}

/**
 * Every cell of an .xlsx, as text.
 *
 * An .xlsx is a zip of XML. Only two entries matter: the shared-string
 * table, where Excel puts text it has seen before, and the sheet itself,
 * where a cell is either an index into that table (`t="s"`) or a literal.
 * Reading both and ignoring everything else — styles, formats, formulas —
 * is enough for a single column of numbers and avoids a spreadsheet
 * library for a job this small.
 *
 * Every sheet is read, not just the first. A list pasted onto "Sheet2" is
 * somebody's reasonable choice, and silently importing nothing from it is
 * the kind of empty success that wastes an afternoon.
 */
export function xlsxCells(file: Buffer): string[] {
  const zip = unzipSync(new Uint8Array(file));
  const text = (name: string): string =>
    zip[name] ? strFromU8(zip[name]!) : "";

  const shared: string[] = [];
  const sharedXml = text("xl/sharedStrings.xml");
  for (const si of sharedXml.match(/<si\b[\s\S]*?<\/si>/g) ?? []) {
    // A string can be split across runs; the cell's value is all of them.
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? "");
    shared.push(unescapeXml(parts.join("")));
  }

  const out: string[] = [];
  const sheets = Object.keys(zip)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();
  for (const name of sheets) {
    for (const cell of text(name).match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) ?? []) {
      const type = /\bt="([^"]+)"/.exec(cell)?.[1] ?? "";
      if (type === "inlineStr") {
        const parts = [...cell.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? "");
        out.push(unescapeXml(parts.join("")));
        continue;
      }
      const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cell)?.[1];
      if (v === undefined) continue;
      out.push(type === "s" ? (shared[Number(v)] ?? "") : unescapeXml(v));
    }
  }
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** An .xlsx is a zip; a CSV is not. Decided on content, never the filename. */
export function looksLikeXlsx(file: Buffer): boolean {
  return file.length > 4 && file[0] === 0x50 && file[1] === 0x4b;
}

export type ParsedFile = {
  /** Canonical numbers, in the order they appeared, duplicates included. */
  numbers: string[];
  /** Cells that looked like an attempt at a number and were not one. */
  rejected: { raw: string; problem: string }[];
  /** How many cells were looked at, for "did it read the right column". */
  cells: number;
};

/**
 * Read a whole file.
 *
 * Every cell is considered rather than one named column. A header row, a
 * second column of dates, the sheet's title — none of them look like an
 * RFID, so they fall out on their own, and the alternative is asking
 * somebody to name a column in a file they just exported.
 *
 * A blank cell is not a reject. A spreadsheet is mostly blank cells, and
 * reporting ten thousand of them buries the two that matter.
 */
export function parseRfidFile(file: Buffer): ParsedFile {
  const cells = looksLikeXlsx(file) ? xlsxCells(file) : csvCells(file.toString("utf8"));
  const numbers: string[] = [];
  const rejected: { raw: string; problem: string }[] = [];
  for (const cell of cells) {
    const read = readCell(cell);
    if (read.number) numbers.push(read.number);
    else if (read.problem) rejected.push({ raw: read.raw, problem: read.problem });
  }
  return { numbers, rejected, cells: cells.length };
}
