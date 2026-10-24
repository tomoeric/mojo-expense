import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye, Loader2, Mail, Pencil, Power, Search, ShieldCheck, UserRound, X,
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
  jobTitle: string | null;
  department: string | null;
  source: "directory" | "invited";
  enabledInDirectory: boolean;
  user: DmUser | null;
};

/**
 * Everybody who could be given access, in one dialog.
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
  iAmSuper, onClose, onViewAs,
}: {
  iAmSuper: boolean;
  onClose: () => void;
  onViewAs: (email: string) => void;
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<"all" | "configured" | "not">("all");
  const [editing, setEditing] = useState<Person | null>(null);
  const [error, setError] = useState("");

  const data = useQuery({
    queryKey: ["dm-people"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/people");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        people: Person[]; roles: Role[];
        directoryAvailable: boolean; directoryProblem: string;
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
      void qc.invalidateQueries({ queryKey: ["dm-users"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const people = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data.data?.people ?? []).filter((p) => {
      if (show === "configured" && !p.user) return false;
      if (show === "not" && p.user) return false;
      if (q === "") return true;
      return p.email.includes(q) || p.name.toLowerCase().includes(q)
        || (p.jobTitle ?? "").toLowerCase().includes(q)
        || (p.department ?? "").toLowerCase().includes(q);
    });
  }, [data.data, filter, show]);

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
          <div>
            <h2 className="text-base font-semibold">People</h2>
            <p className="text-sm text-muted-foreground">
              Everyone at MOJO and Mammoth Holdings, and everyone invited to Dutch Miller.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <div className="flex min-w-56 flex-1 items-center gap-2 rounded-md border border-border px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Name, email, job title or department"
              className="w-full bg-transparent text-sm outline-none"
            />
          </div>
          {([["all", "Everyone"], ["configured", "Has access"], ["not", "No access"]] as const)
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

        {data.data && !data.data.directoryAvailable && (
          <p className="border-b border-border bg-amber-500/10 px-5 py-2.5 text-xs text-amber-900 dark:text-amber-200">
            {/* Degraded, not broken: the people already set up are still
                listed, and an address can still be typed on the Users page. */}
            The staff directory could not be read, so only people already set up are
            listed. {data.data.directoryProblem}
          </p>
        )}
        {error && <p className="border-b border-border px-5 py-2 text-sm text-red-600">{error}</p>}

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
                  {p.source === "invited" && (
                    <Mail className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                  {p.source === "directory" && p.user?.authMethod === "microsoft" && (
                    <ShieldCheck className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {p.email}
                  {p.jobTitle ? ` · ${p.jobTitle}` : ""}
                  {p.department ? ` · ${p.department}` : ""}
                </p>
              </div>

              <div className="w-44 shrink-0 text-xs">
                {p.user ? (
                  <>
                    <span className="font-semibold">{p.user.roleName ?? p.user.roleKey}</span>
                    {p.user.status !== "active" && (
                      <span className="block text-muted-foreground">{p.user.status}</span>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">No access</span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  title={p.user ? "Change role" : "Give access"}
                  onClick={() => setEditing(p)}
                  className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {/* Only a super admin may view as, and only somebody who
                    actually has an account to view. */}
                {iAmSuper && p.user && p.user.status === "active" && (
                  <button
                    type="button"
                    title={`View Dutch Miller as ${p.name}`}
                    onClick={() => onViewAs(p.email)}
                    className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                )}
                {p.user && (
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
