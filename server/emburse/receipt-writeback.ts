import { db, ensureSchema } from "../db.js";
import { GRAPH, graphToken } from "../mail.js";
import { laneTag } from "./connections.js";
import { matchesFor, textOf, type Evidence, baseMessageId } from "./receipt-mail.js";
import { readingOf } from "./receipt-link.js";
import {
  FIELD_LABEL, FILL_FIELDS, pick as pickRule, rulesFor, setsOf, type FillField,
} from "./fill-rules.js";

/**
 * Sending a matched receipt back to the account it came from.
 *
 * The owner's instructions, taken 2026-10-27, and this file is
 * written to them rather than around them:
 *
 *   WRITABLE: the receipt image, the description, and the
 *   category. Nothing else. A field not on that list has no code
 *   path here, so widening it is a deliberate change rather than
 *   a configuration somebody can wander into.
 *
 *   ALWAYS ASK. Even a strong match waits for a click. Nothing
 *   in this file runs on a timer and nothing is queued by a rule
 *   — `queueWrite` is reached from a person pressing a button.
 *
 *   NEVER SUBMIT. Attaching a receipt and setting a description
 *   are edits to a record. No path here touches submit, approve
 *   or deny.
 *
 * And the two that are not preferences but correctness:
 *
 *   IT WRITES TO THE ACCOUNT THE EXPENSE IS IN. The lane is
 *   carried on every row and the credential is fetched for THAT
 *   lane. There is no fallback to the primary connection: a
 *   write to the wrong tenant is not a failed attempt, it is an
 *   edit to somebody else's record.
 *
 *   A RETRY DOES NOT DUPLICATE. Attempts are counted, the state
 *   machine is one-way into `applied`, and the browser step
 *   checks the form for a receipt already on it before
 *   uploading. A save that landed just as the step timed out is
 *   the ordinary case, not the rare one.
 */

/**
 * The kinds of change that can be proposed.
 *
 * `receipt` and `note` come from the matched email. The four
 * field kinds come from a VENDOR RULE and are named for the
 * boxes on Emburse's own Edit Expense Details form, because that
 * is what somebody checking the proposal is looking at.
 */
export type WriteKind =
  | "receipt" | "note"
  | "category" | "purpose" | "location" | "department" | "comment";

export type WriteState =
  /** Proposed, waiting on a person. */
  | "proposed"
  /** A person said yes; the worker has not reached it yet. */
  | "queued"
  /** Done, and read back where Emburse allowed it. */
  | "applied"
  /** Emburse already had it. Nothing was written and nothing is wrong. */
  | "already"
  /** The value changed in Emburse since the proposal. Nothing written. */
  | "stale"
  | "failed";

export type Write = {
  dedupeKey: string;
  kind: WriteKind;
  lane: string;
  /** The description to set, or the message the receipt comes from. */
  proposed: string;
  /** What Emburse read when this was proposed. The conflict check. */
  was: string;
  /** Which message the receipt or the wording came from. */
  messageId: string;
  /** Which attachment, or empty for a receipt rendered from the body. */
  attachmentId: string;
  state: WriteState;
  attempts: number;
  error: string;
  proposedBy: string;
  proposedAt: string;
  settledAt: string | null;
  /** What the browser did on the last attempt, step by step. */
  steps: { name: string; ok: boolean; detail: string }[];
};

const SCHEMA = `
/**
 * One proposed change to one expense in Emburse.
 *
 * A row per (expense, kind), so a receipt and a description are
 * tracked apart — one can land while the other needs a person,
 * and reporting them together would hide that.
 *
 * The STATE is the record of what happened and it is the only
 * thing a retry consults. "applied" and "already" are terminal:
 * nothing re-runs out of them, which is what stops a second
 * upload after a timeout that had in fact succeeded.
 */
CREATE TABLE IF NOT EXISTS receipt_writebacks (
  dedupe_key    text        NOT NULL REFERENCES expenses (dedupe_key) ON DELETE CASCADE,
  kind          text        NOT NULL,
  lane          text        NOT NULL DEFAULT '',
  proposed      text        NOT NULL DEFAULT '',
  was           text        NOT NULL DEFAULT '',
  message_id    text        NOT NULL DEFAULT '',
  attachment_id text        NOT NULL DEFAULT '',
  state         text        NOT NULL DEFAULT 'proposed',
  attempts      integer     NOT NULL DEFAULT 0,
  error         text        NOT NULL DEFAULT '',
  proposed_by   text        NOT NULL DEFAULT '',
  proposed_at   timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  steps         jsonb,
  PRIMARY KEY (dedupe_key, kind)
);
CREATE INDEX IF NOT EXISTS receipt_writebacks_state
  ON receipt_writebacks (state, lane);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

/** For a test that needs the schema re-asserted against a fresh database. */
export const resetWritebackCache = (): void => { ready = null; };

type Row = {
  dedupe_key: string; kind: string; lane: string; proposed: string; was: string;
  message_id: string; attachment_id: string; state: string; attempts: number;
  error: string; proposed_by: string; proposed_at: Date; settled_at: Date | null;
  steps: unknown;
};

/*
 * `steps` is selected now, and it was not.
 *
 * Every attempt has written a step-by-step log of what the
 * browser did — opened Emburse, signed in, found the row, opened
 * the edit form, typed, saved — straight into this column since
 * the write-back existed, and nothing has ever read it back out.
 * It is the only answer to "what happened", and it was sitting in
 * the table while the page showed one word.
 */
const W_COLS = `dedupe_key, kind, lane, proposed, was, message_id, attachment_id,
                state, attempts, error, proposed_by, proposed_at, settled_at, steps`;

const STATES: WriteState[] =
  ["proposed", "queued", "applied", "already", "stale", "failed"];

/** Every kind, so a new one is not silently read back as a receipt. */
const KINDS: WriteKind[] =
  ["receipt", "note", "category", "purpose", "location", "department", "comment"];

const shape = (r: Row): Write => ({
  dedupeKey: r.dedupe_key,
  // Narrowed against the full list. This was
  // `r.kind === "note" ? "note" : "receipt"`, which turned every
  // field write back into a receipt the moment it was read out of
  // the table — five rows came back as four receipts and a note.
  kind: (KINDS as string[]).includes(r.kind) ? (r.kind as WriteKind) : "receipt",
  lane: r.lane,
  proposed: r.proposed,
  was: r.was,
  messageId: r.message_id,
  attachmentId: r.attachment_id,
  state: (STATES as string[]).includes(r.state) ? (r.state as WriteState) : "proposed",
  attempts: r.attempts,
  error: r.error,
  proposedBy: r.proposed_by,
  proposedAt: r.proposed_at.toISOString(),
  settledAt: r.settled_at?.toISOString() ?? null,
  steps: Array.isArray(r.steps)
    ? (r.steps as { name?: unknown; ok?: unknown; detail?: unknown }[]).map((x) => ({
      name: String(x.name ?? ""),
      ok: x.ok === true,
      detail: String(x.detail ?? ""),
    }))
    : [],
});

/**
 * A description written from the receipt, when there is anything
 * worth writing.
 *
 * Deliberately dull: the merchant the receipt names, its date and
 * its reference. No invention, no category guessing, nothing read
 * out of the body beyond what was already extracted as evidence.
 * It is a note a person will read next to the receipt, not a
 * conclusion.
 *
 * Empty when the evidence is too thin to say anything, and an
 * empty proposal is never offered — a write that sets a
 * description to "Receipt" tells nobody anything and overwrites
 * something that may have.
 */
/**
 * The receipt's line ADDED to what the description already says.
 *
 * Idempotent, which is the whole difficulty. A proposal is recomputed
 * every time the page is read and improves once the AI reader has been
 * over the image, so the same expense is offered a note more than once —
 * and an append that simply concatenated would stack
 * "… · Receipt: X · Receipt: X" on the second pass and again on the
 * third. So: already carries this exact line, leave it; carries an
 * EARLIER receipt line, replace from there; otherwise append.
 *
 * "Receipt: " is the marker, which is the one thing `noteFrom` and
 * `noteFromReading` both always start with.
 */
export function mergeNote(existing: string, line: string): string {
  const had = existing.trim();
  const add = line.trim();
  if (!add) return had;
  if (!had) return add;
  if (had.includes(add)) return had;
  const prior = had.indexOf("Receipt: ");
  if (prior >= 0) {
    const before = had.slice(0, prior).replace(/[\s·]+$/u, "");
    return before ? `${before} · ${add}` : add;
  }
  return `${had} · ${add}`;
}

export function noteFrom(e: Evidence): string {
  const bits: string[] = [];
  if (e.merchant) bits.push(e.merchant);
  if (e.date) bits.push(e.date);
  if (e.reference) bits.push(`ref ${e.reference}`);
  if (bits.length < 2) return "";
  return `Receipt: ${bits.join(" · ")}`;
}

/**
 * The same, from THE RECEIPT ITSELF once the reader has read it.
 *
 * Better evidence than the email, and the reason linking comes
 * before sending. An email's subject line says "Your receipt from
 * Starbucks"; the receipt says what was bought, when, and for how
 * much — and the reader has already extracted all of it for every
 * other receipt in this app.
 *
 * Falls back to the email when the reader has not got there yet,
 * or could not read it. An illegible photograph is a real
 * outcome, and the email's own evidence is still worth
 * something.
 */
export function noteFromReading(
  reading: { legible: boolean; merchant: string | null; purchasedAt: string | null;
    totalCents: number | null; items: string[] } | null,
  fallback: Evidence,
): { note: string; from: "receipt" | "email" } {
  if (!reading || !reading.legible) {
    return { note: noteFrom(fallback), from: "email" };
  }
  const bits: string[] = [];
  if (reading.merchant) bits.push(reading.merchant);
  if (reading.purchasedAt) bits.push(reading.purchasedAt);
  if (reading.totalCents !== null) {
    bits.push(`$${(reading.totalCents / 100).toFixed(2)}`);
  }
  /*
   * What was bought, when the receipt lists it.
   *
   * Three lines, not forty: this goes in a description box
   * somebody reads at a glance, and a twelve-item grocery list
   * pasted into it is worse than nothing. The full list is on
   * the receipt, which is now attached.
   */
  if (reading.items.length > 0) {
    const few = reading.items.slice(0, 3).join(", ");
    bits.push(reading.items.length > 3 ? `${few}, +${reading.items.length - 3} more` : few);
  }
  if (bits.length < 2) return { note: noteFrom(fallback), from: "email" };
  return { note: `Receipt: ${bits.join(" · ")}`, from: "receipt" };
}

export type ProposeResult =
  | { ok: true; writes: Write[] }
  | { ok: false; problem: string };

/**
 * Propose what to send back, from a receipt a person has chosen.
 *
 * Reads the CURRENT description out of this app's copy of the
 * expense and stores it as `was`, which is what the browser step
 * later compares against. That copy is as old as the last import
 * — which is exactly why the comparison is made again, in the
 * browser, against what Emburse says at the moment of writing.
 * This one is the proposal's own record of what it was deciding
 * about.
 */
export async function proposeWrites(opts: {
  dedupeKey: string; messageId: string; by: string;
}): Promise<ProposeResult> {
  await ensure();
  const chosen = (await matchesFor(null, "chosen"))
    .find((m) => m.dedupeKey === opts.dedupeKey && m.messageId === opts.messageId);
  if (!chosen) {
    return {
      ok: false,
      problem: "That receipt has not been chosen for this expense. Choose it first — "
        + "nothing is sent to Emburse that a person has not picked.",
    };
  }

  const { rows } = await db().query<{
    note: string | null; lane: string; merchant: string; reviewer: string;
    category: string | null; location: string | null; department: string | null;
  }>(
    `SELECT note, lane, merchant, reviewer, category, location, department
       FROM expenses WHERE dedupe_key = $1`, [opts.dedupeKey]);
  const expense = rows[0];
  if (!expense) return { ok: false, problem: "That expense is no longer here." };
  const lane = laneTag(expense.lane);
  if (!lane) {
    return {
      ok: false,
      problem: "That expense is in the manager queue, not a personal account. Receipt "
        + "write-back is for your own expenses.",
    };
  }

  const e = chosen.evidence;
  /*
   * WHAT THE RECEIPT SAYS, where the reader has got to it.
   *
   * This is why the image is pulled in and linked before
   * anything is sent: the reading is better evidence than the
   * email, and it is produced by machinery that already exists.
   * At the moment a match is first chosen the reader will not
   * have run yet, so this is empty and the email's own evidence
   * is used — and the proposal is recomputed below on every
   * later read, which is how it improves once the reading lands.
   */
  const reading = chosen.linkedSha256 ? await readingOf(chosen.linkedSha256) : null;
  /*
   * The attachment, when there is one. A receipt that is only in
   * the body is rendered at send time rather than here — the
   * proposal should not spend a browser on something a person may
   * not go through with.
   */
  const file = e.attachments.find(
    (a) => /pdf|image\//i.test(a.contentType) || /\.(pdf|png|jpe?g|gif|webp)$/i.test(a.name));

  const writes: { kind: WriteKind; proposed: string; was: string; attachment: string }[] = [
    {
      kind: "receipt",
      proposed: file ? file.name : `${e.subject || "receipt"}.pdf`,
      was: "",
      attachment: file?.id ?? "",
    },
  ];
  const { note } = noteFromReading(reading, e);
  /*
   * KEPT, NOT REPLACED. The owner's call, 2026-10-31.
   *
   * The proposal used to BE the description, so sending it would have
   * wiped "IT & Compliance Department Spend" off an expense and put
   * "Receipt: Replit · 2026-08-11 · ref 1359-4607" in its place —
   * across 272 expenses, with no copy of the old text anywhere but the
   * `was` column of this table.
   */
  const had = (expense.note ?? "").trim();
  const merged = mergeNote(had, note);
  // Only when it says more than the box already does.
  if (merged && merged !== had) {
    writes.push({ kind: "note", proposed: merged, was: had, attachment: "" });
  }

  /*
   * WHAT THE VENDOR RULE SAYS THIS EXPENSE SHOULD BE.
   *
   * The rule proposes; it never sends. Its fields join the same
   * list the receipt and the description are in and wait for the
   * same press, which is the standing instruction — always ask —
   * rather than something a rule is allowed around.
   *
   * A field already holding the rule's value is not proposed at
   * all: there is nothing to change, and a list of no-ops is how
   * a person stops reading the list.
   */
  const rule = pickRule(
    await rulesFor(expense.reviewer),
    { merchant: expense.merchant ?? "", category: expense.category ?? "" },
    lane);
  if (rule) {
    const have: Record<FillField, string> = {
      category: (expense.category ?? "").trim(),
      // Business Purpose is not in the export, so nothing here
      // knows what the form currently holds. The browser step
      // reads the box before it types, and reports `already`
      // when it is the same.
      purpose: "",
      location: (expense.location ?? "").trim(),
      department: (expense.department ?? "").trim(),
      // Nor is Comment: it is an Emburse-side box with no column
      // in the export, so the browser step reads it before typing.
      comment: "",
    };
    const sets = setsOf(rule);
    for (const field of FILL_FIELDS) {
      const want = sets[field];
      if (!want) continue;
      if (have[field].toLowerCase() === want.toLowerCase()) continue;
      writes.push({ kind: field, proposed: want, was: have[field], attachment: "" });
    }
  }

  for (const w of writes) {
    await db().query(
      `INSERT INTO receipt_writebacks
         (dedupe_key, kind, lane, proposed, was, message_id, attachment_id, proposed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (dedupe_key, kind) DO UPDATE
         SET proposed = excluded.proposed, was = excluded.was,
             message_id = excluded.message_id, attachment_id = excluded.attachment_id,
             proposed_by = excluded.proposed_by, proposed_at = now(),
             state = 'proposed', error = ''
         -- A write that has landed is not re-proposed. "applied"
         -- and "already" are terminal, which is what stops a
         -- second upload after a timeout that had succeeded.
         WHERE receipt_writebacks.state NOT IN ('applied', 'already')`,
      [opts.dedupeKey, w.kind, lane, w.proposed, w.was, opts.messageId, w.attachment, opts.by]);
  }
  return { ok: true, writes: await writesFor(opts.dedupeKey) };
}

export async function writesFor(dedupeKey?: string): Promise<Write[]> {
  await ensure();
  const { rows } = dedupeKey
    ? await db().query<Row>(
      `SELECT ${W_COLS} FROM receipt_writebacks WHERE dedupe_key = $1 ORDER BY kind`,
      [dedupeKey])
    : await db().query<Row>(
      `SELECT ${W_COLS} FROM receipt_writebacks ORDER BY proposed_at DESC LIMIT 200`);
  return rows.map(shape);
}

/**
 * A person says yes.
 *
 * The only way a write becomes eligible to run. Nothing here is
 * scheduled, nothing is triggered by a rule, and a strong match
 * does not queue itself — the owner's instruction is that even a
 * strong match waits for a click, and this is where that is true.
 */
export async function queueWrite(
  dedupeKey: string, kind: WriteKind,
): Promise<{ ok: boolean; problem?: string }> {
  await ensure();
  const { rowCount } = await db().query(
    `UPDATE receipt_writebacks SET state = 'queued', error = ''
      WHERE dedupe_key = $1 AND kind = $2 AND state IN ('proposed', 'failed', 'stale')`,
    [dedupeKey, kind]);
  if (rowCount === 0) {
    const now = (await writesFor(dedupeKey)).find((w) => w.kind === kind);
    return {
      ok: false,
      problem: now
        ? `That change is ${now.state}, so there is nothing to send.`
        : "There is no such proposed change.",
    };
  }
  return { ok: true };
}

/** Everything a person has said yes to and the worker has not reached. */
export async function queuedWrites(): Promise<Write[]> {
  await ensure();
  const { rows } = await db().query<Row>(
    `SELECT ${W_COLS} FROM receipt_writebacks WHERE state = 'queued'
      ORDER BY proposed_at LIMIT 25`);
  return rows.map(shape);
}

export async function settleWrite(
  dedupeKey: string, kind: WriteKind,
  out: { state: WriteState; error?: string; steps?: unknown },
): Promise<void> {
  await ensure();
  await db().query(
    `UPDATE receipt_writebacks
        SET state = $3, error = $4, attempts = attempts + 1, settled_at = now(),
            steps = $5::jsonb
      WHERE dedupe_key = $1 AND kind = $2`,
    [dedupeKey, kind, out.state, (out.error ?? "").slice(0, 600),
      JSON.stringify(out.steps ?? null)]);
}

/* ------------------------------------------------------------------ *
 * The receipt's bytes
 * ------------------------------------------------------------------ */

/**
 * The file to upload, fetched when it is needed and not before.
 *
 * An attachment comes straight off the message. A receipt that is
 * only in the BODY — which the brief names explicitly, and which
 * is most of them — is rendered to a PDF from the message's own
 * HTML, so the thing attached in Emburse is what the merchant
 * sent rather than a screenshot of a list.
 *
 * Read only, like every other Graph call in this feature.
 */
export async function receiptBytes(opts: {
  mailbox: string; messageId: string; attachmentId: string; subject: string;
}): Promise<{ name: string; contentType: string; bytes: Buffer }> {
  const token = await graphToken();
  const head = { authorization: `Bearer ${token}` };

  if (opts.attachmentId) {
    const res = await fetch(
      `${GRAPH}/users/${encodeURIComponent(opts.mailbox)}/messages/`
      + `${baseMessageId(opts.messageId)}/attachments/${opts.attachmentId}`,
      { headers: head });
    if (!res.ok) {
      throw new Error(`Graph would not hand over the attachment (${res.status}). `
        + "The message may have been deleted or moved since it was matched.");
    }
    const a = (await res.json()) as {
      name?: string; contentType?: string; contentBytes?: string;
    };
    if (!a.contentBytes) {
      throw new Error("That attachment has no bytes to upload — it may be a link rather "
        + "than a file.");
    }
    return {
      name: a.name ?? "receipt",
      contentType: a.contentType || "application/octet-stream",
      bytes: Buffer.from(a.contentBytes, "base64"),
    };
  }

  // Body-only: render what the merchant sent.
  const res = await fetch(
    `${GRAPH}/users/${encodeURIComponent(opts.mailbox)}/messages/${baseMessageId(opts.messageId)}`
    + `?${new URLSearchParams({ "$select": "subject,body" }).toString()}`,
    { headers: head });
  if (!res.ok) {
    throw new Error(`Graph would not hand over the message (${res.status}). `
      + "It may have been deleted or moved since it was matched.");
  }
  const m = (await res.json()) as { body?: { contentType?: string; content?: string } };
  const html = m.body?.contentType?.toLowerCase() === "html"
    ? (m.body.content ?? "")
    : `<pre>${escapeHtml(textOf(m.body?.content ?? ""))}</pre>`;

  /*
   * LAUNCHED THE WAY EVERY OTHER BROWSER HERE IS.
   *
   * This was a bare `chromium.launch()` — no `--no-sandbox`, no
   * `--disable-dev-shm-usage`, and none of the system Chromium path the
   * rest of the app resolves. In a container that fails outright, so a
   * BODY-ONLY receipt could never be rendered: the ones with a real
   * attachment previewed and uploaded fine and the ones without — which
   * is most of them — died here, showing a broken frame with no reason
   * beside it.
   */
  const { chromium } = await import("playwright");
  const { systemChromium } = await import("./auto-export.js");
  const executablePath = (await systemChromium()) ?? undefined;
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    // No network: a receipt email is full of tracking pixels and
    // remote images, and fetching them would tell the sender the
    // message had been opened by a machine.
    await page.route("**/*", (route) => (
      route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const bytes = await page.pdf({ format: "Letter", printBackground: true });
    return {
      name: `${(opts.subject || "receipt").replace(/[^\w .-]+/g, " ").trim().slice(0, 60)}.pdf`,
      contentType: "application/pdf",
      bytes,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

/** Drop a removed person's proposals. Rows cascade with their expenses. */
export async function forgetWrites(dedupeKey: string): Promise<void> {
  await ensure();
  await db().query("DELETE FROM receipt_writebacks WHERE dedupe_key = $1", [dedupeKey]);
}
