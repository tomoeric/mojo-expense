import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Loader2, Lock, Send, X } from "lucide-react";

/**
 * Member Signups — enrol a member, and hand them an RFID tag.
 *
 * Two things in this file are not ordinary form plumbing and should not be
 * simplified away:
 *
 *   The generated values (date, time, GUID) are MINTED BY THE SERVER and
 *   come back signed. The form carries the signature through verification
 *   and submission untouched. That is what makes "read-only" a rule rather
 *   than a styling choice — a client cannot invent a creation time or
 *   replay a GUID.
 *
 *   Selecting a tag does nothing. It is claimed only by Confirm & Submit,
 *   in the same transaction that writes the member, because a tag issued
 *   without a member is lost and a member without a tag is a second person
 *   being handed the same one.
 */

export type SignupRow = {
  guid: string;
  createdAt: string;
  displayTimezone: string;
  dealer: { dlwContractId: string; dealNumber: string; customerId: string };
  customer: {
    firstName: string; lastName: string; plateDlw: string | null;
    plateState: string | null;
    vehicleMake: string | null; vehicleModel: string | null;
    vehicleYear: string | null; vehicleColor: string | null; rfid: string;
  };
  submittedAt: string;
  submittedBy: string;
  notifiedAt: string | null;
  openedAt: string | null;
  openedBy: string | null;
  completedAt: string | null;
  completedBy: string | null;
};

type Handle = { guid: string; createdAt: string; token: string; displayTimezone: string };

const DEALER_FIELDS = [
  { key: "dlwContractId", label: "DLW Contract ID", required: true },
  // The dealer's own references, not always known when somebody is
  // signed up, so the form does not stop for them.
  { key: "dealNumber", label: "Deal #", required: false },
  { key: "customerId", label: "Customer ID #", required: false },
] as const;

/**
 * Year, make, model — in the order people say them.
 *
 * It used to read make, model, year, and the first real entry put 2022
 * in Make, Honda in Model and Accord in Year. Nobody describes a car in
 * that order out loud, so the form stops asking them to.
 */
const CUSTOMER_FIELDS = [
  { key: "firstName", label: "First Name", required: true, placeholder: "First Name" },
  { key: "lastName", label: "Last Name", required: true, placeholder: "Last Name" },
  { key: "plateDlw", label: "Plate (DLW)", required: false, placeholder: "Optional" },
  { key: "vehicleYear", label: "Vehicle Year", required: false, placeholder: "YYYY" },
  { key: "vehicleMake", label: "Vehicle Make", required: false, placeholder: "Honda" },
  { key: "vehicleModel", label: "Vehicle Model", required: false, placeholder: "Accord" },
  { key: "vehicleColor", label: "Vehicle Color", required: false, placeholder: "Vehicle Color" },
] as const;

/**
 * The plate's state, as the two letters on the registration.
 *
 * A list rather than a text box: a plate is only unique within its
 * state, so "OH", "Ohio" and "oh" being three different answers makes
 * the pair useless for matching a vehicle later.
 */
const STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
  "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

type DealerKey = (typeof DEALER_FIELDS)[number]["key"];
type CustomerKey = (typeof CUSTOMER_FIELDS)[number]["key"];
type Form = Record<DealerKey | CustomerKey, string> & { plateState: string; rfid: string };

const BLANK: Form = {
  dlwContractId: "", dealNumber: "", customerId: "",
  firstName: "", lastName: "", plateDlw: "", plateState: "",
  vehicleMake: "", vehicleModel: "", vehicleYear: "", vehicleColor: "",
  rfid: "",
};

/* The generated timestamp is shown in the configured zone, never the
   browser's: two people reading the same record must see the same time. */
const dateIn = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso)).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");

const timeIn = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: true, timeZoneName: "short",
  }).format(new Date(iso));

const stamp = (iso: string | null, tz: string) =>
  iso ? `${dateIn(iso, tz)} ${timeIn(iso, tz)}` : "—";

export function DmSignupsPage({
  view,
  onView,
  viewingAs,
}: {
  view: "review" | "add";
  onView: (v: "review" | "add") => void;
  /** Set while a super admin is looking through somebody else's eyes. */
  viewingAs?: { real: string; viewed: string } | null;
}) {
  const [justSaved, setJustSaved] = useState<SignupRow | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Member Signups</h1>
        <p className="text-sm text-muted-foreground">
          Member registration &amp; RFID assignment.
        </p>
      </div>

      {justSaved && view === "review" && (
        <p className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-800 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {justSaved.customer.firstName} {justSaved.customer.lastName} was submitted to MOJO
          with RFID {justSaved.customer.rfid}.
        </p>
      )}

      {view === "review"
        ? <ReviewExisting />
        : viewingAs
          ? <NotWhileViewing viewed={viewingAs.viewed} onBack={() => onView("review")} />
          : <AddNew
            onCancel={() => { setJustSaved(null); onView("review"); }}
            onSaved={(row) => { setJustSaved(row); onView("review"); }}
          />}
    </div>
  );
}

/**
 * Add New, inside a view.
 *
 * Starting an entry mints its GUID and creation time on the server, so
 * it is a write — and nothing is written while viewing as somebody else,
 * because a signup carries the name of whoever made it and an RFID tag
 * leaves the pool for good. Said here rather than left to the red error
 * the refusal produces, which reads as a fault instead of the rule.
 */
function NotWhileViewing({ viewed, onBack }: { viewed: string; onBack: () => void }) {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <p className="text-sm font-semibold">Not while viewing as somebody else</p>
      <p className="mt-1 text-sm text-muted-foreground">
        You are looking at the app as {viewed}. A signup records who made it and takes an
        RFID tag out of the pool for good, so it has to be made by the person whose name
        goes on it. Stop viewing to add one.
      </p>
      <button
        type="button"
        onClick={onBack}
        className="mt-4 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
      >
        Back to Review Existing
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Review Existing
 * ------------------------------------------------------------------ */

/**
 * `?open=<guid>` on the hash, as the notification email links to.
 *
 * Read once on mount and then cleared from the address, so a reload or
 * a shared link does not keep re-opening the same record over whatever
 * somebody has moved on to.
 */
function useRequestedSignup(): string {
  const [guid] = useState(() => {
    const q = window.location.hash.split("?")[1] ?? "";
    return new URLSearchParams(q).get("open") ?? "";
  });
  useEffect(() => {
    if (!guid) return;
    const [path] = window.location.hash.split("?");
    window.history.replaceState(null, "", path ?? "#/member-signups/review");
  }, [guid]);
  return guid;
}

function ReviewExisting() {
  const qc = useQueryClient();
  const requested = useRequestedSignup();
  const [tab, setTab] = useState<"all" | "new" | "complete">("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<SignupRow | null>(null);
  const [error, setError] = useState("");

  const list = useQuery({
    queryKey: ["dm-signups", tab, search],
    queryFn: async () => {
      const q = new URLSearchParams({ status: tab, search, limit: "200" });
      const res = await fetch(`/api/dutch-miller/signups?${q}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        rows: SignupRow[]; total: number;
        counts: { new: number; complete: number; total: number };
        canComplete: boolean;
      };
    },
  });

  const complete = useMutation({
    mutationFn: async (v: { guid: string; complete: boolean }) => {
      const res = await fetch(`/api/dutch-miller/signups/${v.guid}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ complete: v.complete }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not change it.");
      return body as { row: SignupRow };
    },
    onSuccess: (b) => {
      setError("");
      setOpen((o) => (o && o.guid === b.row.guid ? b.row : o));
      void qc.invalidateQueries({ queryKey: ["dm-signups"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  // Arrived from an email link: open that record as soon as it loads.
  useEffect(() => {
    if (!requested || open) return;
    const row = list.data?.rows.find((r) => r.guid === requested);
    if (row) setOpen(row);
  }, [requested, list.data, open]);

  const opened = useMutation({
    mutationFn: async (guid: string) => {
      await fetch(`/api/dutch-miller/signups/${guid}/opened`, { method: "POST" });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["dm-signups"] }),
  });

  const counts = list.data?.counts;
  const canComplete = list.data?.canComplete ?? false;
  const chips: { key: "all" | "new" | "complete"; label: string; n?: number }[] = [
    { key: "new", label: "Awaiting MOJO", n: counts?.new },
    { key: "complete", label: "Completed", n: counts?.complete },
    { key: "all", label: "All", n: counts?.total },
  ];

  return (
    <>
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
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name, contract, deal or RFID…"
          className="ml-auto w-64 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
      </div>

      {error && <p className="mt-3 text-sm font-semibold text-red-600">{error}</p>}

      <div className="mt-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Customer</th>
              <th className="px-3 py-2 text-left font-semibold">DLW Contract ID</th>
              <th className="px-3 py-2 text-left font-semibold">Deal #</th>
              <th className="px-3 py-2 text-left font-semibold">RFID</th>
              <th className="px-3 py-2 text-left font-semibold">Date Created</th>
              <th className="px-3 py-2 text-left font-semibold">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {list.data?.rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                No signups yet.
              </td></tr>
            )}
            {list.data?.rows.map((r) => (
              <tr key={r.guid} className="border-t border-border">
                <td className="px-3 py-2">{r.customer.firstName} {r.customer.lastName}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.dealer.dlwContractId}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.dealer.dealNumber}</td>
                <td className="px-3 py-2 font-mono text-xs tabular-nums">{r.customer.rfid}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {dateIn(r.createdAt, r.displayTimezone)}
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    <Tracker row={r} compact />
                    <StatusBadge row={r} />
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setOpen(r)}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <ViewSignup
          row={open}
          canComplete={canComplete}
          busy={complete.isPending}
          onComplete={(v) => complete.mutate({ guid: open.guid, complete: v })}
          onOpened={() => opened.mutate(open.guid)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/**
 * Where a signup has got to, as four steps.
 *
 * Green when done, grey when not, and each one a real event rather than
 * a guess: the row exists, the notification left, somebody at MOJO
 * opened it, somebody marked it complete.
 *
 * Note what the third step is NOT. "Email opened" would be a tracking
 * pixel, and a pixel is wrong in both directions — blocked images read
 * as never opened, and the scanners that fetch everything read as
 * opened before a person saw it, which is the exact thing that burned
 * an invite here. Opening the record is somebody actually looking.
 */
function Tracker({ row, compact }: { row: SignupRow; compact?: boolean }) {
  const steps = [
    { label: "Submitted", at: row.submittedAt, who: row.submittedBy },
    { label: "Email sent", at: row.notifiedAt, who: "" },
    { label: "Opened", at: row.openedAt, who: row.openedBy ?? "" },
    { label: "Completed", at: row.completedAt, who: row.completedBy ?? "" },
  ];
  const tz = row.displayTimezone;

  if (compact) {
    return (
      <span className="flex items-center gap-1" title={steps
        .map((st) => `${st.label}: ${st.at ? stamp(st.at, tz) : "not yet"}`).join("\n")}>
        {steps.map((st) => (
          <span
            key={st.label}
            className={`h-1.5 w-5 rounded-full ${
              st.at ? "bg-emerald-500" : "bg-muted-foreground/25"
            }`}
          />
        ))}
      </span>
    );
  }

  return (
    <ol className="flex flex-wrap items-stretch gap-2">
      {steps.map((st, i) => (
        <li
          key={st.label}
          className={`flex-1 rounded-lg border px-3 py-2 ${
            st.at
              ? "border-emerald-500/40 bg-emerald-500/10"
              : "border-border bg-muted/30"
          }`}
        >
          <span className="flex items-center gap-1.5">
            {st.at
              ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              : <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
            <span className={`text-xs font-semibold ${
              st.at ? "text-emerald-800 dark:text-emerald-300" : "text-muted-foreground"
            }`}>
              {i + 1}. {st.label}
            </span>
          </span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            {st.at ? stamp(st.at, tz) : "—"}
            {st.at && st.who ? <><br />{st.who}</> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The two internal marks, as one badge.
 *
 * Every row carries "submitted to MOJO" — the record exists because it was
 * submitted — so the badge's job is to show which of the two states it is
 * in, not to repeat a fact that is always true.
 */
function StatusBadge({ row }: { row: SignupRow }) {
  return row.completedAt ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="h-3 w-3" />
      Completed by MOJO
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-700 dark:text-sky-300">
      <Send className="h-3 w-3" />
      Submitted to MOJO
    </span>
  );
}

function ViewSignup({
  row, canComplete, busy, onComplete, onOpened, onClose,
}: {
  row: SignupRow;
  canComplete: boolean;
  busy: boolean;
  onComplete: (v: boolean) => void;
  onOpened: () => void;
  onClose: () => void;
}) {
  const tz = row.displayTimezone;
  // Only the first time, and only for somebody who could act on it —
  // the server decides that again and ignores anybody else.
  useEffect(() => { if (canComplete && !row.openedAt) onOpened(); },
    [canComplete, row.openedAt, row.guid]);
  return (
    <Modal title={`${row.customer.firstName} ${row.customer.lastName}`} onClose={onClose}>
      <div className="space-y-4">
        <Tracker row={row} />
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge row={row} />
          {canComplete && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onComplete(!row.completedAt)}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${
                row.completedAt
                  ? "border border-border hover:bg-muted"
                  : "bg-foreground text-background"
              }`}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {row.completedAt ? "Reopen" : "Mark complete"}
            </button>
          )}
        </div>

        <Bucket title="Auto Data" note="Automatically generated · locked">
          <Readout label="Date Created" value={dateIn(row.createdAt, tz)} />
          <Readout label="Time Created" value={timeIn(row.createdAt, tz)} />
          <Readout label="Unique GUID" value={row.guid} mono />
        </Bucket>

        <Bucket title="Dealer">
          <Readout label="DLW Contract ID" value={row.dealer.dlwContractId} />
          <Readout label="Deal #" value={row.dealer.dealNumber} />
          <Readout label="Customer ID #" value={row.dealer.customerId} />
        </Bucket>

        <Bucket title="Customer">
          <Readout label="First Name" value={row.customer.firstName} />
          <Readout label="Last Name" value={row.customer.lastName} />
          <Readout
            label="Plate (DLW)"
            value={[row.customer.plateDlw, row.customer.plateState].filter(Boolean).join("  ")
              || null}
          />
          <Readout label="Vehicle Make" value={row.customer.vehicleMake} />
          <Readout label="Vehicle Model" value={row.customer.vehicleModel} />
          <Readout label="Vehicle Year" value={row.customer.vehicleYear} />
          <Readout label="Vehicle Color" value={row.customer.vehicleColor} />
          <Readout label="RFID" value={row.customer.rfid} mono />
        </Bucket>

      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Add New
 * ------------------------------------------------------------------ */

function AddNew({
  onCancel, onSaved,
}: {
  onCancel: () => void;
  onSaved: (row: SignupRow) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(BLANK);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [verifying, setVerifying] = useState(false);
  const [conflict, setConflict] = useState("");
  // Bumped by Cancel and by a successful submission: a fresh entry gets a
  // fresh GUID and a fresh creation time, never the previous one's.
  const [entry, setEntry] = useState(0);

  const handle = useQuery({
    queryKey: ["dm-signup-handle", entry],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/signups/new", { method: "POST" });
      if (!res.ok) throw new Error("Could not start a new entry.");
      return (await res.json()) as Handle;
    },
    // The creation stamp is the moment the form opened; refetching would
    // quietly move it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const options = useQuery({
    queryKey: ["dm-rfid-options"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/signups/rfid-options");
      if (!res.ok) throw new Error("Could not load RFID numbers.");
      return (await res.json()) as { options: string[] };
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/signups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, ...handle.data }),
      });
      const body = await res.json();
      if (!res.ok) {
        const err = new Error(body.error ?? "Could not submit.") as Error & {
          errors?: Record<string, string>; kind?: string;
        };
        err.errors = body.errors;
        err.kind = body.kind;
        throw err;
      }
      return body as { row: SignupRow; alreadyExisted: boolean };
    },
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: ["dm-signups"] });
      void qc.invalidateQueries({ queryKey: ["dm-rfid"] });
      void qc.invalidateQueries({ queryKey: ["dm-rfid-options"] });
      setVerifying(false);
      setForm(BLANK);
      setEntry((n) => n + 1);
      onSaved(b.row);
    },
    onError: (e) => {
      const err = e as Error & { errors?: Record<string, string>; kind?: string };
      if (err.errors) { setErrors(err.errors); setVerifying(false); return; }
      if (err.kind === "rfid-taken") {
        // Everything typed is still good; only the tag is gone. Keep the
        // entry, clear the one field, and go back for a fresh list.
        setConflict(err.message);
        setForm((f) => ({ ...f, rfid: "" }));
        void options.refetch();
        return;
      }
      setConflict(err.message);
    },
  });

  const set = (k: keyof Form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => { const { [k]: _gone, ...rest } = e; return rest; });
    if (k === "rfid") setConflict("");
  };

  /** The same rules the server applies, so the form can answer immediately. */
  const check = (): Record<string, string> => {
    const e: Record<string, string> = {};
    for (const f of DEALER_FIELDS) {
      if (f.required && form[f.key].trim() === "") e[f.key] = `${f.label} is required.`;
    }
    for (const f of CUSTOMER_FIELDS) {
      if (f.required && form[f.key].trim() === "") e[f.key] = `${f.label} is required.`;
    }
    if (form.vehicleYear.trim() !== "" && !/^\d{4}$/.test(form.vehicleYear.trim())) {
      e.vehicleYear = "Vehicle Year must be four digits.";
    }
    if (form.rfid === "") e.rfid = "RFID is required.";
    return e;
  };

  const h = handle.data;
  const tz = h?.displayTimezone ?? "America/Chicago";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">New member</h2>
        <p className="text-sm text-muted-foreground">
          Enter member details, then verify each bucket.
        </p>
      </div>

      {handle.isError && (
        <p className="text-sm font-semibold text-red-600">
          Could not start a new entry. Reload the page and try again.
        </p>
      )}
      {conflict && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200">
          {conflict}
        </p>
      )}

      <Bucket title="Auto Data" note="Automatically generated · locked">
        <Locked label="Date Created" value={h ? dateIn(h.createdAt, tz) : "…"} />
        <Locked label="Time Created" value={h ? timeIn(h.createdAt, tz) : "…"} />
        <Locked label="Unique GUID" value={h?.guid ?? "…"} mono />
      </Bucket>

      <Bucket title="Dealer" note="User input">
        {DEALER_FIELDS.map((f) => (
          <Field
            key={f.key} label={f.label} required={f.required} error={errors[f.key]}
            value={form[f.key]} placeholder={f.label} onChange={(v) => set(f.key, v)}
          />
        ))}
      </Bucket>

      <Bucket title="Customer" note="User input">
        {CUSTOMER_FIELDS.map((f) => (
          <Fragment key={f.key}>
            <Field
              label={f.label} required={f.required} error={errors[f.key]}
              value={form[f.key]} placeholder={f.placeholder} onChange={(v) => set(f.key, v)}
            />
            {f.key === "plateDlw" && (
              <StateField
                value={form.plateState}
                error={errors.plateState}
                onChange={(v) => set("plateState", v)}
              />
            )}
          </Fragment>
        ))}
        <RfidField
          value={form.rfid}
          error={errors.rfid}
          options={options.data?.options ?? []}
          loading={options.isPending}
          onChange={(v) => set("rfid", v)}
        />
      </Bucket>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
        >
          Cancel
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setForm(BLANK); setErrors({}); setConflict(""); }}
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={!h}
            onClick={() => {
              const e = check();
              setErrors(e);
              if (Object.keys(e).length === 0) setVerifying(true);
            }}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Submit
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        RFID is marked used only after final confirmation.
      </p>

      {verifying && h && (
        <Verify
          form={form}
          handle={h}
          options={options.data?.options ?? []}
          busy={submit.isPending}
          conflict={conflict}
          onChange={set}
          onCancelEntry={() => {
            setVerifying(false);
            setForm(BLANK);
            setErrors({});
            setConflict("");
            setEntry((n) => n + 1);
            onCancel();
          }}
          onConfirm={() => submit.mutate()}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Verification popup
 * ------------------------------------------------------------------ */

function Verify({
  form, handle, options, busy, conflict, onChange, onCancelEntry, onConfirm,
}: {
  form: Form;
  handle: Handle;
  options: string[];
  busy: boolean;
  conflict: string;
  onChange: (k: keyof Form, v: string) => void;
  onCancelEntry: () => void;
  onConfirm: () => void;
}) {
  const [dealerOk, setDealerOk] = useState(false);
  const [customerOk, setCustomerOk] = useState(false);
  const tz = handle.displayTimezone;

  // A correction after verifying unverifies THAT bucket and only that one:
  // re-reading the dealer fields because a vehicle colour changed teaches
  // people to tick without looking.
  const editDealer = (k: keyof Form, v: string) => { setDealerOk(false); onChange(k, v); };
  const editCustomer = (k: keyof Form, v: string) => { setCustomerOk(false); onChange(k, v); };

  // The tag can be taken by somebody else between opening this and
  // confirming. When the server says so the field is cleared, and this
  // bucket must be looked at again before it can be sent.
  useEffect(() => { if (conflict) setCustomerOk(false); }, [conflict]);

  return (
    <Modal title="Verify member information" onClose={onCancelEntry}>
      <div className="space-y-4">
        {conflict && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200">
            {conflict}
          </p>
        )}

        <Bucket title="Auto Data" note="Automatically generated · locked">
          <Locked label="Date Created" value={dateIn(handle.createdAt, tz)} />
          <Locked label="Time Created" value={timeIn(handle.createdAt, tz)} />
          <Locked label="Unique GUID" value={handle.guid} mono />
        </Bucket>

        <Bucket title="Dealer" note="User input">
          {DEALER_FIELDS.map((f) => (
            <Field
              key={f.key} label={f.label} required={f.required}
              value={form[f.key]} placeholder={f.label}
              onChange={(v) => editDealer(f.key, v)}
            />
          ))}
        </Bucket>
        <Verified
          checked={dealerOk}
          onChange={setDealerOk}
          label="I verified the dealer information."
        />

        <Bucket title="Customer" note="User input">
          {CUSTOMER_FIELDS.map((f) => (
            <Fragment key={f.key}>
              <Field
                label={f.label} required={f.required}
                value={form[f.key]} placeholder={f.placeholder}
                onChange={(v) => editCustomer(f.key, v)}
              />
              {f.key === "plateDlw" && (
                <StateField
                  value={form.plateState}
                  onChange={(v) => editCustomer("plateState", v)}
                />
              )}
            </Fragment>
          ))}
          <RfidField
            value={form.rfid}
            options={options}
            loading={false}
            onChange={(v) => editCustomer("rfid", v)}
          />
        </Bucket>
        <Verified
          checked={customerOk}
          onChange={setCustomerOk}
          label="I verified the customer information."
        />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <button
            type="button"
            onClick={onCancelEntry}
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          >
            Cancel Entry
          </button>
          <button
            type="button"
            disabled={!dealerOk || !customerOk || form.rfid === "" || busy}
            onClick={onConfirm}
            className="inline-flex items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? "Submitting…" : "Confirm & Submit"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Verified({
  checked, onChange, label,
}: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 px-1 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function Bucket({
  title, note, children,
}: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

function Field({
  label, value, onChange, placeholder, required, error,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; required?: boolean; error?: string;
}) {
  const id = `f-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      <input
        id={id}
        value={value}
        placeholder={placeholder ?? label}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-md border bg-background px-2.5 py-2 text-sm ${
          error ? "border-red-500" : "border-border"
        }`}
      />
      {error && <p id={`${id}-err`} role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/**
 * The tag dropdown.
 *
 * Only active, unused tags — the list comes from the pool itself, never
 * from anything made up for a form. A selection that is no longer in the
 * refreshed list is kept visible rather than silently dropped, so nobody
 * submits thinking they still hold a tag they do not.
 */
function RfidField({
  value, options, loading, error, onChange,
}: {
  value: string; options: string[]; loading: boolean; error?: string;
  onChange: (v: string) => void;
}) {
  const list = useMemo(
    () => (value !== "" && !options.includes(value) ? [value, ...options] : options),
    [value, options]);
  return (
    <div>
      <label htmlFor="f-rfid" className="mb-1 block text-xs text-muted-foreground">
        RFID<span className="text-red-500"> *</span>
      </label>
      <select
        id="f-rfid"
        value={value}
        aria-invalid={Boolean(error)}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-md border bg-background px-2.5 py-2 text-sm ${
          error ? "border-red-500" : "border-border"
        }`}
      >
        <option value="">{loading ? "Loading…" : "Select active RFID"}</option>
        {list.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
      {!loading && options.length === 0 && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          No active RFID numbers are left. Upload more under RFID Review.
        </p>
      )}
    </div>
  );
}

/** Two letters, picked rather than typed. */
function StateField({
  value, error, onChange,
}: { value: string; error?: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label htmlFor="f-plate-state" className="mb-1 block text-xs text-muted-foreground">
        State
      </label>
      <select
        id="f-plate-state"
        value={value}
        aria-invalid={Boolean(error)}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-md border bg-background px-2.5 py-2 text-sm ${
          error ? "border-red-500" : "border-border"
        }`}
      >
        <option value="">—</option>
        {STATES.map((st) => <option key={st} value={st}>{st}</option>)}
      </select>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function Locked({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
        <Lock className="h-3 w-3" />{label}
      </span>
      <p className={`truncate rounded-md border border-dashed border-border bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground ${
        mono ? "font-mono text-xs" : ""
      }`} title={value}>
        {value}
      </p>
    </div>
  );
}

function Readout({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <p className={`break-all text-sm ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</p>
    </div>
  );
}

/**
 * A dialog that cannot be dismissed by accident.
 *
 * No backdrop click: the popup holds an entry somebody has typed out, and
 * a stray click on the page behind it must not throw that away. Escape is
 * routed through the same deliberate exit as the Cancel button, focus is
 * trapped inside, and the page behind it is inert to the keyboard.
 */
function Modal({
  title, onClose, children,
}: { title: string; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previously = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>(
      "input, select, textarea, button, [href]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !box.current) return;
      const can = [...box.current.querySelectorAll<HTMLElement>(
        'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.hasAttribute("disabled"));
      if (can.length === 0) return;
      const first = can[0]!;
      const last = can[can.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      previously?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-3xl rounded-xl border border-border bg-background p-5 shadow-xl"
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
