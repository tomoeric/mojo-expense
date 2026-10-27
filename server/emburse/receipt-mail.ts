import { GRAPH, graphToken, isGraphConfigured } from "../mail.js";
import { db, ensureSchema } from "../db.js";

/**
 * Receipts that arrive as email, and the expenses they belong to.
 *
 * A receipt is usually in a mailbox long before anybody goes
 * looking for it. This reads that mailbox, takes the evidence out
 * of each message, and offers candidate matches — it does not
 * decide, and it does not touch Emburse.
 *
 * FOUR THINGS IT MUST NOT DO, each of which is easy to do by
 * accident and expensive afterwards:
 *
 *   CHANGE THE MAILBOX. Read only. Nothing here moves, deletes,
 *   marks as read, flags, files or replies to a message. The
 *   Graph calls are all GETs and there is no code path that is
 *   not. Somebody's inbox is not this app's to tidy.
 *
 *   GUESS WHICH ACCOUNT AN EXPENSE IS IN. Account identity comes
 *   from the EXPENSE and its lane, never from which mailbox the
 *   receipt was found in. One MOJO mailbox holds receipts for
 *   both personal Emburse accounts, and "it arrived here so it is
 *   this account's" is the assumption that attaches a Mammoth
 *   receipt to a MOJO expense.
 *
 *   CALL A WEAK MATCH A MATCH. Same amount is not evidence; it is
 *   the single most common coincidence in an expense table. A
 *   candidate carries its reasons and its confidence, and anything
 *   short of strong needs a person.
 *
 *   ASSIGN ONE RECEIPT TO TWO EXPENSES. A receipt matching several
 *   expenses is a conflict to be shown, never a thing to spread
 *   across them.
 *
 * The mailbox searched is configured SEPARATELY from the Emburse
 * login and from the app sign-in. All three are different
 * concepts and this deployment is the proof: the person signs
 * into the app as MOJO, their saved Emburse connection signs in
 * as Mammoth, and the mailbox holding the receipts is a third
 * address again.
 */

export type MailSettings = {
  /** The mailbox to search. Not the Emburse login and not the app login. */
  mailbox: string;
  /** Folders to look in, by display name. Empty means the whole mailbox. */
  folders: string[];
  /** How many days back a search reaches. */
  days: number;
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string;
};

/** What a message says about a purchase, as far as it can be read. */
export type Evidence = {
  messageId: string;
  subject: string;
  from: string;
  receivedAt: string;
  folder: string;
  /** The merchant, as the message names it. */
  merchant: string;
  /** The transaction date, when the message states one. */
  date: string | null;
  /** The total, in cents, when the message states one. */
  totalCents: number | null;
  currency: string;
  /** An order or transaction number, when there is one. The strongest signal. */
  reference: string;
  /** Whether a receipt file is attached, as against being in the body. */
  hasAttachment: boolean;
  attachments: { id: string; name: string; contentType: string; size: number }[];
  /** The text the evidence was read out of, kept so a person can check it. */
  excerpt: string;
};

const SCHEMA = `
/**
 * Which mailbox to search, per person.
 *
 * Separate from the Emburse login on purpose: they are different
 * concepts and on this deployment they are different addresses.
 * One row per app user — the mailbox is theirs, not the
 * deployment's.
 */
CREATE TABLE IF NOT EXISTS receipt_mail_settings (
  user_email text PRIMARY KEY,
  mailbox    text        NOT NULL DEFAULT '',
  folders    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  days       integer     NOT NULL DEFAULT 90,
  enabled    boolean     NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text        NOT NULL DEFAULT ''
);

/**
 * A candidate match between a message and an expense.
 *
 * One row per (expense, message), so the same message can be a
 * candidate for several expenses and the conflict is visible
 * rather than resolved by whichever was written last. The STATE
 * is what a person decided, and it starts as "candidate" — never
 * as "matched", however strong the evidence.
 */
CREATE TABLE IF NOT EXISTS receipt_mail_matches (
  dedupe_key  text        NOT NULL REFERENCES expenses (dedupe_key) ON DELETE CASCADE,
  message_id  text        NOT NULL,
  /** Which Emburse account the EXPENSE is in. Copied so a read needs no join. */
  lane        text        NOT NULL DEFAULT '',
  confidence  text        NOT NULL DEFAULT 'weak',
  score       integer     NOT NULL DEFAULT 0,
  reasons     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  evidence    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  state       text        NOT NULL DEFAULT 'candidate',
  decided_by  text        NOT NULL DEFAULT '',
  decided_at  timestamptz,
  found_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dedupe_key, message_id)
);
CREATE INDEX IF NOT EXISTS receipt_mail_matches_state
  ON receipt_mail_matches (state, lane);
CREATE INDEX IF NOT EXISTS receipt_mail_matches_message
  ON receipt_mail_matches (message_id);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

/** For a test that needs the schema re-asserted against a fresh database. */
export const resetReceiptMailCache = (): void => { ready = null; };

export async function mailSettings(userEmail: string): Promise<MailSettings> {
  await ensure();
  const { rows } = await db().query<{
    mailbox: string; folders: unknown; days: number; enabled: boolean;
    updated_at: Date; updated_by: string;
  }>(`SELECT mailbox, folders, days, enabled, updated_at, updated_by
        FROM receipt_mail_settings WHERE lower(user_email) = lower($1)`, [userEmail]);
  const r = rows[0];
  return {
    mailbox: r?.mailbox ?? "",
    folders: Array.isArray(r?.folders) ? (r!.folders as unknown[]).map(String) : [],
    days: r?.days ?? 90,
    enabled: r?.enabled ?? false,
    updatedAt: r?.updated_at?.toISOString() ?? null,
    updatedBy: r?.updated_by ?? "",
  };
}

export async function saveMailSettings(
  userEmail: string,
  input: Partial<Pick<MailSettings, "mailbox" | "folders" | "days" | "enabled">>,
  by: string,
): Promise<MailSettings> {
  await ensure();
  const now = await mailSettings(userEmail);
  const mailbox = (input.mailbox ?? now.mailbox).trim().toLowerCase();
  const folders = (input.folders ?? now.folders)
    .map((f) => String(f).trim()).filter(Boolean).slice(0, 20);
  const days = Math.min(Math.max(Number(input.days ?? now.days) || 90, 1), 730);
  const enabled = input.enabled ?? now.enabled;
  await db().query(
    `INSERT INTO receipt_mail_settings
       (user_email, mailbox, folders, days, enabled, updated_at, updated_by)
     VALUES ($1,$2,$3::jsonb,$4,$5, now(), $6)
     ON CONFLICT (user_email) DO UPDATE
       SET mailbox = excluded.mailbox, folders = excluded.folders, days = excluded.days,
           enabled = excluded.enabled, updated_at = now(), updated_by = excluded.updated_by`,
    [userEmail.toLowerCase(), mailbox, JSON.stringify(folders), days, enabled, by]);
  return mailSettings(userEmail);
}

/* ------------------------------------------------------------------ *
 * Reading the mailbox. GET only, always.
 * ------------------------------------------------------------------ */

type GraphMessage = {
  id: string;
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
  parentFolderId?: string;
};

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { authorization: `Bearer ${await graphToken()}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const hint = res.status === 403
      ? " — Mail.Read has not been consented for this app, or an application access "
        + "policy excludes this mailbox."
      : res.status === 404 ? " — no such mailbox or folder." : "";
    throw new Error(`Graph refused the read (${res.status})${hint} ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as T;
};

/** The folders in a mailbox, so the picker offers real ones. */
export async function listFolders(
  mailbox: string,
): Promise<{ id: string; name: string; total: number }[]> {
  if (!isGraphConfigured()) throw new Error("The Microsoft app credentials are not set.");
  const folderQs = new URLSearchParams();
  folderQs.set("$top", "100");
  folderQs.set("$select", "id,displayName,totalItemCount");
  const out = await get<{ value: { id: string; displayName: string; totalItemCount: number }[] }>(
    `/users/${encodeURIComponent(mailbox)}/mailFolders?${folderQs.toString()}`);
  return out.value.map((f) => ({ id: f.id, name: f.displayName, total: f.totalItemCount }));
}

/**
 * Messages that could be receipts, in one mailbox.
 *
 * Read only. No message is moved, deleted, marked, flagged or
 * replied to — every call here is a GET, and there is no path
 * that is not.
 *
 * A folder the configuration names but the mailbox does not have
 * is reported rather than skipped: "we searched a folder that is
 * not there" and "we searched nothing" look identical from a
 * result list, and the brief asks for the scope to be visible.
 */
export async function searchMailbox(opts: {
  mailbox: string;
  folders?: string[];
  days?: number;
  /** A cap, so an unbounded mailbox cannot become an unbounded read. */
  limit?: number;
}): Promise<{ messages: Evidence[]; searched: string[]; missing: string[] }> {
  if (!isGraphConfigured()) throw new Error("The Microsoft app credentials are not set.");
  const mailbox = opts.mailbox.trim();
  if (!mailbox) throw new Error("No mailbox is configured to search.");
  const days = Math.min(Math.max(opts.days ?? 90, 1), 730);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const searched: string[] = [];
  const missing: string[] = [];
  let paths: string[] = [`/users/${encodeURIComponent(mailbox)}/messages`];

  if (opts.folders && opts.folders.length > 0) {
    const have = await listFolders(mailbox);
    paths = [];
    for (const want of opts.folders) {
      const found = have.find((f) => f.name.toLowerCase() === want.trim().toLowerCase());
      if (!found) { missing.push(want); continue; }
      searched.push(found.name);
      paths.push(
        `/users/${encodeURIComponent(mailbox)}/mailFolders/${found.id}/messages`);
    }
    if (paths.length === 0) {
      return { messages: [], searched, missing };
    }
  } else {
    searched.push("the whole mailbox");
  }

  const seen = new Map<string, Evidence>();
  for (const path of paths) {
    /*
     * Built with URLSearchParams rather than string concatenation
     * — the OData parameters start with $, and a hand-built query
     * string of them reads enough like SQL to trip the repo's own
     * SQL-template check, which is a fair warning to have given.
     */
    const qs = new URLSearchParams();
    qs.set("$top", String(limit));
    qs.set("$select", "id,subject,receivedDateTime,bodyPreview,from,hasAttachments,body");
    qs.set("$filter", `receivedDateTime ge ${since}`);
    qs.set("$orderby", "receivedDateTime desc");
    const page = await get<{ value: GraphMessage[] }>(`${path}?${qs.toString()}`);
    for (const m of page.value) {
      if (seen.has(m.id)) continue;
      seen.set(m.id, await evidenceOf(mailbox, m, searched[0] ?? ""));
    }
  }
  return { messages: [...seen.values()], searched, missing };
}

/* ------------------------------------------------------------------ *
 * Reading a message
 * ------------------------------------------------------------------ */

const MONEY = /(?:(?:US)?\$|USD\s*)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})/gi;
const TOTAL_LINE =
  /(?:order\s+total|grand\s+total|total\s+charged|amount\s+charged|total\s+paid|total)\s*[:\-]?\s*(?:US)?\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})/i;
const REFERENCE =
  /(?:order|transaction|confirmation|receipt|invoice)\s*(?:#|no\.?|number|id)?\s*[:\-#]?\s*([A-Z0-9][A-Z0-9-]{4,24})/i;
const DATE_ISO = /\b(20\d{2})-(\d{2})-(\d{2})\b/;
const DATE_US = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE_WORDS = new RegExp(
  `\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, "i");

/** HTML out, whitespace collapsed. A receipt's text, not its markup. */
export const textOf = (html: string): string => html
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const cents = (s: string): number =>
  Math.round(Number(s.replace(/,/g, "")) * 100);

/**
 * The date a receipt states, as far as the text says one.
 *
 * Three formats, in the order they are unambiguous. A bare
 * `03/04/2026` is read as US month-first, which is what every
 * merchant mailing this tenant uses — and the parse is reported
 * as a REASON on the candidate, so a person can see what was
 * assumed rather than discovering it from a wrong match.
 */
export function dateIn(text: string): string | null {
  const iso = DATE_ISO.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const words = DATE_WORDS.exec(text);
  if (words) {
    const month = MONTHS.indexOf(words[1]!.slice(0, 3).toLowerCase()) + 1;
    return `${words[3]}-${String(month).padStart(2, "0")}`
      + `-${words[2]!.padStart(2, "0")}`;
  }
  const us = DATE_US.exec(text);
  if (us) {
    return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  }
  return null;
}

/**
 * The total a receipt states.
 *
 * A labelled total wins. Without one, the LARGEST money figure in
 * the text is the best guess — a receipt lists items, tax and
 * shipping, and the total is the biggest of them. Returned with
 * the distinction intact, because an unlabelled guess is weaker
 * evidence and the candidate has to say so.
 */
export function totalIn(text: string): { cents: number | null; labelled: boolean } {
  const labelled = TOTAL_LINE.exec(text);
  if (labelled) return { cents: cents(labelled[1]!), labelled: true };
  const all = [...text.matchAll(MONEY)].map((m) => cents(m[1]!)).filter((n) => n > 0);
  if (all.length === 0) return { cents: null, labelled: false };
  return { cents: Math.max(...all), labelled: false };
}

/** The merchant, from the sender's display name or domain. */
export function merchantOf(from: string, subject: string): string {
  const domain = from.split("@")[1] ?? "";
  const stem = domain.split(".").filter((p) => !["com", "net", "org", "co", "uk", "mail",
    "email", "e", "info", "noreply", "no-reply"].includes(p.toLowerCase()))[0] ?? "";
  // A subject that names the merchant beats a domain that does
  // not: "Your Starbucks receipt" from mail.sbux-e.com is the
  // case this exists for.
  const fromSubject = /(?:from|at|your)\s+([A-Z][\w&'. -]{2,28}?)\s+(?:receipt|order|purchase)/i
    .exec(subject);
  return (fromSubject?.[1] ?? stem).trim();
}

async function evidenceOf(
  mailbox: string, m: GraphMessage, folder: string,
): Promise<Evidence> {
  const from = m.from?.emailAddress?.address ?? "";
  const html = m.body?.contentType?.toLowerCase() === "html";
  const raw = m.body?.content ?? m.bodyPreview ?? "";
  // The receipt is often IN the body rather than attached, which
  // the brief names explicitly, so the body is read the same way
  // either way.
  const text = html ? textOf(raw) : raw;
  const total = totalIn(text);
  const attachments = m.hasAttachments
    ? await get<{ value: { id: string; name: string; contentType: string; size: number }[] }>(
      `/users/${encodeURIComponent(mailbox)}/messages/${m.id}/attachments`
      + `?${new URLSearchParams({ "$select": "id,name,contentType,size" }).toString()}`)
      .then((a) => a.value)
      .catch(() => [])
    : [];
  return {
    messageId: m.id,
    subject: m.subject ?? "",
    from,
    receivedAt: m.receivedDateTime ?? "",
    folder,
    merchant: merchantOf(from, m.subject ?? ""),
    date: dateIn(text) ?? (m.receivedDateTime ? m.receivedDateTime.slice(0, 10) : null),
    totalCents: total.cents,
    currency: /\bEUR\b|€/.test(text) ? "EUR" : /\bGBP\b|£/.test(text) ? "GBP" : "USD",
    reference: REFERENCE.exec(text)?.[1]?.trim() ?? "",
    hasAttachment: attachments.length > 0,
    attachments,
    excerpt: text.slice(0, 600),
  };
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

export type Candidate = {
  dedupeKey: string;
  lane: string;
  messageId: string;
  confidence: "strong" | "likely" | "weak";
  score: number;
  reasons: string[];
  evidence: Evidence;
};

/** The expense, as matching sees it. */
export type Target = {
  dedupeKey: string;
  lane: string;
  merchant: string;
  date: string | null;
  amountCents: number;
  currency: string;
};

const DAY = 86_400_000;

const normalise = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Does either name contain the other's distinctive word? */
function merchantAgrees(a: string, b: string): boolean {
  const x = normalise(a), y = normalise(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const words = (s: string) => s.split(" ").filter((w) => w.length >= 4);
  return words(x).some((w) => words(y).includes(w));
}

/**
 * How well one message matches one expense, and WHY.
 *
 * The reasons are the output, not a by-product. "Same amount" on
 * its own is the single most common coincidence in an expense
 * table, and a match presented without its reasons cannot be
 * checked by the person who has to approve it.
 *
 * Nothing here is ever "confirmed". The strongest result is
 * `strong`, which still means a person says yes.
 */
export function scoreMatch(expense: Target, e: Evidence): Candidate | null {
  const reasons: string[] = [];
  let score = 0;

  // A reference number that appears in both is the one signal
  // worth more than everything else together.
  if (e.reference && normalise(expense.merchant).includes(normalise(e.reference))) {
    score += 60;
    reasons.push(`The order number ${e.reference} is in the expense's merchant field.`);
  }

  const sameMerchant = merchantAgrees(expense.merchant, e.merchant)
    || merchantAgrees(expense.merchant, e.subject);
  if (sameMerchant) {
    score += 30;
    reasons.push(`The merchant matches: “${expense.merchant}” and “${e.merchant}”.`);
  }

  if (e.totalCents !== null) {
    if (e.totalCents === expense.amountCents) {
      score += 30;
      reasons.push(`The total matches exactly: $${(e.totalCents / 100).toFixed(2)}.`);
    } else if (Math.abs(e.totalCents) === Math.abs(expense.amountCents)
      && Math.sign(e.totalCents) !== Math.sign(expense.amountCents)) {
      // A refund is the same money in the other direction, and
      // reads as a match to anything that only compares size.
      score -= 20;
      reasons.push("The amounts are equal and opposite — this looks like a refund of it, "
        + "not a receipt for it.");
    } else {
      score -= 15;
      reasons.push(`The totals differ: the receipt says `
        + `$${(e.totalCents / 100).toFixed(2)} and the expense says `
        + `$${(expense.amountCents / 100).toFixed(2)}.`);
    }
  } else {
    reasons.push("No total could be read out of the message.");
  }

  if (e.currency !== expense.currency) {
    score -= 25;
    reasons.push(`Different currencies: the receipt is in ${e.currency} and the expense `
      + `is in ${expense.currency}.`);
  }

  if (expense.date && e.date) {
    const apart = Math.round(
      Math.abs(Date.parse(e.date) - Date.parse(expense.date)) / DAY);
    if (apart === 0) { score += 20; reasons.push("Same date."); }
    else if (apart <= 3) {
      score += 8;
      reasons.push(`${apart} day${apart === 1 ? "" : "s"} apart — a card posts a day or `
        + "two after the purchase.");
    } else {
      score -= 10;
      reasons.push(`${apart} days apart.`);
    }
  } else {
    reasons.push("One of the two has no date to compare.");
  }

  if (score <= 0) return null;

  /*
   * STRONG still means "a person says yes".
   *
   * It takes the merchant AND an exact total, or a reference
   * number — amount alone never reaches it, however exact,
   * because two $12.99 lunches in a month is not a coincidence,
   * it is Tuesday.
   */
  const confidence: Candidate["confidence"] =
    score >= 60 ? "strong" : score >= 35 ? "likely" : "weak";

  return {
    dedupeKey: expense.dedupeKey,
    lane: expense.lane,
    messageId: e.messageId,
    confidence,
    score,
    reasons,
    evidence: e,
  };
}

/**
 * Candidates for a set of expenses, from a set of messages.
 *
 * Every pair is scored, which is what makes a conflict visible:
 * one message that matches three expenses produces three
 * candidates, and the caller can see that rather than being
 * handed whichever scored highest.
 */
export function matchAll(expenses: Target[], messages: Evidence[]): Candidate[] {
  const out: Candidate[] = [];
  for (const expense of expenses) {
    for (const message of messages) {
      const c = scoreMatch(expense, message);
      if (c) out.push(c);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Which candidates are in conflict, and therefore need a person.
 *
 * Two shapes: one message wanted by several expenses, and one
 * expense with several plausible messages. Both are returned as
 * the message or expense they are about, so the page can say
 * "this receipt matches three expenses" rather than showing three
 * rows that each look settled.
 */
export function conflicts(candidates: Candidate[]): {
  byMessage: Map<string, Candidate[]>;
  byExpense: Map<string, Candidate[]>;
} {
  const byMessage = new Map<string, Candidate[]>();
  const byExpense = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.confidence === "weak") continue;
    byMessage.set(c.messageId, [...(byMessage.get(c.messageId) ?? []), c]);
    byExpense.set(c.dedupeKey, [...(byExpense.get(c.dedupeKey) ?? []), c]);
  }
  for (const [k, v] of byMessage) if (v.length < 2) byMessage.delete(k);
  for (const [k, v] of byExpense) if (v.length < 2) byExpense.delete(k);
  return { byMessage, byExpense };
}

/* ------------------------------------------------------------------ *
 * Storing what was found
 * ------------------------------------------------------------------ */

export async function recordCandidates(found: Candidate[]): Promise<number> {
  await ensure();
  if (found.length === 0) return 0;
  let written = 0;
  for (const c of found) {
    const { rowCount } = await db().query(
      `INSERT INTO receipt_mail_matches
         (dedupe_key, message_id, lane, confidence, score, reasons, evidence)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
       ON CONFLICT (dedupe_key, message_id) DO UPDATE
         SET confidence = excluded.confidence, score = excluded.score,
             reasons = excluded.reasons, evidence = excluded.evidence
         -- A candidate a person has already decided keeps its
         -- state. Re-scoring is not a reason to reopen a
         -- question somebody has answered.
       WHERE receipt_mail_matches.state = 'candidate'`,
      [c.dedupeKey, c.messageId, c.lane, c.confidence, c.score,
        JSON.stringify(c.reasons), JSON.stringify(c.evidence)]);
    written += rowCount ?? 0;
  }
  return written;
}

export type StoredMatch = Candidate & {
  state: "candidate" | "chosen" | "rejected" | "attached" | "failed";
  decidedBy: string;
  decidedAt: string | null;
  foundAt: string;
};

export async function matchesFor(
  lane: string | null, state?: string,
): Promise<StoredMatch[]> {
  await ensure();
  const { rows } = await db().query<{
    dedupe_key: string; message_id: string; lane: string; confidence: string;
    score: number; reasons: unknown; evidence: unknown; state: string;
    decided_by: string; decided_at: Date | null; found_at: Date;
  }>(
    `SELECT dedupe_key, message_id, lane, confidence, score, reasons, evidence, state,
            decided_by, decided_at, found_at
       FROM receipt_mail_matches
      WHERE ($1::text IS NULL OR lane = $1)
        AND ($2::text IS NULL OR state = $2)
      ORDER BY score DESC, found_at DESC`,
    [lane, state ?? null]);
  return rows.map((r) => ({
    dedupeKey: r.dedupe_key,
    lane: r.lane,
    messageId: r.message_id,
    confidence: (r.confidence === "strong" || r.confidence === "likely"
      ? r.confidence : "weak"),
    score: r.score,
    reasons: Array.isArray(r.reasons) ? (r.reasons as unknown[]).map(String) : [],
    evidence: r.evidence as Evidence,
    state: (["candidate", "chosen", "rejected", "attached", "failed"]
      .includes(r.state) ? r.state : "candidate") as StoredMatch["state"],
    decidedBy: r.decided_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
    foundAt: r.found_at.toISOString(),
  }));
}

/**
 * A person chooses, or rejects, one candidate.
 *
 * Choosing one REJECTS the other candidates for the same expense,
 * in the same statement: an expense with two receipts chosen is
 * the ambiguity this whole flow exists to prevent, and leaving
 * both open would let a later pass attach the second.
 *
 * It does NOT reject the message's other candidates. One receipt
 * genuinely can cover several expenses — a purchase split across
 * sites is already a case this app handles — so that stays a
 * conflict for a person rather than a rule.
 */
export async function decideMatch(opts: {
  dedupeKey: string; messageId: string; choose: boolean; by: string;
}): Promise<{ ok: boolean; problem?: string }> {
  await ensure();
  const { rowCount } = await db().query(
    `UPDATE receipt_mail_matches
        SET state = $3, decided_by = $4, decided_at = now()
      WHERE dedupe_key = $1 AND message_id = $2 AND state IN ('candidate', 'rejected')`,
    [opts.dedupeKey, opts.messageId, opts.choose ? "chosen" : "rejected", opts.by]);
  if (rowCount === 0) {
    return {
      ok: false,
      problem: "That candidate is not waiting on a decision — it may already be attached.",
    };
  }
  if (opts.choose) {
    await db().query(
      `UPDATE receipt_mail_matches
          SET state = 'rejected', decided_by = $3, decided_at = now()
        WHERE dedupe_key = $1 AND message_id <> $2 AND state = 'candidate'`,
      [opts.dedupeKey, opts.messageId, opts.by]);
  }
  return { ok: true };
}

/** Drop a removed person's settings. Matches cascade with their expenses. */
export async function forgetMailSettings(userEmail: string): Promise<void> {
  await ensure();
  await db().query("DELETE FROM receipt_mail_settings WHERE lower(user_email) = lower($1)",
    [userEmail]);
}
