import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye, Loader2, Mail, Pencil, Power, ScrollText, Send, ShieldCheck, Trash2,
  UserRound, Users as UsersIcon,
} from "lucide-react";
import { DmPeopleDialog } from "@/pages/dm-people";

type Role = { key: string; name: string; pages: string[]; administers: boolean; builtin: boolean };
type Status = "invited" | "active" | "disabled";
type DmUser = {
  email: string; roleKey: string; roleName: string;
  authMethod: "microsoft" | "link"; status: Status;
  firstName: string | null; lastName: string | null;
  business: string | null; phone: string | null;
  invitedAt: string | null; activatedAt: string | null; lastSeenAt: string | null;
};
type Payload = {
  users: DmUser[];
  roles: Role[];
  allPages: readonly { key: string; label: string; blurb: string }[];
  myRole: "super" | "admin" | "user";
  mailConfigured: boolean;
  mailFrom: string;
  mailProblem: string;
  mailAppIsSeparate: boolean;
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

/**
 * Users — administrators only, and mainly about people OUTSIDE MOJO.
 *
 * Staff do not need adding here in the ordinary way: they sign in with
 * Microsoft, and giving one of them a Dutch Miller role is a couple of
 * clicks in the People dialog, off the staff directory. What this page
 * exists for is the other direction — inviting a dealer, who has no
 * Microsoft account and can never create one for themselves.
 *
 * Which pages anybody can open is NOT decided here. It comes from the
 * role they hold, and roles live on their own page under the super
 * administrator.
 */
export function DmUsersPage({ me, iAmSuper }: { me: string; iAmSuper: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [inviting, setInviting] = useState(false);
  const [people, setPeople] = useState(false);
  const [trail, setTrail] = useState<string | null>(null);

  const data = useQuery({
    queryKey: ["dm-users"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/users");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as Payload;
    },
  });

  const act = useMutation({
    mutationFn: async (v: { url: string; method?: string; body?: unknown }) => {
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
      void qc.invalidateQueries({ queryKey: ["dm-users"] });
      void qc.invalidateQueries({ queryKey: ["dm-people"] });
    },
    onError: (e) => { setError((e as Error).message); setNote(""); },
  });

  const viewAs = async (email: string) => {
    await fetch("/api/auth/view-as", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    // A full load: every cached query was answered for somebody else.
    window.location.href = "/";
  };

  const users = data.data?.users ?? [];
  const roles = data.data?.roles ?? [];
  const mailOff = data.data && !data.data.mailConfigured;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">
            Invite people outside MOJO and Mammoth Holdings, and set what everybody holds.
            Administrators only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={mailOff || act.isPending}
            title={mailOff ? "Set MAIL_FROM first." : "Send yourself a test message"}
            onClick={() => act.mutate({ url: "/api/dutch-miller/mail-test" }, {
              onSuccess: (b) => setNote(
                `Test message sent to you from ${(b as { from: string }).from}.`),
            })}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Mail className="h-4 w-4" />
            Test email
          </button>
          <button
            type="button"
            onClick={() => setTrail(trail === null ? "" : null)}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          >
            <ScrollText className="h-4 w-4" />
            Audit trail
          </button>
          {/* Staff come off the directory rather than being typed out. */}
          <button
            type="button"
            onClick={() => setPeople(true)}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          >
            <UsersIcon className="h-4 w-4" />
            People
          </button>
          <button
            type="button"
            onClick={() => setInviting(true)}
            className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background"
          >
            <Send className="h-4 w-4" />
            Invite someone
          </button>
        </div>
      </div>

      {mailOff && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200">
          Invitations cannot be sent yet. {data.data?.mailProblem} MOJO staff can still be
          given a role — they sign in with Microsoft.
        </p>
      )}
      {!mailOff && data.data && (
        <p className="text-xs text-muted-foreground">
          Invitations send from <strong>{data.data.mailFrom}</strong> using the{" "}
          {data.data.mailAppIsSeparate ? "dedicated mail" : "shared sign-in"} app registration.
        </p>
      )}
      {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
      {note && <p className="text-sm text-emerald-700 dark:text-emerald-400">{note}</p>}

      {inviting && (
        <InviteRow
          roles={roles}
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

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Person</th>
              <th className="px-3 py-2 text-left font-semibold">Signs in</th>
              <th className="px-3 py-2 text-left font-semibold">Role</th>
              <th className="px-3 py-2 text-left font-semibold">Last seen</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {data.isPending && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!data.isPending && users.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                Nobody has been given a role yet. Use <strong>People</strong> for MOJO and
                Mammoth staff, or <strong>Invite someone</strong> for a dealer.
                <br />
                You can see this page because you are a super administrator by configuration.
              </td></tr>
            )}
            {users.map((u) => (
              <tr key={u.email} className="border-t border-border align-top">
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-1.5">
                    <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">
                      {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email}
                    </span>
                    {u.email === me && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        you
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {u.email}{u.business ? ` · ${u.business}` : ""}
                  </span>
                  <StatusLine user={u} />
                </td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    {u.authMethod === "microsoft"
                      ? <><ShieldCheck className="h-3 w-3" /> Microsoft</>
                      : <><Mail className="h-3 w-3" /> Email link</>}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-sm">{u.roleName || u.roleKey}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{when(u.lastSeenAt)}</td>
                <td className="px-3 py-2.5">
                  <RowActions
                    user={u}
                    roles={roles}
                    iAmSuper={iAmSuper}
                    busy={act.isPending}
                    onAct={(url, body, method) => act.mutate({ url, body, method })}
                    onViewAs={() => void viewAs(u.email)}
                    onTrail={() => setTrail(u.email)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Which pages somebody can open comes from the role they hold, not from this page.
        {iAmSuper
          ? " Roles are set under Roles in the rail."
          : " Only a super administrator can change what a role covers."}
      </p>

      {trail !== null && <AuditTrail subject={trail} onClose={() => setTrail(null)} />}
      {people && (
        <DmPeopleDialog
          iAmSuper={iAmSuper}
          onClose={() => setPeople(false)}
          onViewAs={(email) => void viewAs(email)}
        />
      )}
    </div>
  );
}

/** Where this account is in its life, said in words rather than a colour. */
function StatusLine({ user }: { user: DmUser }) {
  if (user.status === "disabled") {
    return (
      <span className="mt-1 inline-block rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:text-red-400">
        Switched off
      </span>
    );
  }
  if (user.status === "invited") {
    return (
      <span className="mt-1 inline-block rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
        Invited {when(user.invitedAt)} — not set up yet
      </span>
    );
  }
  return null;
}

/**
 * Edit, view as, switch off — plus resend and remove where they apply.
 *
 * An action is ABSENT rather than disabled when it cannot apply. The
 * server refuses all of these against an administrator unless a super
 * administrator is asking, and a button that always refuses teaches
 * people to ignore buttons.
 */
function RowActions({
  user, roles, iAmSuper, busy, onAct, onViewAs, onTrail,
}: {
  user: DmUser;
  roles: Role[];
  iAmSuper: boolean;
  busy: boolean;
  onAct: (url: string, body?: unknown, method?: string) => void;
  onViewAs: () => void;
  onTrail: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const base = `/api/dutch-miller/users/${encodeURIComponent(user.email)}`;
  const theirs = roles.find((r) => r.key === user.roleKey);
  const mayTouch = iAmSuper || !theirs?.administers;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1">
        {mayTouch && (
          <button
            type="button"
            title="Change role"
            onClick={() => setEditing((v) => !v)}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {iAmSuper && user.status === "active" && (
          <button
            type="button"
            title={`View Dutch Miller as ${user.email}`}
            onClick={onViewAs}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        )}
        {mayTouch && (
          <button
            type="button"
            disabled={busy}
            title={user.status === "disabled" ? "Switch on" : "Switch off"}
            onClick={() => onAct(`${base}/enabled`, { enabled: user.status === "disabled" })}
            className={`rounded-md border p-1.5 hover:bg-muted disabled:opacity-50 ${
              user.status === "disabled"
                ? "border-red-500/50 text-red-600"
                : "border-border text-muted-foreground"
            }`}
          >
            <Power className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          title="History for this account"
          onClick={onTrail}
          className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
        >
          <ScrollText className="h-3.5 w-3.5" />
        </button>
        {user.authMethod === "link" && user.status === "invited" && mayTouch && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct(`${base}/invite`)}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            Resend
          </button>
        )}
        {mayTouch && (
          <button
            type="button"
            disabled={busy}
            title="Remove"
            onClick={() => {
              if (window.confirm(
                `Remove ${user.email}? Switching off keeps the record and the audit trail.`)) {
                onAct(base, undefined, "DELETE");
              }
            }}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {editing && (
        <select
          autoFocus
          value={user.roleKey}
          onChange={(e) => {
            setEditing(false);
            onAct("/api/dutch-miller/users", { email: user.email, roleKey: e.target.value });
          }}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          {roles.map((r) => (
            <option
              key={r.key}
              value={r.key}
              // Handing out a role that administers is the super
              // administrator's alone; the server refuses it either way.
              disabled={r.administers && !iAmSuper}
            >
              {r.name}{r.administers ? " (administers)" : ""}
            </option>
          ))}
        </select>
      )}
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
