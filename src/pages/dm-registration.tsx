import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, CheckCircle2, Clock, FileText, Loader2, Mail, Upload,
} from "lucide-react";
import { ArrangedPage } from "@/components/buckets";

/**
 * Account Registration — the partner's own business record.
 *
 * One page, shared by every partner; one record per partner, never
 * visible across one. The buckets are arranged per account like every
 * other page here, so a dealership can widen Business Information or
 * put Verification first without that reaching anybody else.
 *
 * Three things this page is careful about, and each is a rule rather
 * than a styling choice:
 *
 *   Opening it writes nothing and sends nothing. A record that does
 *   not exist is a usable empty draft, not a row and not an invented
 *   example.
 *
 *   A failed submission keeps the draft. Everything missing is
 *   listed at once; nothing typed is lost. A submission that threw
 *   the form away is how somebody stops trying.
 *
 *   Naming a primary contact creates no login. Said on the page,
 *   because it is exactly what somebody would assume.
 */

type Fields = Record<string, string>;

type Record_ = {
  accountId: string;
  fields: Fields;
  status: "draft" | "verification-pending" | "submitted" | "changes-requested" | "approved";
  verifiedEmail: string;
  verifiedAt: string | null;
  pendingEmail: string;
  pendingSentAt: string | null;
  documentState:
  | "not-requested" | "requested" | "uploaded" | "under-review"
  | "approved" | "needs-correction";
  documentNote: string;
  agreementVersion: string;
  agreementAcceptedAt: string | null;
  agreementAcceptedBy: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string;
};

type Answer = {
  record: Record_;
  document: {
    id: string; filename: string; contentType: string; sizeBytes: number;
    uploadedAt: string; uploadedBy: string;
  } | null;
  blockers: string[];
  fields: { key: string; label: string; required: boolean; bucket: string }[];
  types: string[];
  agreement: { version: string; title: string; body: string[] };
  maxBytes: number;
  documentTypes: string[];
  account: { id: string; name: string; line: string };
  canReview: boolean;
};

const STATUS: Record<Record_["status"], { label: string; tone: string; says: string }> = {
  draft: {
    label: "Draft", tone: "bg-slate-100 text-slate-700 border-slate-200",
    says: "Nothing has been sent to MOJO yet. Save as often as you like.",
  },
  "verification-pending": {
    label: "Verification pending", tone: "bg-amber-50 text-amber-800 border-amber-200",
    says: "Something still has to be verified before this can go for review.",
  },
  submitted: {
    label: "Submitted for review", tone: "bg-blue-50 text-blue-700 border-blue-200",
    says: "With MOJO. You will see the outcome here.",
  },
  "changes-requested": {
    label: "Changes requested", tone: "bg-amber-50 text-amber-800 border-amber-200",
    says: "MOJO has asked for corrections. Make them and submit again.",
  },
  approved: {
    label: "Approved", tone: "bg-emerald-50 text-emerald-700 border-emerald-200",
    says: "MOJO has accepted this registration.",
  },
};

const DOCUMENT_SAYS: Record<Record_["documentState"], string> = {
  "not-requested": "MOJO has not asked this account for proof of business.",
  requested: "MOJO has asked for a registration or licence.",
  uploaded: "Uploaded. MOJO has not looked at it yet.",
  "under-review": "MOJO is looking at it.",
  approved: "Accepted by MOJO.",
  "needs-correction": "MOJO has asked for a different document.",
};

export function DmRegistrationPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["dm-business"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/business");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as Answer;
    },
  });

  const [form, setForm] = useState<Fields>({});
  const [errors, setErrors] = useState<Fields>({});
  const [stops, setStops] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const loaded = useRef("");

  // Load the record into the form ONCE per record, so typing is never
  // overwritten by a background refetch.
  useEffect(() => {
    const r = q.data?.record;
    if (!r) return;
    const stamp = `${r.accountId}:${r.submittedAt ?? ""}:${r.decidedAt ?? ""}`;
    if (loaded.current === stamp) return;
    loaded.current = stamp;
    setForm({ ...r.fields });
  }, [q.data?.record]);

  const set = (k: string, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: "" } : e));
  };

  const post = async (url: string, body?: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(out.error ?? "That did not work.") as Error & {
        errors?: Fields; blockers?: string[];
      };
      err.errors = out.errors;
      err.blockers = out.blockers;
      throw err;
    }
    return out;
  };

  const after = () => {
    setError(""); setStops([]); setErrors({});
    void qc.invalidateQueries({ queryKey: ["dm-business"] });
  };
  const onFail = (e: unknown) => {
    const err = e as Error & { errors?: Fields; blockers?: string[] };
    setErrors(err.errors ?? {});
    setStops(err.blockers ?? []);
    setError(err.errors || err.blockers ? "" : err.message);
  };

  const saveDraft = useMutation({
    mutationFn: () => post("/api/dutch-miller/business", form),
    onSuccess: () => { after(); setNote("Draft saved."); },
    onError: onFail,
  });
  const submit = useMutation({
    // Saved first, so Submit never sends an older version of what is
    // on screen — and a validation failure reports the form in front
    // of them rather than the one they last saved.
    mutationFn: async () => {
      await post("/api/dutch-miller/business", form);
      return post("/api/dutch-miller/business/submit");
    },
    onSuccess: () => { after(); setNote("Sent to MOJO for review."); },
    onError: onFail,
  });
  const verify = useMutation({
    mutationFn: async () => {
      await post("/api/dutch-miller/business", form);
      return post("/api/dutch-miller/business/verify");
    },
    onSuccess: (out: { sentTo?: string }) => {
      after(); setNote(`Verification link sent to ${out.sentTo ?? "the business email"}.`);
    },
    onError: onFail,
  });
  const accept = useMutation({
    mutationFn: () => post("/api/dutch-miller/business/agreement",
      { version: q.data?.agreement.version }),
    onSuccess: () => { after(); setNote("Agreement accepted."); },
    onError: onFail,
  });
  const decide = useMutation({
    mutationFn: (v: { approve: boolean; note: string }) =>
      post("/api/dutch-miller/business/decide", v),
    onSuccess: () => { after(); setNote("Recorded."); },
    onError: onFail,
  });
  const askDocument = useMutation({
    mutationFn: (wanted: boolean) =>
      post("/api/dutch-miller/business/document/request", { wanted }),
    onSuccess: after,
    onError: onFail,
  });

  /*
   * A verification link opened in the browser.
   *
   * Spent by a POST from here rather than by the GET that loaded the
   * page: mail providers fetch the URLs in incoming messages to scan
   * them, and a link redeemed on a GET is a link burned on delivery.
   * The same lesson as the dealer invitations, which learned it the
   * hard way within a day of shipping.
   */
  const [verified, setVerified] = useState("");
  useEffect(() => {
    const hash = window.location.hash;
    const at = hash.indexOf("?");
    if (at < 0) return;
    const token = new URLSearchParams(hash.slice(at + 1)).get("verify");
    if (!token) return;
    window.location.hash = hash.slice(0, at);
    void post("/api/dutch-miller/business/verify/complete", { token })
      .then((out: { email?: string }) => {
        setVerified(out.email ?? "");
        void qc.invalidateQueries({ queryKey: ["dm-business"] });
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const r = q.data?.record;
  const spec = useMemo(
    () => new Map((q.data?.fields ?? []).map((f) => [f.key, f])), [q.data?.fields]);
  const field = (key: string) => {
    const f = spec.get(key);
    if (!f) return null;
    const id = `reg-${key}`;
    const isType = key === "businessType";
    return (
      <div>
        <label htmlFor={id} className="block text-xs font-medium">
          {f.label}
          {f.required && <span className="ml-0.5 text-rose-600" aria-hidden>*</span>}
          {f.required && <span className="sr-only"> (required)</span>}
        </label>
        {isType ? (
          <select
            id={id}
            value={form[key] ?? ""}
            onChange={(e) => set(key, e.target.value)}
            aria-invalid={Boolean(errors[key])}
            aria-describedby={errors[key] ? `${id}-err` : undefined}
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5
                       text-sm"
          >
            <option value="">Choose…</option>
            {(q.data?.types ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        ) : (
          <input
            id={id}
            value={form[key] ?? ""}
            onChange={(e) => set(key, e.target.value)}
            aria-invalid={Boolean(errors[key])}
            aria-describedby={errors[key] ? `${id}-err` : undefined}
            placeholder={f.required ? "" : "Optional"}
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5
                       text-sm"
          />
        )}
        {errors[key] && (
          <p id={`${id}-err`} role="alert" className="mt-1 text-xs font-semibold text-rose-600">
            {errors[key]}
          </p>
        )}
      </div>
    );
  };

  const render = (key: string): React.ReactNode => {
    if (spec.has(key)) return field(key);
    if (!r || !q.data) return null;
    switch (key) {
      case "contactNote":
        return (
          <p className="text-xs text-muted-foreground">
            Naming somebody here does not create a login or give them access to this
            application. Access is given under Users &amp; Access, by an administrator,
            as a separate decision.
          </p>
        );
      case "emailVerification":
        return (
          <VerificationRow
            record={r}
            email={form.businessEmail ?? ""}
            busy={verify.isPending}
            onSend={() => verify.mutate()}
          />
        );
      case "proofOfBusiness":
        return (
          <DocumentRow
            answer={q.data}
            canReview={q.data.canReview}
            onAsk={(w) => askDocument.mutate(w)}
            onDone={after}
          />
        );
      case "agreement":
        return (
          <AgreementRow
            record={r}
            agreement={q.data.agreement}
            busy={accept.isPending}
            onAccept={() => accept.mutate()}
          />
        );
      default: return null;
    }
  };

  const status = r ? STATUS[r.status] : STATUS.draft;
  const sending = saveDraft.isPending || submit.isPending;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Account Registration</h1>
        <p className="text-sm text-muted-foreground">
          Manage your business information and verification.
        </p>
      </div>

      {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && (
        <p className="text-sm font-semibold text-rose-600">{(q.error as Error).message}</p>
      )}

      {r && (
        <div className="flex flex-wrap items-center gap-3">
          <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5
                            text-xs font-semibold ${status.tone}`}>
            {status.label}
          </span>
          <span className="text-xs text-muted-foreground">{status.says}</span>
        </div>
      )}

      {verified && (
        <p className="flex items-center gap-2 rounded-lg border border-emerald-500/40
                      bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-800 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {verified} is verified.
        </p>
      )}

      {/* What MOJO asked for, where the person fixing it will read it. */}
      {r?.status === "changes-requested" && r.decisionNote && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40
                      bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>MOJO asked for changes
            {r.decidedBy ? ` — ${r.decidedBy}` : ""}.</strong>{" "}
            {r.decisionNote}
          </span>
        </p>
      )}

      {note && <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">{note}</p>}
      {error && <p className="text-sm font-semibold text-rose-600">{error}</p>}

      {/* Everything missing, at once, with the draft untouched. */}
      {stops.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Not ready to send yet. Nothing you typed has been lost.
          </p>
          <ul className="mt-1.5 space-y-1 text-sm text-amber-900 dark:text-amber-200">
            {stops.map((b) => <li key={b}>· {b}</li>)}
          </ul>
        </div>
      )}

      <ArrangedPage
        page="account-registration"
        render={render}
        fallback={(
          <p className="text-sm text-muted-foreground">
            Loading this page&rsquo;s arrangement…
          </p>
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={sending}
          onClick={() => { setNote(""); saveDraft.mutate(); }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border
                     px-3 py-2 text-sm disabled:opacity-50"
        >
          {saveDraft.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save Draft
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={() => { setNote(""); submit.mutate(); }}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-4 py-2
                     text-sm font-semibold text-background disabled:opacity-50"
        >
          {submit.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Submit for Review
        </button>
        <span className="text-xs text-muted-foreground">
          Required fields are marked <span className="text-rose-600">*</span>. Submitting
          checks them, the email verification and the agreement.
        </span>
      </div>

      {/* MOJO's side, on the same page rather than in a second one. */}
      {q.data?.canReview && r && (
        <ReviewPanel
          record={r}
          busy={decide.isPending}
          onDecide={(approve, text) => decide.mutate({ approve, note: text })}
        />
      )}
    </div>
  );
}

function VerificationRow({
  record, email, busy, onSend,
}: {
  record: Record_; email: string; busy: boolean; onSend: () => void;
}) {
  const matches = record.verifiedEmail !== "" && record.verifiedEmail === email;
  const waiting = record.pendingEmail !== "" && record.pendingEmail === email;
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <Mail className="h-3.5 w-3.5" />
        Business email verification
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {matches
          ? `${record.verifiedEmail} was verified${record.verifiedAt
            ? ` on ${new Date(record.verifiedAt).toLocaleDateString()}` : ""}.`
          : record.verifiedEmail
            // The one case people get caught by: the proof belongs to
            // the address that was proved, so changing it starts again.
            ? `${record.verifiedEmail} is verified, but the form now says ${email || "nothing"}.`
              + " A changed address has to be verified again."
            : waiting
              ? `A link was sent to ${record.pendingEmail}. It is good for three days.`
              : "Not verified yet."}
      </p>
      {!matches && (
        <button
          type="button"
          disabled={busy || !email}
          onClick={onSend}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border
                     px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {waiting ? "Send it again" : "Send a verification link"}
        </button>
      )}
    </div>
  );
}

function DocumentRow({
  answer, canReview, onAsk, onDone,
}: {
  answer: Answer;
  canReview: boolean;
  onAsk: (wanted: boolean) => void;
  onDone: () => void;
}) {
  const r = answer.record;
  const pick = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/dutch-miller/business/document", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-filename": file.name,
        },
        body: await file.arrayBuffer(),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? "Could not upload it.");
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Not requested and nobody can request it: say so and stop. An
  // upload control nobody asked for invites paperwork nobody wanted,
  // which then has to be stored.
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <FileText className="h-3.5 w-3.5" />
        Proof of business
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {DOCUMENT_SAYS[r.documentState]}
        {r.documentNote ? ` ${r.documentNote}` : ""}
      </p>

      {answer.document && (
        <p className="mt-1.5 text-xs">
          <a
            href={`/api/dutch-miller/business/document/${answer.document.id}`}
            target="_blank"
            rel="noreferrer"
            className="text-sky-600 hover:underline"
          >
            {answer.document.filename}
          </a>
          <span className="text-muted-foreground">
            {" "}· {(answer.document.sizeBytes / 1024).toFixed(0)} KB · uploaded{" "}
            {new Date(answer.document.uploadedAt).toLocaleDateString()}
          </span>
        </p>
      )}

      {r.documentState !== "not-requested" && (
        <>
          <input
            ref={pick}
            type="file"
            accept={answer.documentTypes.join(",")}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => pick.current?.click()}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border
                       px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Upload className="h-3.5 w-3.5" />}
            {answer.document ? "Replace it" : "Upload a document"}
          </button>
        </>
      )}
      {error && <p className="mt-1.5 text-xs font-semibold text-rose-600">{error}</p>}

      {canReview && (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => onAsk(r.documentState === "not-requested")}
            className="rounded-md border border-border px-2.5 py-1 text-xs"
          >
            {r.documentState === "not-requested"
              ? "Ask this partner for proof"
              : "Withdraw the request"}
          </button>
        </div>
      )}
    </div>
  );
}

function AgreementRow({
  record, agreement, busy, onAccept,
}: {
  record: Record_;
  agreement: { version: string; title: string; body: string[] };
  busy: boolean;
  onAccept: () => void;
}) {
  const [open, setOpen] = useState(false);
  const current = record.agreementVersion === agreement.version;
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        {current ? <Check className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
        {agreement.title}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {current
          ? `Version ${record.agreementVersion} accepted`
            + `${record.agreementAcceptedBy ? ` by ${record.agreementAcceptedBy}` : ""}`
            + `${record.agreementAcceptedAt
              ? ` on ${new Date(record.agreementAcceptedAt).toLocaleDateString()}` : ""}.`
          // Which version was accepted, not merely that one was. An
          // agreement that has moved on is not an agreement anybody made.
          : record.agreementVersion
            ? `Version ${record.agreementVersion} was accepted, but the current one is `
              + `${agreement.version}. It has to be accepted again.`
            : `Version ${agreement.version} has not been accepted.`}
      </p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-1.5 text-xs text-sky-600 hover:underline"
      >
        {open ? "Hide it" : "Read it"}
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5 rounded-md bg-muted/40 p-3 text-xs">
          {agreement.body.map((line) => <li key={line}>· {line}</li>)}
        </ul>
      )}
      {!current && (
        <button
          type="button"
          disabled={busy}
          onClick={onAccept}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5
                     text-sm font-semibold text-background disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Accept version {agreement.version}
        </button>
      )}
    </div>
  );
}

/**
 * MOJO's side of the review.
 *
 * On the same page as the record rather than in a queue of its own:
 * the decision is made by reading what is on screen, and a second
 * screen would mean deciding from a summary.
 *
 * Approving records a judgement and grants nothing. Said on the
 * panel, because "approved" is exactly the word somebody would read
 * as "and now they can do more".
 */
function ReviewPanel({
  record, busy, onDecide,
}: {
  record: Record_;
  busy: boolean;
  onDecide: (approve: boolean, note: string) => void;
}) {
  const [note, setNote] = useState("");
  const waiting = record.status === "submitted";
  return (
    <div className="rounded-xl border border-sky-500/40 bg-sky-500/5 p-4">
      <p className="text-sm font-semibold">MOJO review</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {waiting
          ? "This registration is waiting on you."
          : `Nothing is waiting. The registration is ${STATUS[record.status].label.toLowerCase()}.`}
        {" "}Approving records that MOJO accepts the business details. It grants no extra
        access — that is still Users &amp; Access.
      </p>
      {waiting && (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="What needs correcting? (required to send it back)"
            className="mt-2 w-full rounded-md border border-border bg-background px-2.5 py-1.5
                       text-sm"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide(true, note)}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5
                         text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Approve
            </button>
            <button
              type="button"
              disabled={busy || note.trim().length < 5}
              title={note.trim().length < 5
                ? "Say what needs correcting — the partner has to know what to fix."
                : undefined}
              onClick={() => onDecide(false, note)}
              className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Request changes
            </button>
          </div>
        </>
      )}
      {record.decidedAt && (
        <p className="mt-2 text-xs text-muted-foreground">
          Last decided {new Date(record.decidedAt).toLocaleString()}
          {record.decidedBy ? ` by ${record.decidedBy}` : ""}
          {record.decisionNote ? ` — ${record.decisionNote}` : ""}
        </p>
      )}
    </div>
  );
}
