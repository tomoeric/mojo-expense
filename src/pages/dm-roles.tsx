import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, Loader2, Plus, Trash2 } from "lucide-react";

type PageDef = { key: string; label: string; blurb: string };
type Role = {
  key: string; name: string; pages: string[];
  administers: boolean; builtin: boolean; holders?: number;
  createdAt: string | null; createdBy: string | null;
};

type Draft = { key?: string; name: string; pages: string[]; administers: boolean };

/**
 * Roles, and what each one can open.
 *
 * Super administrator only. A role IS a grant of access, so an
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
      return (await res.json()) as { roles: Role[]; allPages: readonly PageDef[] };
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
  const pages = data.data?.allPages ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Crown className="h-4 w-4" />
            Roles
          </h1>
          <p className="text-sm text-muted-foreground">
            What each kind of person can open in Dutch Miller. Super administrator only.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDraft({ name: "", pages: [], administers: false })}
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
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.administers
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
                <button
                  type="button"
                  onClick={() => setDraft({
                    key: r.key, name: r.name, pages: [...r.pages], administers: r.administers,
                  })}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                >
                  Edit
                </button>
                {/* Built-in roles and roles somebody holds are not offered a
                    delete button: the server refuses both, and moving people
                    automatically would be a silent change to what several of
                    them can see. */}
                {!r.builtin && r.holders === 0 && (
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
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        A role cannot be removed while anybody holds it — move them first. Built-in roles can
        have their pages changed but cannot be renamed or removed, because other things are
        written against them.
      </p>
    </div>
  );
}

function RoleEditor({
  draft, pages, busy, onChange, onSave, onCancel,
}: {
  draft: Draft;
  pages: readonly PageDef[];
  busy: boolean;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const builtin = draft.key === "administrator" || draft.key === "general-user";
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

      {!builtin && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.administers}
            onChange={(e) => onChange({ ...draft, administers: e.target.checked })}
          />
          Administers — every page, plus Users and Settings
        </label>
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
