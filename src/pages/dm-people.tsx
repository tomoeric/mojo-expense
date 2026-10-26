import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2, ChevronDown, Eye, Loader2, Mail, Pencil, Power, ScrollText, Search, Send, ShieldCheck,
  Trash2, UserRound, X,
} from "lucide-react";

type Role = {
  key: string; name: string; pages: string[];
  administers: boolean; approves: boolean; builtin: boolean;
};
type DmUser = {
  email: string; roleKey: string; roleName?: string;
  authMethod: "microsoft" | "link"; status: "invited" | "active" | "disabled";
  firstName: string | null; lastName: string | null; business: string | null;
};
type PartnerRef = {
  id: string; name: string; affiliation: string;
  line: string; status: "active" | "inactive";
};
type Person = {
  email: string;
  name: string;
  business: string | null;
  /** Partner ids this person may open. */
  accounts: string[];
  /** Every partner, including ones created later. */
  allAccounts: boolean;
  /** How they get in: the Microsoft button, or an emailed link. */
  source: "microsoft" | "invited";
  /** Pinned in DM_SUPER_ADMINS: holds everything, and cannot be edited here. */
  pinnedSuper: boolean;
  user: DmUser | null;
};

/**
 * Everybody who could be given access, in one dialog.
 *
 * This IS the Users screen — reached from the user icon rather than the
 * rail, because it administers the app rather than being a place to do
 * work in it. The rail is for the pages people come here to use.
 *
 * The staff directory and the people already set up, together rather than
 * in two lists, because "is Dana already set up?" is the question somebody
 * is holding when they open this. Picking a name off a list also removes
 * the worst failure of typing an address: an invite that goes somewhere
 * real and is never mentioned again.
 *
 * Three actions per row, and each is absent rather than disabled when it
 * cannot apply — a button that always refuses teaches people to ignore
 * buttons.
 */
export function DmPeopleDialog({
  me, iAmSuper, onClose, onViewAs, onHistory, embedded = false,
}: {
  me: string;
  iAmSuper: boolean;
  onClose: () => void;
  onViewAs: (email: string) => void;
  /**
   * Open Audit History for one account.
   *
   * The trail used to be a second table inside this dialog, reading the
   * same route with a different renderer. One of them was always going
   * to drift. Per-account history is now the Audit History page with the
   * account filled in — the same read, so the two cannot disagree.
   */
  onHistory: (email: string) => void;
  /** Rendered inside the Administration workspace rather than over it. */
  embedded?: boolean;
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [onlyNoRole, setOnlyNoRole] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  const [inviting, setInviting] = useState(false);
  const [partners, setPartners] = useState<Person | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const data = useQuery({
    queryKey: ["dm-people"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/people");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        people: Person[]; roles: Role[];
        accounts: PartnerRef[];
        iAmAccountAdmin: boolean;
        mailConfigured: boolean; mailFrom: string; mailProblem: string;
      };
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
      void qc.invalidateQueries({ queryKey: ["dm-people"] });
    },
    onError: (e) => { setError((e as Error).message); setNote(""); },
  });

  /**
   * Two groups, because they are two different jobs.
   *
   * MOJO staff are already in the tenant and only need a role. Invited
   * people are an account MOJO made for somebody outside, with an
   * invitation that can go unanswered and a link that can expire.
   * Mixed in one list, you had to read the badge on every row to work
   * out which kind of problem you were looking at.
   */
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matches = (p: Person) =>
      (!onlyNoRole || (!p.user && !p.pinnedSuper))
      && (q === "" || p.email.includes(q) || p.name.toLowerCase().includes(q)
        || (p.business ?? "").toLowerCase().includes(q));
    const all = data.data?.people ?? [];
    return {
      microsoft: all.filter((p) => p.source === "microsoft" && matches(p)),
      invited: all.filter((p) => p.source === "invited" && matches(p)),
      total: all.filter(matches).length,
      /*
       * "No role yet" means somebody who cannot do anything.
       *
       * The pinned account administrator has no ROW, so they used to be
       * counted here — the one account that holds everything sitting
       * in a warning list of people waiting for access. Their lack of
       * a row is still true and still shown on their line; it is not
       * a problem anybody should be asked to fix, and assigning them
       * a role to silence it would narrow the owner's own access.
       */
      noRole: all.filter((p) => !p.user && !p.pinnedSuper).length,
    };
  }, [data.data, filter, onlyNoRole]);

  const mailOff = data.data && !data.data.mailConfigured;

  // The same body either way: over the page for the thirty-second
  // errand, inside Administration when somebody came to do a round of
  // them. One component, so the two cannot drift apart.
  const Shell = embedded ? EmbeddedShell : DialogShell;

  return (
    <Shell>
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Users</h2>
            <p className="text-sm text-muted-foreground">
              Everyone who can reach Dutch Miller: MOJO staff on the access list, and
              everyone invited from outside.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={mailOff || act.isPending}
              title={mailOff ? "Email is not configured." : "Send yourself a test message"}
              onClick={() => act.mutate({ url: "/api/dutch-miller/mail-test" }, {
                onSuccess: (b) => setNote(
                  `Test message sent to you from ${(b as { from: string }).from}.`),
              })}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
            >
              <Mail className="h-3.5 w-3.5" />
              Test email
            </button>
            <button
              type="button"
              onClick={() => { setInviting(true); setEditing(null); }}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-semibold text-background"
            >
              <Send className="h-3.5 w-3.5" />
              Invite someone
            </button>
            {!embedded && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <div className="flex min-w-56 flex-1 items-center gap-2 rounded-md border border-border px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Name, email or dealership"
              className="w-full bg-transparent text-sm outline-none"
            />
          </div>
          {/* The two kinds are sections now, so the only filter left is
              the one that crosses both: who still has nothing. */}
          <button
            type="button"
            onClick={() => setOnlyNoRole((v) => !v)}
            className={`rounded-full border px-3 py-1 text-xs ${
              onlyNoRole ? "border-foreground font-semibold" : "border-border text-muted-foreground"
            }`}
          >
            No role yet {groups.noRole}
          </button>
        </div>

        {error && <p className="border-b border-border px-5 py-2 text-sm text-red-600">{error}</p>}
        {note && (
          <p className="border-b border-border px-5 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            {note}
          </p>
        )}
        {inviting && (
          <InviteRow
            roles={data.data?.roles ?? []}
            iAmSuper={iAmSuper}
            busy={act.isPending}
            onCancel={() => setInviting(false)}
            onSave={(body) => act.mutate(
              { url: "/api/dutch-miller/users", body },
              {
                onSuccess: () => {
                  setInviting(false);
                  setNote(`Invitation sent to ${body.email}.`);
                },
              })}
          />
        )}

        <div className="max-h-[60vh] overflow-auto">
          {data.isPending && (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          )}
          {data.data && groups.total === 0 && (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              {filter || onlyNoRole ? "Nobody matches that." : "Nobody to show."}
            </p>
          )}
          {([
            ["MOJO staff", "They sign in with Microsoft. Give them a role.", groups.microsoft],
            ["Invited from outside", "Accounts MOJO created for people with no Microsoft login.",
              groups.invited],
          ] as const).map(([heading, blurb, list]) => list.length === 0 ? null : (
            <section key={heading}>
              <div className="sticky top-0 z-[1] border-b border-border bg-muted/60 px-5 py-1.5 backdrop-blur">
                <p className="text-xs font-semibold">
                  {heading}
                  <span className="ml-1.5 font-normal text-muted-foreground">{list.length}</span>
                </p>
                <p className="text-[11px] text-muted-foreground">{blurb}</p>
              </div>
              {list.map((p) => (
              <Fragment key={p.email}>
            <div
              className="flex items-center gap-3 border-b border-border px-5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                  <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {p.name}
                  {p.email === me && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                      you
                    </span>
                  )}
                  <SourceTag source={p.source} />
                  {p.pinnedSuper && (
                    <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                      Account Admin
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {p.email}
                  {p.business ? ` · ${p.business}` : ""}
                  {p.source === "microsoft" && !p.user ? " · allowed, no role yet" : ""}
                </p>
              </div>

              <div className="hidden w-28 shrink-0 text-xs text-muted-foreground sm:block">
                {p.source === "microsoft" ? "Microsoft" : "Email link"}
              </div>

              <div className="w-44 shrink-0 text-xs">
                {/* Inherited access is not the absence of a role, which
                    is how this used to read: the pinned account admin held
                    no row, so the column said "No role yet" beside the
                    one account that holds everything. */}
                {p.pinnedSuper ? (
                  <>
                    <span className="font-semibold">Inherited full access</span>
                    <span className="block text-muted-foreground">
                      Pinned in configuration, not assigned here
                    </span>
                  </>
                ) : p.user ? (
                  <>
                    <span className="font-semibold">{p.user.roleName ?? p.user.roleKey}</span>
                    {p.user.status !== "active" && (
                      <span className="block text-muted-foreground">
                        {p.user.status === "invited"
                          ? "invited — no access until they set the account up"
                          : "disabled — no access"}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">No role yet</span>
                )}
                {/* Scope, beside the role, because they are two
                    different questions and the answer to one says
                    nothing about the other. A CSC in one dealership
                    and a CSC across seven are the same role. */}
                <PartnerScope person={p} accounts={data.data?.accounts ?? []} />
              </div>

              <ManageMenu
                person={p}
                iAmSuper={iAmSuper}
                onPartners={() => setPartners(p)}
                busy={act.isPending}
                mailOff={Boolean(mailOff)}
                onEdit={() => setEditing(p)}
                onViewAs={() => onViewAs(p.email)}
                onHistory={() => onHistory(p.email)}
                onToggle={() => act.mutate({
                  url: `/api/dutch-miller/users/${encodeURIComponent(p.email)}/enabled`,
                  body: { enabled: p.user!.status === "disabled" },
                })}
                onResend={() => act.mutate(
                  { url: `/api/dutch-miller/users/${encodeURIComponent(p.email)}/invite` },
                  { onSuccess: () => setNote(`Invitation re-sent to ${p.email}.`) })}
                onRemove={() => {
                  if (window.confirm(
                    `Remove ${p.email}?\n\n`
                    + "REMOVE deletes the account row: their role, their invitation "
                    + "and their details go. Their sessions end immediately.\n\n"
                    + "DISABLE ACCESS keeps all of that and simply refuses them, "
                    + "which is what you want if they may come back.\n\n"
                    + "Either way the audit history stays — every event they were "
                    + "part of, and every member record they submitted, is "
                    + "untouched by this.")) {
                    act.mutate({
                      url: `/api/dutch-miller/users/${encodeURIComponent(p.email)}`,
                      method: "DELETE",
                    });
                  }
                }}
              />
            </div>
            {editing?.email === p.email && (
              <AssignRole
                person={p}
                roles={data.data?.roles ?? []}
                iAmSuper={iAmSuper}
                busy={act.isPending}
                onCancel={() => setEditing(null)}
                onSave={(roleKey, invite) => act.mutate(
                  { url: "/api/dutch-miller/users", body: { email: p.email, roleKey, invite } },
                  { onSuccess: () => setEditing(null) })}
              />
            )}
            {partners?.email === p.email && (
              <AssignPartners
                person={p}
                accounts={data.data?.accounts ?? []}
                busy={act.isPending}
                onCancel={() => setPartners(null)}
                onSave={(ids, all) => act.mutate(
                  {
                    url: `/api/dutch-miller/users/${encodeURIComponent(p.email)}/accounts`,
                    body: { accounts: ids, allAccounts: all },
                  },
                  { onSuccess: () => setPartners(null) })}
              />
            )}
              </Fragment>
              ))}
            </section>
          ))}
        </div>
    </Shell>
  );
}

/**
 * Over the page, or part of it.
 *
 * Two wrappers around one body. Users is reachable both ways on
 * purpose: setting somebody's role is a thirty-second errand and
 * losing your place to run it is the annoying part, while a round of
 * them belongs in Administration beside Roles and Audit History.
 */
function DialogShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Users"
        className="w-full max-w-4xl rounded-xl border border-border bg-background shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}

function EmbeddedShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      {children}
    </div>
  );
}

/**
 * Which door somebody comes through, as a word rather than an icon.
 *
 * The distinction is the one that decides what they can be trusted
 * with — a tenant account is MOJO's own and carries the staff-side
 * controls; an invited one never can, whatever its address spells. An
 * icon makes that a thing to decode; the word does not.
 */
function SourceTag({ source }: { source: "microsoft" | "invited" }) {
  return source === "microsoft" ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
      <ShieldCheck className="h-2.5 w-2.5" />
      MOJO
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300">
      <Mail className="h-2.5 w-2.5" />
      Outside
    </span>
  );
}

/**
 * Pick a role for one person.
 *
 * The pages each role carries are shown inline, because "Service Writer"
 * means nothing on its own and nobody should have to open another screen
 * to find out what they are about to grant.
 */
function AssignRole({
  person, roles, iAmSuper, busy, onSave, onCancel,
}: {
  person: Person;
  roles: Role[];
  iAmSuper: boolean;
  busy: boolean;
  onSave: (roleKey: string, invite: boolean) => void;
  onCancel: () => void;
}) {
  const [roleKey, setRoleKey] = useState(person.user?.roleKey ?? "general-user");
  const isNew = !person.user;
  const outside = person.source === "invited" || !person.email.endsWith("mojocarwash.com");
  const needsInvite = isNew && person.source === "invited";
  const chosen = roles.find((r) => r.key === roleKey);

  return (
    <div className="border-t border-border bg-muted/30 px-5 py-4">
      <p className="text-sm font-semibold">
        {isNew ? "Give access to" : "Change role for"} {person.name}
      </p>
      <p className="mb-3 text-xs text-muted-foreground">{person.email}</p>

      <div className="space-y-1.5">
        {roles.map((r) => (
          <label
            key={r.key}
            className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${
              roleKey === r.key ? "border-foreground bg-background" : "border-border"
            } ${r.administers && !iAmSuper ? "opacity-50" : ""}`}
          >
            <input
              type="radio"
              name="role"
              className="mt-0.5"
              checked={roleKey === r.key}
              // Only an account admin hands out a role that administers.
              disabled={r.administers && !iAmSuper}
              onChange={() => setRoleKey(r.key)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{r.name}</span>
              <span className="block text-xs text-muted-foreground">
                {r.approves
                  ? "Every page, and the only role that can approve a membership."
                  : r.administers
                  ? "Every page, plus Users and Settings."
                  : r.pages.length === 0
                    ? "No pages."
                    : `${r.pages.length} page${r.pages.length === 1 ? "" : "s"}.`}
                {r.administers && !iAmSuper ? " Account Administrator only." : ""}
              </span>
            </span>
          </label>
        ))}
      </div>

      {needsInvite && (
        <p className="mt-3 rounded-md bg-background px-3 py-2 text-xs text-muted-foreground">
          An outside address — saving emails them a one-time invitation. The account stays
          inactive until they open it, confirm a code and enter their details.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !chosen}
          onClick={() => onSave(roleKey, needsInvite)}
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {needsInvite ? "Save and invite" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Cancel
        </button>
        {outside && !needsInvite && !isNew && (
          <span className="text-xs text-muted-foreground">
            Changing a role does not re-send an invitation.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Invite somebody from outside.
 *
 * Outside addresses only: one of our own already has a Microsoft account,
 * and emailing them a link would be a second, weaker way into the same
 * app. The server refuses it too.
 */
function InviteRow({
  roles, iAmSuper, busy, onSave, onCancel,
}: {
  roles: Role[];
  iAmSuper: boolean;
  busy: boolean;
  onSave: (u: { email: string; roleKey: string; invite: true }) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState(
    roles.find((r) => !r.administers)?.key ?? "general-user");

  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  const ours = ["mojocarwash.com", "mammothholdings.com"].includes(domain);
  const ready = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && !ours;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <p className="text-sm font-semibold">Invite someone outside MOJO</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@dealership.com"
          className="w-72 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
        <select
          value={roleKey}
          onChange={(e) => setRoleKey(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          {roles.map((r) => (
            <option key={r.key} value={r.key} disabled={r.administers && !iAmSuper}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      {ours && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          That is one of our own addresses. They already sign in with Microsoft — give them a
          role from <strong>People</strong> instead, with nothing to send.
        </p>
      )}
      {ready && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          They will get a one-time link. The account stays inactive until they open it,
          confirm a code and enter their details.
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !ready}
          onClick={() => onSave({ email: email.trim(), roleKey, invite: true })}
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Send invitation
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
 * Everything you can do to one person, behind one labelled control.
 *
 * It used to be a row of five unlabelled icons, which is a guessing
 * game for actions that are not alike: changing somebody's role, and
 * deleting their account, should not be two similar grey squares a
 * few pixels apart.
 *
 * Grouped rather than merely labelled, for the same reason. Role and
 * history are routine; wearing somebody's identity is not; disabling
 * and removing are the two that end access, and removing is the one
 * that cannot be undone, so it is last, separated, and red.
 *
 * An action that cannot apply is ABSENT, never greyed: the pinned
 * account administrator is set in configuration and the server refuses
 * every one of these for them, so offering a button that always fails
 * only teaches people to distrust buttons.
 */
function ManageMenu({
  person, iAmSuper, busy, mailOff,
  onEdit, onPartners, onViewAs, onHistory, onToggle, onResend, onRemove,
}: {
  person: Person;
  iAmSuper: boolean;
  busy: boolean;
  mailOff: boolean;
  onEdit: () => void;
  onPartners: () => void;
  onViewAs: () => void;
  onHistory: () => void;
  onToggle: () => void;
  onResend: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const p = person;
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
      >
        Manage
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
          >
            {!p.pinnedSuper && (
              <Item icon={<Pencil className="h-3.5 w-3.5" />} onClick={pick(onEdit)}>
                {p.user ? "Change role" : "Give access"}
              </Item>
            )}
            {/* Scope is a grant, so it is the account administrator's
                alone — an administrator who could widen it could
                widen their own and walk into every partner. */}
            {iAmSuper && !p.pinnedSuper && p.user && (
              <Item
                icon={<Building2 className="h-3.5 w-3.5" />}
                onClick={pick(onPartners)}
              >
                Partner accounts
              </Item>
            )}
            <Item icon={<ScrollText className="h-3.5 w-3.5" />} onClick={pick(onHistory)}>
              Account history
            </Item>

            {/* Wearing somebody's identity is not a routine errand, so
                it is kept apart from the two above it. */}
            {iAmSuper && !p.pinnedSuper && p.user && p.user.status === "active" && (
              <Item
                icon={<Eye className="h-3.5 w-3.5" />}
                onClick={pick(onViewAs)}
                note="See exactly what they see. Nothing can be changed while viewing."
                divide
              >
                View as {p.name.split(" ")[0] ?? "them"}
              </Item>
            )}

            {p.user?.authMethod === "link" && p.user.status === "invited" && (
              <Item
                icon={<Send className="h-3.5 w-3.5" />}
                onClick={pick(onResend)}
                disabled={busy || mailOff}
                divide
              >
                Resend invitation
              </Item>
            )}

            {p.user && !p.pinnedSuper && (
              <Item
                icon={<Power className="h-3.5 w-3.5" />}
                onClick={pick(onToggle)}
                disabled={busy}
                note={p.user.status === "disabled"
                  ? "Their role and history are already here."
                  : "Keeps the account, its role and its history."}
                divide
              >
                {p.user.status === "disabled" ? "Restore access" : "Disable access"}
              </Item>
            )}

            {p.user && !p.pinnedSuper && (
              <Item
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={pick(onRemove)}
                disabled={busy}
                note="Deletes the account row. The audit history stays."
                danger
                divide
              >
                Remove
              </Item>
            )}

            {p.pinnedSuper && (
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                Account Admin, pinned in configuration. Their access is not assigned
                here and cannot be changed from this app.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Item({
  icon, children, onClick, disabled, note, danger, divide,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  note?: string;
  danger?: boolean;
  divide?: boolean;
}) {
  return (
    <button
      role="menuitem"
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-40 ${
        divide ? "border-t border-border" : ""
      } ${danger ? "text-red-600" : ""}`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        {children}
        {note && <span className="mt-0.5 block text-[11px] text-muted-foreground">{note}</span>}
      </span>
    </button>
  );
}

/**
 * Which partners somebody holds, on their row.
 *
 * A separate line from the role, because they are separate
 * questions: a CSC in one dealership and a CSC across seven hold the
 * same role and very different reach, and a column that showed only
 * one of the two would make them look identical.
 */
function PartnerScope({ person, accounts }: { person: Person; accounts: PartnerRef[] }) {
  if (person.allAccounts) {
    return (
      <span className="mt-0.5 block text-[11px] font-semibold text-blue-700 dark:text-blue-400">
        All partners
        {person.pinnedSuper && <span className="font-normal text-muted-foreground"> · pinned</span>}
      </span>
    );
  }
  if (!person.user) return null;
  const names = accounts.filter((a) => person.accounts.includes(a.id)).map((a) => a.name);
  return (
    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
      {names.length === 0
        ? "No partner account"
        : names.length <= 2
          ? names.join(", ")
          : `${names.length} partners`}
    </span>
  );
}

/**
 * Set which partners somebody may open.
 *
 * Whole-list rather than add and remove, because that is what the
 * form shows and reconciling a set of tick-boxes into two streams of
 * calls is how a half-applied change happens.
 *
 * All partners is a MARK, not "tick all seven". The difference shows
 * the day an eighth is created: a list of seven is silently missing
 * from it and the mark is not. Offered only for somebody who came
 * through the Microsoft door — the mark means platform staff, and an
 * invited account is by definition one partner's own person.
 */
function AssignPartners({
  person, accounts, busy, onCancel, onSave,
}: {
  person: Person;
  accounts: PartnerRef[];
  busy: boolean;
  onCancel: () => void;
  onSave: (ids: string[], all: boolean) => void;
}) {
  const [all, setAll] = useState(person.allAccounts);
  const [picked, setPicked] = useState<string[]>(person.accounts);
  const invited = person.user?.authMethod === "link";

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-xs font-semibold">Which partners can {person.name} open?</p>

      {!invited && (
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">All partners</span>
            <span className="block text-muted-foreground">
              Every account on the platform, including ones created later. For MOJO staff
              who work across partners.
            </span>
          </span>
        </label>
      )}

      <div className={`space-y-1 ${all ? "pointer-events-none opacity-40" : ""}`}>
        {accounts.length === 0 && (
          <p className="text-xs text-muted-foreground">There are no partner accounts.</p>
        )}
        {accounts.map((a) => (
          <label key={a.id} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={all || picked.includes(a.id)}
              onChange={(e) => setPicked((v) => (e.target.checked
                ? [...v, a.id]
                : v.filter((x) => x !== a.id)))}
            />
            <span className="truncate">
              {a.line}
              {a.status === "inactive" && (
                <span className="ml-1 text-amber-700 dark:text-amber-400">· deactivated</span>
              )}
            </span>
          </label>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(all ? [] : picked, all)}
          className="rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-background
                     disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
