import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Crown, Loader2, Mail, Plus, RotateCcw, ScrollText, ShieldCheck, Trash2, UserRound,
} from "lucide-react";

type Role = "super" | "admin" | "user";
type StoredRole = "admin" | "user";
type Status = "invited" | "active" | "disabled";

type DmUser = {
  email: string; role: Role; pages: string[];
  authMethod: "microsoft" | "link"; status: Status;
  firstName: string | null; lastName: string | null;
  business: string | null; phone: string | null;
  invitedAt: string | null; invitedBy: string | null;
  activatedAt: string | null; lastSeenAt: string | null;
  updatedAt: string; updatedBy: string;
};
type PageDef = { key: string; label: string; blurb: string };
type Payload = {
  users: DmUser[];
  allPages: readonly PageDef[];
  myRole: Role;
  mailConfigured: boolean;
  mailFrom: string;
  mailProblem: string;
  mailAppIsSeparate: boolean;
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

/**
 * Who may open Dutch Miller, and what they find.
 *
 * Two kinds of account sit in one table, deliberately: MOJO staff who come
 * through Microsoft SSO, and invited dealer staff who sign in with an
 * emailed link. One list is the only way to answer "who can get in", and
 * the two are told apart by a badge rather than by being hidden from each
 * other.
 *
 * The page list is the server's own registry, so a page added there turns
 * up here with no edit.
 */
export function DmUsersPage({ me }: { me: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
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
    onSuccess: () => { setError(""); void qc.invalidateQueries({ queryKey: ["dm-users"] }); },
    onError: (e) => { setError((e as Error).message); setNote(""); },
  });

  const users = data.data?.users ?? [];
  const pages = data.data?.allPages ?? [];
  const iAmSuper = data.data?.myRole === "super";
  const mailOff = data.data && !data.data.mailConfigured;

  const save = (u: DmUser, patch: { role?: StoredRole; pages?: string[] }) =>
    act.mutate({
      url: "/api/dutch-miller/users",
      body: {
        email: u.email,
        role: patch.role ?? (u.role === "super" ? "admin" : u.role),
        pages: patch.pages ?? u.pages,
        invite: false,
      },
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">
            Who may open Dutch Miller, how they sign in, and which pages they can reach.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background"
          >
            <Plus className="h-4 w-4" />
            Add someone
          </button>
        </div>
      </div>

      {mailOff && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200">
          Invitations cannot be sent yet. {data.data?.mailProblem} MOJO staff can still be
          added — they sign in with Microsoft.
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

      {adding && (
        <AddRow
          pages={pages}
          iAmSuper={iAmSuper}
          mailConfigured={data.data?.mailConfigured ?? false}
          busy={act.isPending}
          onCancel={() => setAdding(false)}
          onSave={(body) => act.mutate(
            { url: "/api/dutch-miller/users", body },
            {
              onSuccess: () => {
                setAdding(false);
                setNote(body.invite
                  ? `Invitation sent to ${body.email}.`
                  : `${body.email} can sign in with Microsoft.`);
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
              <th className="px-3 py-2 text-left font-semibold">Pages</th>
              <th className="px-3 py-2 text-left font-semibold">Last seen</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {data.isPending && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!data.isPending && users.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                Nobody added yet. You are a super administrator by configuration, which is
                why you can see this page.
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
                  {u.authMethod === "microsoft" ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <ShieldCheck className="h-3 w-3" /> Microsoft
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Mail className="h-3 w-3" /> Email link
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {u.role === "super" ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold">
                      <Crown className="h-3 w-3" /> Super admin
                    </span>
                  ) : (
                    <select
                      value={u.role}
                      // Only a super admin may create or change an administrator.
                      // The server refuses it either way; this stops the control
                      // being offered to somebody it will say no to.
                      disabled={!iAmSuper}
                      onChange={(e) => save(u, { role: e.target.value as StoredRole })}
                      className="rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-60"
                      title={iAmSuper ? undefined
                        : "Only a super administrator can change this."}
                    >
                      <option value="user">General user</option>
                      <option value="admin">Administrator</option>
                    </select>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {u.role !== "user" ? (
                    <span className="text-xs text-muted-foreground">Every page.</span>
                  ) : (
                    <div className="space-y-1">
                      {pages.map((p) => (
                        <label key={p.key} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={u.pages.includes(p.key)}
                            onChange={(e) => save(u, {
                              pages: e.target.checked
                                ? [...u.pages, p.key]
                                : u.pages.filter((k) => k !== p.key),
                            })}
                          />
                          {p.label}
                        </label>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">
                  {when(u.lastSeenAt)}
                </td>
                <td className="px-3 py-2.5">
                  <RowActions
                    user={u}
                    iAmSuper={iAmSuper}
                    busy={act.isPending}
                    onAct={(url, body, method) => act.mutate({ url, body, method }, {
                      onSuccess: () => setNote(""),
                    })}
                    onTrail={() => setTrail(u.email)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          <p className="font-semibold text-foreground">Pages</p>
          <ul className="mt-1 space-y-0.5">
            {pages.map((p) => <li key={p.key}>{p.label} — {p.blurb}</li>)}
          </ul>
        </div>
      )}

      {trail !== null && <AuditTrail subject={trail} onClose={() => setTrail(null)} />}
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

function RowActions({
  user, iAmSuper, busy, onAct, onTrail,
}: {
  user: DmUser;
  iAmSuper: boolean;
  busy: boolean;
  onAct: (url: string, body?: unknown, method?: string) => void;
  onTrail: () => void;
}) {
  const base = `/api/dutch-miller/users/${encodeURIComponent(user.email)}`;
  // The server refuses all of these for a super admin and, for an admin
  // target, for anybody but a super admin. Not offering them keeps the page
  // honest about what will happen.
  const mayTouch = user.role !== "super" && (iAmSuper || user.role !== "admin");

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <button
        type="button"
        onClick={onTrail}
        title="History for this account"
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
          Resend invite
        </button>
      )}

      {user.status === "active" && mayTouch && (
        <button
          type="button"
          disabled={busy}
          title="Sign them out everywhere, without switching the account off"
          onClick={() => onAct(`${base}/revoke`)}
          className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}

      {mayTouch && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct(`${base}/enabled`, { enabled: user.status === "disabled" })}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {user.status === "disabled" ? "Switch on" : "Switch off"}
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
  );
}

/* ------------------------------------------------------------------ *
 * Adding somebody
 * ------------------------------------------------------------------ */

type NewUser = { email: string; role: StoredRole; pages: string[]; invite: boolean };

/**
 * The one place an address is typed.
 *
 * Which door they use is not a free choice: our own addresses sign in with
 * Microsoft, everyone else is invited. The form works that out from the
 * address and says which it is doing, rather than offering a switch that
 * the server will reject half the time.
 */
function AddRow({
  pages, iAmSuper, mailConfigured, busy, onSave, onCancel,
}: {
  pages: readonly PageDef[];
  iAmSuper: boolean;
  mailConfigured: boolean;
  busy: boolean;
  onSave: (u: NewUser) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StoredRole>("user");
  const [picked, setPicked] = useState<string[]>([]);

  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  // Mirrors the server's STAFF_DOMAINS default. If that list is ever
  // changed by secret the server still decides; this only picks the wording.
  const ours = ["mojocarwash.com", "mammothholdings.com"].includes(domain);
  const ready = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@dealership.com"
          className="w-72 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
        <select
          value={role}
          disabled={!iAmSuper}
          onChange={(e) => setRole(e.target.value as StoredRole)}
          title={iAmSuper ? undefined : "Only a super administrator can add an administrator."}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
        >
          <option value="user">General user</option>
          <option value="admin">Administrator</option>
        </select>
      </div>

      {role === "user" && (
        <div className="flex flex-wrap gap-3">
          {pages.map((p) => (
            <label key={p.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(p.key)}
                onChange={(e) => setPicked((v) =>
                  e.target.checked ? [...v, p.key] : v.filter((k) => k !== p.key))}
              />
              {p.label}
            </label>
          ))}
        </div>
      )}

      {ready && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {ours
            ? "One of our own addresses — they sign in with the Microsoft button, and the "
              + "account works straight away."
            : "An outside address — we will email a one-time invitation. The account stays "
              + "inactive until they open it, confirm a code and enter their details."}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !ready || (!ours && !mailConfigured)}
          onClick={() => onSave({
            email: email.trim(), role, pages: picked, invite: !ours,
          })}
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {ready && !ours ? "Send invitation" : "Add"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Cancel
        </button>
        {!ours && ready && !mailConfigured && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            Email is not set up, so an invitation cannot be sent.
          </span>
        )}
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
        <p className="text-sm font-semibold">
          Audit trail{subject ? ` · ${subject}` : ""}
        </p>
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
