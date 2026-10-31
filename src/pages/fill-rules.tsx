import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Sparkles, Tag, Trash2 } from "lucide-react";

/**
 * VENDOR RULES: what an expense from this merchant should say.
 *
 * The owner's ask, 2026-10-31: *"Want rules for match receipts
 * that fill out data. Would like an interface where vendors can
 * be marked as categories and then the rules applied."* — with a
 * photograph of Emburse's Edit Expense Details form showing the
 * four boxes a rule fills:
 *
 *   Category          Technology/Software, Licenses, and Subscriptions
 *   Business Purpose  AI Development and Use
 *   Location / Site   Corporate-Pure Magic
 *   Department        IT & Compliance
 *
 * Two things this page has to keep true:
 *
 *   A RULE PROPOSES, IT DOES NOT SEND. Its fields land in the
 *   same "what will change" list as the receipt, behind the same
 *   press. Always ask is the standing instruction and a rule is
 *   not a way around it.
 *
 *   THE HISTORY WRITES MOST OF THEM. Nobody should type a rule
 *   for a vendor they have already categorised nine times by
 *   hand, so the suggestions below the table are read back out of
 *   this person's own expenses, with the counts, so a habit can
 *   be told from a one-off.
 */

type Rule = {
  id: number; owner: string; lane: string; vendor: string;
  category: string; purpose: string; location: string; department: string;
  comment: string;
  enabled: boolean; updatedAt: string; updatedBy: string;
};
type Suggestion = {
  vendor: string; seen: number;
  category: { value: string; of: number };
  location: { value: string; of: number };
  department: { value: string; of: number };
};
type Answer = {
  rules: Rule[];
  suggestions: Suggestion[];
  accounts: { lane: string; label: string }[];
  fields: { key: FieldKey; label: string }[];
};

/** The five boxes on Emburse's Edit Expense Details form. */
type FieldKey = "category" | "purpose" | "location" | "department" | "comment";

type Draft = {
  id?: number; lane: string; vendor: string;
  category: string; purpose: string; location: string; department: string;
  comment: string;
};

const EMPTY: Draft = {
  lane: "", vendor: "", category: "", purpose: "", location: "", department: "",
  comment: "",
};

export function FillRulesPage() {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);

  const q = useQuery({
    queryKey: ["fill-rules"],
    queryFn: async () => {
      const res = await fetch("/api/fill-rules");
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      return (await res.json()) as Answer;
    },
  });

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const res = await fetch("/api/fill-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(d),
      });
      const out = await res.json();
      if (!res.ok) throw new Error((out as { error?: string }).error ?? "Could not save it.");
      return out;
    },
    onSuccess: () => {
      setError(""); setDraft(null);
      void qc.invalidateQueries({ queryKey: ["fill-rules"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const drop = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/fill-rules/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["fill-rules"] }),
    onError: (e) => setError((e as Error).message),
  });

  if (q.isLoading) {
    return <Loader2 className="mx-auto mt-10 h-6 w-6 animate-spin text-muted-foreground" />;
  }

  const rules = q.data?.rules ?? [];
  const accounts = q.data?.accounts ?? [];
  const suggested = q.data?.suggestions ?? [];

  const laneName = (lane: string) =>
    lane === "" ? "Every personal tab"
      : accounts.find((a) => a.lane === lane)?.label ?? lane;

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Tag className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          What an expense from a vendor should say. When a receipt is matched to an
          expense whose merchant fits one of these, the rule&rsquo;s fields join the
          same <strong>what will change</strong> list as the receipt — and wait for the
          same press. <strong>Nothing is written to Emburse by a rule on its own.</strong>
        </span>
      </p>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">{error}</p>
      )}

      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">
          {rules.length} vendor rule{rules.length === 1 ? "" : "s"}
        </h3>
        <button
          type="button"
          onClick={() => setDraft({ ...EMPTY })}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border
                     px-3 py-1.5 text-xs font-semibold hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" />
          Add a vendor
        </button>
      </div>

      {draft && (
        <RuleForm
          draft={draft}
          accounts={accounts}
          busy={save.isPending}
          onChange={setDraft}
          onCancel={() => { setDraft(null); setError(""); }}
          onSave={() => save.mutate(draft)}
        />
      )}

      {rules.length === 0 && !draft ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm
                      text-muted-foreground">
          <strong>No vendor rules yet, so there is nothing to edit.</strong> Press{" "}
          <em>Edit and save</em> on one of the suggestions below — that opens it as a
          form with all five fields to change before anything is stored — or{" "}
          <em>Add a vendor</em> above to start from blank. Once a rule is saved it
          appears in a table here, with its own <em>Edit</em> button.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted text-left text-[11px] text-muted-foreground">
              <tr>
                <th className="px-2 py-2 font-semibold">Vendor</th>
                <th className="px-2 py-2 font-semibold">Category</th>
                <th className="px-2 py-2 font-semibold">Business Purpose</th>
                <th className="px-2 py-2 font-semibold">Location / Site</th>
                <th className="px-2 py-2 font-semibold">Department</th>
                <th className="px-2 py-2 font-semibold">Comment</th>
                <th className="px-2 py-2 font-semibold">Applies to</th>
                <th className="w-20 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-2 py-2 font-semibold">{r.vendor}</td>
                  <td className="px-2 py-2">{r.category || <Unset />}</td>
                  <td className="px-2 py-2">{r.purpose || <Unset />}</td>
                  <td className="px-2 py-2">{r.location || <Unset />}</td>
                  <td className="px-2 py-2">{r.department || <Unset />}</td>
                  <td className="px-2 py-2">{r.comment || <Unset />}</td>
                  <td className="px-2 py-2 text-muted-foreground">{laneName(r.lane)}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setDraft({
                          id: r.id, lane: r.lane, vendor: r.vendor, category: r.category,
                          purpose: r.purpose, location: r.location, department: r.department,
                          comment: r.comment,
                        })}
                        className="rounded-md border border-border px-2 py-1 font-semibold
                                   hover:bg-muted"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => drop.mutate(r.id)}
                        aria-label={`Delete the ${r.vendor} rule`}
                        className="rounded-md p-1 text-muted-foreground hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* THE HISTORY WRITES MOST OF THEM. */}
      {suggested.length > 0 && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="h-4 w-4" />
            From expenses you have already filled in
          </h3>
          <p className="text-xs text-muted-foreground">
            The commonest value on each vendor&rsquo;s own expenses, with how many said it.
            Pressing <strong>Edit and save</strong> opens it as a form — category, business
            purpose, location / site, department and comment, all changeable — and nothing
            is stored until you save. Business Purpose and Comment are not suggested: they
            are not in the Emburse export, so there is no history to read, and they are the
            two fields only you can write.
          </p>
          <div className="space-y-1.5">
            {suggested.map((s) => (
              <div key={s.vendor} className="flex flex-wrap items-center gap-x-3 gap-y-1
                                             rounded-lg border border-border p-2.5 text-xs">
                <span className="font-semibold">{s.vendor}</span>
                <span className="text-muted-foreground">
                  {s.seen} expense{s.seen === 1 ? "" : "s"}
                </span>
                {s.category.value && (
                  <Chip label="Category" value={s.category.value} of={s.category.of} seen={s.seen} />
                )}
                {s.location.value && (
                  <Chip label="Location" value={s.location.value} of={s.location.of} seen={s.seen} />
                )}
                {s.department.value && (
                  <Chip label="Dept" value={s.department.value} of={s.department.of} seen={s.seen} />
                )}
                <button
                  type="button"
                  disabled={save.isPending}
                  onClick={() => setDraft({
                    lane: "", vendor: s.vendor, category: s.category.value,
                    purpose: "", location: s.location.value, department: s.department.value,
                    comment: "",
                  })}
                  className="ml-auto inline-flex items-center gap-1 rounded-lg border
                             border-emerald-600/50 px-2.5 py-1 font-semibold
                             disabled:opacity-50"
                >
                  {/* "Make this a rule" read as "save it now", and the
                      owner — looking for a way to EDIT the values —
                      did not press it. It opens the form. Say that. */}
                  <Pencil className="h-3.5 w-3.5" />
                  Edit and save
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const Unset = () => <span className="text-muted-foreground">—</span>;

/** "Category: Software (7 of 9)" — the count is what makes it checkable. */
function Chip({ label, value, of, seen }: {
  label: string; value: string; of: number; seen: number;
}) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5">
      {label}: <strong>{value}</strong>{" "}
      <span className="text-muted-foreground">({of} of {seen})</span>
    </span>
  );
}

/**
 * Adding or editing one.
 *
 * Opened pre-filled from a suggestion as often as it is opened
 * blank, which is the point: the common path is reading a
 * suggested rule, typing the Business Purpose it cannot know,
 * and saving.
 */
function RuleForm({ draft, accounts, busy, onChange, onCancel, onSave }: {
  draft: Draft;
  accounts: { lane: string; label: string }[];
  busy: boolean;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const field = (
    key: "vendor" | FieldKey,
    label: string, hint?: string,
  ) => (
    <label className="block">
      <span className="text-xs font-semibold">{label}</span>
      <input
        value={draft[key]}
        onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
        className="mt-1 w-full rounded-lg border border-border bg-transparent px-2 py-1.5
                   text-sm outline-none focus:border-sky-500"
      />
      {hint && <span className="mt-0.5 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );

  return (
    <div className="space-y-3 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3.5">
      <p className="text-sm font-semibold">
        {draft.id ? `Editing the ${draft.vendor} rule` : "A new vendor rule"}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("vendor", "Vendor",
          "Matched against the expense's merchant, ignoring case and punctuation. "
          + "“REPLIT” covers “Replit.com” and “REPLIT #4417”.")}
        {field("category", "Category",
          "Exactly as Emburse's Category list spells it, or the save will say what it offers.")}
        {field("purpose", "Business Purpose",
          "The sentence about why — “AI Development and Use”.")}
        {field("location", "Location / Site")}
        {field("department", "Department")}
        {field("comment", "Comment",
          "The free-text Comment box at the foot of Emburse's edit form.")}
        <label className="block">
          <span className="text-xs font-semibold">Applies to</span>
          <select
            value={draft.lane}
            onChange={(e) => onChange({ ...draft, lane: e.target.value })}
            className="mt-1 w-full rounded-lg border border-border bg-transparent px-2 py-1.5
                       text-sm outline-none focus:border-sky-500"
          >
            <option value="">Every personal tab</option>
            {accounts.map((a) => (
              <option key={a.lane} value={a.lane}>{a.label}</option>
            ))}
          </select>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            A rule naming one tab beats one covering every tab.
          </span>
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Leave a field empty and the rule says nothing about it — it is left exactly as
        Emburse has it, and emptying one later is how you stop a rule touching that box.
        Nothing here is written on its own: a rule only ever adds lines to what a matched
        receipt proposes, behind the same press.
        {!draft.id && " Once saved, this rule gets its own Edit button in the table above."}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !draft.vendor.trim()}
          onClick={onSave}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5
                     text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Save the rule
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
