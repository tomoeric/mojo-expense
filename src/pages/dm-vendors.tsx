import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Building2, Check, CheckCircle2, Clock, Info, Loader2, Plus,
  Search, Trash2, X,
} from "lucide-react";

/**
 * Approved vendors, and the review that makes them approved.
 *
 * The thing that shapes this page is that a CHANGE needs approval
 * too. So a vendor can be two things at once — what was approved,
 * and what somebody is proposing — and the page has to show both
 * without ever letting the second look like the first. Everywhere a
 * pending version appears it is labelled, and the approved record
 * underneath is what the list, the search and the detail show as the
 * vendor.
 */

type Fields = {
  companyName: string; contactName: string; phone: string; email: string;
  address1: string; address2: string; city: string; state: string; postalCode: string;
  services: string; website: string; taxId: string;
  w9OnFile: boolean; insuranceOnFile: boolean; insuranceExpires: string;
  paymentTerms: string; notes: string;
};

type Revision = {
  id: string; vendorId: string; seq: number; fields: Fields;
  status: "pending" | "approved" | "rejected" | "superseded";
  submittedAt: string; submittedBy: string; submitNote: string;
  decidedAt: string | null; decidedBy: string | null; decisionNote: string;
  changed: string[];
};

type Vendor = Fields & {
  id: string;
  status: "pending" | "approved" | "rejected" | "inactive";
  createdAt: string; createdBy: string;
  approvedAt: string | null; approvedBy: string | null;
  deletedAt: string | null; deletedBy: string | null; deleteNote: string | null;
  pending: Revision | null;
  neverApproved: boolean;
};

const BLANK: Fields = {
  companyName: "", contactName: "", phone: "", email: "",
  address1: "", address2: "", city: "", state: "", postalCode: "",
  services: "", website: "", taxId: "",
  w9OnFile: false, insuranceOnFile: false, insuranceExpires: "",
  paymentTerms: "", notes: "",
};

const STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
  "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

type Tab = "all" | "awaiting" | "approved" | "pending" | "rejected" | "inactive";

export function DmVendorsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = useQuery({
    queryKey: ["dm-vendors", tab, search],
    queryFn: async () => {
      const q = new URLSearchParams({ status: tab, search });
      const res = await fetch(`/api/dutch-miller/vendors?${q}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        vendors: Vendor[]; counts: Record<string, number>;
        canApprove: boolean; canDelete: boolean;
      };
    },
  });

  const counts = list.data?.counts;
  const chips: { key: Tab; label: string; n?: number }[] = [
    { key: "awaiting", label: "Waiting on review", n: counts?.awaiting },
    { key: "approved", label: "Approved", n: counts?.approved },
    { key: "all", label: "All", n: counts?.total },
    { key: "inactive", label: "Removed", n: counts?.inactive },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Building2 className="h-4 w-4" />
            Vendors
          </h1>
          <p className="text-sm text-muted-foreground">
            Approved vendors, and the review that approves them.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background"
        >
          <Plus className="h-4 w-4" />
          Submit a vendor
        </button>
      </div>

      {/* Said once, because it is the rule that shapes everything
          else on the page. */}
      <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          A new vendor and <strong>every change to one</strong> go through the same
          review. Until a change is approved, the record below is the last approved
          version — nothing a reviewer has not signed off ever appears as the vendor.
        </span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setTab(c.key)}
            className={`rounded-full border px-3 py-1 text-xs ${
              tab === c.key ? "border-foreground font-semibold" : "border-border text-muted-foreground"
            }`}
          >
            {c.label}{c.n === undefined ? "" : ` ${c.n.toLocaleString()}`}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Company, contact or email"
            className="w-56 bg-transparent text-sm outline-none"
          />
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Company</th>
              <th className="px-3 py-2 text-left font-semibold">Point of contact</th>
              <th className="px-3 py-2 text-left font-semibold">Phone</th>
              <th className="px-3 py-2 text-left font-semibold">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                Loading…
              </td></tr>
            )}
            {list.data?.vendors.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-10 text-center">
                <span className="block text-sm font-medium">No vendors here</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Submit one and it goes for review.
                </span>
              </td></tr>
            )}
            {list.data?.vendors.map((v) => (
              <tr
                key={v.id}
                onClick={() => setOpen(v.id)}
                className="cursor-pointer border-t border-border hover:bg-muted/40"
              >
                <td className={`px-3 py-2 ${v.deletedAt ? "line-through text-muted-foreground" : ""}`}>
                  {/* A brand-new vendor has no approved name yet, so
                      the proposed one stands in — labelled, because
                      it is not a vendor until somebody says so. */}
                  {v.companyName || v.pending?.fields.companyName || "(not yet named)"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {v.contactName || v.pending?.fields.contactName || "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {v.phone || v.pending?.fields.phone || "—"}
                </td>
                <td className="px-3 py-2"><StatusTag vendor={v} /></td>
                <td className="px-3 py-2 text-right">
                  <span className="rounded-md border border-border px-2 py-1 text-xs">
                    Open
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <VendorForm
          title="Submit a vendor"
          initial={BLANK}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ["dm-vendors"] });
          }}
        />
      )}

      {open && (
        <VendorDetail
          id={open}
          canApprove={list.data?.canApprove ?? false}
          canDelete={list.data?.canDelete ?? false}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/**
 * Where a vendor stands, in one phrase.
 *
 * Two facts, not one: whether it is approved, and whether something
 * is waiting. An approved vendor with a pending change is both, and
 * collapsing that to a single word is how somebody approves a record
 * believing it is the one in front of them.
 */
function StatusTag({ vendor }: { vendor: Vendor }) {
  const pill = (cls: string, icon: React.ReactNode, text: string) => (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {icon}{text}
    </span>
  );
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {vendor.deletedAt
        ? pill("bg-rose-500/15 text-rose-700 dark:text-rose-400",
          <Trash2 className="h-3 w-3" />, "Removed")
        : vendor.neverApproved
          ? pill("bg-sky-500/15 text-sky-700 dark:text-sky-300",
            <Clock className="h-3 w-3" />, "Not yet approved")
          : pill("bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
            <CheckCircle2 className="h-3 w-3" />, "Approved")}
      {vendor.pending && !vendor.deletedAt && (
        pill("bg-amber-500/15 text-amber-700 dark:text-amber-400",
          <Clock className="h-3 w-3" />,
          vendor.neverApproved ? "Waiting on review" : "Change waiting")
      )}
    </span>
  );
}

function VendorDetail({
  id, canApprove, canDelete, onClose,
}: {
  id: string; canApprove: boolean; canDelete: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  const q = useQuery({
    queryKey: ["dm-vendor", id],
    queryFn: async () => {
      const res = await fetch(`/api/dutch-miller/vendors/${id}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        vendor: Vendor & { history: Revision[] };
        blockers: string[];
        labels: Record<string, string>;
      };
    },
  });

  const decide = useMutation({
    mutationFn: async (approve: boolean) => {
      const res = await fetch(`/api/dutch-miller/vendors/${id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revisionId: q.data?.vendor.pending?.id, approve, note,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not record it.");
      return body;
    },
    onSuccess: () => {
      setNote("");
      setError("");
      void qc.invalidateQueries({ queryKey: ["dm-vendor", id] });
      void qc.invalidateQueries({ queryKey: ["dm-vendors"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const v = q.data?.vendor;
  const p = v?.pending ?? null;

  return (
    <Modal title={v?.companyName || p?.fields.companyName || "Vendor"} onClose={onClose}>
      {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {v && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <StatusTag vendor={v} />
            {!v.deletedAt && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
              >
                Propose a change
              </button>
            )}
            {canDelete && !v.deletedAt && (
              <button
                type="button"
                onClick={() => setRemoving(true)}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-rose-500/50 px-2.5 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-500/10 dark:text-rose-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            )}
          </div>

          {v.deletedAt && (
            <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-800 dark:text-rose-300">
              <strong>Removed {new Date(v.deletedAt).toLocaleDateString()}
              {v.deletedBy ? ` by ${v.deletedBy}` : ""}.</strong> {v.deleteNote}
            </p>
          )}

          {/* What is waiting, with exactly what it would change. A
              reviewer approving a record they have only skim-read is
              the failure this is for. */}
          {p && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                {v.neverApproved
                  ? "This vendor is waiting on its first approval"
                  : `A change is waiting — ${p.changed.length} field${p.changed.length === 1 ? "" : "s"}`}
              </p>
              <p className="mt-0.5 text-xs text-amber-900/80 dark:text-amber-200/80">
                Submitted {new Date(p.submittedAt).toLocaleString()} by {p.submittedBy}
                {p.submitNote ? ` — ${p.submitNote}` : ""}
              </p>

              <div className="mt-3 overflow-hidden rounded-md border border-amber-500/30 bg-background">
                {(Object.keys(BLANK) as (keyof Fields)[])
                  .filter((k) => v.neverApproved
                    ? String(p.fields[k] ?? "") !== ""
                    : String(v[k] ?? "") !== String(p.fields[k] ?? ""))
                  .map((k) => (
                    <div key={k} className="grid grid-cols-[10rem_1fr] gap-2 border-b border-border px-3 py-1.5 text-xs last:border-b-0">
                      <span className="text-muted-foreground">
                        {q.data?.labels[k] ?? k}
                      </span>
                      <span>
                        {!v.neverApproved && (
                          <span className="mr-2 text-muted-foreground line-through">
                            {show(v[k]) || "(blank)"}
                          </span>
                        )}
                        <strong>{show(p.fields[k]) || "(blank)"}</strong>
                      </span>
                    </div>
                  ))}
              </div>

              {/* What stops a reviewer, as opposed to what stopped the
                  submitter. Reported, never enforced: approving anyway
                  is a decision, and their name is on it. */}
              {(q.data?.blockers.length ?? 0) > 0 && (
                <div className="mt-3 rounded-md border border-amber-600/40 bg-background px-3 py-2">
                  <p className="flex items-center gap-1.5 text-xs font-semibold">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Worth checking before approving
                  </p>
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {q.data?.blockers.map((b) => <li key={b}>• {b}</li>)}
                  </ul>
                </div>
              )}

              {canApprove ? (
                <div className="mt-3 space-y-2">
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder="A note. Required to send it back."
                    className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
                  />
                  {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate(true)}
                      className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      {decide.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      <Check className="h-3.5 w-3.5" />
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate(false)}
                      className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                      Send back
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  Waiting on somebody who can approve a vendor.
                </p>
              )}
            </div>
          )}

          {/* The approved record. Never the pending one. */}
          {!v.neverApproved && (
            <div className="rounded-lg border border-border">
              <p className="border-b border-border px-3 py-2 text-xs font-semibold">
                Approved record
                {v.approvedAt && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    — {new Date(v.approvedAt).toLocaleDateString()}
                    {v.approvedBy ? ` by ${v.approvedBy}` : ""}
                  </span>
                )}
              </p>
              <dl className="grid grid-cols-[11rem_1fr] gap-x-3 gap-y-1 px-3 py-2.5 text-xs">
                {(Object.keys(BLANK) as (keyof Fields)[]).map((k) => (
                  <Row key={k} label={q.data?.labels[k] ?? k} value={show(v[k])} />
                ))}
              </dl>
            </div>
          )}

          <History history={q.data?.vendor.history ?? []} />
        </div>
      )}

      {editing && v && (
        <VendorForm
          title="Propose a change"
          initial={v.neverApproved && p ? p.fields : pick(v)}
          vendorId={v.id}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void qc.invalidateQueries({ queryKey: ["dm-vendor", id] });
            void qc.invalidateQueries({ queryKey: ["dm-vendors"] });
          }}
        />
      )}

      {removing && v && (
        <RemoveVendor
          id={v.id}
          name={v.companyName || p?.fields.companyName || "this vendor"}
          onClose={() => setRemoving(false)}
          onDone={() => {
            setRemoving(false);
            onClose();
            void qc.invalidateQueries({ queryKey: ["dm-vendors"] });
          }}
        />
      )}
    </Modal>
  );
}

const show = (v: unknown): string =>
  typeof v === "boolean" ? (v ? "Yes" : "No") : String(v ?? "");

const pick = (v: Vendor): Fields =>
  Object.fromEntries(
    (Object.keys(BLANK) as (keyof Fields)[]).map((k) => [k, v[k]]),
  ) as unknown as Fields;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value || "—"}</dd>
    </>
  );
}

/** Every version ever proposed, and what became of it. */
function History({ history }: { history: Revision[] }) {
  if (history.length === 0) return null;
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
        Review history — {history.length} submission{history.length === 1 ? "" : "s"}
      </summary>
      <div className="border-t border-border">
        {history.map((r) => (
          <div key={r.id} className="border-b border-border px-3 py-2 text-xs last:border-b-0">
            <p>
              <strong>#{r.seq}</strong> {r.status}
              {" · "}submitted {new Date(r.submittedAt).toLocaleString()} by {r.submittedBy}
              {r.decidedAt && (
                <> · {r.status} {new Date(r.decidedAt).toLocaleString()} by {r.decidedBy}</>
              )}
            </p>
            {r.submitNote && <p className="text-muted-foreground">“{r.submitNote}”</p>}
            {r.decisionNote && (
              <p className="text-muted-foreground">Decision: {r.decisionNote}</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

const FORM_FIELDS: {
  key: keyof Fields; label: string; required?: boolean;
  kind?: "state" | "check" | "date" | "area"; placeholder?: string; wide?: boolean;
}[] = [
  { key: "companyName", label: "Company name", required: true, wide: true },
  { key: "contactName", label: "Main point of contact", required: true },
  { key: "phone", label: "Phone", required: true, placeholder: "(304) 555-0133" },
  { key: "email", label: "Email", required: true, placeholder: "name@company.com" },
  { key: "address1", label: "Address", required: true, wide: true },
  { key: "address2", label: "Address line 2" },
  { key: "city", label: "City", required: true },
  { key: "state", label: "State", required: true, kind: "state" },
  { key: "postalCode", label: "ZIP", required: true, placeholder: "25701" },
  { key: "website", label: "Website", placeholder: "https://" },
  { key: "services", label: "Services provided", kind: "area", wide: true },
  { key: "taxId", label: "Tax ID (EIN)", placeholder: "00-0000000" },
  { key: "paymentTerms", label: "Payment terms", placeholder: "Net 30" },
  { key: "insuranceExpires", label: "Insurance expires", kind: "date" },
  { key: "w9OnFile", label: "W-9 on file", kind: "check" },
  { key: "insuranceOnFile", label: "Certificate of insurance on file", kind: "check" },
  { key: "notes", label: "Notes", kind: "area", wide: true },
];

function VendorForm({
  title, initial, vendorId, onClose, onSaved,
}: {
  title: string;
  initial: Fields;
  vendorId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Fields>(initial);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/vendors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, id: vendorId, note }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.errors) { setErrors(body.errors); throw new Error("Check the fields."); }
        throw new Error(body.error ?? "Could not submit it.");
      }
      return body;
    },
    onSuccess: onSaved,
    onError: (e) => setError((e as Error).message),
  });

  const set = (k: keyof Fields, v: string | boolean) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => { const { [k]: _gone, ...rest } = e; return rest; });
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This goes for review. {vendorId
            ? "The approved record stays exactly as it is until somebody signs this off."
            : "It is not a vendor until somebody approves it."}
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FORM_FIELDS.map((f) => (
            <div key={f.key} className={f.wide ? "sm:col-span-2 lg:col-span-3" : ""}>
              {f.kind === "check" ? (
                <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={Boolean(form[f.key])}
                    onChange={(e) => set(f.key, e.target.checked)}
                  />
                  {f.label}
                </label>
              ) : (
                <>
                  <label
                    htmlFor={`v-${f.key}`}
                    className="mb-1 block text-xs text-muted-foreground"
                  >
                    {f.label}
                    {f.required && <span className="text-red-500"> *</span>}
                  </label>
                  {f.kind === "state" ? (
                    <select
                      id={`v-${f.key}`}
                      value={String(form[f.key])}
                      onChange={(e) => set(f.key, e.target.value)}
                      className={`w-full rounded-md border bg-background px-2.5 py-2 text-sm ${
                        errors[f.key] ? "border-red-500" : "border-border"
                      }`}
                    >
                      <option value="">—</option>
                      {STATES.map((st) => <option key={st} value={st}>{st}</option>)}
                    </select>
                  ) : f.kind === "area" ? (
                    <textarea
                      id={`v-${f.key}`}
                      rows={2}
                      value={String(form[f.key])}
                      onChange={(e) => set(f.key, e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
                    />
                  ) : (
                    <input
                      id={`v-${f.key}`}
                      type={f.kind === "date" ? "date" : "text"}
                      value={String(form[f.key])}
                      placeholder={f.placeholder}
                      onChange={(e) => set(f.key, e.target.value)}
                      className={`w-full rounded-md border bg-background px-2.5 py-2 text-sm ${
                        errors[f.key] ? "border-red-500" : "border-border"
                      }`}
                    />
                  )}
                  {errors[f.key] && (
                    <p role="alert" className="mt-1 text-xs text-red-600">{errors[f.key]}</p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            A note for whoever reviews this
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="New insurance certificate attached; expiry updated."
            className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
          />
        </label>

        {error && <p className="text-sm font-semibold text-red-600">{error}</p>}

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate()}
            className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Send for review
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RemoveVendor({
  id, name, onClose, onDone,
}: {
  id: string; name: string; onClose: () => void; onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const go = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/dutch-miller/vendors/${id}/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not remove it.");
      return body;
    },
    onSuccess: onDone,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Modal title={`Remove ${name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          The record stays in the list, marked removed, with your note and its whole
          review history. Anything waiting on it is closed.
        </p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Contract ended 31 December; no longer used."
          className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
        />
        {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={go.isPending || note.trim().length < 5}
            onClick={() => go.mutate()}
            className="inline-flex items-center gap-2 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {go.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Remove vendor
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({
  title, onClose, children,
}: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-4xl rounded-xl border border-border bg-background p-5 shadow-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
