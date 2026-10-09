/**
 * Rules: "when the note mentions gas, the category must be Auto Fee & Fuel".
 *
 * A rule is a question asked of every expense, not a filter. It has three
 * parts, and the middle one is what makes it a rule rather than a saved search:
 *
 *   WHEN   conditions that decide which expenses the rule is about
 *   MUST   an expectation those expenses have to meet (optional)
 *   THEN   what happens to the ones that do not meet it
 *
 * Evaluation runs in JavaScript over rows read from the database, not as
 * generated SQL. The fields and operators are a closed set either way, but a
 * rule is user-authored data and building a WHERE clause out of it is a
 * standing invitation to get that wrong once. At a few thousand expenses the
 * scan costs nothing worth protecting.
 *
 * Two things are deliberately not symmetrical:
 *
 *   - `flag` and `deny` act on the expenses that FAIL the expectation.
 *   - `approve` acts on the ones that PASS it.
 *
 * which is the only reading that makes both "deny anything from this merchant"
 * and "approve anything matching this pattern" expressible in one shape.
 */

export const FIELDS = [
  "note", "merchant", "category", "location", "department", "employee", "title",
  "amount", "method", "receipt", "receiptItems", "receiptTotal",
  "receiptAlcohol", "receiptReadable", "receiptItemised", "receiptSubstitute",
  "receiptFuel",
  "date", "receiptDate", "receiptMerchant",
  "receiptShared", "receiptSplitAddsUp",
  "dayCount", "dayTotal",
] as const;
export type Field = (typeof FIELDS)[number];

export const FIELD_LABEL: Record<Field, string> = {
  note: "Note",
  merchant: "Merchant",
  category: "Category",
  location: "Location / Site",
  department: "Department",
  employee: "Employee",
  title: "Job title",
  amount: "Amount",
  method: "Payment method",
  receipt: "Receipt",
  receiptItems: "Receipt line items",
  receiptAlcohol: "Receipt shows alcohol",
  receiptItemised: "Receipt lists what was bought",
  receiptSubstitute: "Receipt is a lost-receipt form",
  receiptFuel: "Receipt shows a fuel purchase",
  receiptReadable: "Receipt could be read",
  date: "Transaction date",
  receiptDate: "Date on the receipt",
  receiptMerchant: "Business name on the receipt",
  receiptTotal: "Receipt total (read off the image)",
  receiptShared: "Receipt is shared with other expenses",
  receiptSplitAddsUp: "The shares on that receipt add up",
  dayCount: "Matching expenses that day",
  dayTotal: "Matching total that day",
};

/**
 * The same labels, shortened for a flag.
 *
 * The editor wants "Receipt total (read off the image)" — somebody choosing a
 * field needs telling where the figure comes from. A flag does not: it is a
 * chip on a queue row, read a hundred times a day, and the parenthesis pushes
 * the two figures that matter off the end of the line. Only the labels that
 * are actually long appear here; the rest fall through.
 */
const SHORT_LABEL: Partial<Record<Field, string>> = {
  receiptTotal: "Receipt total",
  receiptShared: "Shared receipt",
  receiptSplitAddsUp: "The shares add up",
  receiptMerchant: "Receipt business name",
  receiptItems: "Receipt lines",
};

const shortLabel = (f: Field): string => SHORT_LABEL[f] ?? FIELD_LABEL[f];

/**
 * Fields that describe a GROUP rather than one expense: how many of the
 * expenses this rule matched belong to the same person on the same day, and
 * what they add up to.
 *
 * "More than three meals in a day" and "more than $75 of meals in a day" are
 * not questions a single row can answer, and they are the two most useful
 * things to ask of an expense queue. They can only appear in MUST — they are
 * computed FROM the WHEN, so putting one in the WHEN would be circular.
 */
export const GROUP_FIELDS: ReadonlySet<Field> = new Set<Field>(["dayCount", "dayTotal"]);
export const isGroupField = (f: Field): boolean => GROUP_FIELDS.has(f);

/** Count and sum of the expenses a rule matched, for one person on one day. */
export type Group = { count: number; totalCents: number };

/**
 * Fields holding money. They compare with a tolerance, because two figures for
 * the same purchase differ by a cent for reasons nobody wants to be told
 * about: rounding, a tip line, a currency conversion.
 */
const MONEY: ReadonlySet<Field> = new Set<Field>(["amount", "receiptTotal", "dayTotal"]);

/**
 * Fields holding a date. Their own kind, so "Date on the receipt is the
 * Transaction date" is offered and "Date on the receipt is the Merchant" is
 * not — a comparison that can never be true is worse than no comparison,
 * because somebody will write it and believe it.
 */
const DATES: ReadonlySet<Field> = new Set<Field>(["date", "receiptDate"]);

/**
 * Business names, which never match exactly and must not be compared as if
 * they did. Emburse prints "KENT ELECTRICAL SUPPLYKENT ELECTRICAL SUPPLY,
 * LLC" where the receipt says "Kent Electrical Supply" — an exact comparison
 * flags every expense in the queue and teaches everyone to ignore the rule.
 */
const NAMES: ReadonlySet<Field> = new Set<Field>(["merchant", "receiptMerchant"]);

/** Absolute and proportional slack before two amounts count as different. */
export const MONEY_TOLERANCE_ABS = 0.02;
export const MONEY_TOLERANCE_PCT = 0.01;

const tolerance = (a: number, b: number): number =>
  Math.max(MONEY_TOLERANCE_ABS, Math.abs(b || a) * MONEY_TOLERANCE_PCT);

/**
 * Do two money figures, in CENTS, differ by more than the slack allows?
 *
 * The same question the rules ask, exported so nothing has to ask it a
 * second way. Every place this arithmetic got written out again is a place
 * it later disagreed with the flag — the screen saying Match beside a flag
 * saying Amounts Off started exactly like that.
 */
export const centsDiffer = (aCents: number, bCents: number): boolean =>
  Math.abs(aCents - bCents) > tolerance(aCents / 100, bCents / 100) * 100;

/**
 * Which figure to treat as "the receipt total" when an expense carries
 * several receipts.
 *
 * This started as a plain sum, and the sum is what produced a flag reading
 * "Receipt total $937.32 does not equal Amount $312.44" on a $312.44 Menards
 * charge — three receipts on the expense, each for the same $312.44, added
 * together. Every duplicate attachment became a mismatch, and the flag could
 * not be argued with because it would not say where $937.32 came from.
 *
 * Deduplicating identical totals was my first answer and it was too narrow:
 * it only helps when the copies are read to the exact cent, and one page of
 * a scan read a penny out puts the expense straight back in the bucket.
 *
 * The question the rule is actually asking is whether a receipt SUBSTANTIATES
 * the charge. So:
 *
 *   - one receipt: that one, always;
 *   - several, and one of them is the charge: that one — the bill is here,
 *     whatever else was attached alongside it;
 *   - several, none of them the charge: the distinct ones added up, which is
 *     what a genuine split bill needs, and what a genuine shortfall shows.
 *
 * It cannot make an unsubstantiated claim look substantiated: every candidate
 * is a real total off a real receipt on this expense, so the only claims that
 * come out matching are ones a receipt actually covers. The direction it
 * moves in is fewer false flags, never fewer true ones.
 */
export function chosenReceiptTotal(
  amountCents: number,
  totalsCents: readonly number[],
  /**
   * The same receipts read a second way: subtotal + tax + tip, off the
   * receipt's own figures.
   *
   * A receipt can be internally inconsistent and still be perfectly honest,
   * because the print is what fails, not the purchase. A crumpled Dollar
   * Tree slip listed four items at 1.50, tax 0.37, and a smudged total that
   * read 5.37 in all three places it appeared — while 6.00 + 0.37 = 6.37 is
   * both the arithmetic and the charge. Asserting 5.37 as "the receipt
   * total" and flagging a dollar of overclaim is a confident statement
   * built on the one figure that could not be read.
   *
   * These are candidates, never a replacement: an arithmetic figure is only
   * ever preferred when it ANSWERS THE CHARGE and the printed one does not.
   * An Airline Hydraulics invoice prints Subtotal 159.61 with tax already in
   * it and a Stripe payment of 159.61 — arithmetic says 171.44, and it is
   * wrong. The charge decides between them, which is the only thing that
   * can.
   */
  arithmeticCents: readonly number[] = [],
): number | null {
  if (totalsCents.length === 0) return null;

  // A REFUND prints as a positive total against a negative charge.
  //
  // Best Buy: "RETURN" at the top, three items handed back, "Total 136.36",
  // "REFUND AMEX 136.36" — and the expense is a credit of -$136.36. Harbor
  // Freight the same, at -$108.49. The receipt and the charge are the same
  // transaction seen from the two ends of it, and both were being reported
  // as "Receipt total $136.36 does not equal Amount $-136.36", which is
  // true as arithmetic and wrong about the world. The reader had even
  // written "this is a return receipt" in its notes.
  //
  // One direction only. A CREDIT may be answered by a positive receipt,
  // because that is what a returns slip prints; a CHARGE is still compared
  // strictly, so a refund slip attached to a purchase is not waved through.
  const refund = amountCents < 0;
  const answers = (c: number): boolean =>
    refund ? !centsDiffer(Math.abs(c), Math.abs(amountCents)) : !centsDiffer(c, amountCents);
  /** Signed the way the charge is, once it is established they are the same. */
  const asCharged = (c: number): number => (refund ? -Math.abs(c) : c);

  /** An arithmetic reading that answers the charge, when nothing else did. */
  const byArithmetic = (): number | null => {
    for (const c of arithmeticCents) if (answers(c)) return asCharged(c);
    return null;
  };

  if (totalsCents.length === 1) {
    const only = totalsCents[0]!;
    if (answers(only)) return asCharged(only);
    return byArithmetic() ?? only;
  }

  // The CLOSEST candidate within tolerance, not the first one found. Two
  // scans of one bill can read a penny apart, and picking whichever the sort
  // happened to put first made the figure on the flag depend on nothing.
  let covers: number | null = null;
  for (const c of totalsCents) {
    if (!answers(c)) continue;
    const off = Math.abs(Math.abs(c) - Math.abs(amountCents));
    if (covers === null || off < Math.abs(Math.abs(covers) - Math.abs(amountCents))) covers = c;
  }
  if (covers !== null) return asCharged(covers);

  const arithmetic = byArithmetic();
  if (arithmetic !== null) return arithmetic;

  let sum = 0;
  for (const c of new Set(totalsCents)) sum += c;
  return sum;
}

/**
 * Fields holding a figure rather than words. The value typed against one of
 * these has to parse as a number or the rule cannot mean anything.
 */
const NUMERIC: ReadonlySet<Field> = new Set<Field>([...MONEY, "dayCount"]);

/**
 * A number as somebody actually types it into a money field.
 *
 * `Number("$75.00")` is NaN, and a rule whose expectation is NaN fails every
 * comparison it makes — so "flag a day totalling more than $75" flagged all
 * 116 matching expenses, including a $10 breakfast, and the reason was
 * invisible: the rule read correctly on screen and the preview counted
 * confidently. A dollar sign is the obvious thing to type in a field labelled
 * "Matching total that day"; the engine reads it rather than the person
 * having to know not to write it. Commas and stray spaces go the same way.
 *
 * Null means it is not a number at all, which is caught at save time by
 * `problems()` and treated as unjudgeable at run time — never as a failure.
 */
export function numberValue(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Which fields a given field can be compared against.
 *
 * Same kind only. "Merchant is more than Amount" is not a question, and an
 * editor that offers it invites a rule that can never be true.
 */
/** Which of the three kinds a field belongs to; only like compares with like. */
const kindOf = (f: Field): string =>
  MONEY.has(f) ? "money" : DATES.has(f) ? "date" : NAMES.has(f) ? "name" : "text";

export function comparableTo(field: Field): Field[] {
  // A group figure against another column is not a question anybody asks, and
  // offering it would invite a rule that can never mean anything. That holds
  // in both directions: a group figure is no good as the TARGET either, because
  // the only place a group can be judged at all is MUST, and a WHEN row that
  // compares against one would quietly match nothing.
  if (field === "receipt" || isGroupField(field)) return [];
  if (YES_NO.has(field)) return [];
  return FIELDS.filter(
    (f) =>
      f !== field && f !== "receipt" && !isGroupField(f) && !YES_NO.has(f) &&
      kindOf(f) === kindOf(field),
  );
}

/** Fields whose values come from a permanent list, so the UI offers a dropdown. */
/** Fields whose values are a fixed yes/no, so the UI offers exactly those. */
export const YES_NO: ReadonlySet<Field> = new Set<Field>(
  ["receiptAlcohol", "receiptReadable", "receiptItemised", "receiptSubstitute",
   "receiptFuel", "receiptShared", "receiptSplitAddsUp"]);

/** Fields whose empty value is "not known", never "blank". See `holds`. */
const UNKNOWN_WHEN_EMPTY = new Set<Field>(["title"]);

export const FIELD_LIST: Partial<Record<Field, "category" | "location" | "department">> = {
  category: "category",
  location: "location",
  department: "department",
};

export const OPS = [
  "contains", "not_contains", "is", "is_not", "starts_with",
  "gt", "lt", "gte", "lte", "is_blank", "is_not_blank",
] as const;
export type Op = (typeof OPS)[number];

export const OP_LABEL: Record<Op, string> = {
  contains: "contains",
  not_contains: "does not contain",
  is: "is",
  is_not: "is not",
  starts_with: "starts with",
  gt: "is more than",
  lt: "is less than",
  // "at most 3" is how a limit is actually spoken. Expressing it as "less than
  // 4" is the sort of off-by-one somebody gets wrong once and never notices.
  gte: "is at least",
  lte: "is at most",
  is_blank: "is blank",
  is_not_blank: "is not blank",
};

/**
 * How an operator reads for a given field.
 *
 * "is" is fine for a category and ambiguous for money — nobody asks whether an
 * amount "is" another amount, they ask whether it equals it. The wording is
 * per-field for that reason, and it is the server's answer rather than the
 * editor's so the rule reads the same everywhere it is printed.
 */
export function opLabel(field: Field, op: Op): string {
  if (YES_NO.has(field)) {
    if (op === "is_blank") return "could not be judged";
    if (op === "is_not_blank") return "was judged";
  }
  if (MONEY.has(field)) {
    if (op === "is") return "equals";
    if (op === "is_not") return "does not equal";
    if (op === "is_blank") return "was not read";
    if (op === "is_not_blank") return "was read";
  }
  return OP_LABEL[op];
}

/** Which operators make sense for a field — the UI offers only these. */
export function opsFor(field: Field): Op[] {
  if (isGroupField(field)) return ["lte", "gte", "gt", "lt", "is", "is_not"];
  // "at most" and "at least" as well as the strict pair. A group field
  // already offered all four, so somebody who wrote "Matching total that day
  // is at most $75" and then tried the same wording on Amount was told the
  // field could not be tested that way — for no reason: the comparison is
  // the same one, with the same money tolerance.
  if (field === "amount") return ["is", "is_not", "gt", "lt", "gte", "lte"];
  // Unlike Amount, this one can be absent: the receipt may not have been read,
  // or may have been unreadable. "is blank" is how you find those.
  if (field === "receiptTotal") {
    return ["is", "is_not", "gt", "lt", "gte", "lte", "is_blank", "is_not_blank"];
  }
  if (field === "receipt") return ["is_blank", "is_not_blank"];
  // Yes/no, plus a way to find the ones nobody could answer for. "is blank"
  // on these means the reader never got far enough to say — an unread
  // receipt, an unreadable one, or one with no line items on it.
  if (field === "receiptAlcohol" || field === "receiptReadable"
      || field === "receiptItemised" || field === "receiptSubstitute"
      || field === "receiptFuel") {
    return ["is", "is_not", "is_blank", "is_not_blank"];
  }
  // A date is not a string to search inside. ISO dates sort lexically, so
  // before/after fall out of the same comparison as equality.
  if (DATES.has(field)) return ["is", "is_not", "gt", "lt", "is_blank", "is_not_blank"];
  return ["contains", "not_contains", "is", "is_not", "starts_with", "is_blank", "is_not_blank"];
}

export const ACTIONS = ["flag", "approve", "deny"] as const;
export type Action = (typeof ACTIONS)[number];

export type Condition = {
  field: Field;
  op: Op;
  value: string;
  /**
   * Compare against another field instead of `value`.
   *
   * This is what makes "the receipt's own total must equal the amount claimed"
   * expressible — the check that matters most on an expense queue, and the one
   * a field-against-a-constant rule can never state.
   */
  compare?: Field | null;
};

export type RuleBody = {
  name: string;
  enabled: boolean;
  /** Whether every WHEN condition has to hold, or any one of them. */
  match: "all" | "any";
  when: Condition[];
  /** The expectation. Null means "every expense the WHEN matches is an offender". */
  must: Condition | null;
  action: Action;
  /** Shown on the flag, and used as the reason on a denial. */
  message: string;
};

/** One expense, in the shape a rule sees it. */
export type Subject = {
  dedupeKey: string;
  employee: string;
  /**
   * The person's job title, from the directory — "" when unknown.
   *
   * Not from the expense: an export says who spent the money and in
   * which department, neither of which is what somebody's job is. The
   * empty string is "we could not match this name", and the engine
   * treats an empty text field as unanswerable, so no rule fires either
   * way on it.
   */
  title: string;
  merchant: string;
  note: string;
  category: string;
  location: string;
  department: string;
  method: string;
  amountCents: number;
  hasReceipt: boolean;
  /** Every line item read off the attached receipts, joined. */
  receiptItems: string;
  /**
   * Whether any line the reader saw is an alcoholic drink.
   *
   * Null when nothing has been read — no receipt, an unread one, or a
   * receipt that lists no items at all. Null is "cannot say", never "no
   * alcohol": treating an unreadable bar tab as clean is the exact mistake
   * this field exists to avoid.
   */
  receiptAlcohol: boolean | null;
  /**
   * Does the receipt say WHAT was bought, or only what it cost?
   *
   * Distinct from readable, which folds this in: a card slip or an order
   * summary reading "1 Item $141.24" is perfectly legible and itemises
   * nothing. Null when nothing has been read, so "cannot say" never reads
   * as "no".
   */
  receiptItemised: boolean | null;
  /**
   * Is the "receipt" a lost-receipt form rather than a receipt?
   *
   * An affidavit or declaration the employee filled in themselves. It is
   * not weak evidence of a purchase, it is the employee's word for it,
   * which is the thing a reviewer is meant to decide about.
   */
  receiptSubstitute: boolean | null;
  /**
   * Is there EVIDENCE the purchase was fuel — on the receipt, or in the
   * merchant's name?
   *
   * Deliberately not the note. A note is the submitter's words ABOUT a
   * purchase: "gas powered pressure washer", "gas line repair", "gas
   * grill" all say gas and none is fuel. A rule that asks the note alone
   * flagged a cleaning supplier's invoice for two foam tires.
   */
  receiptFuel: boolean | null;
  /**
   * Whether the reader got anything usable off the image — legible AND
   * itemised. False is the honest answer to "is there alcohol on this?" being
   * unanswerable, and is worth a human look in its own right.
   */
  receiptReadable: boolean | null;
  /** The date printed on the receipt, YYYY-MM-DD, or null when unread. */
  receiptDate: string | null;
  /** The business name printed on the receipt, or "" when unread. */
  receiptMerchant: string;
  /**
   * The total read off the receipt image, in cents — null when no receipt has
   * been read, which is NOT the same as zero and must never be treated as a
   * mismatch.
   */
  receiptTotalCents: number | null;
  /**
   * Every receipt total on this expense, individually, smallest first.
   *
   * `receiptTotalCents` is one number chosen from these — see
   * `chosenReceiptTotal`. The list is kept so a flag can show its working,
   * because "does not equal" on a figure nobody can account for is not a
   * finding, it is a riddle.
   */
  receiptTotalsCents: number[];
  /**
   * How many expenses share this expense's receipt image, itself included.
   *
   * One means it is nobody else's. More means a purchase was divided —
   * lunch for seven sites on one card, the same image on all seven.
   */
  receiptSharedWith: number;
  /**
   * Whether those shares add up to the receipt. Null when it is not shared,
   * so "no" keeps its meaning: a split that does NOT reconcile.
   */
  receiptSplitAddsUp: boolean | null;
  /**
   * Whether this expense counts towards its owner's own day.
   *
   * False for a reconciling receipt split across several sites: that is
   * food bought FOR sites, and counting it as one person's lunch is what
   * made "7 meals, $86.60" out of one purchase.
   */
  countsTowardsDay: boolean;
  inInbox: boolean;
  /** The expense's own date, and what a receipt's date is checked against. */
  date: string | null;
};

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * A business name reduced to something two printings of it can agree on.
 *
 * Emburse doubles the name and appends the legal form; a receipt prints the
 * trading name with a store number. Punctuation, the suffix, digits and
 * repetition all go, and a doubled string collapses back to one copy — so
 * "KENT ELECTRICAL SUPPLYKENT ELECTRICAL SUPPLY, LLC" and "Kent Electrical
 * Supply" end up the same.
 */
export function nameKey(raw: string): string {
  let t = raw.toLowerCase()
    // Apostrophes VANISH rather than becoming a space. Turning "lowe's"
    // into "lowe s" stopped it matching "lowes", and "weigel's" into
    // "weigel s" against "weigels" — a rule comparing the receipt's
    // business name to Emburse's flagged 56 of 163 expenses, and the
    // apostrophe alone accounted for a good share of them.
    .replace(/['\u2019\u02bc`]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    // Digits glued to letters are two tokens, not one. Emburse writes
    // "#1797LOWES COMPANIES" and "221LOWES", and the digit-stripping below
    // only removes runs standing on their own — so "1797lowes" survived
    // whole and matched nothing.
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/\b(llc|inc|incorporated|corp|corporation|co|ltd|limited|lp|llp|plc|the)\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Emburse's doubled name: exactly the same text twice, back to back.
  const half = t.length / 2;
  if (t.length > 6 && t.length % 2 === 0 && t.slice(0, half) === t.slice(half)) t = t.slice(0, half);
  const doubled = t.match(/^(.+?) \1$/);
  if (doubled) t = doubled[1]!;
  return t;
}

/**
 * Do two printings of a business name describe the same business?
 *
 * Equality and containment are not enough once BOTH sides carry words the
 * other lacks: the receipt says "Lowe's Home Centers, LLC" and Emburse says
 * "LOWES OF TEMPLE #221LOWES COMPANIES INC" — same shop, neither string
 * inside the other. Likewise "McDonald's Restaurant #6218" against
 * "MCDONALD'S- 6218FARIS PROPERTIES", where the franchisee's name is the
 * only thing Emburse prints.
 *
 * So a shared distinctive word counts. Four characters or more, which keeps
 * "of", "the" and stray initials out of it, and the corporate suffixes are
 * already gone by the time this sees the tokens.
 *
 * This is deliberately generous, because the cost either way is not
 * symmetric. Too strict and the rule flags a hundred and fifty expenses
 * that are perfectly fine, which is how a flag gets ignored. Too loose and
 * a mismatch goes unflagged — and the expense is still sitting in the queue
 * in front of a person, which is where it was anyway.
 */
export function sameBusiness(a: string, b: string): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const words = (t: string) => new Set(t.split(" ").filter((w) => w.length >= 4));
  const mine = words(x);
  for (const w of words(y)) if (mine.has(w)) return true;
  return false;
}

/** Null when there is no figure — an unread receipt, or a group not yet counted. */
function numberOf(subject: Subject, field: Field, group?: Group): number | null {
  if (field === "amount") return subject.amountCents / 100;
  if (field === "receiptTotal") {
    return subject.receiptTotalCents === null ? null : subject.receiptTotalCents / 100;
  }
  if (field === "dayCount") return group ? group.count : null;
  if (field === "dayTotal") return group ? group.totalCents / 100 : null;
  return null;
}

function textOf(subject: Subject, field: Field): string {
  switch (field) {
    case "note": return subject.note;
    case "merchant": return subject.merchant;
    case "category": return subject.category;
    case "location": return subject.location;
    case "department": return subject.department;
    case "employee": return subject.employee;
    /*
     * Empty when we do not know it, and that is load-bearing.
     *
     * An empty text field makes a condition "cannot say" (see below),
     * so a rule reading "title is not Store Manager → deny" skips the
     * people it could not match rather than denying them. For an
     * unattended denial that is the only acceptable way to fail.
     */
    case "title": return subject.title;
    case "method": return subject.method;
    case "receiptItems": return subject.receiptItems;
    case "receipt": return subject.hasReceipt ? "receipt" : "";
    // Rendered as yes/no so a rule reads "Receipt shows alcohol is yes".
    // Null stays empty, which no comparison matches — an unknown never fires.
    case "receiptAlcohol":
      return subject.receiptAlcohol === null ? "" : subject.receiptAlcohol ? "yes" : "no";
    case "receiptItemised":
      return subject.receiptItemised === null ? "" : subject.receiptItemised ? "yes" : "no";
    case "receiptSubstitute":
      return subject.receiptSubstitute === null ? "" : subject.receiptSubstitute ? "yes" : "no";
    case "receiptFuel":
      return subject.receiptFuel === null ? "" : subject.receiptFuel ? "yes" : "no";
    case "receiptReadable":
      return subject.receiptReadable === null ? "" : subject.receiptReadable ? "yes" : "no";
    case "receiptShared": return subject.receiptSharedWith > 1 ? "yes" : "no";
    case "receiptSplitAddsUp":
      return subject.receiptSplitAddsUp === null ? "" : subject.receiptSplitAddsUp ? "yes" : "no";
    case "date": return subject.date ?? "";
    case "receiptDate": return subject.receiptDate ?? "";
    case "receiptMerchant": return subject.receiptMerchant;
    case "amount": return (subject.amountCents / 100).toFixed(2);
    case "receiptTotal":
      return subject.receiptTotalCents === null ? "" : (subject.receiptTotalCents / 100).toFixed(2);
    // Only meaningful with a group, which textOf has no access to. Group
    // fields are numeric and never reach the text path.
    case "dayCount":
    case "dayTotal":
      return "";
  }
}

/** What the right-hand side of a condition is: another field, or a literal. */
function rightHandSide(subject: Subject, c: Condition): { text: string; number: number | null } {
  if (c.compare) {
    return { text: textOf(subject, c.compare), number: numberOf(subject, c.compare) };
  }
  return { text: c.value, number: numberValue(c.value) };
}

/**
 * Judge one condition.
 *
 * Returns **null when it cannot be judged** — a receipt total that has not been
 * read yet, most of the time. That third state is the whole reason this is not
 * a boolean: treating an unread receipt as "does not match the amount" would
 * flag every expense in the queue the moment somebody wrote the rule, and the
 * rule would look right while being worse than useless.
 */
export function test(subject: Subject, c: Condition, group?: Group): boolean | null {
  const numeric = c.field === "amount" || c.field === "receiptTotal" || isGroupField(c.field);

  if (numeric) {
    const got = numberOf(subject, c.field, group);

    // Blankness is knowable even when the figure is not, and "the receipt
    // could not be read" is a rule worth being able to write.
    if (c.op === "is_blank") return got === null;
    if (c.op === "is_not_blank") return got !== null;
    if (got === null) return null;

    const rhs = rightHandSide(subject, c);
    // A right-hand side that is not a number cannot be compared with one.
    // That is UNKNOWN, not "failed": returning false here meant a rule with a
    // mistyped figure flagged every expense it matched, loudly and wrongly,
    // rather than doing nothing while the editor complained.
    if (rhs.number === null) return null;
    const want = rhs.number;
    const slack = MONEY.has(c.field) ? tolerance(got, want) : 0.005;

    switch (c.op) {
      case "gt": return got > want;
      case "lt": return got < want;
      case "gte": return got >= want - slack;
      case "lte": return got <= want + slack;
      case "is": return Math.abs(got - want) <= slack;
      case "is_not": return Math.abs(got - want) > slack;
      default: return false;
    }
  }

  // Dates: ISO strings order correctly as text, so before/after and equality
  // are one comparison. Handled apart from the text path so "contains" and
  // friends never reach a date, and so a missing one is UNKNOWN rather than
  // an empty string that compares unequal to everything.
  if (DATES.has(c.field)) {
    const mine = textOf(subject, c.field);
    if (c.op === "is_blank") return mine === "";
    if (c.op === "is_not_blank") return mine !== "";
    if (mine === "") return null;
    const other = rightHandSide(subject, c).text.trim();
    if (other === "") return c.compare ? null : false;
    switch (c.op) {
      case "is": return mine === other;
      case "is_not": return mine !== other;
      case "gt": return mine > other;
      case "lt": return mine < other;
      default: return false;
    }
  }

  // Business names never match exactly. Emburse prints "KENT ELECTRICAL
  // SUPPLYKENT ELECTRICAL SUPPLY, LLC" where the receipt says "Kent
  // Electrical Supply", so comparing two name fields as strings marks the
  // whole queue as mismatched. Compared loosely only when BOTH sides are
  // names — "Merchant is 'Walmart'" typed by hand stays exact.
  if (c.compare && NAMES.has(c.field) && NAMES.has(c.compare)) {
    const mineRaw = textOf(subject, c.field);
    const otherRaw = textOf(subject, c.compare);
    if (!nameKey(mineRaw) || !nameKey(otherRaw)) return null;
    const same = sameBusiness(mineRaw, otherRaw);
    if (c.op === "is") return same;
    if (c.op === "is_not") return !same;
  }

  // A yes/no the reader could not answer is UNKNOWN, not "no". Falling
  // through to the text path would compare "" against "yes" and return false,
  // which reads as "there is no alcohol on this receipt" — the exact claim
  // this field must never make about a receipt nobody could read.
  if (YES_NO.has(c.field)) {
    const known = textOf(subject, c.field) !== "";
    if (c.op === "is_blank") return !known;
    if (c.op === "is_not_blank") return known;
    if (!known) return null;
  }

  /*
   * Fields where EMPTY means "we could not find out", not "it is blank".
   *
   * A note can genuinely be empty, and "note is not X" matching it is
   * right. A job title cannot: an empty one means the name did not match
   * the directory, and "title is not Store Manager" matching that person
   * is this app concluding something about somebody it never found.
   *
   * It came within one test of mattering. The rule this field was built
   * for is "corporate title → DENY", and the inverse — "not a store
   * title → deny" — would have denied every unmatched person in the
   * queue, unattended, with a reason the employee reads. Unknown has to
   * mean unknown in both directions.
   *
   * is_blank and is_not_blank still answer, and on this field they ask a
   * useful question of their own: do we know what this person does?
   */
  if (UNKNOWN_WHEN_EMPTY.has(c.field)) {
    const known = textOf(subject, c.field) !== "";
    if (c.op === "is_blank") return !known;
    if (c.op === "is_not_blank") return known;
    if (!known) return null;
  }

  const got = norm(textOf(subject, c.field));
  const rhs = rightHandSide(subject, c);
  const want = norm(rhs.text);

  switch (c.op) {
    case "is_blank": return got === "";
    case "is_not_blank": return got !== "";
    // A blank value would match everything, which is never what was meant and
    // is how a half-finished rule quietly starts approving the whole queue.
    case "contains": return want !== "" && got.includes(want);
    case "not_contains": return want !== "" && !got.includes(want);
    case "is": return want !== "" && got === want;
    case "is_not": return want !== "" && got !== want;
    case "starts_with": return want !== "" && got.startsWith(want);
    default: return false;
  }
}

/**
 * Does this rule apply to this expense at all?
 *
 * A condition that cannot be judged does not match. Erring the other way would
 * pull every unread receipt into every rule's scope.
 */
export function applies(subject: Subject, rule: RuleBody): boolean {
  if (rule.when.length === 0) return false;
  return rule.match === "any"
    ? rule.when.some((c) => test(subject, c) === true)
    : rule.when.every((c) => test(subject, c) === true);
}

export type Verdict = "not-applicable" | "pass" | "fail";

export function evaluate(subject: Subject, rule: RuleBody, group?: Group): Verdict {
  if (!applies(subject, rule)) return "not-applicable";
  if (!rule.must) return "fail";
  const met = test(subject, rule.must, group);
  // Unknown is not failure. An expectation nobody can check yet — a receipt
  // waiting to be read — earns no verdict at all, so no flag, no denial, and
  // no approval either.
  if (met === null) return "not-applicable";
  return met ? "pass" : "fail";
}

/** Whether the rule's action should fire, given the verdict. */
export function fires(verdict: Verdict, action: Action): boolean {
  if (verdict === "not-applicable") return false;
  // approve rewards compliance; flag and deny punish its absence. With no
  // expectation every match is a "fail", so an approve rule needs one.
  return action === "approve" ? verdict === "pass" : verdict === "fail";
}

const shown = (subject: Subject, field: Field, group?: Group): string => {
  if (field === "dayCount") return group ? String(group.count) : "(not counted)";
  const n = numberOf(subject, field, group);
  if (n !== null) return `$${n.toFixed(2)}`;
  return textOf(subject, field) || "(blank)";
};

/**
 * One condition, written out with the figures it actually saw.
 *
 * "Receipt total (read off the image) $28.36 does not equal Amount $14.18" —
 * the two numbers, side by side, in the rule's own words. What this replaces
 * is a flag that said only `Matches “Amounts Off”.` on an expense whose
 * receipt and charge were both $14.18 on screen, which reads as the app being
 * broken. It was not: the expense carried the same bill twice and the rule
 * had added them up. A flag that shows its arithmetic says that in one line;
 * a flag that only names itself sends somebody to the source code.
 */
function said(subject: Subject, c: Condition, group?: Group): string {
  const label = shortLabel(c.field);
  const op = opLabel(c.field, c.op);
  if (c.op === "is_blank" || c.op === "is_not_blank") return `${label} ${op}`;
  const mine = shown(subject, c.field, group);
  const theirs = c.compare
    ? `${shortLabel(c.compare)} ${shown(subject, c.compare, group)}`
    : `“${c.value}”`;
  return `${label} ${mine} ${op} ${theirs}`;
}

/**
 * Where the receipt total came from, when it came from more than one place.
 *
 * Silent for the ordinary single-receipt expense. Appended to any flag that
 * names the receipt total otherwise, because the alternative is a figure the
 * reviewer cannot account for and cannot check — which is how $937.32 stood
 * unchallenged on a $312.44 charge.
 */
function receiptsBehind(subject: Subject, rule: RuleBody): string {
  const totals = subject.receiptTotalsCents;
  if (totals.length < 2) return "";
  const mentions = (c: Condition | null) =>
    c !== null && (c.field === "receiptTotal" || c.compare === "receiptTotal");
  if (!rule.when.some(mentions) && !mentions(rule.must)) return "";
  const each = totals.map((c) => `$${(c / 100).toFixed(2)}`).join(", ");
  return ` This expense carries ${totals.length} receipts: ${each}.`;
}

/** What the reviewer is told, in the rule's own terms. */
export function explain(subject: Subject, rule: RuleBody, group?: Group): string {
  if (rule.message.trim()) return rule.message.trim();
  // A rule with no expectation flags everything its WHEN matches, so the WHEN
  // *is* the finding. Say which parts of it matched, and on what figures.
  if (!rule.must) {
    const matched = rule.when.filter((c) => test(subject, c, group) === true);
    if (matched.length === 0) return `Matches “${rule.name}”.`;
    return `${matched.map((c) => said(subject, c, group)).join(" and ")}.`
      + receiptsBehind(subject, rule);
  }
  const got = shown(subject, rule.must.field, group);

  // A field-against-a-field mismatch reads best as the two figures side by
  // side — "$43.57 against $39.88" says more than either half alone.
  if (rule.must.compare) {
    return `Expected ${shortLabel(rule.must.field)} ${opLabel(rule.must.field, rule.must.op)} ` +
      `${shortLabel(rule.must.compare)}, but found ${got} against ` +
      `${shown(subject, rule.must.compare, group)}.` + receiptsBehind(subject, rule);
  }
  return `${shortLabel(rule.must.field)} ${opLabel(rule.must.field, rule.must.op)} ` +
    `${rule.must.value ? `“${rule.must.value}”` : ""} was expected — found “${got}”.`
    + receiptsBehind(subject, rule);
}

/**
 * The opposite of each operator, for saying what a rule CATCHES.
 *
 * `starts_with` has no inverse in the set, so it is worded rather than mapped.
 */
const NEGATE: Partial<Record<Op, Op>> = {
  contains: "not_contains", not_contains: "contains",
  is: "is_not", is_not: "is",
  gt: "lte", lte: "gt", lt: "gte", gte: "lt",
  is_blank: "is_not_blank", is_not_blank: "is_blank",
};

/** How a condition reads when it FAILS, which is what an action acts on. */
function failLabel(field: Field, op: Op): string {
  if (op === "starts_with") return "does not start with";
  const opposite = NEGATE[op];
  return opposite ? opLabel(field, opposite) : `is not ${opLabel(field, op)}`;
}

/**
 * One line saying what a rule does, phrased as what it CATCHES.
 *
 * Not as what it requires. The old wording — "Matching total that day is more
 * than 75 — otherwise flag it" — reads to any normal person as "flag anything
 * over 75", when it means the exact opposite: flag everything at or under.
 * Two real rules were written backwards that way and between them caught 204
 * expenses out of a queue of 126, because the summary agreed with the
 * mistaken reading instead of contradicting it.
 *
 * Said as the catch, a correct rule reads plainly ("flags meals where the
 * day's total is more than 75") and an inverted one reads absurd — which is
 * the point. The sentence has to disagree with you when you are wrong.
 */
export function summarise(rule: RuleBody): string {
  const cond = (c: Condition) =>
    c.op === "is_blank" || c.op === "is_not_blank"
      ? `${FIELD_LABEL[c.field]} ${opLabel(c.field, c.op)}`
      : c.compare
        ? `${FIELD_LABEL[c.field]} ${opLabel(c.field, c.op)} ${FIELD_LABEL[c.compare]}`
        : `${FIELD_LABEL[c.field]} ${opLabel(c.field, c.op)} “${c.value}”`;

  /** The MUST as a reviewer meets it: the thing that went wrong. */
  const failed = (c: Condition) =>
    c.op === "is_blank" || c.op === "is_not_blank"
      ? `${FIELD_LABEL[c.field]} ${failLabel(c.field, c.op)}`
      : c.compare
        ? `${FIELD_LABEL[c.field]} ${failLabel(c.field, c.op)} ${FIELD_LABEL[c.compare]}`
        : `${FIELD_LABEL[c.field]} ${failLabel(c.field, c.op)} “${c.value}”`;

  const when = rule.when.map(cond).join(rule.match === "any" ? " or " : " and ");

  // Approve acts on the ones that PASS, so it is the one action that reads
  // correctly as a requirement rather than as a catch.
  if (rule.action === "approve") {
    return rule.must
      ? `Approves an expense where ${when} and ${cond(rule.must)}.`
      : `Approves every expense where ${when}.`;
  }
  const verb = rule.action === "deny" ? "Denies" : "Flags";
  return rule.must
    ? `${verb} an expense where ${when}, and ${failed(rule.must)}.`
    : `${verb} every expense where ${when}.`;
}

/** Everything wrong with a rule, in sentences. Empty means it is usable. */
export function problems(rule: RuleBody): string[] {
  const out: string[] = [];
  if (!rule.name.trim()) out.push("A rule needs a name.");
  if (rule.when.length === 0) out.push("A rule needs at least one condition.");

  const needsValue = (c: Condition) =>
    c.op !== "is_blank" && c.op !== "is_not_blank" && !c.compare;

  // Each complaint says WHICH row it is about. A rule has two places a
  // condition can sit and they look alike on screen; "“Category is” needs a
  // value" with no location sends you hunting through the form for a row that
  // is right there under MUST.
  const rows: Array<{ c: Condition; where: "WHEN" | "MUST" }> = [
    ...rule.when.map((c) => ({ c, where: "WHEN" as const })),
    ...(rule.must ? [{ c: rule.must, where: "MUST" as const }] : []),
  ];

  for (const { c, where } of rows) {
    const at = `${where}: `;
    if (needsValue(c) && !c.value.trim()) {
      // For a flag or deny rule the × is often the right answer rather than
      // the fallback, and the old wording did not say so. Every new rule
      // arrives with a MUST row, so "flag anything where the receipt shows
      // alcohol" — a rule that is complete at the WHEN — cannot be saved
      // until somebody works out that the row is optional. That is the
      // second time "why can't I save this" has meant exactly this.
      const removable = where === "MUST" && rule.action !== "approve";
      out.push(
        `${at}“${FIELD_LABEL[c.field]} ${opLabel(c.field, c.op)}” needs a value — pick one, ` +
        (removable
          ? `or remove the row with the ×: with no MUST this rule ` +
            `${rule.action === "deny" ? "denies" : "flags"} everything ` +
            `the WHEN matches, which is all a rule like this usually needs.`
          : `or remove the row with the ×.`),
      );
    }
    // Every numeric field, not just Amount. Only Amount was checked, so
    // "$75.00" saved against "Matching total that day" without a word and
    // then matched nothing — which the engine turned into flagging
    // everything. A dollar sign now parses; genuine nonsense is refused here,
    // at the one moment somebody can fix it.
    if (NUMERIC.has(c.field) && needsValue(c) && c.value.trim() !== "" &&
        numberValue(c.value) === null) {
      out.push(`${at}“${c.value}” is not ${MONEY.has(c.field) ? "an amount" : "a number"}.`);
    }
    if (!opsFor(c.field).includes(c.op)) {
      out.push(`${at}${FIELD_LABEL[c.field]} cannot be tested with “${opLabel(c.field, c.op)}”.`);
    }
    if (isGroupField(c.field) && where === "WHEN") {
      out.push(
        `${at}“${FIELD_LABEL[c.field]}” can only be used in MUST — it counts the expenses the WHEN picked, ` +
          `so putting it in the WHEN would be circular.`,
      );
    }
    if (c.compare) {
      if (c.op === "is_blank" || c.op === "is_not_blank") {
        out.push(`${at}“${opLabel(c.field, c.op)}” does not take another column to compare with.`);
      } else if (!comparableTo(c.field).includes(c.compare)) {
        out.push(`${at}${FIELD_LABEL[c.field]} cannot be compared with ${FIELD_LABEL[c.compare]}.`);
      }
    }
  }

  // An approve rule with no expectation approves everything it matches. That
  // is legitimate ("anything from this merchant") but it is never an accident
  // worth allowing silently, so it has to be said out loud in the message.
  if (rule.action === "approve" && !rule.must && !rule.message.trim()) {
    out.push("An approve rule with no “must” approves every expense it matches — say why in the message.");
  }
  if (rule.action === "deny" && rule.message.trim().length < 3) {
    out.push("A deny rule needs a message: it becomes the reason the employee is shown.");
  }
  return out;
}
