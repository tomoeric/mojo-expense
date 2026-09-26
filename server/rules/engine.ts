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
  "note", "merchant", "category", "location", "department", "employee",
  "amount", "method", "receipt", "receiptItems", "receiptTotal",
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
  amount: "Amount",
  method: "Payment method",
  receipt: "Receipt",
  receiptItems: "Receipt line items",
  receiptTotal: "Receipt total (read off the image)",
  dayCount: "Matching expenses that day",
  dayTotal: "Matching total that day",
};

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

/** Absolute and proportional slack before two amounts count as different. */
export const MONEY_TOLERANCE_ABS = 0.02;
export const MONEY_TOLERANCE_PCT = 0.01;

const tolerance = (a: number, b: number): number =>
  Math.max(MONEY_TOLERANCE_ABS, Math.abs(b || a) * MONEY_TOLERANCE_PCT);

/**
 * Which fields a given field can be compared against.
 *
 * Same kind only. "Merchant is more than Amount" is not a question, and an
 * editor that offers it invites a rule that can never be true.
 */
export function comparableTo(field: Field): Field[] {
  // A group figure against another column is not a question anybody asks, and
  // offering it would invite a rule that can never mean anything. That holds
  // in both directions: a group figure is no good as the TARGET either, because
  // the only place a group can be judged at all is MUST, and a WHEN row that
  // compares against one would quietly match nothing.
  if (field === "receipt" || isGroupField(field)) return [];
  return FIELDS.filter(
    (f) =>
      f !== field && f !== "receipt" && !isGroupField(f) && MONEY.has(f) === MONEY.has(field),
  );
}

/** Fields whose values come from a permanent list, so the UI offers a dropdown. */
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
  if (field === "amount") return ["is", "is_not", "gt", "lt"];
  // Unlike Amount, this one can be absent: the receipt may not have been read,
  // or may have been unreadable. "is blank" is how you find those.
  if (field === "receiptTotal") return ["is", "is_not", "gt", "lt", "is_blank", "is_not_blank"];
  if (field === "receipt") return ["is_blank", "is_not_blank"];
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
   * The total read off the receipt image, in cents — null when no receipt has
   * been read, which is NOT the same as zero and must never be treated as a
   * mismatch.
   */
  receiptTotalCents: number | null;
  inInbox: boolean;
  /**
   * Not a field a rule can test — carried so a decision the rule queues can
   * describe its target without a second query per expense.
   */
  date: string | null;
};

const norm = (s: string): string => s.trim().toLowerCase();

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
    case "method": return subject.method;
    case "receiptItems": return subject.receiptItems;
    case "receipt": return subject.hasReceipt ? "receipt" : "";
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
  const n = Number(c.value);
  return { text: c.value, number: Number.isFinite(n) && c.value.trim() !== "" ? n : null };
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
    if (rhs.number === null) return c.compare ? null : false;
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

/** What the reviewer is told, in the rule's own terms. */
export function explain(subject: Subject, rule: RuleBody, group?: Group): string {
  if (rule.message.trim()) return rule.message.trim();
  if (!rule.must) return `Matches “${rule.name}”.`;
  const got = shown(subject, rule.must.field, group);

  // A field-against-a-field mismatch reads best as the two figures side by
  // side — "$43.57 against $39.88" says more than either half alone.
  if (rule.must.compare) {
    return `Expected ${FIELD_LABEL[rule.must.field]} ${opLabel(rule.must.field, rule.must.op)} ` +
      `${FIELD_LABEL[rule.must.compare]}, but found ${got} against ` +
      `${shown(subject, rule.must.compare, group)}.`;
  }
  return `${FIELD_LABEL[rule.must.field]} ${opLabel(rule.must.field, rule.must.op)} ` +
    `${rule.must.value ? `“${rule.must.value}”` : ""} was expected — found “${got}”.`;
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
      out.push(`${at}“${FIELD_LABEL[c.field]} ${opLabel(c.field, c.op)}” needs a value — pick one, or remove the row with the ×.`);
    }
    if (c.field === "amount" && needsValue(c) && !Number.isFinite(Number(c.value))) {
      out.push(`${at}“${c.value}” is not an amount.`);
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
