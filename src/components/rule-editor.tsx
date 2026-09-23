import { useEffect, useMemo, useState } from "react";
import { Plus, X, Loader2, AlertTriangle, CheckCircle2, ArrowLeftRight } from "lucide-react";
import { money } from "@/lib/format";
import { SegmentedControl } from "@/components/ui";
import { preview, type Action, type Condition, type Field, type Op, type Options, type Preview, type RuleBody } from "@/lib/rules";

/**
 * Writing one rule.
 *
 * The form reads as the sentence the rule is — When … must … otherwise … —
 * rather than as a row of labelled boxes, because the thing people get wrong
 * about rules is not which field to pick, it is which way round the logic
 * goes. A preview sits under it and updates as you type: for a flag rule that
 * is a convenience, and for an approve or deny rule it is the only thing
 * standing between a typo and a morning of undoing decisions in Emburse.
 */

const ACTIONS: { value: Action; label: string }[] = [
  { value: "flag", label: "Flag it" },
  { value: "deny", label: "Deny it" },
  { value: "approve", label: "Approve it" },
];

export function RuleEditor({
  initial,
  options,
  saving,
  error,
  onSave,
  onCancel,
}: {
  initial: RuleBody;
  options: Options | undefined;
  saving: boolean;
  error: string | null;
  onSave: (body: RuleBody) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState<RuleBody>(initial);
  const [seen, setSeen] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => setBody(initial), [initial]);

  // Debounced: every keystroke in a value box would otherwise scan the whole
  // expense table.
  useEffect(() => {
    let live = true;
    setChecking(true);
    const t = setTimeout(() => {
      preview(body)
        .then((p) => live && setSeen(p))
        .catch(() => live && setSeen(null))
        .finally(() => live && setChecking(false));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [body]);

  const set = (patch: Partial<RuleBody>) => setBody((b) => ({ ...b, ...patch }));
  const deciding = body.action !== "flag";

  return (
    <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={body.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Name this rule — e.g. “Gas must be Fuel”"
          className="min-w-64 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold outline-none focus:border-muted-foreground/50"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={body.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Enabled
        </label>
      </div>

      <Block label="When" hint={body.when.length > 1 ? undefined : "which expenses this rule is about"}>
        {body.when.length > 1 && (
          <div className="mb-2">
            <SegmentedControl
              value={body.match}
              onChange={(match) => set({ match })}
              options={[{ value: "all", label: "All of these" }, { value: "any", label: "Any of these" }]}
            />
          </div>
        )}
        <div className="space-y-2">
          {body.when.map((c, i) => (
            <ConditionRow
              key={i}
              condition={c}
              options={options}
              onChange={(next) => set({ when: body.when.map((x, j) => (j === i ? next : x)) })}
              onRemove={body.when.length > 1 ? () => set({ when: body.when.filter((_, j) => j !== i) }) : undefined}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => set({ when: [...body.when, { field: "merchant", op: "contains", value: "" }] })}
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" /> Add a condition
        </button>
      </Block>

      <Block
        label="Must"
        hint={body.must ? "what those expenses have to be" : "nothing required — every match counts"}
      >
        {body.must ? (
          <ConditionRow
            condition={body.must}
            options={options}
            onChange={(must) => set({ must })}
            onRemove={() => set({ must: null })}
          />
        ) : (
          <button
            type="button"
            onClick={() => set({ must: { field: "category", op: "is", value: "" } })}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" /> Add an expectation
          </button>
        )}
      </Block>

      <Block label={body.must ? "Otherwise" : "Then"} hint={undefined}>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl value={body.action} onChange={(action) => set({ action })} options={ACTIONS} />
          <input
            value={body.message}
            onChange={(e) => set({ message: e.target.value })}
            placeholder={
              body.action === "deny"
                ? "Reason the employee is shown — required"
                : "Message shown on the flag (optional)"
            }
            className="min-w-64 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-muted-foreground/50"
          />
        </div>
        {deciding && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              This reaches Emburse. Decisions are queued under <strong>your</strong> Emburse login, only for
              expenses still in the inbox that nobody has decided, and at most{" "}
              {options?.maxDecisionsPerRun ?? 25} per run. Check the preview below before enabling it.
            </span>
          </p>
        )}
      </Block>

      <PreviewPanel preview={seen} checking={checking} action={body.action} />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving || Boolean(seen?.incomplete)}
          onClick={() => onSave(body)}
          className="rounded-lg bg-foreground px-3 py-2 text-sm font-semibold text-background disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save rule"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-border px-3 py-2 text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Block({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
        {hint && <span className="ml-2 font-normal normal-case">— {hint}</span>}
      </p>
      {children}
    </div>
  );
}

function ConditionRow({
  condition,
  options,
  onChange,
  onRemove,
}: {
  condition: Condition;
  options: Options | undefined;
  onChange: (c: Condition) => void;
  onRemove?: () => void;
}) {
  const field = options?.fields.find((f) => f.value === condition.field);
  const ops = field?.ops ?? [];
  const list = field?.list ? options?.lists[field.list] : undefined;
  const comparable = field?.comparable ?? [];
  const takesOperand = condition.op !== "is_blank" && condition.op !== "is_not_blank";
  const comparing = Boolean(condition.compare);
  const needsValue = takesOperand && !comparing;

  // Changing the field can strand an operator the new field does not support,
  // which the server would reject on save. Moved to the field's first operator
  // instead, so the form cannot express something that will not store.
  const changeField = (value: Field) => {
    const next = options?.fields.find((f) => f.value === value);
    const keep = next?.ops.some((o) => o.value === condition.op);
    // A comparison that made sense for the old field rarely survives the new
    // one, and a stale one would be refused on save.
    const keepCompare =
      condition.compare && next?.comparable.some((c) => c.value === condition.compare);
    onChange({
      field: value,
      op: keep ? condition.op : ((next?.ops[0]?.value ?? "contains") as Op),
      value: "",
      compare: keepCompare ? condition.compare : null,
    });
  };

  const select = "rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-muted-foreground/50";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={condition.field} onChange={(e) => changeField(e.target.value as Field)} className={select}>
        {(options?.fields ?? []).map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>

      <select
        value={condition.op}
        onChange={(e) => {
          const op = e.target.value as Op;
          // "is blank" takes nothing on the right, so a comparison left over
          // from the previous operator has to go with it.
          const blank = op === "is_blank" || op === "is_not_blank";
          onChange({ ...condition, op, compare: blank ? null : condition.compare });
        }}
        className={select}
      >
        {ops.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {comparing && (
        <select
          value={condition.compare ?? ""}
          onChange={(e) => onChange({ ...condition, compare: e.target.value as Field })}
          className={`${select} max-w-72 min-w-44 border-sky-500/50 bg-sky-500/5`}
        >
          {comparable.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      )}

      {needsValue && (list && list.length > 0 ? (
        // A taxonomy field gets the permanent list, so a rule cannot be written
        // against a category that does not exist — which would never match and
        // would look like the rule was broken.
        <select
          value={condition.value}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
          className={`${select} max-w-96 min-w-48`}
        >
          <option value="">Pick one…</option>
          {list.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      ) : (
        <input
          value={condition.value}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
          placeholder={condition.field === "amount" ? "0.00" : "value"}
          className={`${select} w-48`}
        />
      ))}

      {/* The switch between "a value I type" and "another column". Without it
          the one check an expense queue most needs — the receipt's own total
          against the amount claimed — cannot be written at all. */}
      {takesOperand && comparable.length > 0 && (
        <button
          type="button"
          onClick={() =>
            onChange({
              ...condition,
              value: "",
              compare: comparing ? null : (comparable[0]!.value as Field),
            })}
          title={comparing ? "Compare with a value you type instead" : "Compare with another column instead"}
          className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
            comparing ? "border-sky-500 bg-sky-500/10 font-semibold text-sky-700" : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
          {comparing ? "column" : "value"}
        </button>
      )}

      {onRemove && (
        <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-foreground" title="Remove">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function PreviewPanel({ preview: p, checking, action }: { preview: Preview | null; checking: boolean; action: Action }) {
  const verb = action === "approve" ? "approve" : action === "deny" ? "deny" : "flag";
  const rows = useMemo(() => p?.sample.slice(0, 8) ?? [], [p]);

  if (!p) {
    return (
      <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        {checking ? "Checking…" : "Finish the rule to see what it would catch."}
      </div>
    );
  }

  if (p.incomplete) {
    return (
      <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        <p className="font-semibold">Not finished yet</p>
        <ul className="mt-1 list-disc pl-4">
          {p.problems.map((x, i) => <li key={i}>{x}</li>)}
        </ul>
      </div>
    );
  }

  const heavy = action !== "flag" && p.wouldAct > 25;

  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2 text-xs">
        {checking && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <span className="font-semibold">{p.summary}</span>
        <span className="ml-auto text-muted-foreground">
          {p.matched.toLocaleString()} matched · {p.failing.toLocaleString()} failing · {p.passing.toLocaleString()} passing
        </span>
      </div>

      <p className={`px-3 py-2 text-xs ${heavy ? "text-amber-800" : "text-muted-foreground"}`}>
        {heavy && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />}
        Right now it would <strong>{verb} {p.wouldAct.toLocaleString()}</strong>{" "}
        expense{p.wouldAct === 1 ? "" : "s"}
        {action !== "flag" && " still in the inbox"}.
        {heavy && " That is above the per-run cap, so it would stop partway and warn — check the conditions."}
        {p.wouldAct === 0 && action === "flag" && " Nothing is wrong today, which is the point."}
      </p>

      {rows.length > 0 && (
        <table className="w-full border-t border-border text-xs">
          <tbody>
            {rows.map((r) => (
              <tr key={r.dedupeKey} className="border-t border-border/60">
                <td className="px-3 py-1.5">
                  {r.verdict === "fail"
                    ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                    : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
                </td>
                <td className="px-2 py-1.5">{r.employee}</td>
                <td className="max-w-40 truncate px-2 py-1.5">{r.merchant}</td>
                <td className="tnum px-2 py-1.5 text-right">{money(r.amountCents / 100)}</td>
                <td className="max-w-56 truncate px-2 py-1.5 text-muted-foreground">
                  {r.detail || r.category || r.note}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.sample.length > rows.length && (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">
          …and {(p.matched - rows.length).toLocaleString()} more.
        </p>
      )}
    </div>
  );
}
