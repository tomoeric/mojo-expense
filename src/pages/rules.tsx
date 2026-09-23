import { useState } from "react";
import {
  Loader2, Plus, Pencil, Trash2, AlertTriangle, ShieldCheck, Flag, Ban, Play,
} from "lucide-react";
import { StatChip, StatChipRow, Empty } from "@/components/ui";
import { RuleEditor } from "@/components/rule-editor";
import { BLANK, useRules, type Action, type Rule, type RuleBody } from "@/lib/rules";

/**
 * The rules, and what each one is currently catching.
 *
 * A rule is only as trustworthy as what it is doing right now, so every row
 * leads with its live count rather than its definition. "Gas must be Fuel —
 * catching 3" is a working rule; "catching 400" is a typo, and the number is
 * the first thing on the row for that reason.
 */

const ICON: Record<Action, typeof Flag> = { flag: Flag, approve: ShieldCheck, deny: Ban };
const TONE: Record<Action, string> = {
  flag: "text-amber-600",
  approve: "text-emerald-600",
  deny: "text-red-600",
};

export function RulesPage({ isAdmin }: { isAdmin: boolean }) {
  const { list, options, save, remove, toggle, runAll } = useRules();
  const [editing, setEditing] = useState<{ id?: number; body: RuleBody } | null>(null);
  const [ran, setRan] = useState<string | null>(null);

  const rules = list.data?.rules ?? [];

  if (list.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the rules…
      </div>
    );
  }

  if (list.isError) {
    return (
      <Empty>
        <p className="font-semibold text-red-600">Could not load the rules</p>
        <p className="mt-1">{(list.error as Error).message}</p>
      </Empty>
    );
  }

  const catching = rules.filter((r) => r.enabled).reduce((a, r) => a + r.stats.fail, 0);
  const deciding = rules.filter((r) => r.enabled && r.action !== "flag").length;
  const stuck = rules.filter((r) => r.enabled && r.action !== "flag" && !r.ownerCanDecide);

  return (
    <div className="space-y-4">
      <StatChipRow>
        <StatChip value={rules.length} label="rules" />
        <StatChip value={rules.filter((r) => r.enabled).length} label="enabled" tone="emerald" />
        <StatChip value={catching} label="expenses currently caught" tone="amber" />
        {deciding > 0 && <StatChip value={deciding} label="that approve or deny" tone="red" />}
        {isAdmin && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={runAll.isPending}
              onClick={() =>
                runAll.mutate(false, {
                  onSuccess: (r) =>
                    setRan(`Checked every expense — ${r.failed.toLocaleString()} caught, ${r.passed.toLocaleString()} fine. No decisions were made.`),
                })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
              title="Re-check every expense against every enabled rule. Flags only."
            >
              {runAll.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Re-check all
            </button>
            <button
              type="button"
              onClick={() => setEditing({ body: BLANK })}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-semibold text-background"
            >
              <Plus className="h-3.5 w-3.5" /> New rule
            </button>
          </div>
        )}
      </StatChipRow>

      {ran && <p className="text-xs text-muted-foreground">{ran}</p>}

      {/* A rule that cannot act is worse than no rule: it looks like cover and
          provides none. Said once, at the top, naming who needs to do what. */}
      {stuck.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {stuck.length === 1 ? "One rule is" : `${stuck.length} rules are`} enabled but cannot act:{" "}
            {stuck.map((r) => `“${r.name}”`).join(", ")}. A decision is applied under its owner's own Emburse
            login, and {stuck.length === 1 ? `${stuck[0]!.createdBy ?? "the owner"} has` : "their owners have"}{" "}
            none stored. They are still flagging; they are not approving or denying anything.
          </p>
        </div>
      )}

      {editing && (
        <RuleEditor
          initial={editing.body}
          options={options.data}
          saving={save.isPending}
          error={save.error ? (save.error as Error).message : null}
          onSave={(body) =>
            save.mutate({ body, id: editing.id }, { onSuccess: () => setEditing(null) })}
          onCancel={() => {
            save.reset();
            setEditing(null);
          }}
        />
      )}

      {rules.length === 0 && !editing ? (
        <Empty>
          <p className="font-semibold">No rules yet</p>
          <p className="mt-1">
            A rule says what an expense has to look like — “when the note mentions gas, the category must be
            Auto Fee &amp; Fuel”. Anything that does not match is flagged in the queue, and every import is
            checked as it lands.
          </p>
        </Empty>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              isAdmin={isAdmin}
              onEdit={() => {
                save.reset();
                setEditing({ id: rule.id, body: rule });
              }}
              onToggle={() => toggle.mutate({ id: rule.id, enabled: !rule.enabled })}
              onDelete={() => remove.mutate(rule.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RuleRow({
  rule, isAdmin, onEdit, onToggle, onDelete,
}: {
  rule: Rule; isAdmin: boolean; onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const Icon = ICON[rule.action];

  return (
    <div className={`rounded-xl border px-4 py-3 ${rule.enabled ? "border-border" : "border-dashed border-border bg-muted/20"}`}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${rule.enabled ? TONE[rule.action] : "text-muted-foreground"}`} />

        <div className="min-w-56 flex-1">
          <p className={`text-sm font-semibold ${rule.enabled ? "" : "text-muted-foreground"}`}>
            {rule.name}
            {!rule.enabled && <span className="ml-2 text-xs font-normal text-muted-foreground">off</span>}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{rule.summary}</p>
          {rule.message && <p className="mt-0.5 text-xs text-muted-foreground italic">“{rule.message}”</p>}
          {rule.problems.length > 0 && (
            <p className="mt-1 text-xs text-red-600">{rule.problems.join(" ")}</p>
          )}
        </div>

        <div className="text-right text-xs">
          <p className={`tnum text-base leading-none font-extrabold ${rule.stats.fail > 0 ? "text-amber-600" : "text-muted-foreground"}`}>
            {rule.stats.fail.toLocaleString()}
          </p>
          <p className="mt-1 text-muted-foreground">
            caught{rule.stats.waiting > 0 ? ` · ${rule.stats.waiting} in queue` : ""}
          </p>
        </div>

        {isAdmin && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onToggle}
              className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted"
            >
              {rule.enabled ? "Turn off" : "Turn on"}
            </button>
            <button type="button" onClick={onEdit} className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground" title="Edit">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => (confirming ? onDelete() : setConfirming(true))}
              onBlur={() => setConfirming(false)}
              className={`rounded-lg p-1.5 ${confirming ? "bg-red-50 text-red-600" : "text-muted-foreground hover:text-foreground"}`}
              title={confirming ? "Click again to delete" : "Delete"}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
