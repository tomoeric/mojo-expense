import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, Loader2, Plus, Trash2 } from "lucide-react";

type PageDef = { key: string; label: string; blurb: string };
type ActionDef = { key: string; label: string; source: string };
type Role = {
  key: string; name: string; pages: string[];
  administers: boolean; approves: boolean; builtin: boolean; holders?: number;
  /** Empty for a shared template role; an account id for one partner's own. */
  accountId: string;
  deletesSignups: boolean; deletesRfid: boolean; rfidReadOnly: boolean;
  approvesVendors: boolean;
  createdAt: string | null; createdBy: string | null;
  /** Derived from the rules the guards apply. Never stored, never edited. */
  actions: Record<string, boolean>;
};
type Payload = {
  roles: Role[];
  /** The rail's grouping. The editor uses `allGrants` instead. */
  allPages: readonly PageDef[];
  /** What a role can actually be given, flat — one entry per grant. */
  allGrants: readonly PageDef[];
  allActions: ActionDef[];
  approvalPolicy: { roleKey: string; note: string };
  superAdmin: { actions: Record<string, boolean> };
  /** Writing a SHARED role reaches every partner, so it is the platform's. */
  canWriteShared: boolean;
  /** The account in view, when there is one. Its own roles are editable here. */
  myAccount: string;
  accountName: string;
};

type Draft = {
  key?: string; name: string; pages: string[]; administers: boolean;
  deletesSignups: boolean; deletesRfid: boolean; rfidReadOnly: boolean;
  approvesVendors: boolean;
  /** Empty for a shared template role; an account id for one partner's own. */
  accountId: string;
};

/**
 * Roles, and what each one can open.
 *
 * Account Administrator only. A role IS a grant of access, so an
 * administrator who could write one could write themselves a better one
 * — the two levels would then differ by a label.
 *
 * Pages come from the role and nowhere else. Granting a new page to a job
 * is one tick here rather than finding everybody who does that job.
 */
export function DmRolesPage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");

  const data = useQuery({
    queryKey: ["dm-roles"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/roles");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as Payload;
    },
  });

  const act = useMutation({
    mutationFn: async (v: { url: string; body?: unknown; method?: string }) => {
      const res = await fetch(v.url, {
        method: v.method ?? "POST",
        headers: { "content-type": "application/json" },
        body: v.body === undefined ? undefined : JSON.stringify(v.body),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "That did not work.");
      return body;
    },
    onSuccess: () => {
      setError("");
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ["dm-roles"] });
      void qc.invalidateQueries({ queryKey: ["dm-users"] });
      void qc.invalidateQueries({ queryKey: ["dm-people"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const roles = data.data?.roles ?? [];
  // The flat list, because a role is given PAGES and the rail's
  // grouping is a layout detail. Member Signups is one heading over
  // two grants, and the editor has to offer both.
  const pages = data.data?.allGrants ?? data.data?.allPages ?? [];
  const canWriteShared = data.data?.canWriteShared === true;
  const myAccount = data.data?.myAccount ?? "";
  const accountName = data.data?.accountName ?? "this account";
  /*
   * What this person may write, per role.
   *
   * A shared role reaches every partner, so only the platform's
   * account administrator writes one. An account's own administrator
   * writes their own account's roles. Said per row rather than once
   * at the top, because both kinds are in the same list.
   */
  const mayWrite = (r: Role) =>
    (r.accountId === "" ? canWriteShared : r.accountId === myAccount);
  const allActions = data.data?.allActions ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Crown className="h-4 w-4" />
            Roles &amp; Permissions
          </h1>
          <p className="text-sm text-muted-foreground">
            What each kind of person can <strong>open</strong>, and what they can{" "}
            <strong>do</strong>.{" "}
            {canWriteShared
              ? "Shared template roles exist in every partner account and a change to "
                + "one changes them all. A partner's own roles apply to that partner "
                + "alone."
              : `Shared template roles come from MOJO and are read-only here. Roles you `
                + `add belong to ${accountName} and apply nowhere else — pages and the `
                + `RFID view-only setting, since a grant that widens reach stays with an `
                + `account administrator.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDraft({
            name: "", pages: [], administers: false,
            deletesSignups: false, deletesRfid: false, rfidReadOnly: false,
            approvesVendors: false,
            // A new role belongs to whoever is making it: shared for
            // the platform, this partner's for an account's own
            // administrator. Decided again on the server from who is
            // asking, never from this.
            accountId: canWriteShared ? "" : myAccount,
          })}
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background"
        >
          <Plus className="h-4 w-4" />
          New role
        </button>
      </div>

      {error && <p className="text-sm font-semibold text-red-600">{error}</p>}

      {draft && (
        <RoleEditor
          draft={draft}
          pages={pages}
          busy={act.isPending}
          canWriteShared={canWriteShared}
          accountName={accountName}
          onChange={setDraft}
          onCancel={() => { setDraft(null); setError(""); }}
          onSave={() => act.mutate({ url: "/api/dutch-miller/roles", body: draft })}
        />
      )}

      <div className="space-y-2">
        {data.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {roles.map((r) => (
          <div key={r.key} className="rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  {r.name}
                  {/* Whose role this is, first, because it decides
                      what changing it would reach. */}
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    r.accountId === ""
                      ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
                      : "bg-amber-500/15 text-amber-800 dark:text-amber-300"}`}>
                    {r.accountId === "" ? "shared template" : `${accountName} only`}
                  </span>
                  {r.builtin && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                      built in
                    </span>
                  )}
                  {r.administers && (
                    <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
                      administers
                    </span>
                  )}
                  {/* Not a tick-box anywhere: approving belongs to this
                      one role, so it is stated rather than granted. */}
                  {r.approves && (
                    <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                      approves memberships
                    </span>
                  )}
                  {/* Worth seeing without opening the role: these are
                      the two that remove things. */}
                  {r.deletesSignups && (
                    <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-400">
                      deletes members
                    </span>
                  )}
                  {r.deletesRfid && (
                    <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-400">
                      deletes RFIDs
                    </span>
                  )}
                  {r.approvesVendors && (
                    <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                      approves vendors
                    </span>
                  )}
                  {r.rfidReadOnly && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      RFID view only
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.approves
                    ? "The only role that can mark a membership approved."
                    : r.administers
                    ? "Every page, plus Users, Roles and Settings."
                    : r.pages.length === 0
                      ? "No pages — holders see nothing until this changes."
                      : pages.filter((p) => r.pages.includes(p.key))
                        .map((p) => p.label).join(" · ")}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.holders === 0
                    ? "Nobody holds it"
                    : `${r.holders} ${r.holders === 1 ? "person holds" : "people hold"} it`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* A role somebody cannot write shows no Edit rather
                    than one that refuses: a button that always fails
                    teaches people to ignore buttons. */}
                {mayWrite(r) ? (
                  <button
                    type="button"
                    onClick={() => setDraft({
                      key: r.key, name: r.name, pages: [...r.pages],
                      administers: r.administers,
                      deletesSignups: r.deletesSignups, deletesRfid: r.deletesRfid,
                      rfidReadOnly: r.rfidReadOnly,
                      approvesVendors: r.approvesVendors,
                      accountId: r.accountId,
                    })}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                  >
                    Edit
                  </button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {r.accountId === ""
                      ? "Shared — an account administrator changes it"
                      : "Another partner's"}
                  </span>
                )}
                {/* Built-in roles and roles somebody holds are not offered a
                    delete button: the server refuses both, and moving people
                    automatically would be a silent change to what several of
                    them can see. */}
                {!r.builtin && r.holders === 0 && mayWrite(r) && (
                  <button
                    type="button"
                    disabled={act.isPending}
                    title="Remove"
                    onClick={() => {
                      if (window.confirm(`Remove the ${r.name} role?`)) {
                        act.mutate({
                          url: `/api/dutch-miller/roles/${encodeURIComponent(r.key)}`,
                          method: "DELETE",
                        });
                      }
                    }}
                    className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* The two questions, side by side. A list of pages answers
                only one of them, which is how "can a service writer
                approve?" came to have no visible answer anywhere. */}
            <details className="mt-3 border-t border-border pt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Page access and action permissions
              </summary>
              <div className="mt-2 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold">Page access</p>
                  <ul className="mt-1 space-y-0.5">
                    {pages.map((pg) => (
                      <Mark
                        key={pg.key}
                        on={r.administers || r.pages.includes(pg.key)}
                        label={pg.label}
                        note={r.administers && !r.pages.includes(pg.key)
                          ? "via administering" : ""}
                      />
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-semibold">Action permissions</p>
                  <p className="text-[11px] text-muted-foreground">
                    Worked out from the rules the server enforces. Not editable —
                    see the note below.
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {allActions.map((a) => (
                      <Mark
                        key={a.key}
                        on={Boolean(r.actions?.[a.key])}
                        label={a.label}
                        note={a.source}
                      />
                    ))}
                  </ul>
                </div>
              </div>
            </details>
          </div>
        ))}
      </div>

      {/* The question the role list cannot answer on its own: nobody
          holds CSC, and approvals work anyway. */}
      {data.data?.approvalPolicy && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-900 dark:text-amber-200">
          <p className="font-semibold">Who can approve a membership</p>
          <p className="mt-1">{data.data.approvalPolicy.note}</p>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        A role cannot be removed while anybody holds it — move them first. Built-in roles can
        have their pages changed but cannot be renamed or removed, because other things are
        written against them. Approving a membership belongs to the CSC role alone and is
        not something a role can be given here.
      </p>
    </div>
  );
}

function RoleEditor({
  draft, pages, busy, canWriteShared, accountName, onChange, onSave, onCancel,
}: {
  draft: Draft;
  pages: readonly PageDef[];
  busy: boolean;
  /** The platform's account administrator. Everybody else writes their own. */
  canWriteShared: boolean;
  accountName: string;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const builtin = draft.key === "administrator" || draft.key === "general-user"
    || draft.key === "csc";
  /*
   * The grants that WIDEN reach are the platform's.
   *
   * Administering, deleting and signing vendors off are not offered
   * to an account's own administrator — the rule this codebase has
   * had since roles existed is that somebody who can hand out a
   * grant can hand it to themselves, and that does not stop being
   * true inside a partner. The server refuses them too; this is
   * what stops a tick-box appearing that would only be rejected.
   */
  const widening = canWriteShared;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div>
        <label htmlFor="role-name" className="mb-1 block text-xs text-muted-foreground">
          Role name
        </label>
        <input
          id="role-name"
          autoFocus
          value={draft.name}
          disabled={builtin}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="Service Writer"
          className="w-72 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm disabled:opacity-60"
        />
        {builtin && (
          <p className="mt-1 text-xs text-muted-foreground">
            A built-in role cannot be renamed. Its pages can still be changed.
          </p>
        )}
      </div>

      <div>
        <p className="mb-1 text-xs text-muted-foreground">Can open</p>
        <div className="flex flex-wrap gap-3">
          {pages.map((p) => (
            <label key={p.key} className="flex items-center gap-2 text-sm" title={p.blurb}>
              <input
                type="checkbox"
                disabled={draft.administers}
                checked={draft.administers || draft.pages.includes(p.key)}
                onChange={(e) => onChange({
                  ...draft,
                  pages: e.target.checked
                    ? [...draft.pages, p.key]
                    : draft.pages.filter((k) => k !== p.key),
                })}
              />
              {p.label}
            </label>
          ))}
        </div>
      </div>

      {!builtin && widening && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.administers}
            onChange={(e) => onChange({ ...draft, administers: e.target.checked })}
          />
          Administers — every page, plus Users and Settings
        </label>
      )}

      {!widening && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          This role belongs to <strong>{accountName}</strong> and applies nowhere else.
          Administering, deleting records and approving vendors are granted by a MOJO
          account administrator — somebody who can hand out a grant can hand it to
          themselves, which is why those stay outside the account.
        </p>
      )}

      {/* Its own grant rather than borrowing CSC: approving a
          membership says a car may be washed, approving a vendor
          says a company may be paid. Different question, often a
          different department. */}
      {draft.pages.includes("vendors") && widening && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={draft.approvesVendors}
            onChange={(e) => onChange({ ...draft, approvesVendors: e.target.checked })}
          />
          <span>
            Can approve a vendor
            <span className="block text-xs text-muted-foreground">
              Signs off a new vendor and every change to one, or sends it back with
              a reason. Separate from approving a membership.
            </span>
          </span>
        </label>
      )}

      {/* Opening the page and changing it are different things, so
          this sits with the page list rather than with the grants. */}
      {draft.pages.includes("rfid-review") && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={draft.rfidReadOnly}
            onChange={(e) => onChange({ ...draft, rfidReadOnly: e.target.checked })}
          />
          <span>
            RFID Inventory is view only
            <span className="block text-xs text-muted-foreground">
              They can read the pool and search it. No uploading, no holding tags
              back, no issuing and no removing — even if those are ticked below.
            </span>
          </span>
        </label>
      )}

      {/* Separated from the page list, and from administering, because
          these are the only two that take something away. Both are
          soft deletes — the record stays, struck through, with the
          note whoever removed it had to write — which is what makes
          them safe to grant rather than keep to one person. */}
      {widening && (
      <div>
        <p className="mb-1 text-xs text-muted-foreground">Can delete</p>
        <div className="space-y-1.5">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={draft.deletesSignups}
              onChange={(e) => onChange({ ...draft, deletesSignups: e.target.checked })}
            />
            <span>
              Member records
              <span className="block text-xs text-muted-foreground">
                Marks a membership deleted, with a required note. The record stays
                in the list and its RFID stays issued unless released.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={draft.deletesRfid}
              onChange={(e) => onChange({ ...draft, deletesRfid: e.target.checked })}
            />
            <span>
              RFID numbers
              <span className="block text-xs text-muted-foreground">
                Removes tags from the pool, with a required note. They never come
                back — not even by re-uploading the file that brought them in.
              </span>
            </span>
          </label>
        </div>
      </div>
      )}

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          disabled={busy || draft.name.trim() === ""}
          onClick={onSave}
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * One permission, on or off, with where it comes from.
 *
 * A tick rather than a checkbox, deliberately: none of these is stored
 * per role, so an editable-looking control would broaden access the
 * first time somebody saved one. The source line is what makes a tick
 * checkable — "approve a membership" says why it is off, rather than
 * leaving somebody hunting for the box.
 */
function Mark({ on, label, note }: { on: boolean; label: string; note?: string }) {
  return (
    <li className="flex items-start gap-1.5 text-xs">
      <span
        aria-hidden
        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
          on ? "bg-emerald-500" : "bg-muted-foreground/30"
        }`}
      />
      <span className={on ? "" : "text-muted-foreground"}>
        {label}
        <span className="sr-only">{on ? " — allowed" : " — not allowed"}</span>
        {note && <span className="block text-[11px] text-muted-foreground">{note}</span>}
      </span>
    </li>
  );
}
