import { createHash, randomBytes } from "node:crypto";
import { db, ensureSchema } from "../db.js";

/**
 * Account Registration — one partner's business record.
 *
 * The PAGE is shared: one implementation, one set of fields, one
 * workflow, improved in one place. The RECORD is the account's and is
 * never visible across one. That line is the whole design, and every
 * function here takes an account id for it.
 *
 * FIVE STATES, and they are about the SUBMISSION rather than about
 * the individual checks:
 *
 *   draft                 being filled in. Saves freely, validates nothing.
 *   verification-pending  submitted, but a check is outstanding.
 *   submitted             with MOJO, waiting on a person.
 *   changes-requested     sent back, with what to fix. Still editable.
 *   approved              done.
 *
 * The verification items keep their OWN states beside that, because
 * they answer different questions: "has this address been proved" is
 * not "is this registration finished", and collapsing the two would
 * mean a resubmission silently un-verifying an email.
 *
 * WHAT IS NOT COLLECTED, deliberately: tax IDs, bank details, card
 * numbers. None of them is needed to say a dealership is who it says
 * it is, and a field that exists is a field that gets filled in.
 */

export const BUSINESS_STATUSES = [
  "draft", "verification-pending", "submitted", "changes-requested", "approved",
] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export const BUSINESS_TYPES = [
  "Sole proprietorship", "Partnership", "LLC", "S corporation", "C corporation",
  "Non-profit", "Other",
] as const;

/** The agreement as it stands. Shipped with the code, versioned by hand. */
export const AGREEMENT = {
  version: "2026-10-01",
  title: "MOJO Partner Agreement",
  body: [
    "The partner will apply RFID tags only to vehicles enrolled through this "
      + "application, and only in the position the RFID Instructions page states.",
    "The partner will keep member records accurate and will tell MOJO promptly "
      + "when a membership ends or a vehicle changes.",
    "The partner will not share access to this application with anybody MOJO has "
      + "not invited through Users & Access.",
    "MOJO may suspend a partner account, which keeps every record and blocks "
      + "operational access until it is resumed.",
  ],
} as const;

export type BusinessFields = {
  legalName: string;
  dba: string;
  businessType: string;
  website: string;
  address1: string;
  city: string;
  state: string;
  postalCode: string;
  businessPhone: string;
  businessEmail: string;
  contactName: string;
  contactTitle: string;
  contactEmail: string;
  contactPhone: string;
};

export const BLANK_BUSINESS: BusinessFields = {
  legalName: "", dba: "", businessType: "", website: "",
  address1: "", city: "", state: "", postalCode: "",
  businessPhone: "", businessEmail: "",
  contactName: "", contactTitle: "", contactEmail: "", contactPhone: "",
};

/** Label and requiredness in one place, so the form and the server agree. */
export const BUSINESS_FIELDS: {
  key: keyof BusinessFields; label: string; required: boolean; bucket: string;
}[] = [
  { key: "legalName", label: "Legal business name", required: true, bucket: "business" },
  { key: "dba", label: "Doing business as (DBA)", required: false, bucket: "business" },
  { key: "businessType", label: "Business type", required: true, bucket: "business" },
  { key: "website", label: "Website", required: false, bucket: "business" },
  { key: "address1", label: "Street address", required: true, bucket: "business" },
  { key: "city", label: "City", required: true, bucket: "business" },
  { key: "state", label: "State", required: true, bucket: "business" },
  { key: "postalCode", label: "ZIP code", required: true, bucket: "business" },
  { key: "businessPhone", label: "Business phone", required: true, bucket: "business" },
  { key: "businessEmail", label: "Business email", required: true, bucket: "business" },
  { key: "contactName", label: "Full name", required: true, bucket: "contact" },
  { key: "contactTitle", label: "Job title", required: false, bucket: "contact" },
  { key: "contactEmail", label: "Work email", required: true, bucket: "contact" },
  { key: "contactPhone", label: "Phone", required: true, bucket: "contact" },
];

export type DocumentState =
  | "not-requested" | "requested" | "uploaded" | "under-review"
  | "approved" | "needs-correction";

export type BusinessRecord = {
  accountId: string;
  fields: BusinessFields;
  status: BusinessStatus;
  /** The address proved, which is not always the one in the form now. */
  verifiedEmail: string;
  verifiedAt: string | null;
  /** A link is outstanding for this address. */
  pendingEmail: string;
  pendingSentAt: string | null;
  documentState: DocumentState;
  documentNote: string;
  agreementVersion: string;
  agreementAcceptedAt: string | null;
  agreementAcceptedBy: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string;
  updatedAt: string | null;
  updatedBy: string;
};

const SCHEMA = `
/**
 * One row per partner. The record is the account's; the page is not.
 *
 * The verified address is kept SEPARATELY from the one in the form,
 * because they come apart the moment somebody edits the form: the
 * proof belongs to the address that was proved, and silently carrying
 * it over to a new one would make the check worthless.
 */
CREATE TABLE IF NOT EXISTS dm_business (
  account_id            text        PRIMARY KEY,
  fields                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status                text        NOT NULL DEFAULT 'draft',
  verified_email        text        NOT NULL DEFAULT '',
  verified_at           timestamptz,
  pending_email         text        NOT NULL DEFAULT '',
  pending_sent_at       timestamptz,
  document_state        text        NOT NULL DEFAULT 'not-requested',
  document_note         text        NOT NULL DEFAULT '',
  agreement_version     text        NOT NULL DEFAULT '',
  agreement_accepted_at timestamptz,
  agreement_accepted_by text,
  submitted_at          timestamptz,
  submitted_by          text,
  decided_at            timestamptz,
  decided_by            text,
  decision_note         text        NOT NULL DEFAULT '',
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text        NOT NULL DEFAULT ''
);

/**
 * The outstanding verification link, hashed.
 *
 * Never stored in the clear, like every other token here. One live
 * link per account: asking again replaces the previous one, so a
 * forwarded old link stops working the moment somebody resends.
 */
CREATE TABLE IF NOT EXISTS dm_business_verify (
  account_id text        PRIMARY KEY,
  email      text        NOT NULL,
  token_hash text        NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

/**
 * Proof of business, when MOJO has asked for it.
 *
 * The bytes live here rather than on a disk the deployment rebuilds.
 * One live document per account — a replacement supersedes rather
 * than piling up, because "which of these four is the current
 * licence" is a question nobody should have to answer.
 */
CREATE TABLE IF NOT EXISTS dm_business_documents (
  id           bigserial   PRIMARY KEY,
  account_id   text        NOT NULL,
  filename     text        NOT NULL,
  content_type text        NOT NULL DEFAULT 'application/octet-stream',
  bytes        bytea       NOT NULL,
  size_bytes   integer     NOT NULL DEFAULT 0,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  uploaded_by  text        NOT NULL DEFAULT '',
  superseded_at timestamptz
);
CREATE INDEX IF NOT EXISTS dm_business_documents_live
  ON dm_business_documents (account_id, superseded_at);
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

/** For a test that needs the schema re-asserted against a fresh database. */
export const resetBusinessCache = (): void => { ready = null; };

type Db = {
  account_id: string; fields: unknown; status: BusinessStatus;
  verified_email: string; verified_at: Date | null;
  pending_email: string; pending_sent_at: Date | null;
  document_state: DocumentState; document_note: string;
  agreement_version: string; agreement_accepted_at: Date | null;
  agreement_accepted_by: string | null;
  submitted_at: Date | null; submitted_by: string | null;
  decided_at: Date | null; decided_by: string | null; decision_note: string;
  updated_at: Date; updated_by: string;
};

const COLS = `account_id, fields, status, verified_email, verified_at, pending_email,
  pending_sent_at, document_state, document_note, agreement_version,
  agreement_accepted_at, agreement_accepted_by, submitted_at, submitted_by,
  decided_at, decided_by, decision_note, updated_at, updated_by`;

const fieldsOf = (raw: unknown): BusinessFields => {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out = { ...BLANK_BUSINESS };
  for (const f of BUSINESS_FIELDS) {
    const v = o[f.key];
    if (typeof v === "string") out[f.key] = v;
  }
  return out;
};

const shape = (r: Db): BusinessRecord => ({
  accountId: r.account_id,
  fields: fieldsOf(r.fields),
  status: r.status,
  verifiedEmail: r.verified_email,
  verifiedAt: r.verified_at?.toISOString() ?? null,
  pendingEmail: r.pending_email,
  pendingSentAt: r.pending_sent_at?.toISOString() ?? null,
  documentState: r.document_state,
  documentNote: r.document_note,
  agreementVersion: r.agreement_version,
  agreementAcceptedAt: r.agreement_accepted_at?.toISOString() ?? null,
  agreementAcceptedBy: r.agreement_accepted_by,
  submittedAt: r.submitted_at?.toISOString() ?? null,
  submittedBy: r.submitted_by,
  decidedAt: r.decided_at?.toISOString() ?? null,
  decidedBy: r.decided_by,
  decisionNote: r.decision_note,
  updatedAt: r.updated_at.toISOString(),
  updatedBy: r.updated_by,
});

/** An empty draft, not a row. Opening the page must not write anything. */
const EMPTY = (accountId: string): BusinessRecord => ({
  accountId,
  fields: { ...BLANK_BUSINESS },
  status: "draft",
  verifiedEmail: "", verifiedAt: null,
  pendingEmail: "", pendingSentAt: null,
  documentState: "not-requested", documentNote: "",
  agreementVersion: "", agreementAcceptedAt: null, agreementAcceptedBy: null,
  submittedAt: null, submittedBy: null,
  decidedAt: null, decidedBy: null, decisionNote: "",
  updatedAt: null, updatedBy: "",
});

/**
 * One partner's registration.
 *
 * An account with nothing filled in gets a usable empty draft rather
 * than a null or an invented example. Opening the page writes no row
 * and sends no email, which is the difference between reading a form
 * and starting a process.
 */
export async function getBusiness(accountId: string): Promise<BusinessRecord> {
  await ensure();
  const { rows } = await db().query<Db>(
    `SELECT ${COLS} FROM dm_business WHERE account_id = $1`, [accountId]);
  return rows[0] ? shape(rows[0]) : EMPTY(accountId);
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;

const digits = (v: string): string => v.replace(/\D+/g, "");

/** Formatted once, here, so the form, the record and the email agree. */
export function formatPhone(raw: string): string {
  const t = raw.trim();
  if (t === "") return "";
  if (/[A-Za-z]/.test(t)) return t;
  const d = digits(t);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) {
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  return t;
}

export function cleanBusiness(raw: Partial<BusinessFields>): BusinessFields {
  const t = (v: unknown) => String(v ?? "").trim();
  return {
    legalName: t(raw.legalName).slice(0, 120),
    dba: t(raw.dba).slice(0, 120),
    businessType: t(raw.businessType).slice(0, 40),
    website: t(raw.website).slice(0, 200),
    address1: t(raw.address1).slice(0, 160),
    city: t(raw.city).slice(0, 80),
    state: t(raw.state).toUpperCase().slice(0, 2),
    postalCode: t(raw.postalCode).slice(0, 10),
    businessPhone: formatPhone(t(raw.businessPhone)).slice(0, 40),
    businessEmail: t(raw.businessEmail).toLowerCase().slice(0, 160),
    contactName: t(raw.contactName).slice(0, 120),
    contactTitle: t(raw.contactTitle).slice(0, 80),
    contactEmail: t(raw.contactEmail).toLowerCase().slice(0, 160),
    contactPhone: formatPhone(t(raw.contactPhone)).slice(0, 40),
  };
}

/**
 * What is wrong with it.
 *
 * `forSubmission` is the difference between saving a draft and
 * sending it: a draft is allowed to be half-finished, because the
 * whole point of a draft is that somebody can come back to it. A
 * malformed value is wrong either way, and is reported either way —
 * catching a mistyped address at the keyboard beats discovering it
 * when the verification link bounces.
 */
export function validateBusiness(
  f: BusinessFields, forSubmission: boolean,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (forSubmission) {
    for (const spec of BUSINESS_FIELDS) {
      if (spec.required && f[spec.key] === "") {
        errors[spec.key] = `${spec.label} is required.`;
      }
    }
  }
  if (f.businessEmail !== "" && !EMAIL_RE.test(f.businessEmail)) {
    errors.businessEmail = "That is not an email address.";
  }
  if (f.contactEmail !== "" && !EMAIL_RE.test(f.contactEmail)) {
    errors.contactEmail = "That is not an email address.";
  }
  if (f.postalCode !== "" && !ZIP_RE.test(f.postalCode)) {
    errors.postalCode = "A ZIP code is five digits, or five plus four.";
  }
  if (f.state !== "" && !/^[A-Z]{2}$/.test(f.state)) {
    errors.state = "Use the two-letter state code.";
  }
  if (f.businessPhone !== "" && digits(f.businessPhone).length < 10) {
    errors.businessPhone = "A phone number needs at least ten digits.";
  }
  if (f.contactPhone !== "" && digits(f.contactPhone).length < 10) {
    errors.contactPhone = "A phone number needs at least ten digits.";
  }
  if (f.website !== "" && !/^(https?:\/\/)?[\w-]+(\.[\w-]+)+/.test(f.website)) {
    errors.website = "That is not a web address.";
  }
  return errors;
}

/**
 * What is stopping a submission, in the order somebody should fix it.
 *
 * Reported rather than guessed at, and reported WITHOUT discarding
 * the draft: a submission that failed is still everything the person
 * typed, and losing it is how somebody stops trying.
 */
export function blockers(r: BusinessRecord): string[] {
  const out: string[] = [];
  const missing = BUSINESS_FIELDS
    .filter((f) => f.required && r.fields[f.key] === "")
    .map((f) => f.label);
  if (missing.length > 0) out.push(`Still to fill in: ${missing.join(", ")}.`);
  if (r.fields.businessEmail !== "" && r.verifiedEmail !== r.fields.businessEmail) {
    out.push(`The business email ${r.fields.businessEmail} has not been verified yet.`);
  }
  if (r.agreementVersion !== AGREEMENT.version) {
    out.push(`The ${AGREEMENT.title} (${AGREEMENT.version}) has not been accepted.`);
  }
  // Only when MOJO has asked. A document nobody requested is not a
  // blocker, and asking for one by default is how a registration
  // stalls on paperwork nobody needed.
  if (r.documentState === "requested") {
    out.push("Proof of business was requested and has not been uploaded.");
  }
  if (r.documentState === "needs-correction") {
    out.push(`The document needs correcting${r.documentNote ? `: ${r.documentNote}` : "."}`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

async function upsert(
  accountId: string, patch: Record<string, unknown>, by: string,
): Promise<BusinessRecord> {
  await ensure();
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  const cols = ["account_id", "updated_by", ...keys].join(", ");
  const vals = ["$1", "$2", ...keys.map((_, i) => `$${i + 3}`)].join(", ");
  const { rows } = await db().query<Db>(
    `INSERT INTO dm_business (${cols}) VALUES (${vals})
     ON CONFLICT (account_id) DO UPDATE
        SET ${sets}, updated_at = now(), updated_by = EXCLUDED.updated_by
  RETURNING ${COLS}`,
    [accountId, by, ...keys.map((k) => patch[k])]);
  return shape(rows[0]!);
}

export type SaveResult =
  | { ok: true; record: BusinessRecord }
  | { ok: false; errors: Record<string, string> };

/**
 * Save the draft.
 *
 * Never validates requiredness, and never changes the status of a
 * registration that is already with MOJO — editing while a reviewer
 * is reading it would move the record under them. A record that was
 * sent back IS editable, and stays in changes-requested until it is
 * resubmitted, so the reason is still on screen while it is fixed.
 */
export async function saveBusiness(
  accountId: string, raw: Partial<BusinessFields>, by: string,
): Promise<SaveResult> {
  const clean = cleanBusiness(raw);
  const errors = validateBusiness(clean, false);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const current = await getBusiness(accountId);
  const patch: Record<string, unknown> = { fields: JSON.stringify(clean) };
  /*
   * Changing the business email takes the verification with it.
   *
   * The proof belongs to the address that was proved. Carrying it
   * over to a new one would mean a registration approved on the
   * strength of a check nobody did — so the verified address stays
   * recorded, and the mismatch is what blocks the submission.
   */
  if (clean.businessEmail !== current.fields.businessEmail) {
    patch.pending_email = "";
    patch.pending_sent_at = null;
    await db().query("DELETE FROM dm_business_verify WHERE account_id = $1", [accountId])
      .catch(() => undefined);
  }
  if (current.status === "approved") patch.status = "draft";
  return { ok: true, record: await upsert(accountId, patch, by) };
}

export type VerifyStart =
  | { ok: true; token: string; email: string; record: BusinessRecord }
  | { ok: false; problem: string };

const hash = (t: string): string => createHash("sha256").update(t).digest("hex");

/** How long a verification link lives. Long enough to find the email. */
export const VERIFY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Send a verification link to the business email.
 *
 * Returns the token for the caller to put in a message; nothing is
 * stored in the clear. Asking again replaces the previous link, so a
 * forwarded old one stops working the moment somebody resends — the
 * same rule as every other link in this application.
 */
export async function startVerification(
  accountId: string, by: string,
): Promise<VerifyStart> {
  const r = await getBusiness(accountId);
  const email = r.fields.businessEmail;
  if (email === "" || !EMAIL_RE.test(email)) {
    return { ok: false, problem: "Fill in a valid business email first." };
  }
  if (r.verifiedEmail === email) {
    return { ok: false, problem: `${email} is already verified.` };
  }
  const token = randomBytes(32).toString("base64url");
  await db().query(
    `INSERT INTO dm_business_verify (account_id, email, token_hash, sent_at, expires_at)
          VALUES ($1, $2, $3, now(), now() + ($4 || ' milliseconds')::interval)
     ON CONFLICT (account_id) DO UPDATE
        SET email = EXCLUDED.email, token_hash = EXCLUDED.token_hash,
            sent_at = now(), expires_at = EXCLUDED.expires_at`,
    [accountId, email, hash(token), String(VERIFY_TTL_MS)]);
  const record = await upsert(accountId, {
    pending_email: email, pending_sent_at: new Date(),
  }, by);
  return { ok: true, token, email, record };
}

export type VerifyResult =
  | { ok: true; accountId: string; email: string }
  | { ok: false; problem: string };

/**
 * Spend a verification link.
 *
 * Single use, by a conditional DELETE rather than a read then a
 * write: two clicks on the same link in a scanned message would both
 * pass a prior check, and the second would verify an address the
 * first had already moved on from.
 */
export async function completeVerification(token: string): Promise<VerifyResult> {
  await ensure();
  if (!token.trim()) return { ok: false, problem: "That link is not valid." };
  const { rows } = await db().query<{ account_id: string; email: string }>(
    `DELETE FROM dm_business_verify
      WHERE token_hash = $1 AND expires_at > now()
  RETURNING account_id, email`, [hash(token.trim())]);
  const got = rows[0];
  if (!got) {
    return {
      ok: false,
      problem: "That link has been used already, or it has expired. Ask for a new one "
        + "from the Account Registration page.",
    };
  }
  await db().query(
    `UPDATE dm_business
        SET verified_email = $2, verified_at = now(), pending_email = '',
            pending_sent_at = NULL
      WHERE account_id = $1`, [got.account_id, got.email]);
  return { ok: true, accountId: got.account_id, email: got.email };
}

/** Accept the agreement. The version is recorded, not just the fact. */
export async function acceptAgreement(
  accountId: string, by: string, version: string,
): Promise<{ ok: true; record: BusinessRecord } | { ok: false; problem: string }> {
  if (version !== AGREEMENT.version) {
    return {
      ok: false,
      problem: "The agreement has changed since this page was opened. Reload and read "
        + "the current one.",
    };
  }
  return {
    ok: true,
    record: await upsert(accountId, {
      agreement_version: AGREEMENT.version,
      agreement_accepted_at: new Date(),
      agreement_accepted_by: by,
    }, by),
  };
}

export type SubmitResult =
  | { ok: true; record: BusinessRecord }
  | { ok: false; blockers: string[]; errors: Record<string, string> };

/**
 * Send it to MOJO.
 *
 * Everything that is missing is reported at once and the draft is
 * kept exactly as it was. A submission that failed and took the form
 * with it is how somebody stops trying.
 */
export async function submitBusiness(
  accountId: string, by: string,
): Promise<SubmitResult> {
  const r = await getBusiness(accountId);
  const errors = validateBusiness(r.fields, true);
  const stops = blockers(r);
  if (Object.keys(errors).length > 0 || stops.length > 0) {
    return { ok: false, blockers: stops, errors };
  }
  return {
    ok: true,
    record: await upsert(accountId, {
      status: "submitted", submitted_at: new Date(), submitted_by: by,
      decided_at: null, decided_by: null, decision_note: "",
    }, by),
  };
}

/**
 * The reviewer's decision.
 *
 * Approving is a state, not a grant: it records that MOJO believes
 * the dealership is who it says it is, and gives them nothing they
 * did not already have. Access is still Users & Access, which is a
 * separate decision by a separate person.
 */
export async function decideBusiness(opts: {
  accountId: string; approve: boolean; note: string; by: string;
}): Promise<{ ok: true; record: BusinessRecord } | { ok: false; problem: string }> {
  const r = await getBusiness(opts.accountId);
  if (r.status !== "submitted") {
    return { ok: false, problem: "There is nothing waiting on that registration." };
  }
  const note = opts.note.trim();
  if (!opts.approve && note.length < 5) {
    return { ok: false, problem: "Say what needs correcting." };
  }
  return {
    ok: true,
    record: await upsert(opts.accountId, {
      status: opts.approve ? "approved" : "changes-requested",
      decided_at: new Date(), decided_by: opts.by,
      decision_note: note.slice(0, 2000),
    }, opts.by),
  };
}

/**
 * Ask a partner for proof of business, or stop asking.
 *
 * Off by default and per account, because most partners will never
 * be asked. An upload control that is always there invites documents
 * nobody wanted and then has to store them.
 */
export async function requestDocument(
  accountId: string, wanted: boolean, note: string, by: string,
): Promise<BusinessRecord> {
  const r = await getBusiness(accountId);
  // Never un-approve a document that has been accepted. Stopping the
  // request is not the same as withdrawing the approval.
  const next: DocumentState = wanted
    ? (r.documentState === "not-requested" ? "requested" : r.documentState)
    : (r.documentState === "requested" ? "not-requested" : r.documentState);
  return upsert(accountId, {
    document_state: next, document_note: note.trim().slice(0, 500),
  }, by);
}

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export const DOCUMENT_TYPES = [
  "application/pdf", "image/png", "image/jpeg", "image/webp",
];

export type UploadResult =
  | { ok: true; record: BusinessRecord }
  | { ok: false; problem: string };

/**
 * Upload the proof MOJO asked for.
 *
 * Only when it was asked for. A partner cannot push documents at
 * MOJO unprompted — that is a store of other people's paperwork
 * nobody agreed to hold.
 */
export async function uploadDocument(opts: {
  accountId: string; filename: string; contentType: string; bytes: Buffer; by: string;
}): Promise<UploadResult> {
  await ensure();
  const r = await getBusiness(opts.accountId);
  if (r.documentState === "not-requested") {
    return {
      ok: false,
      problem: "MOJO has not asked this account for proof of business.",
    };
  }
  if (opts.bytes.length === 0) return { ok: false, problem: "That file is empty." };
  if (opts.bytes.length > MAX_DOCUMENT_BYTES) {
    return { ok: false, problem: "That file is larger than 8 MB." };
  }
  if (!DOCUMENT_TYPES.includes(opts.contentType)) {
    return { ok: false, problem: "Upload a PDF or an image." };
  }
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    // One live document. A replacement supersedes rather than piling
    // up, so "which of these is the current licence" never arises.
    await client.query(
      `UPDATE dm_business_documents SET superseded_at = now()
        WHERE account_id = $1 AND superseded_at IS NULL`, [opts.accountId]);
    await client.query(
      `INSERT INTO dm_business_documents
         (account_id, filename, content_type, bytes, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [opts.accountId, opts.filename.slice(0, 200), opts.contentType,
        opts.bytes, opts.bytes.length, opts.by]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return {
    ok: true,
    record: await upsert(opts.accountId, {
      document_state: "uploaded", document_note: "",
    }, opts.by),
  };
}

export type StoredDocument = {
  id: string; filename: string; contentType: string; sizeBytes: number;
  uploadedAt: string; uploadedBy: string;
};

/** What is on file, without the bytes. */
export async function currentDocument(
  accountId: string,
): Promise<StoredDocument | null> {
  await ensure();
  const { rows } = await db().query<{
    id: string; filename: string; content_type: string; size_bytes: number;
    uploaded_at: Date; uploaded_by: string;
  }>(
    `SELECT id, filename, content_type, size_bytes, uploaded_at, uploaded_by
       FROM dm_business_documents
      WHERE account_id = $1 AND superseded_at IS NULL
      ORDER BY id DESC LIMIT 1`, [accountId]);
  const r = rows[0];
  return r ? {
    id: String(r.id), filename: r.filename, contentType: r.content_type,
    sizeBytes: r.size_bytes, uploadedAt: r.uploaded_at.toISOString(),
    uploadedBy: r.uploaded_by,
  } : null;
}

/**
 * The bytes, for somebody allowed to read them.
 *
 * The account is part of the LOOKUP. An id from another partner's
 * document answers exactly as an id that never existed, which is the
 * same rule every other record here follows — and matters more, because
 * this one is somebody's business licence.
 */
export async function documentBytes(
  accountId: string, id: string,
): Promise<{ filename: string; contentType: string; bytes: Buffer } | null> {
  await ensure();
  if (!/^\d+$/.test(id)) return null;
  const { rows } = await db().query<{
    filename: string; content_type: string; bytes: Buffer;
  }>(
    `SELECT filename, content_type, bytes FROM dm_business_documents
      WHERE id = $1 AND account_id = $2`, [Number(id), accountId]);
  const r = rows[0];
  return r ? { filename: r.filename, contentType: r.content_type, bytes: r.bytes } : null;
};

/** The reviewer's verdict on a document, kept apart from the submission's. */
export async function decideDocument(
  accountId: string, state: DocumentState, note: string, by: string,
): Promise<BusinessRecord> {
  return upsert(accountId, {
    document_state: state, document_note: note.trim().slice(0, 500),
  }, by);
}

/** Drop a removed account's registration. */
export async function forgetBusiness(accountId: string): Promise<void> {
  await ensure();
  await db().query("DELETE FROM dm_business_documents WHERE account_id = $1", [accountId]);
  await db().query("DELETE FROM dm_business_verify WHERE account_id = $1", [accountId]);
  await db().query("DELETE FROM dm_business WHERE account_id = $1", [accountId]);
}
