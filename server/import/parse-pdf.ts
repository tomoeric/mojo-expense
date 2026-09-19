import * as mupdf from "mupdf";

/**
 * Parses the Emburse Spend "Expenses" PDF export.
 *
 * The file is a Chromium print of a web table and has two halves:
 *
 *   pages 1..N   the expense table, five columns at fixed x positions
 *   pages N+1..  one page per receipt image, captioned with employee,
 *                merchant, amount and date
 *
 * Reading order is useless here — the columns interleave — so rows are
 * reconstructed from geometry. Three things make that reliable, and each was
 * established by reconciling the parsed total against the total printed on
 * the PDF itself:
 *
 *   - Every row's Expense cell ENDS with a "M/D/YYYY · …" line, which is the
 *     only dependable row delimiter (the avatar is vertically centred, so it
 *     drifts; row height varies with the number of description lines).
 *   - Amounts are RIGHT-aligned, so a wide figure starts further left than a
 *     narrow one. The amount band must reach back far enough or four-figure
 *     expenses vanish silently.
 *   - Every page after the first repeats the column header, so the "skip the
 *     header" cutoff has to be found per page, not hard-coded.
 */

export type ParsedExpense = {
  employee: string;
  merchant: string;
  note: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  method: string;
  receiptLabel: string;
  location: string;
  department: string;
  category: string;
  /** Integer cents — never a float, so sums reconcile exactly. */
  amountCents: number;
  sourcePage: number;
};

export type ParsedReceipt = {
  /** 1-based page in the source PDF. */
  page: number;
  employee: string;
  amountCents: number;
  date: string;
};

export type ParsedExport = {
  expenses: ParsedExpense[];
  receipts: ParsedReceipt[];
  /** The TOTAL printed on page 1, for reconciliation. */
  statedTotalCents: number | null;
  pageCount: number;
};

type Line = { x: number; y: number; text: string };

const COLUMNS = {
  expense: [80, 285],
  details: [285, 388],
  category: [388, 452],
  // The receipt column holds only a 13pt icon; the amount band reaches back
  // to 484 so that wide, right-aligned figures are not clipped.
  receipt: [452, 484],
  amount: [484, 620],
} as const;

const DATE_LINE = /^(\d{1,2}\/\d{1,2}\/\d{4})\s*·\s*(.*)$/;
const RECEIPT_ONLY = /^Receipt(\s+\d+\s+of\s+\d+)?$/i;
const MONEY = /-?\$[\d,]+\.\d{2}/;

const JOINERS = new Set(["and", "or", "of", "the", "for", "in", "to", "a", "an", "with", "&"]);

export function parseExpensesPdf(data: Buffer | Uint8Array): ParsedExport {
  const doc = mupdf.Document.openDocument(data, "application/pdf");
  const pageCount = doc.countPages();

  const expenses: ParsedExpense[] = [];
  const receipts: ParsedReceipt[] = [];
  let statedTotalCents: number | null = null;
  let carry: { lines: Line[]; rest: Line[] } | null = null;

  for (let i = 0; i < pageCount; i++) {
    const lines = pageLines(doc, i);

    if (statedTotalCents === null) {
      const t = lines.find((l) => l.text.includes("TOTAL:"));
      if (t) statedTotalCents = toCents(MONEY.exec(t.text)?.[0] ?? "");
    }

    // A receipt page holds a single image and a two-line caption; the table
    // pages always carry the five-column header.
    const receipt = asReceiptPage(lines, i + 1);
    if (receipt) {
      receipts.push(receipt);
      continue;
    }

    const { rows, tail } = splitRows(lines, doc.loadPage(i).getBounds()[3]);
    rows.forEach((row, j) => {
      const merged = j === 0 && carry ? { lines: carry.lines.concat(row.lines), rest: carry.rest.concat(row.rest) } : row;
      if (j === 0) carry = null;
      expenses.push(toExpense(merged, i + 1));
    });
    carry = tail;
  }

  return { expenses, receipts, statedTotalCents, pageCount };
}

function pageLines(doc: mupdf.Document, index: number): Line[] {
  const st = JSON.parse(doc.loadPage(index).toStructuredText("preserve-whitespace").asJSON()) as {
    blocks: { type: string; lines?: { bbox: { x: number; y: number }; text: string }[] }[];
  };
  return st.blocks
    .filter((b) => b.type === "text")
    .flatMap((b) => b.lines ?? [])
    .map((l) => ({ x: l.bbox.x, y: l.bbox.y, text: l.text.trim() }))
    .filter((l) => l.text.length > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Y below which data rows begin — located per page, never assumed. */
function headerCut(lines: Line[]): number {
  const byY = new Map<number, string[]>();
  for (const l of lines) {
    const k = Math.round(l.y);
    (byY.get(k) ?? byY.set(k, []).get(k)!).push(l.text);
  }
  for (const [y, texts] of [...byY.entries()].sort((a, b) => a[0] - b[0])) {
    if (texts.includes("Expense") && texts.includes("Amount")) return y + 10;
  }
  return 50;
}

type RawRow = { lines: Line[]; rest: Line[] };

function splitRows(all: Line[], pageHeight: number): { rows: RawRow[]; tail: RawRow | null } {
  const cut = headerCut(all);
  const body = all.filter((l) => l.y >= cut);
  const expenseCol = body.filter((l) => inCol(l.x, "expense"));
  if (expenseCol.length === 0) return { rows: [], tail: null };

  const groups: Line[][] = [];
  let current: Line[] = [];
  for (const l of expenseCol) {
    current.push(l);
    if (DATE_LINE.test(l.text)) {
      groups.push(current);
      current = [];
    }
  }
  const tailLines = current;

  // Band edges sit midway between one row's last line and the next row's
  // first. The Expense cell is top-aligned but the other columns are
  // vertically centred and can start ABOVE the employee name — a fixed offset
  // clips the "Location / Site -" label and silently loses the location.
  const starts = groups.map((g) => g[0]!.y).concat(tailLines.length ? [tailLines[0]!.y] : []);
  const ends = groups.map((g) => g[g.length - 1]!.y);
  const edges = [cut];
  for (let i = 0; i + 1 < starts.length; i++) edges.push((ends[i]! + starts[i + 1]!) / 2);
  edges.push(pageHeight);

  const rows = groups.map((g, i) => ({
    lines: g,
    rest: body.filter((l) => !inCol(l.x, "expense") && l.y >= edges[i]! && l.y < edges[i + 1]!),
  }));
  const tail = tailLines.length
    ? {
        lines: tailLines,
        rest: body.filter((l) => !inCol(l.x, "expense") && l.y >= edges[groups.length]! && l.y < pageHeight),
      }
    : null;
  return { rows, tail };
}

const inCol = (x: number, name: keyof typeof COLUMNS) => x >= COLUMNS[name][0] && x < COLUMNS[name][1];

function toExpense(row: RawRow, page: number): ParsedExpense {
  const texts = row.lines.map((l) => l.text);
  const employee = texts[0] ?? "";
  let date = "";
  let method = "";
  let receiptLabel = "";
  const body: string[] = [];

  for (const t of texts.slice(1)) {
    const m = DATE_LINE.exec(t);
    if (m) {
      date = isoDate(m[1]!);
      for (const part of m[2]!.split("·").map((p) => p.trim())) {
        if (/^receipt/i.test(part)) receiptLabel ||= part;
        else if (part) method = part;
      }
    } else if (RECEIPT_ONLY.test(t)) {
      receiptLabel ||= t;
    } else {
      body.push(t);
    }
  }

  const { merchant, note } = splitMerchant(body);
  const details = unwrap(row.rest.filter((l) => inCol(l.x, "details")).map((l) => l.text));
  const amountText = row.rest.filter((l) => inCol(l.x, "amount")).map((l) => l.text).join(" ");

  return {
    employee,
    merchant,
    note,
    date,
    method,
    receiptLabel,
    location: capture(details, /Location\s*\/\s*Site\s*-\s*(.*?)(?=Department\s*-|$)/),
    department: capture(details, /Department\s*-\s*(.*?)(?=Location\s*\/\s*Site\s*-|$)/),
    category: unwrap(row.rest.filter((l) => inCol(l.x, "category")).map((l) => l.text)),
    amountCents: toCents(MONEY.exec(amountText)?.[0] ?? ""),
    sourcePage: page,
  };
}

/**
 * Separate a wrapped merchant name from the note the submitter typed.
 * Merchant names arrive in caps and wrap ("DOORDASHDOORDASH," + "INC.");
 * the note is prose.
 */
function splitMerchant(body: string[]): { merchant: string; note: string } {
  if (body.length === 0) return { merchant: "", note: "" };
  const shouty = (s: string) => {
    const letters = [...s].filter((c) => /[a-z]/i.test(c));
    return letters.length > 0 && letters.filter((c) => c === c.toUpperCase()).length / letters.length >= 0.7;
  };
  const name = [body[0]!];
  let i = 1;
  while (i < body.length && (/[,&+/-]$/.test(name[name.length - 1]!.trimEnd()) || shouty(body[i]!))) {
    name.push(body[i]!);
    i++;
  }
  return { merchant: name.join(" ").trim(), note: body.slice(i).join(" ").trim() };
}

/**
 * Rejoin wrapped column text. The narrow Category column breaks mid-word, so
 * lines cannot simply be space-joined: "Entertain"+"ment" is one word,
 * "Business License"+"and RE Permits" is not, and "Construction-in-" carries
 * its hyphen into the next line while "Travel -" does not.
 */
function unwrap(parts: string[]): string {
  if (parts.length === 0) return "";
  let out = parts[0]!;
  for (const next of parts.slice(1)) {
    const first = next.split(" ")[0]!.toLowerCase();
    let glue = " ";
    if (out.endsWith("-") && !out.endsWith(" -")) glue = "";
    else if (JOINERS.has(first)) glue = " ";
    else if (/[a-z]$/.test(out) && /^[a-z]/.test(next)) glue = "";
    out += glue + next;
  }
  return out.replace(/\s+/g, " ").trim();
}

function capture(text: string, re: RegExp): string {
  return (re.exec(text)?.[1] ?? "").replace(/\s+/g, " ").replace(/^[\s-]+|[\s-]+$/g, "");
}

/** Money → integer cents, so totals reconcile without float drift. */
function toCents(s: string): number {
  if (!s) return 0;
  const n = Number(s.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function isoDate(us: string): string {
  const [m, d, y] = us.split("/").map(Number);
  if (!m || !d || !y) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A receipt page: one image, a caption naming the employee and amount. */
function asReceiptPage(lines: Line[], page: number): ParsedReceipt | null {
  if (lines.length < 2 || lines.length > 6) return null;
  if (lines.some((l) => l.text === "Amount")) return null;
  const joined = lines.map((l) => l.text).join(" ");
  const amount = MONEY.exec(joined);
  const date = /(\d{1,2}\/\d{1,2}\/\d{4})/.exec(joined);
  if (!amount || !date || !/receipt/i.test(joined)) return null;
  return {
    page,
    employee: lines[0]!.text.trim(),
    amountCents: toCents(amount[0]),
    date: isoDate(date[1]!),
  };
}
