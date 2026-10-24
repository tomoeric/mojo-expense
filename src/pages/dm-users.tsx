import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, UserRound } from "lucide-react";

type Role = "admin" | "user";
type DmUser = {
  email: string; role: Role; pages: string[]; updatedAt: string; updatedBy: string;
};
type PageDef = { key: string; label: string; blurb: string };
type Payload = { users: DmUser[]; allPages: readonly PageDef[] };

const day = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * Who may open what, inside Dutch Miller.
 *
 * Deliberately not a second copy of the page list: the rows come from the
 * server's own registry (`DM_PAGES`), so a page added there appears here
 * with no edit, and a page that does not exist cannot be ticked.
 */
export function DmUsersPage({ me }: { me: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const data = useQuery({
    queryKey: ["dm-users"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/users");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as Payload;
    },
  });

  const save = useMutation({
    mutationFn: async (u: { email: string; role: Role; pages: string[] }) => {
      const res = await fetch("/api/dutch-miller/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(u),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save.");
      return body as { users: DmUser[] };
    },
    onSuccess: () => { setError(""); void qc.invalidateQueries({ queryKey: ["dm-users"] }); },
    onError: (e) => setError((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch(`/api/dutch-miller/users/${encodeURIComponent(email)}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not remove.");
      return body as { users: DmUser[] };
    },
    onSuccess: () => { setError(""); void qc.invalidateQueries({ queryKey: ["dm-users"] }); },
    onError: (e) => setError((e as Error).message),
  });

  const users = data.data?.users ?? [];
  const pages = data.data?.allPages ?? [];
  const admins = users.filter((u) => u.role === "admin").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">
            Who may open Dutch Miller, whether they administer it, and which pages a
            general user can reach.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background"
        >
          <Plus className="h-4 w-4" />
          Add someone
        </button>
      </div>

      {/* The bootstrap state, said out loud rather than left to be noticed.
          With no rows at all everybody who reaches Dutch Miller is treated as
          an administrator, because a permission table that starts empty would
          otherwise lock the first person out of the page that fills it in. The
          first row closes it, including for whoever is reading this. */}
      {users.length === 0 && !data.isPending && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          Nobody is set up yet, so <strong>everyone with Dutch Miller access is an
          administrator</strong>. Adding the first person here turns that off — add
          yourself as an administrator first, or you will lock yourself out of this page.
        </p>
      )}

      {error && <p className="text-sm font-semibold text-red-600">{error}</p>}

      {adding && (
        <AddRow
          pages={pages}
          busy={save.isPending}
          onCancel={() => setAdding(false)}
          onSave={(u) => save.mutate(u, { onSuccess: () => setAdding(false) })}
        />
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Person</th>
              <th className="px-3 py-2 text-left font-semibold">Role</th>
              <th className="px-3 py-2 text-left font-semibold">Pages</th>
              <th className="px-3 py-2 text-left font-semibold">Updated</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {data.isPending && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!data.isPending && users.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                No one added yet.
              </td></tr>
            )}
            {users.map((u) => (
              <tr key={u.email} className="border-t border-border align-top">
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-1.5">
                    <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{u.email}</span>
                    {u.email === me && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        you
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <select
                    value={u.role}
                    onChange={(e) => save.mutate({
                      email: u.email, role: e.target.value as Role, pages: u.pages,
                    })}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                  >
                    <option value="user">General user</option>
                    <option value="admin">Administrator</option>
                  </select>
                </td>
                <td className="px-3 py-2.5">
                  {u.role === "admin" ? (
                    <span className="text-xs text-muted-foreground">
                      Every page, including this one.
                    </span>
                  ) : (
                    <div className="space-y-1">
                      {pages.map((p) => (
                        <label key={p.key} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={u.pages.includes(p.key)}
                            onChange={(e) => save.mutate({
                              email: u.email,
                              role: u.role,
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
                  {day(u.updatedAt)}
                  {u.updatedBy ? <><br />{u.updatedBy}</> : null}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {/* The server refuses to remove the last administrator; this
                      only keeps the button from being offered for it. */}
                  <button
                    type="button"
                    disabled={remove.isPending || (u.role === "admin" && admins <= 1)}
                    title={u.role === "admin" && admins <= 1
                      ? "The only administrator cannot be removed."
                      : "Remove"}
                    onClick={() => remove.mutate(u.email)}
                    className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
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
    </div>
  );
}

/** The one place an email is typed. Editing a row never changes its address. */
function AddRow({
  pages, busy, onSave, onCancel,
}: {
  pages: readonly PageDef[];
  busy: boolean;
  onSave: (u: { email: string; role: Role; pages: string[] }) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [picked, setPicked] = useState<string[]>([]);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@mojocarwash.com"
          className="w-72 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || email.trim() === ""}
          onClick={() => onSave({ email: email.trim(), role, pages: picked })}
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
      <p className="text-xs text-muted-foreground">
        Being listed here does not by itself let somebody in — the Dutch Miller access
        list governs who reaches the app at all. This decides what they find once they do.
      </p>
    </div>
  );
}
