import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye, Loader2, Mail, Pencil, Power, ScrollText, Search, Send, ShieldCheck,
  Trash2, UserRound, X,
} from "lucide-react";

type Role = { key: string; name: string; pages: string[]; administers: boolean; builtin: boolean };
type DmUser = {
  email: string; roleKey: string; roleName?: string;
  authMethod: "microsoft" | "link"; status: "invited" | "active" | "disabled";
  firstName: string | null; lastName: string | null; business: string | null;
};
type Person = {
  email: string;
  name: string;
  business: string | null;
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
  me, iAmSuper, onClose, onViewAs,
}: {
  me: string;
  iAmSuper: boolean;
  onClose: () => void;
  onViewAs: (email: string) => void;
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<"all" | "configured" | "not">("all");
  const [editing, setEditing] = useState<Person | null>(null);
  const [inviting, setInviting] = useState(false);
  const [trail, setTrail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const data = useQuery({
    queryKey: ["dm-people"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/people");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        people: Person[]; roles: Role[];
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

  const people = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data.data?.people ?? []).filter((p) => {
      if (show === "configured" && !p.user) return false;
      if (show === "not" && p.user) return false;
      if (q === "") return true;
      return p.email.includes(q) || p.name.toLowerCase().includes(q)
        || (p.business ?? "").toLowerCase().includes(q);
    });
  }, [data.data, filter, show]);

  const mailOff = data.data && !data.data.mailConfigured;
  const counts = {
    all: data.data?.people.length ?? 0,
    configured: data.data?.people.filter((p) => p.user).length ?? 0,
    not: data.data?.people.filter((p) => !p.user).length ?? 0,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="People"
        className="w-full max-w-4xl rounded-xl border border-border bg-background shadow-xl"
      >
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
              onClick={() => setTrail(trail === null ? "" : null)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
            >
              <ScrollText className="h-3.5 w-3.5" />
              Audit trail
            </button>
            <button
              type="button"
              onClick={() => { setInviting(true); setEditing(null); }}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-semibold text-background"
            >
              <Send className="h-3.5 w-3.5" />
              Invite someone
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
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
          {([["all", "Everyone"], ["configured", "Has a role"], ["not", "No role yet"]] as const)
            .map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setShow(k)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  show === k ? "border-foreground font-semibold" : "border-border text-muted-foreground"
                }`}
              >
                {label} {counts[k]}
              </button>
            ))}
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
        {trail !== null && <AuditTrail subject={trail} onClose={() => setTrail(null)} />}

        <div className="max-h-[60vh] overflow-auto">
          {data.isPending && (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          )}
          {data.data && people.length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              {filter ? "Nobody matches that." : "Nobody to show."}
            </p>
          )}
          {people.map((p) => (
            <div
              key={p.email}
              className="flex items-center gap-3 border-b border-border px-5 py-2.5 last:border-b-0"
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
                  {p.source === "invited"
                    ? <Mail className="h-3 w-3 shrink-0 text-muted-foreground" />
                    : <ShieldCheck className="h-3 w-3 shrink-0 text-muted-foreground" />}
                  {p.pinnedSuper && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                      super admin
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {p.email}
                  {p.business ? ` · ${p.business}` : ""}
                  {p.source === "microsoft" && !p.user ? " · allowed, no role yet" : ""}
                </p>
              </div>

              <div className="w-44 shrink-0 text-xs">
                {p.pinnedSuper ? (
                  <span className="font-semibold">Everything</span>
                ) : p.user ? (
                  <>
                    <span className="font-semibold">{p.user.roleName ?? p.user.roleKey}</span>
                    {p.user.status !== "active" && (
                      <span className="block text-muted-foreground">{p.user.status}</span>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">No role yet</span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {/* A pinned super administrator is set in configuration,
                    not here — the server refuses every one of these for
                    them, and a button that always fails is worse than none. */}
                {!p.pinnedSuper && (
                  <button
                    type="button"
                    title={p.user ? "Change role" : "Give access"}
                    onClick={() => setEditing(p)}
                    className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
                {/* Only a super admin may view as, and only somebody who
                    actually has an account to view. */}
                {iAmSuper && !p.pinnedSuper && p.user && p.user.status === "active" && (
                  <button
                    type="button"
                    title={`View Dutch Miller as ${p.name}`}
                    onClick={() => onViewAs(p.email)}
                    className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                )}
                {p.user && !p.pinnedSuper && (
                  <button
                    type="button"
                    disabled={act.isPending}
                    title={p.user.status === "disabled" ? "Switch on" : "Switch off"}
                    onClick={() => act.mutate({
                      url: `/api/dutch-miller/users/${encodeURIComponent(p.email)}/enabled`,
                      body: { enabled: p.user!.status === "disabled" },
                    })}
                    className={`rounded-md border p-1.5 hover:bg-muted disabled:opacity-50 ${
                      p.user.status === "disabled"
                        ? "border-red-500/50 text-red-600"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    <Power className="h-3.5 w-3.5" />
                  </button>
                )}
                {p.user?.authMethod === "link" && p.user.status === "invited" && (
                  <button
                    type="button"
                    disabled={act.isPending || mailOff}
                    title="Send the invitation again"
                    onClick={() => act.mutate(
                      { url: `/api/dutch-miller/users/${encodeURIComponent(p.email)}/invite` },
                      { onSuccess: () => setNote(`Invitation re-sent to ${p.email}.`) })}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    Resend
                  </button>
                )}
                <button
                  type="button"
                  title="History for this account"
                  onClick={() => setTrail(p.email)}
                  className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
                >
                  <ScrollText className="h-3.5 w-3.5" />
                </button>
                {/* Removing is not the same as switching off, and the
                    difference is worth the extra click: switching off keeps
                    the record and its history, this does not. */}
                {p.user && !p.pinnedSuper && (
                  <button
                    type="button"
                    disabled={act.isPending}
                    title="Remove"
                    onClick={() => {
                      if (window.confirm(
                        `Remove ${p.email}? Switching off instead keeps the record and `
                        + "the audit trail.")) {
                        act.mutate({
                          url: `/api/dutch-miller/users/${encodeURIComponent(p.email)}`,
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
          ))}
        </div>

        {editing && (
          <AssignRole
            person={editing}
            roles={data.data?.roles ?? []}
            iAmSuper={iAmSuper}
            busy={act.isPending}
            onCancel={() => setEditing(null)}
            onSave={(roleKey, invite) => act.mutate(
              { url: "/api/dutch-miller/users", body: { email: editing.email, roleKey, invite } },
              { onSuccess: () => setEditing(null) })}
          />
        )}
      </div>
    </div>
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
              // Only a super admin hands out a role that administers.
              disabled={r.administers && !iAmSuper}
              onChange={() => setRoleKey(r.key)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{r.name}</span>
              <span className="block text-xs text-muted-foreground">
                {r.administers
                  ? "Every page, plus Users and Settings."
                  : r.pages.length === 0
                    ? "No pages."
                    : `${r.pages.length} page${r.pages.length === 1 ? "" : "s"}.`}
                {r.administers && !iAmSuper ? " Super administrator only." : ""}
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

/* ------------------------------------------------------------------ *
 * The audit trail
 * ------------------------------------------------------------------ */

type Entry = {
  id: string; at: string; actor: string; action: string;
  subject: string; detail: string; ip: string;
};

function AuditTrail({ subject, onClose }: { subject: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["dm-audit", subject],
    queryFn: async () => {
      const url = `/api/dutch-miller/audit${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as { entries: Entry[] };
    },
  });

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <p className="text-sm font-semibold">Audit trail{subject ? ` · ${subject}` : ""}</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          Close
        </button>
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-xs">
          <tbody>
            {q.isPending && (
              <tr><td className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {q.data?.entries.length === 0 && (
              <tr><td className="px-4 py-6 text-center text-muted-foreground">
                Nothing recorded yet.
              </td></tr>
            )}
            {q.data?.entries.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="px-4 py-1.5 whitespace-nowrap text-muted-foreground">
                  {new Date(e.at).toLocaleString()}
                </td>
                <td className="px-2 py-1.5 font-mono">{e.action}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{e.subject}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{e.actor || "—"}</td>
                <td className="px-4 py-1.5 text-muted-foreground">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Read-only on purpose: there is no route that edits or deletes a
          line. A log somebody can tidy up is not evidence of anything. */}
      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        Read-only. Entries are never edited or removed, and never contain a code or a link.
      </p>
    </div>
  );
}
