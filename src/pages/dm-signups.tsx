import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronLeft, ChevronRight, Circle,
  Download, ExternalLink, Eye, FileSpreadsheet, Loader2, Lock, Send, Trash2, X,
} from "lucide-react";
import { DmBulkDialog } from "@/pages/dm-bulk";
import { placementLine, type Placement } from "@/pages/dm-rfid-instructions";

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
    firstName: string; lastName: string;
    /** How to reach the MEMBER. Both optional. */
    phone: string | null; email: string | null;
    plateDlw: string | null;
    plateState: string | null;
    vehicleMake: string | null; vehicleModel: string | null;
    vehicleYear: string | null; vehicleColor: string | null; rfid: string;
    stickerAttached: boolean;
    /** confirmed · pending (imported) · legacy (predates the question). */
    stickerState: "confirmed" | "pending" | "legacy";
    stickerConfirmedAt: string | null;
    stickerConfirmedBy: string | null;
  };
  submittedAt: string;
  submittedBy: string;
  notifiedAt: string | null;
  openedAt: string | null;
  openedBy: string | null;
  completedAt: string | null;
  completedBy: string | null;
  /** Deleted records stay in the list, marked, with the reason attached. */
  deletedAt: string | null;
  deletedBy: string | null;
  deleteNote: string | null;
  tagReleased: boolean;
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
type Form = Record<DealerKey | CustomerKey, string>
  & { plateState: string; rfid: string; stickerAttached: boolean };

const BLANK: Form = {
  dlwContractId: "", dealNumber: "", customerId: "",
  firstName: "", lastName: "", plateDlw: "", plateState: "",
  vehicleMake: "", vehicleModel: "", vehicleYear: "", vehicleColor: "",
  rfid: "", stickerAttached: false,
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
  placement = "inside",
}: {
  view: "review" | "add";
  onView: (v: "review" | "add") => void;
  /** Set while an account admin is looking through somebody else's eyes. */
  viewingAs?: { real: string; viewed: string } | null;
  /**
   * Which face of the glass the sticker goes on.
   *
   * Drives the wording of the confirmation somebody ticks. It comes
   * from the same stored setting as RFID Instructions, so the two can
   * never tell a dealer different things — which they would within a
   * month if this were copy in two places.
   */
  placement?: Placement;
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
            placement={placement}
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

type Tab = "all" | "new" | "review" | "complete" | "deleted";

function ReviewExisting() {
  const qc = useQueryClient();
  const requested = useRequestedSignup();
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<SignupRow | null>(null);
  const [deleting, setDeleting] = useState<SignupRow | null>(null);
  const [error, setError] = useState("");
  // Newest first is what somebody opening this page wants to see.
  const [sort, setSort] = useState<{ by: "customer" | "created"; dir: "asc" | "desc" }>(
    { by: "created", dir: "desc" });

  const list = useQuery({
    queryKey: ["dm-signups", tab, search],
    queryFn: async () => {
      const q = new URLSearchParams({ status: tab, search, limit: "200" });
      const res = await fetch(`/api/dutch-miller/signups?${q}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        rows: SignupRow[]; total: number;
        counts: {
          new: number; review: number; complete: number; deleted: number; total: number;
        };
        canComplete: boolean;
        canDelete: boolean;
      };
    },
    /**
     * A fallback, not the mechanism.
     *
     * The server pushes changes over `useLiveUpdates`, which is what
     * normally turns the second step green a moment after a signup is
     * submitted. This covers the case where the stream cannot be held
     * open — a proxy that buffers, a browser without EventSource — and
     * only while there is something to wait for, so it stops by itself.
     */
    refetchInterval: (q) => {
      const rows = q.state.data?.rows ?? [];
      const waiting = rows.some((r) =>
        !r.notifiedAt && Date.now() - new Date(r.submittedAt).getTime() < 5 * 60_000);
      return waiting ? 8000 : false;
    },
  });

  const complete = useMutation({
    mutationFn: async (guid: string) => {
      const res = await fetch(`/api/dutch-miller/signups/${guid}/complete`, {
        method: "POST",
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

  /**
   * Arrived from an email link: open that record once it has loaded.
   *
   * ONCE. Without the latch this re-ran every time `open` went back to
   * null — which is what closing the dialog does — so the X reopened
   * the thing it had just closed and the popup could not be escaped.
   */
  const honoured = useRef(false);
  useEffect(() => {
    if (!requested || honoured.current) return;
    const row = list.data?.rows.find((r) => r.guid === requested);
    if (row) { honoured.current = true; setOpen(row); }
  }, [requested, list.data]);

  const opened = useMutation({
    mutationFn: async (guid: string) => {
      const res = await fetch(`/api/dutch-miller/signups/${guid}/opened`, { method: "POST" });
      return (await res.json()) as { row: SignupRow | null };
    },
    onSuccess: (b) => {
      // Show it immediately rather than on the refetch this triggers:
      // the step turning green is the feedback for having opened it.
      if (b.row) setOpen(b.row);
      void qc.invalidateQueries({ queryKey: ["dm-signups"] });
    },
  });

  const confirmSticker = useMutation({
    mutationFn: async (guid: string) => {
      const res = await fetch(`/api/dutch-miller/signups/${guid}/sticker`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not confirm it.");
      return body as { row: SignupRow };
    },
    onSuccess: (b) => {
      setError("");
      setOpen((o) => (o && o.guid === b.row.guid ? b.row : o));
      void qc.invalidateQueries({ queryKey: ["dm-signups"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: async (v: { guid: string; note: string; releaseTag: boolean }) => {
      const res = await fetch(`/api/dutch-miller/signups/${v.guid}/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: v.note, releaseTag: v.releaseTag }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not delete it.");
      return body as { row: SignupRow; tagReleased: boolean };
    },
    onSuccess: (b) => {
      setError("");
      setDeleting(null);
      // Left open, now showing the deletion: the record did not go
      // anywhere, and closing the dialog would suggest it had.
      setOpen((o) => (o && o.guid === b.row.guid ? b.row : o));
      void qc.invalidateQueries({ queryKey: ["dm-signups"] });
      void qc.invalidateQueries({ queryKey: ["dm-rfid"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  /**
   * Sorted here rather than by the server.
   *
   * The whole filtered set is already on the client — the server caps
   * at 200 and says so — and a round trip to reverse a column people
   * flip back and forth while scanning a list would be slower than the
   * scanning.
   */
  const rows = useMemo(() => {
    const out = [...(list.data?.rows ?? [])];
    out.sort((a, b) => {
      const d = sort.by === "customer"
        ? `${a.customer.lastName} ${a.customer.firstName}`
          .localeCompare(`${b.customer.lastName} ${b.customer.firstName}`)
        : a.createdAt.localeCompare(b.createdAt);
      return sort.dir === "asc" ? d : -d;
    });
    return out;
  }, [list.data, sort]);

  /**
   * The open record, read from the LIST rather than from what was
   * clicked.
   *
   * `open` is a snapshot taken at the moment of the click. Opening
   * marks the record as opened on the server, the list refetches, and
   * the dialog went on showing the snapshot — so the third step stayed
   * grey and Mark complete stayed disabled in front of somebody who
   * had just done the thing that enables it. Anything that changes
   * while it is open now shows through.
   */
  const openRow = open ? (rows.find((r) => r.guid === open.guid) ?? open) : null;

  const counts = list.data?.counts;
  const canComplete = list.data?.canComplete ?? false;
  const canDelete = list.data?.canDelete ?? false;
  const chips: { key: Tab; label: string; n?: number }[] = [
    { key: "new", label: "Awaiting MOJO", n: counts?.new },
    { key: "review", label: "Under review", n: counts?.review },
    { key: "complete", label: "Completed", n: counts?.complete },
    { key: "all", label: "All", n: counts?.total },
  ];
  // Only worth a chip once there is something in it, or for the one
  // person who can put something in it. Everybody else is being shown
  // a permanently empty filter.
  if (canDelete || (counts?.deleted ?? 0) > 0) {
    chips.push({ key: "deleted", label: "Deleted", n: counts?.deleted });
  }

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
        <ExportMenu rows={rows} />
      </div>

      {error && <p className="mt-3 text-sm font-semibold text-red-600">{error}</p>}

      <div className="mt-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <SortHeader
                label="Customer" col="customer" sort={sort} onSort={setSort}
              />
              <th className="px-3 py-2 text-left font-semibold">DLW Contract ID</th>
              <th className="px-3 py-2 text-left font-semibold">Deal #</th>
              <th className="px-3 py-2 text-left font-semibold">RFID</th>
              <SortHeader
                label="Date Created" col="created" sort={sort} onSort={setSort}
              />
              <th className="px-3 py-2 text-left font-semibold">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {list.data && rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                No signups yet.
              </td></tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.guid}
                onClick={() => setOpen(r)}
                className={`cursor-pointer border-t border-border hover:bg-muted/40 ${
                  r.deletedAt ? "text-muted-foreground" : ""
                }`}
              >
                <td className={`px-3 py-2 ${r.deletedAt ? "line-through" : ""}`}>
                  {r.customer.firstName} {r.customer.lastName}
                </td>
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

      {openRow && (
        <ViewSignup
          row={openRow}
          canComplete={canComplete}
          canDelete={canDelete}
          busy={complete.isPending}
          onDelete={() => setDeleting(openRow)}
          position={{
            index: Math.max(0, rows.findIndex((r) => r.guid === openRow.guid)),
            total: rows.length,
          }}
          onComplete={() => complete.mutate(openRow.guid)}
          onConfirmSticker={() => confirmSticker.mutate(openRow.guid)}
          confirming={confirmSticker.isPending}
          onOpened={() => opened.mutate(openRow.guid)}
          onStep={(d) => {
            const at = rows.findIndex((r) => r.guid === openRow.guid);
            const next = rows[at + d];
            if (next) setOpen(next);
          }}
          onClose={() => setOpen(null)}
        />
      )}

      {deleting && (
        <DeleteSignup
          row={deleting}
          busy={remove.isPending}
          error={remove.isError ? (remove.error as Error).message : ""}
          onCancel={() => setDeleting(null)}
          onConfirm={(note, releaseTag) =>
            remove.mutate({ guid: deleting.guid, note, releaseTag })}
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
    { label: "Opened in MOJO", at: row.openedAt, who: row.openedBy ?? "" },
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

function SortHeader({
  label, col, sort, onSort,
}: {
  label: string;
  col: "customer" | "created";
  sort: { by: "customer" | "created"; dir: "asc" | "desc" };
  onSort: (s: { by: "customer" | "created"; dir: "asc" | "desc" }) => void;
}) {
  const on = sort.by === col;
  return (
    <th className="px-3 py-2 text-left font-semibold">
      <button
        type="button"
        onClick={() => onSort({
          by: col,
          // Clicking the column you are already on reverses it; a new
          // column starts the way people expect that column to start.
          dir: on ? (sort.dir === "asc" ? "desc" : "asc") : (col === "created" ? "desc" : "asc"),
        })}
        className={`inline-flex items-center gap-1 ${on ? "text-foreground" : "hover:text-foreground"}`}
      >
        {label}
        {on && (sort.dir === "asc"
          ? <ArrowUp className="h-3 w-3" />
          : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );
}

/**
 * Export what is on screen.
 *
 * Two shapes, because they answer different questions. The list is
 * what the page shows — one line per signup, for counting and
 * reconciling. The detailed one is every field of every bucket, which
 * is what somebody loading these into another system needs.
 *
 * It exports the CURRENT view: the filter, the search and the sort all
 * apply, so what comes out matches what is being looked at.
 */
function ExportMenu({ rows }: { rows: SignupRow[] }) {
  const [open, setOpen] = useState(false);

  const download = (detailed: boolean) => {
    const head = detailed
      ? ["Customer", "First Name", "Last Name", "Phone", "Email",
        "DLW Contract ID", "Deal #", "Customer ID #",
        "Plate", "State", "Vehicle Year", "Vehicle Make", "Vehicle Model", "Vehicle Color",
        "RFID", "Sticker Attached", "Status", "Date Created", "Time Created",
        "Submitted By", "Email Sent",
        "Opened", "Opened By", "Completed", "Completed By",
        "Deleted", "Deleted By", "Delete Note", "RFID Released", "Reference"]
      : ["Customer", "DLW Contract ID", "Deal #", "RFID", "Date Created", "Status"];

    const status = (r: SignupRow) =>
      r.deletedAt ? "Deleted"
        : r.completedAt ? "Completed"
          : r.openedAt ? "Under review" : "Submitted";

    const body = rows.map((r) => (detailed
      ? [
        `${r.customer.firstName} ${r.customer.lastName}`.trim(),
        r.customer.firstName, r.customer.lastName,
        r.customer.phone ?? "", r.customer.email ?? "",
        r.dealer.dlwContractId, r.dealer.dealNumber, r.dealer.customerId,
        r.customer.plateDlw ?? "", r.customer.plateState ?? "",
        r.customer.vehicleYear ?? "", r.customer.vehicleMake ?? "",
        r.customer.vehicleModel ?? "", r.customer.vehicleColor ?? "",
        r.customer.rfid, r.customer.stickerAttached ? "Yes" : "No", status(r),
        dateIn(r.createdAt, r.displayTimezone), timeIn(r.createdAt, r.displayTimezone),
        r.submittedBy,
        r.notifiedAt ? stamp(r.notifiedAt, r.displayTimezone) : "",
        r.openedAt ? stamp(r.openedAt, r.displayTimezone) : "", r.openedBy ?? "",
        r.completedAt ? stamp(r.completedAt, r.displayTimezone) : "", r.completedBy ?? "",
        r.deletedAt ? stamp(r.deletedAt, r.displayTimezone) : "", r.deletedBy ?? "",
        r.deleteNote ?? "", r.deletedAt ? (r.tagReleased ? "Yes" : "No") : "",
        r.guid,
      ]
      : [
        `${r.customer.firstName} ${r.customer.lastName}`.trim(),
        r.dealer.dlwContractId, r.dealer.dealNumber, r.customer.rfid,
        dateIn(r.createdAt, r.displayTimezone), status(r),
      ]));

    const csv = [head, ...body].map((line) => line.map(csvCell).join(",")).join("\r\n");
    // A BOM, so Excel opens it as UTF-8 instead of mangling anything
    // that is not plain ASCII.
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `member-signups-${detailed ? "detailed-" : ""}`
      + `${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setOpen(false);
    // Member data leaving the app, on the record. The file is built
    // here from rows the page already has, so there is no download
    // route to hang this on — and an export that leaves no trace is
    // exactly the one worth tracing.
    void fetch("/api/dutch-miller/exported", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "members", rows: rows.length,
        detail: detailed ? "detailed export" : "list export",
      }),
    }).catch(() => undefined);
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={rows.length === 0}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
      >
        <Download className="h-3.5 w-3.5" />
        Export
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
            <button
              type="button"
              onClick={() => download(false)}
              className="block w-full border-b border-border px-3 py-2.5 text-left text-sm hover:bg-muted"
            >
              <span className="block font-medium">This list</span>
              <span className="block text-xs text-muted-foreground">
                The columns on screen, {rows.length} row{rows.length === 1 ? "" : "s"}.
              </span>
            </button>
            <button
              type="button"
              onClick={() => download(true)}
              className="block w-full px-3 py-2.5 text-left text-sm hover:bg-muted"
            >
              <span className="block font-medium">Detailed</span>
              <span className="block text-xs text-muted-foreground">
                Every member field, plus who did what and when.
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One CSV cell.
 *
 * Quoted whenever it holds a comma, a quote or a newline, with inner
 * quotes doubled — and a leading apostrophe stripped of meaning by the
 * quoting, so an identifier beginning with 0 keeps its zero instead of
 * Excel reading it as a number.
 */
function csvCell(v: string): string {
  const needs = /[",\r\n]/.test(v);
  const body = v.replace(/"/g, '""');
  return needs ? `"${body}"` : body;
}

/**
 * Where it stands, in one phrase.
 *
 * Three states, not two. "Submitted" stops being true the moment
 * somebody at MOJO opens the record — the dealer who submitted it
 * wants to know the difference between nobody having looked yet and
 * it being in hand, and that is the whole question they would
 * otherwise ring up to ask.
 */
/**
 * What we actually know about the sticker, in words.
 *
 * Three answers, because a boolean made a record written before the
 * question existed read as "somebody checked and found none" — which
 * is a claim nobody ever made.
 */
function stickerText(row: SignupRow): string {
  const c = row.customer;
  if (c.stickerState === "confirmed") {
    return c.stickerConfirmedBy
      ? `Confirmed by ${c.stickerConfirmedBy}`
      : "Confirmed";
  }
  if (c.stickerState === "pending") {
    return `Tag ${c.rfid} allocated by an import — not confirmed on the vehicle yet`;
  }
  return "Legacy record — confirmation was never recorded. "
    + "This does not mean the sticker is missing.";
}

function StatusBadge({ row }: { row: SignupRow }) {
  // First, because it outranks everything else that could be true of
  // the record — a deleted membership that still read "Completed by
  // MOJO" would be answering the wrong question.
  if (row.deletedAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:text-rose-400">
        <Trash2 className="h-3 w-3" />
        Deleted
      </span>
    );
  }
  if (row.completedAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        Completed by MOJO
      </span>
    );
  }
  if (row.openedAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
        <Eye className="h-3 w-3" />
        Under review by MOJO
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-700 dark:text-sky-300">
      <Send className="h-3 w-3" />
      Submitted to MOJO
    </span>
  );
}

function ViewSignup({
  row, canComplete, canDelete, busy, confirming, position, onComplete, onDelete,
  onConfirmSticker, onOpened, onStep, onClose,
}: {
  row: SignupRow;
  canComplete: boolean;
  canDelete: boolean;
  busy: boolean;
  confirming: boolean;
  /** Where this one sits in the list behind the dialog, for the arrows. */
  position: { index: number; total: number };
  onComplete: () => void;
  onDelete: () => void;
  onConfirmSticker: () => void;
  onOpened: () => void;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
}) {
  const tz = row.displayTimezone;
  // Only the first time, and only for somebody who could act on it —
  // the server decides that again and ignores anybody else.
  useEffect(() => { if (canComplete && !row.openedAt && !row.deletedAt) onOpened(); },
    [canComplete, row.openedAt, row.deletedAt, row.guid]);
  return (
    <Modal
      title={`${row.customer.firstName} ${row.customer.lastName}`}
      onClose={onClose}
      /* Reviewing is usually a run through several, not one lookup, so
         the next one is a keystroke rather than a close and a scroll. */
      nav={{
        label: `${position.index + 1} of ${position.total}`,
        onPrev: position.index > 0 ? () => onStep(-1) : undefined,
        onNext: position.index < position.total - 1 ? () => onStep(1) : undefined,
      }}
    >
      <div className="space-y-4">
        <Tracker row={row} />
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge row={row} />
          {/* Not offered before the record has been opened, and never
              offered again afterwards: completing means somebody read
              this one, and it is final. The server refuses both cases
              regardless. */}
          {canComplete && !row.completedAt && !row.deletedAt && (
            <button
              type="button"
              disabled={busy || !row.openedAt
                || row.customer.stickerState !== "confirmed"}
              title={!row.openedAt
                ? "Opening this record is what makes it reviewable."
                : row.customer.stickerState !== "confirmed"
                  ? "Nobody has confirmed the sticker is on this vehicle yet."
                  : undefined}
              onClick={onComplete}
              className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Mark complete
            </button>
          )}
          {canDelete && !row.deletedAt && (
            <button
              type="button"
              onClick={onDelete}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-rose-500/50 px-3 py-1.5 text-sm font-semibold text-rose-700 hover:bg-rose-500/10 dark:text-rose-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          )}
        </div>

        {/* What happened to it, where somebody looking at the record
            will actually read it — the note is the whole point of
            keeping the row. */}
        {row.deletedAt && (
          <p className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-800 dark:text-rose-300">
            <Trash2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>Deleted {stamp(row.deletedAt, tz)}
              {row.deletedBy ? ` by ${row.deletedBy}` : ""}.</strong>{" "}
              {row.deleteNote}
              <span className="mt-1 block text-xs">
                RFID {row.customer.rfid} {row.tagReleased
                  ? "was put back in the pool."
                  : "stays issued and cannot be given out again."}
              </span>
            </span>
          </p>
        )}

        {/* The point of the whole flow, said plainly. A dealer reading
            this wants one fact, and it is not a timestamp. */}
        {row.completedAt && !row.deletedAt && (
          <p className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>{row.customer.firstName} {row.customer.lastName} is set up and can
              now wash their vehicle.</strong> RFID {row.customer.rfid} is active on the
              account{row.customer.plateDlw
                ? ` for plate ${row.customer.plateDlw}${row.customer.plateState ? ` (${row.customer.plateState})` : ""}`
                : ""}.
            </span>
          </p>
        )}

        {/* The step an import cannot take for you.
            A bulk run allocates the tag AFTER the file was written, so
            nobody filling in that spreadsheet could know which sticker
            goes on which car. Somebody confirms it here, against the
            manifest, and approval waits for them. */}
        {row.customer.stickerState !== "confirmed" && !row.deletedAt && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <p className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {row.customer.stickerState === "pending" ? (
                  <>
                    <strong>RFID {row.customer.rfid} is allocated to this member,
                    but nobody has confirmed it is on the vehicle.</strong>{" "}
                    The number was chosen when the file was imported, after the
                    spreadsheet was written — so it could not have been confirmed
                    in advance. Apply the sticker, then confirm it here.
                  </>
                ) : (
                  <>
                    <strong>This record predates the sticker question.</strong>{" "}
                    No confirmation was ever recorded, which is not the same as
                    the sticker being missing. Check the vehicle and confirm.
                  </>
                )}
              </span>
            </p>
            <button
              type="button"
              disabled={confirming}
              onClick={onConfirmSticker}
              className="mt-2.5 inline-flex items-center gap-2 rounded-md border border-amber-600/50 bg-background px-3 py-1.5 text-sm font-semibold hover:bg-muted disabled:opacity-50"
            >
              {confirming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Confirm the sticker is on this vehicle
            </button>
          </div>
        )}

        <Deliveries guid={row.guid} />

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
          <Readout label="Phone" value={row.customer.phone} />
          <Readout label="Email" value={row.customer.email} />
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
          <Readout
            label="Sticker attached"
            value={stickerText(row)}
          />
        </Bucket>

      </div>
    </Modal>
  );
}

/**
 * Deleting a member record — the note, and what becomes of the tag.
 *
 * Two deliberate frictions. The note is required and short answers are
 * refused, because "why is this member gone?" is asked months later and
 * the only person who can answer it is the one pressing the button now.
 * And the tag is a separate question with no default, because both
 * answers are right sometimes: a duplicate entry should give its number
 * back, a member who drove off with the sticker on the windscreen
 * should not.
 */
function DeleteSignup({
  row, busy, error, onCancel, onConfirm,
}: {
  row: SignupRow;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (note: string, releaseTag: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const [release, setRelease] = useState(false);
  const short = note.trim().length < 5;

  return (
    <Modal title="Delete member record" onClose={onCancel}>
      <div className="space-y-4">
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>{row.customer.firstName} {row.customer.lastName}</strong> stays in
            the list, marked deleted, with your note attached. Nothing is erased —
            this records that the membership should no longer count.
          </span>
        </p>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">
            Why is this record being deleted? <span className="text-rose-600">Required</span>
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Duplicate of the entry submitted the same morning."
            className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
          />
        </label>

        <label className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm">
          <input
            type="checkbox"
            checked={release}
            onChange={(e) => setRelease(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            <span className="font-medium">
              Put RFID {row.customer.rfid} back in the pool
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Only if the sticker was never attached to a vehicle. Leave this
              unticked and the number stays issued, so it can never be handed out
              a second time.
            </span>
          </span>
        </label>

        {error && <p className="text-sm font-semibold text-red-600">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || short}
            onClick={() => onConfirm(note.trim(), release)}
            className="inline-flex items-center gap-2 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Delete record
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Add New
 * ------------------------------------------------------------------ */

function AddNew({
  onCancel, onSaved, placement,
}: {
  onCancel: () => void;
  onSaved: (row: SignupRow) => void;
  placement: Placement;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(BLANK);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [verifying, setVerifying] = useState(false);
  const [conflict, setConflict] = useState("");
  // Bumped by Cancel and by a successful submission: a fresh entry gets a
  // fresh GUID and a fresh creation time, never the previous one's.
  const [entry, setEntry] = useState(0);
  const vehicles = useVehicleLists(form.vehicleMake, form.vehicleYear);
  const [bulk, setBulk] = useState(false);

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
      return (await res.json()) as { options: string[]; testOnly?: string[] };
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

  const set = (k: keyof Form, v: string | boolean) => {
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
    if (!form.stickerAttached) {
      e.stickerAttached = "Confirm the sticker is on the windshield before submitting.";
    }
    return e;
  };

  const h = handle.data;
  const tz = h?.displayTimezone ?? "America/Chicago";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">New member</h2>
          <p className="text-sm text-muted-foreground">
            Enter member details, then verify each bucket.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setBulk(true)}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
        >
          <FileSpreadsheet className="h-4 w-4" />
          Bulk upload
        </button>
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
            {/* Year, make and model come from NHTSA's vehicle
                catalogue. Suggestions, never a gate — see
                `SuggestField`. */}
            {f.key === "vehicleYear" ? (
              <YearField
                value={form.vehicleYear}
                years={vehicles.years}
                error={errors.vehicleYear}
                onChange={(v) => set("vehicleYear", v)}
              />
            ) : f.key === "vehicleMake" ? (
              <SuggestField
                id="f-make"
                label="Vehicle Make"
                value={form.vehicleMake}
                options={vehicles.makes}
                placeholder="Honda"
                error={errors.vehicleMake}
                onChange={(v) => set("vehicleMake", v)}
              />
            ) : f.key === "vehicleModel" ? (
              <SuggestField
                id="f-model"
                label="Vehicle Model"
                value={form.vehicleModel}
                options={vehicles.models}
                placeholder="Accord"
                error={errors.vehicleModel}
                hint={form.vehicleMake && form.vehicleYear
                  ? (vehicles.modelsLoading
                    ? "Looking up models…"
                    : vehicles.models.length === 0
                      ? "No models listed for that make and year — type it in."
                      : undefined)
                  : "Pick a year and make for suggestions, or just type it."}
                onChange={(v) => set("vehicleModel", v)}
              />
            ) : (
            <Field
              label={f.label} required={f.required} error={errors[f.key]}
              value={form[f.key]} placeholder={f.placeholder} onChange={(v) => set(f.key, v)}
            />
            )}
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
          testOnly={options.data?.testOnly ?? []}
          loading={options.isPending}
          onChange={(v) => set("rfid", v)}
        />
        <StickerConfirm
          placement={placement}
          checked={form.stickerAttached}
          error={errors.stickerAttached}
          onChange={(v) => set("stickerAttached", v)}
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

      {bulk && (
        <DmBulkDialog
          onClose={() => setBulk(false)}
          /* Anything added belongs in the list, not on a blank form. */
          onDone={onCancel}
        />
      )}

      {verifying && h && (
        <Verify
          form={form}
          handle={h}
          options={options.data?.options ?? []}
          testOnly={options.data?.testOnly ?? []}
          busy={submit.isPending}
          conflict={conflict}
          placement={placement}
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
  form, handle, options, testOnly, busy, conflict, placement,
  onChange, onCancelEntry, onConfirm,
}: {
  form: Form;
  handle: Handle;
  options: string[];
  testOnly: string[];
  busy: boolean;
  conflict: string;
  placement: Placement;
  onChange: (k: keyof Form, v: string | boolean) => void;
  onCancelEntry: () => void;
  onConfirm: () => void;
}) {
  const [dealerOk, setDealerOk] = useState(false);
  const [customerOk, setCustomerOk] = useState(false);
  const vehicles = useVehicleLists(form.vehicleMake, form.vehicleYear);
  const tz = handle.displayTimezone;

  // A correction after verifying unverifies THAT bucket and only that one:
  // re-reading the dealer fields because a vehicle colour changed teaches
  // people to tick without looking.
  const editDealer = (k: keyof Form, v: string | boolean) => {
    setDealerOk(false);
    onChange(k, v);
  };
  const editCustomer = (k: keyof Form, v: string | boolean) => {
    setCustomerOk(false);
    onChange(k, v);
  };

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
            {/* Year, make and model come from NHTSA's vehicle
                catalogue. Suggestions, never a gate — see
                `SuggestField`. */}
            {f.key === "vehicleYear" ? (
              <YearField
                value={form.vehicleYear}
                years={vehicles.years}
                onChange={(v) => editCustomer("vehicleYear", v)}
              />
            ) : f.key === "vehicleMake" ? (
              <SuggestField
                id="v-make"
                label="Vehicle Make"
                value={form.vehicleMake}
                options={vehicles.makes}
                placeholder="Honda"
                onChange={(v) => editCustomer("vehicleMake", v)}
              />
            ) : f.key === "vehicleModel" ? (
              <SuggestField
                id="v-model"
                label="Vehicle Model"
                value={form.vehicleModel}
                options={vehicles.models}
                placeholder="Accord"
                hint={form.vehicleMake && form.vehicleYear
                  ? (vehicles.modelsLoading
                    ? "Looking up models…"
                    : vehicles.models.length === 0
                      ? "No models listed for that make and year — type it in."
                      : undefined)
                  : "Pick a year and make for suggestions, or just type it."}
                onChange={(v) => editCustomer("vehicleModel", v)}
              />
            ) : (
              <Field
                label={f.label} required={f.required}
                value={form[f.key]} placeholder={f.placeholder}
                onChange={(v) => editCustomer(f.key, v)}
              />
              )}
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
            testOnly={testOnly}
            loading={false}
            onChange={(v) => editCustomer("rfid", v)}
          />
          <StickerConfirm
            placement={placement}
            checked={form.stickerAttached}
            onChange={(v) => editCustomer("stickerAttached", v)}
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
            disabled={!dealerOk || !customerOk || form.rfid === "" || !form.stickerAttached || busy}
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
  value, options, testOnly = [], loading, error, onChange,
}: {
  value: string;
  options: string[];
  /**
   * Tags kept back for testing a gate.
   *
   * Only offered to the account owner at all, and labelled when they
   * are: a test number sitting unmarked among ordinary ones is one
   * mis-click away from a paying member's windshield.
   */
  testOnly?: string[];
  loading: boolean;
  error?: string;
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
        {list.map((n) => (
          <option key={n} value={n}>
            {n}{testOnly.includes(n) ? "  — TEST ONLY" : ""}
          </option>
        ))}
      </select>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
      {testOnly.includes(value) && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-violet-700 dark:text-violet-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          This tag is kept back for testing. Do not use it for a real member.
        </p>
      )}
      {!loading && options.length === 0 && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          No active RFID numbers are left. Upload more under RFID Inventory.
        </p>
      )}
    </div>
  );
}

/**
 * The one thing on this form that is a promise rather than a fact.
 *
 * It spans the row because it is not another field about the vehicle:
 * it is the submitter saying the physical work is done. Recorded with
 * the signup, because when a member cannot get through the gate the
 * question is whether the tag was ever applied, and that is a
 * different conversation from one applied in the wrong place.
 */
function StickerConfirm({
  checked, error, placement, onChange,
}: {
  checked: boolean;
  error?: string;
  placement: Placement;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="sm:col-span-2 lg:col-span-3">
      <label
        className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 ${
          error ? "border-red-500" : checked ? "border-emerald-500/50 bg-emerald-500/5" : "border-border"
        }`}
      >
        <input
          type="checkbox"
          className="mt-0.5"
          checked={checked}
          aria-invalid={Boolean(error)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="text-sm">
          {/* One sentence, from the same setting the instructions page
              reads. Two copies of this would disagree within a month,
              and the person it misleads is holding the sticker. */}
          {placementLine(placement)}
          <span className="text-red-500"> *</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Applied inside the glass, flat and square, not obstructing the driver's view.{" "}
            {/* A real link, not a sentence telling somebody where to go:
                this is the one moment they need the picture, and
                leaving the half-filled form to find it is why it goes
                unread. */}
            <a
              href="#/rfid-instructions"
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-0.5 font-medium text-sky-600 hover:underline"
            >
              See RFID Instructions
              <ExternalLink className="h-3 w-3" />
            </a>
          </span>
        </span>
      </label>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/**
 * The year, make and model lists.
 *
 * One request for years and makes, a second for models once a make
 * and year are both known — which is the only time a model list
 * means anything. Both are cached by the server, so this is cheap
 * and the same for everybody.
 */
function useVehicleLists(make: string, year: string) {
  const base = useQuery({
    queryKey: ["dm-vehicles"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/vehicles");
      if (!res.ok) throw new Error("Could not load.");
      return (await res.json()) as { years: string[]; makes: string[]; source: string };
    },
    staleTime: 60 * 60_000,
  });
  const models = useQuery({
    enabled: make.trim() !== "" && /^(19|20)\d{2}$/.test(year.trim()),
    queryKey: ["dm-vehicle-models", make.trim().toLowerCase(), year.trim()],
    queryFn: async () => {
      const q = new URLSearchParams({ make: make.trim(), year: year.trim() });
      const res = await fetch(`/api/dutch-miller/vehicles/models?${q}`);
      if (!res.ok) throw new Error("Could not load.");
      return (await res.json()) as { models: string[]; source: string };
    },
    staleTime: 60 * 60_000,
  });
  return {
    years: base.data?.years ?? [],
    makes: base.data?.makes ?? [],
    models: models.data?.models ?? [],
    modelsLoading: models.isFetching,
  };
}

/** Model year, picked rather than typed. Nothing has to be fetched for it. */
function YearField({
  value, years, error, onChange,
}: {
  value: string; years: string[]; error?: string; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor="f-year" className="mb-1 block text-xs text-muted-foreground">
        Vehicle Year
      </label>
      <select
        id="f-year"
        value={value}
        aria-invalid={Boolean(error)}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-md border bg-background px-2.5 py-2 text-sm ${
          error ? "border-red-500" : "border-border"
        }`}
      >
        <option value="">—</option>
        {/* A year already on the record that is older than the list
            keeps its place, rather than being silently blanked by a
            dropdown that has never heard of it. */}
        {value !== "" && !years.includes(value) && <option value={value}>{value}</option>}
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/**
 * A field with suggestions that still accepts anything.
 *
 * A combo box rather than a dropdown, deliberately. The catalogue is
 * the US government's and it is still not everything: a kit car, a
 * fleet body, a rebadge or next spring's model must not be
 * unenterable because a list has not caught up. The suggestions stop
 * one dealership writing Chevy, Chevrolet, CHEVY and chev for the
 * same marque; they are not an enumeration.
 */
function SuggestField({
  id, label, value, options, placeholder, hint, error, disabled, onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  placeholder?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        list={`${id}-list`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        aria-invalid={Boolean(error)}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-md border bg-background px-2.5 py-2 text-sm disabled:opacity-60 ${
          error ? "border-red-500" : "border-border"
        }`}
      />
      <datalist id={`${id}-list`}>
        {options.map((o) => <option key={o} value={o} />)}
      </datalist>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
      {!error && hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
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
  title, onClose, children, nav,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  nav?: { label: string; onPrev?: () => void; onNext?: () => void };
}) {
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
          <div className="flex shrink-0 items-center gap-1">
            {nav && (
              <>
                <button
                  type="button"
                  disabled={!nav.onPrev}
                  onClick={nav.onPrev}
                  aria-label="Previous member"
                  className="rounded-md border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="px-1 text-xs tabular-nums text-muted-foreground">
                  {nav.label}
                </span>
                <button
                  type="button"
                  disabled={!nav.onNext}
                  onClick={nav.onNext}
                  aria-label="Next member"
                  className="rounded-md border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="ml-1 rounded-md p-1 text-muted-foreground hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * What was attempted about this member, and how it went.
 *
 * Beside the record, because this is where somebody asks. The wording
 * is careful on purpose: Microsoft ACCEPTING a message is the last
 * fact this application has. Whether it arrived, bounced later, or was
 * read is not observable from here, and a product that says "sent" and
 * means "delivered" is how a dealer gets told their email went
 * through when it did not.
 */
function Deliveries({ guid }: { guid: string }) {
  const q = useQuery({
    queryKey: ["dm-deliveries", guid],
    queryFn: async () => {
      const res = await fetch(`/api/dutch-miller/signups/${guid}/deliveries`);
      if (!res.ok) throw new Error("Could not load.");
      return (await res.json()) as {
        deliveries: {
          id: string; kind: string; email: string; audience: string;
          state: "sending" | "sent" | "failed"; attempts: number;
          firstAt: string; lastAt: string; error: string;
        }[];
        retry: { maxAttempts: number };
      };
    },
  });

  const rows = q.data?.deliveries ?? [];
  if (rows.length === 0) return null;
  const failed = rows.filter((r) => r.state === "failed");

  return (
    <div className="rounded-lg border border-border">
      <p className="border-b border-border px-3 py-2 text-xs font-semibold">
        Email about this member
      </p>
      {failed.length > 0 && (
        <p className="flex items-start gap-2 border-b border-border bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {failed.length} message{failed.length === 1 ? "" : "s"} could not be sent
            after {q.data?.retry.maxAttempts ?? 3} attempts. The member record and its
            RFID are unaffected — only the notification failed.
          </span>
        </p>
      )}
      {rows.map((r) => (
        <div key={r.id} className="flex items-start justify-between gap-3 border-b border-border px-3 py-1.5 text-xs last:border-b-0">
          <span className="min-w-0">
            <span className="block truncate">{r.email}</span>
            <span className="block text-[11px] text-muted-foreground">
              {r.kind === "approved" ? "Approval" : "New member"}
              {r.audience ? ` · ${r.audience}` : ""}
              {r.attempts > 1 ? ` · ${r.attempts} attempts` : ""}
              {r.error ? ` · ${r.error}` : ""}
            </span>
          </span>
          <span className={`shrink-0 font-semibold ${
            r.state === "sent" ? "text-emerald-700 dark:text-emerald-400"
              : r.state === "failed" ? "text-red-700 dark:text-red-400"
                : "text-muted-foreground"
          }`}>
            {r.state === "sent" ? "accepted" : r.state === "failed" ? "failed" : "sending"}
          </span>
        </div>
      ))}
      <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
        &ldquo;Accepted&rdquo; means Microsoft took the message for delivery. Whether it
        arrived, or was read, is not something this application can see.
      </p>
    </div>
  );
}
