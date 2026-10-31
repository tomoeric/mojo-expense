import { GRAPH, forgetGraphToken, graphToken, isGraphConfigured } from "../mail.js";
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

/**
 * The receipt, once it is in the app.
 *
 * Choosing a match PULLS THE IMAGE IN and links it to the expense
 * through the ordinary tables — receipt_blobs for the bytes,
 * expense_receipts for the link. The hash is kept here as well so
 * this row can say whether the pull happened without a join.
 *
 * Linking first, before anything goes to Emburse, is the whole
 * order of operations: a linked receipt is read by the reader
 * that already exists, which is what produces the merchant, date,
 * total and line items the field fill is made of. Uploading
 * straight to Emburse would attach a picture and learn nothing
 * from it.
 */
ALTER TABLE receipt_mail_matches ADD COLUMN IF NOT EXISTS linked_sha256 text;
ALTER TABLE receipt_mail_matches ADD COLUMN IF NOT EXISTS link_error text NOT NULL DEFAULT '';
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
  let res = await fetch(`${GRAPH}${path}`, {
    headers: { authorization: `Bearer ${await graphToken()}` },
  });
  /*
   * ONE RETRY ON A FRESH TOKEN, because a 403 can be an hour out of date.
   *
   * The token carries the app's roles as claims, frozen when it was
   * issued, and it is cached for most of an hour. So granting Mail.Read
   * to a running app changes nothing until that hour is up: the next
   * press fails with exactly the 403 it failed with before the grant,
   * and the obvious conclusion — "the permission did not take" — is
   * wrong. That cost a round of checking a consent that was already
   * there. Minting a new one is a single cheap call and settles it.
   */
  if (res.status === 403) {
    forgetGraphToken();
    res = await fetch(`${GRAPH}${path}`, {
      headers: { authorization: `Bearer ${await graphToken()}` },
    });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(graphWhy(res.status, detail));
  }
  return (await res.json()) as T;
};

/**
 * WHY Graph refused, with the likeliest cause FIRST.
 *
 * The old text said "Mail.Read has not been consented for this app, or an
 * application access policy excludes this mailbox" for every 403, with
 * the raw Graph JSON after it. Those are two different problems with two
 * different fixes, and leading with the wrong one sends somebody to the
 * Azure portal to check a grant that is already there — which is exactly
 * what happened, twice.
 *
 * The two are distinguishable, and Graph says which:
 *
 *   `Authorization_RequestDenied`, "Insufficient privileges" — ENTRA
 *   refused. The application permission is missing or not admin-
 *   consented. That is the Azure portal.
 *
 *   `ErrorAccessDenied` with `ODataAuthorizationException` — EXCHANGE
 *   refused, which it can only do once Entra has already allowed it. So
 *   Mail.Read IS consented and something on the mailbox side is saying
 *   no: an application access policy restricting which mailboxes this app
 *   may touch, which this deployment is told to create. That is
 *   PowerShell, not the portal.
 *
 * The raw body goes last and short. It was first, and it is the least
 * useful part.
 */
export function graphWhy(status: number, body: string): string {
  const brief = body.replace(/\s+/g, " ").slice(0, 200);
  const entra = /Authorization_RequestDenied|Insufficient privileges/i.test(body);
  const exchange = /ErrorAccessDenied|ODataAuthorizationException/i.test(body);

  if (status === 404) {
    return `Graph has no such mailbox or folder (404). Check the address is exactly right `
      + `and that the folder name matches. Graph said: ${brief}`;
  }
  if (status === 403 && exchange && !entra) {
    return "Exchange refused this mailbox (403), not Entra — which means Mail.Read IS "
      + "consented and the block is on the mailbox side. The usual cause is an "
      + "application access policy restricting which mailboxes this app may touch; this "
      + "deployment is set up to have one. Check it with "
      + "`Test-ApplicationAccessPolicy -Identity <mailbox> -AppId <AZURE_CLIENT_ID>` and, "
      + "if it says Denied, add the mailbox to the policy's group. A mailbox in a "
      + "DIFFERENT Microsoft tenant answers the same way and cannot be granted at all. "
      + `Graph said: ${brief}`;
  }
  if (status === 403 && entra) {
    return "Entra refused (403): the app registration does not hold Mail.Read as an "
      + "APPLICATION permission with admin consent. Delegated Mail.Read is not enough — "
      + "there is no signed-in user on a scheduled scan. "
      + `Graph said: ${brief}`;
  }
  if (status === 403) {
    return `Graph refused the read (403). Either Mail.Read is not consented as an `
      + `application permission, or an application access policy excludes this mailbox — `
      + `the body below says which. Graph said: ${brief}`;
  }
  return `Graph refused the read (${status}). Graph said: ${brief}`;
}

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
  /**
   * How many photographs this whole scan may read, in all.
   *
   * Each is a vision call, so this is the difference between a
   * search and a bill. Zero turns the reading off entirely, which
   * is what the tests use.
   */
  photoBudget?: number;
}): Promise<{
  messages: Evidence[]; searched: string[]; missing: string[];
  /** Photographs the reader was spent on, so the page can say so. */
  photosRead: number;
  /** Photographs left unread because the budget ran out. */
  photosSkipped: number;
}> {
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
      return { messages: [], searched, missing, photosRead: 0, photosSkipped: 0 };
    }
  } else {
    searched.push("the whole mailbox");
  }

  const seen = new Map<string, Evidence>();
  const budget = { left: Math.max(opts.photoBudget ?? 40, 0) };
  let photosRead = 0;
  let photosSkipped = 0;
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
      const base = await evidenceOf(mailbox, m, searched[0] ?? "");
      seen.set(m.id, base);

      /*
       * A MESSAGE THAT SAYS NOTHING, CARRYING PICTURES THAT DO.
       *
       * Only when the body yielded no total: an email from a
       * merchant states its own total, and spending a vision call
       * to confirm what is already written in the text would be
       * paying to learn nothing. A phone forwarding eight
       * photographed till receipts states nothing at all, and
       * every fact worth matching on is inside the images.
       */
      if (base.totalCents !== null) continue;
      const photos = base.attachments.filter(isPhoto);
      if (photos.length === 0) continue;
      if (budget.left <= 0) { photosSkipped += photos.length; continue; }

      const before = budget.left;
      const each = await photoEvidence(mailbox, base, budget);
      photosRead += before - budget.left;
      photosSkipped += photos.length - (before - budget.left);
      if (each.length > 0) {
        // The message's own evidence is replaced, not joined: it
        // has no merchant, no date and no total, so it can only
        // ever be the noise this scan already refuses.
        seen.delete(m.id);
        for (const e of each) seen.set(e.messageId, e);
      }
    }
  }
  return { messages: [...seen.values()], searched, missing, photosRead, photosSkipped };
}

/* ------------------------------------------------------------------ *
 * Reading a message
 * ------------------------------------------------------------------ */

const MONEY = /(?:(?:US)?\$|USD\s*)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})/gi;
/**
 * WHAT THE RECEIPT SAYS IS DUE, which is not the first "total" on it.
 *
 * Two faults, one real receipt. A Replit invoice reads
 *
 *   Subtotal              $100.00
 *   Total excluding tax   $100.00
 *   Sales Tax - Texas     $6.60
 *   Total                $106.60
 *   Amount due           $106.60 USD
 *
 * and this read **$100.00**. "Subtotal" CONTAINS the word total and
 * there was no word boundary, so the first thing the pattern hit was
 * the subtotal — and `exec` takes the first match, so the real total
 * four lines below was never looked at. The expense was $106.60, so a
 * perfect match was reported as "the totals differ" and scored down to
 * `likely`.
 *
 * So: a boundary, the strong labels separated out, and the LARGEST of
 * whichever set matched rather than the first. Tax and tips only ever
 * push the true total up, so the largest labelled figure is the one
 * that is due; taking the first is just taking whichever the merchant
 * happened to print highest up the page.
 */
const DUE_LINE =
  /(?:amount\s+due|balance\s+due|total\s+due|amount\s+paid|grand\s+total|order\s+total|total\s+charged|amount\s+charged|total\s+paid)\s*[:\-]?\s*(?:US)?\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})/gi;
const TOTAL_LINE =
  /\btotal\b\s*[:\-]?\s*(?:US)?\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})/gi;
const REFERENCE =
  /(?:order|transaction|confirmation|receipt|invoice)\s*(?:#|no\.?|number|id)?\s*[:\-#]?\s*([A-Z0-9][A-Z0-9-]{4,24})/gi;

/**
 * An order number, and never the word after "Receipt".
 *
 * "Your receipt can be viewed here: Download" gave a reference of
 * **Download**, which then appeared on the card as "ref Download"
 * and went into the description that would be written to Emburse.
 * A reference has a digit in it; a word does not. The first match
 * that qualifies wins, rather than the first match, so a real
 * number later in the text is not lost to a word earlier in it.
 */
export function referenceIn(text: string): string {
  for (const m of text.matchAll(REFERENCE)) {
    const found = (m[1] ?? "").trim();
    if (/\d/.test(found)) return found;
  }
  return "";
}
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
  // "Amount due" and its kin first: a receipt that states one has
  // stated the answer, and nothing else on it needs weighing.
  const due = [...text.matchAll(DUE_LINE)].map((m) => cents(m[1]!)).filter((n) => n > 0);
  if (due.length > 0) return { cents: Math.max(...due), labelled: true };
  // Then plain "Total" — with a boundary, so Subtotal is not one, and
  // taking the largest, so "Total excluding tax" cannot win over the
  // total that includes it.
  const totals = [...text.matchAll(TOTAL_LINE)].map((m) => cents(m[1]!)).filter((n) => n > 0);
  if (totals.length > 0) return { cents: Math.max(...totals), labelled: true };
  const all = [...text.matchAll(MONEY)].map((m) => cents(m[1]!)).filter((n) => n > 0);
  if (all.length === 0) return { cents: null, labelled: false };
  return { cents: Math.max(...all), labelled: false };
}

/**
 * Words that are not a merchant, however the subject capitalises them.
 *
 * "Your Transaction Receipt" from noreply@uhaul.com was read as a
 * merchant called **Transaction**, and the card then offered a
 * U-Haul receipt against a GitHub expense with "Transaction" as
 * the name on it. The subject rule is still right — "Your
 * Starbucks receipt" from mail.sbux-e.com is why it exists — but
 * it has to know when it has caught a noun rather than a company.
 */
const NOT_A_MERCHANT = new Set([
  "transaction", "invoice", "payment", "purchase", "order", "receipt",
  "statement", "subscription", "renewal", "membership", "booking",
  "reservation", "account", "billing", "charge", "refund", "monthly",
  "annual", "yearly", "latest", "recent", "new", "online", "digital",
  "electronic", "email", "copy", "official", "final", "paid",
]);

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
  const named = (fromSubject?.[1] ?? "").trim();
  // Every word of it generic means the subject named no company,
  // and the sending domain is the better answer.
  const generic = named !== "" && named.split(/[\s.&'-]+/).filter(Boolean)
    .every((w) => NOT_A_MERCHANT.has(w.toLowerCase()));
  return (generic || named === "" ? stem : named).trim();
}

/* ------------------------------------------------------------------ *
 * Several receipts in one email
 * ------------------------------------------------------------------ */

/**
 * A candidate's id: the message, or ONE PHOTO INSIDE IT.
 *
 * Eight photographed till receipts arrive in one email, forwarded
 * from a phone, with a body that says "Sent via the Samsung
 * Galaxy S24 Ultra" and nothing else. One Evidence per message
 * makes that one candidate — so seven of the eight receipts are
 * invisible, and the one that is offered has no merchant, no
 * date and no total, because none of those are in the body. They
 * are in the pictures.
 *
 * So a photo-only message becomes one candidate PER PHOTO, and
 * each needs its own id. `<message id>#<attachment id>`: the part
 * before the separator is what Graph understands, and
 * `baseMessageId` is applied at the two places that ask Graph for
 * a message, so nothing else has to know.
 */
export const PHOTO_SEP = "#";

/** The Graph message id inside a candidate's id. */
export const baseMessageId = (id: string): string =>
  id.includes(PHOTO_SEP) ? id.slice(0, id.indexOf(PHOTO_SEP)) : id;

/** One file hanging off a message, as Graph describes it. */
export type MailAttachment = Evidence["attachments"][number];

/**
 * Is this attachment a photograph of a receipt rather than a logo?
 *
 * Takes the whole attachment rather than three of its fields, so
 * `attachments.filter(isPhoto)` works and so a caller handing it
 * a real attachment is not refused for the `id` being there —
 * which is exactly how this shipped with a type error in it.
 */
export const isPhoto = (a: MailAttachment): boolean =>
  (/^image\//i.test(a.contentType) || /\.(jpe?g|png|heic|heif|webp)$/i.test(a.name))
  // A signature image or a tracking pixel is not a receipt. A
  // photographed till receipt off a phone is hundreds of KB.
  && a.size >= 20_000;

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
    reference: referenceIn(text),
    hasAttachment: attachments.length > 0,
    attachments,
    excerpt: text.slice(0, 600),
  };
}

/**
 * One candidate per photograph, read by the receipt reader.
 *
 * The expensive half of this app is a vision call, so this is
 * reached only when the message gives the matcher nothing to work
 * with — no total in the body — and only for attachments big
 * enough to be a photographed receipt. The caller holds a budget
 * across the whole scan so one forwarded album cannot turn a
 * search into a hundred calls.
 *
 * A photo the reader cannot make sense of is DROPPED rather than
 * offered: a candidate with no merchant and no total is the noise
 * this scan already refuses from an email body, and it does not
 * become evidence by having been a picture.
 */
export async function photoEvidence(
  mailbox: string, base: Evidence, budget: { left: number },
): Promise<Evidence[]> {
  const photos = base.attachments.filter(isPhoto);
  if (photos.length === 0) return [];

  const { canReadReceipts, readReceipt } = await import("./receipt-items.js");
  if (!canReadReceipts()) return [];

  const out: Evidence[] = [];
  for (const a of photos) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    try {
      const got = await get<{ contentBytes?: string; contentType?: string }>(
        `/users/${encodeURIComponent(mailbox)}/messages/${base.messageId}`
        + `/attachments/${a.id}`);
      if (!got.contentBytes) continue;
      const bytes = Buffer.from(got.contentBytes, "base64");
      const read = await readReceipt(bytes, got.contentType || a.contentType);
      const cents = read.total ?? read.paid ?? null;
      // Nothing identifying came out of it, so it is not evidence.
      if (!read.merchant && cents === null) continue;
      out.push({
        ...base,
        messageId: `${base.messageId}${PHOTO_SEP}${a.id}`,
        merchant: read.merchant ?? base.merchant,
        date: read.purchasedAt ?? base.date,
        totalCents: cents === null ? null : Math.round(cents * 100),
        currency: read.currency || base.currency,
        // The ONE photo this candidate is about, so the preview
        // shows it and the upload sends it — not the first image
        // in an email of eight.
        attachments: [a],
        excerpt: `Read from the photograph ${a.name}: `
          + `${read.merchant ?? "no merchant"}`
          + `${read.purchasedAt ? ` on ${read.purchasedAt}` : ""}`
          + `${cents === null ? "" : ` for ${cents.toFixed(2)}`}.`
          + `${read.notes ? ` ${read.notes}` : ""}`,
      });
    } catch {
      // One unreadable photo costs that photo, not the scan.
      continue;
    }
  }
  return out;
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
  /**
   * WHAT ACTUALLY AGREED, separately from how much it is worth.
   *
   * The score answers "how good is this", and two candidates can
   * reach the same number by different routes. One-to-one
   * resolution needs the other question — did the price, the date
   * AND the name all agree — because that, and not a total, is
   * what makes a receipt belong to one expense and no other.
   *
   * Optional because a match read back out of the database has
   * only the receipt's side stored; the expense it was scored
   * against is long gone by then.
   */
  signals?: MatchSignals;
};

/** The three things a person checks, as booleans. */
export type MatchSignals = {
  merchant: boolean;
  total: boolean;
  date: boolean;
  reference: boolean;
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
  const signals: MatchSignals =
    { merchant: false, total: false, date: false, reference: false };
  let score = 0;

  // A reference number that appears in both is the one signal
  // worth more than everything else together.
  if (e.reference && normalise(expense.merchant).includes(normalise(e.reference))) {
    score += 60;
    signals.reference = true;
    reasons.push(`The order number ${e.reference} is in the expense's merchant field.`);
  }

  const sameMerchant = merchantAgrees(expense.merchant, e.merchant)
    || merchantAgrees(expense.merchant, e.subject);
  if (sameMerchant) {
    score += 30;
    signals.merchant = true;
    reasons.push(`The merchant matches: “${expense.merchant}” and “${e.merchant}”.`);
  }

  if (e.totalCents !== null) {
    if (e.totalCents === expense.amountCents) {
      score += 30;
      signals.total = true;
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
    if (apart === 0) { score += 20; signals.date = true; reasons.push("Same date."); }
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
   * BEING NEAR IN TIME IS NOT EVIDENCE OF ANYTHING.
   *
   * A U-Haul receipt with no readable total was offered against an
   * $8.28 GitHub charge, on eight points of "2 days apart — a card
   * posts a day or two after the purchase" and nothing else. In a
   * 90-day window every expense is two days from something, so
   * date proximity on its own matches everything, which is the
   * same as matching nothing — and it costs a person a real look
   * to throw away.
   *
   * At least one thing that IDENTIFIES the purchase has to agree:
   * the merchant, the exact total, or an order number. Date and
   * currency only ever strengthen one of those.
   */
  if (!signals.merchant && !signals.total && !signals.reference) return null;

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
    signals,
  };
}

/* ------------------------------------------------------------------ *
 * One receipt, one expense
 * ------------------------------------------------------------------ */

/** The line added to a candidate that settles its own pair. */
export const SURE_REASON =
  "Price, date and merchant all agree — so this receipt is this expense's and "
  + "no other, and the pairs it would otherwise have been offered against are "
  + "not shown.";

/** Did the price, the date and the name all agree? */
export const isSure = (c: Candidate): boolean =>
  Boolean(c.signals && c.signals.merchant && c.signals.total && c.signals.date);

/**
 * ONE RECEIPT MATCHES ONE EXPENSE, when it plainly does.
 *
 * Scoring every pair is what makes a real ambiguity visible, and
 * it is also what buried the page: 26 expenses and a few dozen
 * receipts produced 417 cards, because a $106.60 Replit receipt
 * scores against EVERY $106.60 Replit expense in the window, and
 * each of those scores against every such receipt. The pile was
 * almost entirely pairs nobody would ever pick.
 *
 * So: a candidate whose price, date AND merchant all agree is
 * taken as settled. It claims its receipt and its expense, and
 * every other pair involving either is dropped — not weakened,
 * dropped, because a receipt already spoken for by an exact match
 * is not a plausible second answer, it is noise.
 *
 * Deliberately NOT dropped:
 *   · a candidate that agrees on only two of the three, which is
 *     the genuine "which of these is it" question;
 *   · a split purchase, where the receipt's total is the whole
 *     and the expense is a share — the totals differ, so it never
 *     claims, and the conflict still reaches a person.
 *
 * Best-first, so when two identical expenses face two identical
 * receipts each takes one rather than both chasing the same.
 */
export function resolveOneToOne(found: Candidate[]): Candidate[] {
  const ranked = [...found].sort((a, b) =>
    b.score - a.score
    || a.dedupeKey.localeCompare(b.dedupeKey)
    || a.messageId.localeCompare(b.messageId));
  const claimedMessage = new Set<string>();
  const claimedExpense = new Set<string>();
  const kept: Candidate[] = [];
  for (const c of ranked) {
    if (claimedMessage.has(c.messageId) || claimedExpense.has(c.dedupeKey)) continue;
    if (!isSure(c)) { kept.push(c); continue; }
    claimedMessage.add(c.messageId);
    claimedExpense.add(c.dedupeKey);
    kept.push({ ...c, reasons: [...c.reasons, SURE_REASON] });
  }
  return kept;
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

/**
 * Candidates that a fresh scan no longer stands behind.
 *
 * Without this a re-scan can only ever ADD. The user pressed
 * Search again after the matcher was tightened and the count did
 * not move, because every one of the old pairs was still sitting
 * in the table in state `candidate` — the new, smaller answer was
 * written on top of a list nothing ever removed from.
 *
 * Only `candidate` rows go. A chosen, rejected, attached or
 * failed row is somebody's decision or an attempt that happened,
 * and a re-scan is not an argument against either.
 */
export async function pruneCandidates(
  lanes: string[], keep: Candidate[],
): Promise<number> {
  await ensure();
  if (lanes.length === 0) return 0;
  // Two parallel arrays rather than a joined-up key: Postgres text
  // cannot hold a NUL, and any printable separator is a separator
  // that could turn up inside a Graph message id.
  const keys = keep.map((c) => c.dedupeKey);
  const ids = keep.map((c) => c.messageId);
  const { rowCount } = await db().query(
    `DELETE FROM receipt_mail_matches m
      WHERE m.lane = ANY($1::text[])
        AND m.state = 'candidate'
        AND NOT EXISTS (
              SELECT 1 FROM unnest($2::text[], $3::text[]) AS k(dedupe_key, message_id)
               WHERE k.dedupe_key = m.dedupe_key AND k.message_id = m.message_id)`,
    [lanes, keys, ids]);
  return rowCount ?? 0;
}

export type StoredMatch = Candidate & {
  state: "candidate" | "chosen" | "rejected" | "attached" | "failed";
  decidedBy: string;
  decidedAt: string | null;
  foundAt: string;
  /** The receipt, once it is in the app. Null until it is pulled in. */
  linkedSha256: string | null;
  /** Why the pull did not work, when it did not. */
  linkError: string;
};

export async function matchesFor(
  lane: string | null, state?: string,
): Promise<StoredMatch[]> {
  await ensure();
  const { rows } = await db().query<{
    dedupe_key: string; message_id: string; lane: string; confidence: string;
    score: number; reasons: unknown; evidence: unknown; state: string;
    decided_by: string; decided_at: Date | null; found_at: Date;
    linked_sha256: string | null; link_error: string;
  }>(
    `SELECT dedupe_key, message_id, lane, confidence, score, reasons, evidence, state,
            decided_by, decided_at, found_at, linked_sha256, link_error
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
    linkedSha256: r.linked_sha256,
    linkError: r.link_error ?? "",
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

/**
 * Record that the receipt is now in the app, or why it is not.
 *
 * Kept on the match rather than only in `expense_receipts` so a
 * failed pull has somewhere to say so. A link that silently did
 * not happen looks exactly like one that did from a list of
 * chosen matches.
 */
export async function noteLink(
  dedupeKey: string, messageId: string, hash: string | null, error = "",
): Promise<void> {
  await ensure();
  await db().query(
    `UPDATE receipt_mail_matches SET linked_sha256 = $3, link_error = $4
      WHERE dedupe_key = $1 AND message_id = $2`,
    [dedupeKey, messageId, hash, error.slice(0, 400)]);
}

/** Drop a removed person's settings. Matches cascade with their expenses. */
export async function forgetMailSettings(userEmail: string): Promise<void> {
  await ensure();
  await db().query("DELETE FROM receipt_mail_settings WHERE lower(user_email) = lower($1)",
    [userEmail]);
}
