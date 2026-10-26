import { randomUUID } from "node:crypto";
import { db, ensureSchema } from "../db.js";
import { STATES, formatPhone, digitsOf } from "./signups.js";

/**
 * Approved vendors, and the review that makes them approved.
 *
 * The shape of this is decided by one requirement: a CHANGE needs
 * approval too. So the record people read and the record somebody is
 * proposing cannot be the same row — if an edit wrote straight into
 * the vendor, then between submitting and approving there would be a
 * vendor on file that nobody has approved, which is the exact thing
 * the review exists to prevent.
 *
 * Two tables instead:
 *
 *   `dm_vendors` is the APPROVED record. Nothing writes to its fields
 *   except an approval. Reading it never shows you anything a
 *   reviewer has not signed off.
 *
 *   `dm_vendor_revisions` is every version ever proposed, each with
 *   who submitted it, who decided, when, and why. Approving one
 *   copies it onto the vendor; rejecting leaves the vendor exactly as
 *   it was.
 *
 * A brand-new vendor is a vendor row with no approved content and one
 * pending revision — which is why `status` can be `pending` with
 * every field still empty. It is not a half-written record; it is a
 * request.
 */

export const VENDOR_STATUSES = ["pending", "approved", "rejected", "inactive"] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export const REVISION_STATUSES = [
  "pending", "approved", "rejected", "superseded",
] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

/**
 * What a vendor record holds.
 *
 * The contact block is what somebody needs to ring them up. The rest
 * is what Accounts needs before a cheque can be written — a W-9 on
 * file, insurance that has not lapsed, and terms somebody agreed to.
 * Those are the fields that make "approved" mean something more than
 * "typed in".
 */
export type VendorFields = {
  companyName: string;
  contactName: string;
  phone: string;
  email: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postalCode: string;
  /** What they actually do for us. */
  services: string;
  website: string;
  /** EIN or TIN, as it appears on the W-9. */
  taxId: string;
  w9OnFile: boolean;
  insuranceOnFile: boolean;
  /** When the certificate of insurance lapses, as YYYY-MM-DD. */
  insuranceExpires: string;
  paymentTerms: string;
  notes: string;
};

export const BLANK_VENDOR: VendorFields = {
  companyName: "", contactName: "", phone: "", email: "",
  address1: "", address2: "", city: "", state: "", postalCode: "",
  services: "", website: "", taxId: "",
  w9OnFile: false, insuranceOnFile: false, insuranceExpires: "",
  paymentTerms: "", notes: "",
};

export type Vendor = VendorFields & {
  id: string;
  status: VendorStatus;
  createdAt: string;
  createdBy: string;
  approvedAt: string | null;
  approvedBy: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  deleteNote: string | null;
  /** The revision waiting on somebody, if there is one. */
  pending: Revision | null;
  /** True before anything has ever been approved. */
  neverApproved: boolean;
};

export type Revision = {
  id: string;
  vendorId: string;
  seq: number;
  fields: VendorFields;
  status: RevisionStatus;
  submittedAt: string;
  submittedBy: string;
  submitNote: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string;
  /** Which fields this version changes, against what was approved. */
  changed: string[];
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_vendors (
  id          uuid        PRIMARY KEY,
  status      text        NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL DEFAULT '',
  /* The APPROVED content. Only an approval writes here. */
  fields      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  approved_at timestamptz,
  approved_by text,
  deleted_at  timestamptz,
  deleted_by  text,
  delete_note text
);
CREATE INDEX IF NOT EXISTS dm_vendors_live ON dm_vendors (status, created_at DESC);

CREATE TABLE IF NOT EXISTS dm_vendor_revisions (
  id            bigserial   PRIMARY KEY,
  vendor_id     uuid        NOT NULL REFERENCES dm_vendors (id) ON DELETE CASCADE,
  seq           integer     NOT NULL,
  fields        jsonb       NOT NULL,
  status        text        NOT NULL DEFAULT 'pending',
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  submitted_by  text        NOT NULL DEFAULT '',
  submit_note   text        NOT NULL DEFAULT '',
  decided_at    timestamptz,
  decided_by    text        NOT NULL DEFAULT '',
  decision_note text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS dm_vendor_revisions_vendor
  ON dm_vendor_revisions (vendor_id, seq DESC);
/*
 * One pending revision per vendor.
 *
 * Two people proposing different changes at once, both approved in
 * turn, would silently apply the second over the first with nobody
 * told. The index makes that impossible rather than unlikely; a
 * second proposal supersedes the first explicitly, in one
 * transaction, so the trail says what happened to it.
 */
CREATE UNIQUE INDEX IF NOT EXISTS dm_vendor_revisions_one_pending
  ON dm_vendor_revisions (vendor_id) WHERE status = 'pending';
`;

let ready: Promise<void> | null = null;
const ensure = (): Promise<void> =>
  (ready ??= ensureSchema().then(async () => { await db().query(SCHEMA); }));

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const t = (v: unknown): string => String(v ?? "").trim();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export const VENDOR_LABEL: Record<string, string> = {
  companyName: "Company name", contactName: "Main point of contact",
  phone: "Phone", email: "Email", address1: "Address", address2: "Address line 2",
  city: "City", state: "State", postalCode: "ZIP", services: "Services provided",
  website: "Website", taxId: "Tax ID (EIN)", w9OnFile: "W-9 on file",
  insuranceOnFile: "Certificate of insurance on file",
  insuranceExpires: "Insurance expires", paymentTerms: "Payment terms",
  notes: "Notes",
};

/**
 * What a vendor must have to be proposed at all.
 *
 * The contact block, because a vendor nobody can ring is not a
 * vendor. Everything Accounts needs is checked at APPROVAL instead —
 * see `approvalBlockers` — because a dealership submitting one should
 * not have to hold the W-9 in their hand to start the process.
 */
export function validateVendor(raw: Partial<VendorFields>): {
  clean: VendorFields; errors: Record<string, string>;
} {
  const clean: VendorFields = {
    companyName: t(raw.companyName),
    contactName: t(raw.contactName),
    phone: formatPhone(t(raw.phone)),
    email: t(raw.email).toLowerCase(),
    address1: t(raw.address1),
    address2: t(raw.address2),
    city: t(raw.city),
    state: t(raw.state).toUpperCase(),
    postalCode: t(raw.postalCode),
    services: t(raw.services),
    website: t(raw.website),
    taxId: t(raw.taxId),
    w9OnFile: raw.w9OnFile === true || String(raw.w9OnFile) === "true",
    insuranceOnFile: raw.insuranceOnFile === true || String(raw.insuranceOnFile) === "true",
    insuranceExpires: t(raw.insuranceExpires),
    paymentTerms: t(raw.paymentTerms),
    notes: t(raw.notes),
  };

  const errors: Record<string, string> = {};
  for (const k of ["companyName", "contactName", "phone", "email", "address1",
    "city", "state", "postalCode"] as const) {
    if (clean[k] === "") errors[k] = `${VENDOR_LABEL[k]} is required.`;
  }
  if (clean.email !== "" && !EMAIL_RE.test(clean.email)) {
    errors.email = "That is not an email address.";
  }
  if (clean.phone !== "" && digitsOf(clean.phone).length < 10) {
    errors.phone = "A phone number needs at least ten digits.";
  }
  if (clean.state !== "" && !(STATES as readonly string[]).includes(clean.state)) {
    errors.state = "Pick a state from the list.";
  }
  if (clean.postalCode !== "" && !/^\d{5}(-\d{4})?$/.test(clean.postalCode)) {
    errors.postalCode = "A ZIP is five digits, or five plus four.";
  }
  if (clean.insuranceExpires !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(clean.insuranceExpires)) {
    errors.insuranceExpires = "Use YYYY-MM-DD.";
  }
  return { clean, errors };
}

/**
 * What stops a reviewer approving, as opposed to what stops somebody
 * submitting.
 *
 * Reported rather than enforced. A reviewer who can see that the
 * insurance lapsed last month and approves anyway has made a
 * decision; one who was never told has made a mistake, and only the
 * second is worth preventing. Their name is on it either way.
 */
export function approvalBlockers(f: VendorFields, now = new Date()): string[] {
  const out: string[] = [];
  if (!f.w9OnFile) out.push("No W-9 on file.");
  if (!f.insuranceOnFile) out.push("No certificate of insurance on file.");
  if (f.insuranceExpires !== "") {
    const when = new Date(`${f.insuranceExpires}T00:00:00Z`);
    if (!Number.isNaN(when.getTime()) && when < now) {
      out.push(`The certificate of insurance expired on ${f.insuranceExpires}.`);
    }
  } else if (f.insuranceOnFile) {
    out.push("Insurance is on file but no expiry date was recorded.");
  }
  if (f.taxId === "") out.push("No tax ID recorded.");
  if (f.services === "") out.push("Nothing says what they do for us.");
  return out;
}

/** Which fields differ, in words a reviewer can scan. */
export function changedFields(from: VendorFields, to: VendorFields): string[] {
  return (Object.keys(BLANK_VENDOR) as (keyof VendorFields)[])
    .filter((k) => String(from[k] ?? "") !== String(to[k] ?? ""))
    .map((k) => VENDOR_LABEL[k] ?? k);
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const fieldsOf = (v: unknown): VendorFields => ({
  ...BLANK_VENDOR,
  ...(v && typeof v === "object" ? (v as Partial<VendorFields>) : {}),
});

type DbVendor = {
  id: string; status: string; created_at: Date; created_by: string;
  fields: unknown; approved_at: Date | null; approved_by: string | null;
  deleted_at: Date | null; deleted_by: string | null; delete_note: string | null;
};

type DbRev = {
  id: string; vendor_id: string; seq: number; fields: unknown; status: string;
  submitted_at: Date; submitted_by: string; submit_note: string;
  decided_at: Date | null; decided_by: string; decision_note: string;
};

const isStatus = (v: string): v is VendorStatus =>
  (VENDOR_STATUSES as readonly string[]).includes(v);
const isRevStatus = (v: string): v is RevisionStatus =>
  (REVISION_STATUSES as readonly string[]).includes(v);

function shapeRev(r: DbRev, approved: VendorFields): Revision {
  const fields = fieldsOf(r.fields);
  return {
    id: String(r.id),
    vendorId: r.vendor_id,
    seq: r.seq,
    fields,
    status: isRevStatus(r.status) ? r.status : "pending",
    submittedAt: r.submitted_at.toISOString(),
    submittedBy: r.submitted_by,
    submitNote: r.submit_note,
    decidedAt: r.decided_at?.toISOString() ?? null,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    changed: changedFields(approved, fields),
  };
}

function shape(v: DbVendor, pending: DbRev | null): Vendor {
  const fields = fieldsOf(v.fields);
  return {
    ...fields,
    id: v.id,
    status: isStatus(v.status) ? v.status : "pending",
    createdAt: v.created_at.toISOString(),
    createdBy: v.created_by,
    approvedAt: v.approved_at?.toISOString() ?? null,
    approvedBy: v.approved_by,
    deletedAt: v.deleted_at?.toISOString() ?? null,
    deletedBy: v.deleted_by,
    deleteNote: v.delete_note,
    pending: pending ? shapeRev(pending, fields) : null,
    neverApproved: v.approved_at === null,
  };
}

const V_COLS = `id, status, created_at, created_by, fields, approved_at, approved_by,
                deleted_at, deleted_by, delete_note`;
const R_COLS = `id, vendor_id, seq, fields, status, submitted_at, submitted_by,
                submit_note, decided_at, decided_by, decision_note`;

export async function listVendors(opts: {
  status?: VendorStatus | "all" | "awaiting";
  search?: string;
} = {}): Promise<{ vendors: Vendor[]; counts: Record<string, number> }> {
  await ensure();
  const where: string[] = [];
  const args: unknown[] = [];
  // Deleted is its own view, like everywhere else here.
  if (opts.status === "inactive") where.push("v.status = 'inactive'");
  else where.push("v.deleted_at IS NULL");

  if (opts.status === "awaiting") {
    where.push(`EXISTS (SELECT 1 FROM dm_vendor_revisions r
                         WHERE r.vendor_id = v.id AND r.status = 'pending')`);
  } else if (opts.status && opts.status !== "all" && opts.status !== "inactive") {
    args.push(opts.status);
    where.push(`v.status = $${args.length}`);
  }
  if (opts.search?.trim()) {
    args.push(`%${opts.search.trim().toLowerCase()}%`);
    where.push(`(lower(v.fields->>'companyName') LIKE $${args.length}
                 OR lower(v.fields->>'contactName') LIKE $${args.length}
                 OR lower(v.fields->>'email') LIKE $${args.length})`);
  }

  const { rows } = await db().query<DbVendor>(
    `SELECT ${V_COLS} FROM dm_vendors v WHERE ${where.join(" AND ")}
      ORDER BY coalesce(v.fields->>'companyName', '') , v.created_at DESC LIMIT 500`,
    args);
  const pend = await db().query<DbRev>(
    `SELECT ${R_COLS} FROM dm_vendor_revisions WHERE status = 'pending'`);
  const byVendor = new Map(pend.rows.map((r) => [r.vendor_id, r]));

  const counts = await db().query<{ status: string; n: string }>(
    "SELECT status, count(*) AS n FROM dm_vendors WHERE deleted_at IS NULL GROUP BY status");
  const out: Record<string, number> = {
    pending: 0, approved: 0, rejected: 0, inactive: 0, awaiting: 0, total: 0,
  };
  let total = 0;
  for (const c of counts.rows) {
    out[c.status] = Number(c.n);
    total += Number(c.n);
  }
  out.total = total;
  out.awaiting = Number((await db().query<{ n: string }>(
    `SELECT count(DISTINCT vendor_id) AS n FROM dm_vendor_revisions
      WHERE status = 'pending'`)).rows[0]?.n ?? 0);

  return {
    vendors: rows.map((v) => shape(v, byVendor.get(v.id) ?? null)),
    counts: out,
  };
}

export async function getVendor(id: string): Promise<
  (Vendor & { history: Revision[] }) | null
> {
  await ensure();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db().query<DbVendor>(
    `SELECT ${V_COLS} FROM dm_vendors WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  const revs = await db().query<DbRev>(
    `SELECT ${R_COLS} FROM dm_vendor_revisions WHERE vendor_id = $1 ORDER BY seq DESC`,
    [id]);
  const approved = fieldsOf(rows[0].fields);
  const pending = revs.rows.find((r) => r.status === "pending") ?? null;
  return {
    ...shape(rows[0], pending),
    history: revs.rows.map((r) => shapeRev(r, approved)),
  };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export type ProposeResult =
  | { ok: true; vendor: Vendor; created: boolean; superseded: boolean }
  | { ok: false; errors: Record<string, string> }
  | { ok: false; reason: string };

/**
 * Propose a vendor, or a change to one.
 *
 * The same call for both, deliberately: creating and editing go
 * through identical review, so there is no path that writes a vendor
 * without one. A new vendor gets a row with empty approved content
 * and one pending revision; an edit leaves the approved content
 * exactly where it is.
 *
 * A second proposal while one is pending SUPERSEDES it rather than
 * being refused — somebody spotting their own typo should be able to
 * fix it — and the superseded version stays in the history saying so.
 */
export async function proposeVendor(opts: {
  id?: string;
  raw: Partial<VendorFields>;
  by: string;
  note?: string;
}): Promise<ProposeResult> {
  await ensure();
  const { clean, errors } = validateVendor(opts.raw);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    let id = opts.id ?? "";
    let created = false;
    if (id === "") {
      id = randomUUID();
      await client.query(
        `INSERT INTO dm_vendors (id, status, created_by) VALUES ($1, 'pending', $2)`,
        [id, opts.by]);
      created = true;
    } else {
      const got = await client.query<{ deleted_at: Date | null }>(
        "SELECT deleted_at FROM dm_vendors WHERE id = $1 FOR UPDATE", [id]);
      if (got.rows.length === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "No such vendor." };
      }
      if (got.rows[0]!.deleted_at) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "That vendor has been removed." };
      }
    }

    // Supersede whatever was waiting, inside the same transaction as
    // the new one, so there is never a moment with two pending.
    const gone = await client.query(
      `UPDATE dm_vendor_revisions SET status = 'superseded', decided_at = now(),
              decided_by = $2, decision_note = 'Replaced by a newer submission.'
        WHERE vendor_id = $1 AND status = 'pending'`, [id, opts.by]);

    const seq = await client.query<{ next: number }>(
      `SELECT coalesce(max(seq), 0) + 1 AS next FROM dm_vendor_revisions
        WHERE vendor_id = $1`, [id]);
    await client.query(
      `INSERT INTO dm_vendor_revisions (vendor_id, seq, fields, submitted_by, submit_note)
            VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [id, seq.rows[0]?.next ?? 1, JSON.stringify(clean), opts.by,
        (opts.note ?? "").slice(0, 1000)]);
    await client.query("COMMIT");

    const vendor = await getVendor(id);
    return {
      ok: true, vendor: vendor!, created,
      superseded: (gone.rowCount ?? 0) > 0,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type DecideResult =
  | { ok: true; vendor: Vendor }
  | { ok: false; reason: string };

/**
 * Approve or reject what is waiting.
 *
 * Approving copies the revision onto the vendor — the ONLY thing that
 * ever writes those fields. Rejecting leaves them untouched, which is
 * the whole point for a vendor that was already approved: a bad edit
 * must not disturb a good record.
 *
 * A rejection needs a reason. Whoever submitted it has to know what
 * to fix, and "rejected" with nothing attached only produces a second
 * identical submission.
 */
export async function decideVendor(opts: {
  id: string;
  revisionId: string;
  approve: boolean;
  by: string;
  note?: string;
}): Promise<DecideResult> {
  await ensure();
  const note = (opts.note ?? "").trim();
  if (!opts.approve && note.length < 5) {
    return { ok: false, reason: "Say why it is being sent back." };
  }

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const rev = await client.query<DbRev>(
      `SELECT ${R_COLS} FROM dm_vendor_revisions
        WHERE id = $1 AND vendor_id = $2 AND status = 'pending' FOR UPDATE`,
      [Number(opts.revisionId), opts.id]);
    if (rev.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "There is nothing waiting on that vendor." };
    }

    await client.query(
      `UPDATE dm_vendor_revisions
          SET status = $2, decided_at = now(), decided_by = $3, decision_note = $4
        WHERE id = $1`,
      [rev.rows[0]!.id, opts.approve ? "approved" : "rejected", opts.by,
        note.slice(0, 2000)]);

    if (opts.approve) {
      await client.query(
        `UPDATE dm_vendors
            SET fields = $2::jsonb, status = 'approved',
                approved_at = now(), approved_by = $3
          WHERE id = $1`,
        [opts.id, JSON.stringify(fieldsOf(rev.rows[0]!.fields)), opts.by]);
    } else {
      /*
       * A rejection only changes the vendor's own status when there
       * is nothing approved to fall back to. An established vendor
       * whose edit is refused stays approved — on the content that
       * was approved before, which is still exactly where it was.
       */
      await client.query(
        `UPDATE dm_vendors SET status = 'rejected'
          WHERE id = $1 AND approved_at IS NULL`, [opts.id]);
    }
    await client.query("COMMIT");
    return { ok: true, vendor: (await getVendor(opts.id))! };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Soft delete, with a note, like every other removal here. */
export async function deleteVendor(opts: {
  id: string; note: string; by: string;
}): Promise<{ ok: boolean; reason?: string }> {
  await ensure();
  const note = opts.note.trim();
  if (note.length < 5) return { ok: false, reason: "Say why it is being removed." };
  const { rowCount } = await db().query(
    `UPDATE dm_vendors
        SET deleted_at = now(), deleted_by = $2, delete_note = $3, status = 'inactive'
      WHERE id = $1 AND deleted_at IS NULL`,
    [opts.id, opts.by, note.slice(0, 500)]);
  if ((rowCount ?? 0) === 0) return { ok: false, reason: "No such vendor." };
  // Nothing may be left waiting on a record nobody will look at again.
  await db().query(
    `UPDATE dm_vendor_revisions SET status = 'superseded', decided_at = now(),
            decided_by = $2, decision_note = 'The vendor was removed.'
      WHERE vendor_id = $1 AND status = 'pending'`, [opts.id, opts.by]);
  return { ok: true };
}
