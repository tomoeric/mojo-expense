import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, ShieldAlert, Check } from "lucide-react";

type Settings = {
  sections: string[];
  receiptsOnly: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  allSections: string[];
};

/** What the section means for the people whose expenses are in it. */
const WHY: Record<string, string> = {
  "Needs Review": "The reviewer's queue — the reason this app exists.",
  "Needs Manager Review": "With a manager, still in flight. Worth watching.",
  "Pending Submission": "Not submitted yet. The employee's to finish, not yours.",
  Denied: "Sent back. These tend to return, so they are rarely finished.",
  Completed: "Done. Its absence from the export is how a row leaves the queue.",
};

/**
 * Declare what the daily export is supposed to contain.
 *
 * The app cannot make the export happen — a Power Automate flow on a laptop
 * does that, and it cannot read this. What this buys is enforcement after the
 * fact: every export prints its search on page 1, and each import is checked
 * against what is set here.
 *
 * That matters because a section chip toggled the wrong way in Emburse produces
 * a valid PDF of the wrong rows, which parses cleanly and reconciles against its
 * own printed total. Every other check passes. Only the header disagrees.
 */
export function ExportSettingsPage({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [sections, setSections] = useState<string[] | null>(null);
  const [receiptsOnly, setReceiptsOnly] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const q = useQuery({
    queryKey: ["export-settings"],
    queryFn: async () => {
      const res = await fetch("/api/export-settings");
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      return (await res.json()) as Settings;
    },
  });

  // Seed the form once, then leave it alone so a background refetch cannot
  // discard what someone is in the middle of typing.
  useEffect(() => {
    if (q.data && sections === null) {
      setSections(q.data.sections);
      setReceiptsOnly(q.data.receiptsOnly);
    }
  }, [q.data, sections]);

  if (q.isLoading || sections === null) {
    return <Loader2 className="mx-auto mt-10 h-6 w-6 animate-spin text-muted-foreground" />;
  }
  if (q.error) {
    return <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm">{(q.error as Error).message}</p>;
  }

  const all = q.data?.allSections ?? [];
  const dirty =
    JSON.stringify(sections) !== JSON.stringify(q.data?.sections) || receiptsOnly !== q.data?.receiptsOnly;

  const toggle = (name: string) =>
    setSections((prev) =>
      (prev ?? []).includes(name) ? (prev ?? []).filter((s) => s !== name) : [...(prev ?? []), name],
    );

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/export-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sections, receiptsOnly }),
      });
      const body = (await res.json()) as Settings & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
      qc.setQueryData(["export-settings"], body);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-base font-bold">Export scope</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Which Emburse sections the daily export is supposed to cover. The app cannot change what the
          Power Automate flow does — it checks each import against this and flags the difference, which
          is the only way to catch a section chip left in the wrong state.
        </p>
      </div>

      {!isAdmin && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          You can see this but not change it. Ask an administrator.
        </p>
      )}

      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {all.map((name) => {
          const on = sections.includes(name);
          return (
            <label
              key={name}
              className={`flex cursor-pointer items-start gap-3 p-3.5 transition-colors hover:bg-muted ${
                isAdmin ? "" : "cursor-not-allowed opacity-70"
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!isAdmin}
                onChange={() => toggle(name)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-sky-600"
              />
              <span className="min-w-0">
                <span className="text-sm font-semibold">{name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{WHY[name] ?? ""}</span>
              </span>
            </label>
          );
        })}
      </div>

      <label
        className={`flex items-start gap-3 rounded-xl border border-border p-3.5 ${
          isAdmin ? "cursor-pointer hover:bg-muted" : "cursor-not-allowed opacity-70"
        }`}
      >
        <input
          type="checkbox"
          checked={receiptsOnly}
          disabled={!isAdmin}
          onChange={(e) => setReceiptsOnly(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-sky-600"
        />
        <span>
          <span className="text-sm font-semibold">Receipts: true</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Only expenses that have a receipt attached. Switching this off means expenses with no
            receipt are expected too, and the receipt-vs-claim check has nothing to read for them.
          </span>
        </span>
      </label>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">{error}</p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!isAdmin || !dirty || saving || sections.length === 0}
          onClick={() => void save()}
          className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </button>

        {saved && (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-500">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
        {sections.length === 0 && (
          <span className="text-sm text-amber-500">
            Choose at least one section, or every import will be flagged.
          </span>
        )}
        {q.data?.updatedAt && !saved && (
          <span className="ml-auto text-xs text-muted-foreground">
            Last changed {new Date(q.data.updatedAt).toLocaleString()}
            {q.data.updatedBy ? ` by ${q.data.updatedBy}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
