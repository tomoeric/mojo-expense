import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Rules: "when the note mentions gas, the category must be Auto Fee & Fuel."
 *
 * The client mirrors the server's vocabulary rather than inventing its own —
 * the field and operator lists come down from `/api/rules/options`, so a field
 * added on the server appears in the editor without a matching change here.
 */

export type Field =
  | "note" | "merchant" | "category" | "location" | "department"
  | "employee" | "amount" | "method" | "receipt" | "receiptItems" | "receiptTotal"
  | "dayCount" | "dayTotal";

export type Op =
  | "contains" | "not_contains" | "is" | "is_not" | "starts_with"
  | "gt" | "lt" | "gte" | "lte" | "is_blank" | "is_not_blank";

export type Action = "flag" | "approve" | "deny";

export type Condition = {
  field: Field;
  op: Op;
  value: string;
  /** Compare against another column instead of a typed-in value. */
  compare?: Field | null;
};

export type RuleBody = {
  name: string;
  enabled: boolean;
  match: "all" | "any";
  when: Condition[];
  must: Condition | null;
  action: Action;
  message: string;
};

export type Rule = RuleBody & {
  id: number;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  lastRunAt: string | null;
  summary: string;
  problems: string[];
  stats: { fail: number; pass: number; waiting: number };
  /** False when a deciding rule's owner has no Emburse login, so it cannot act. */
  ownerCanDecide: boolean;
};

export type Person = { email: string; allowed: boolean; hasEmburseLogin: boolean };

export type Editors = {
  you: string | null;
  youAreAdmin: boolean;
  /** True once somebody has been named, which is when the list starts biting. */
  restricted: boolean;
  /** False while AUTH_ADMINS is unset, when any signed-in person could undo this. */
  adminsRestricted: boolean;
  people: Person[];
};

export type Options = {
  fields: {
    value: Field;
    label: string;
    list: "category" | "location" | "department" | null;
    ops: { value: Op; label: string }[];
    comparable: { value: Field; label: string }[];
    /** Computed from the WHEN, so only offered in MUST. */
    mustOnly: boolean;
  }[];
  lists: Record<"category" | "location" | "department", string[]>;
  maxDecisionsPerRun: number;
  moneyTolerance: { abs: number; pct: number };
};

export type Preview = {
  incomplete: boolean;
  problems: string[];
  summary?: string;
  matched: number;
  failing: number;
  passing: number;
  wouldAct: number;
  sample: {
    dedupeKey: string; employee: string; merchant: string; amountCents: number;
    category: string; note: string; verdict: "pass" | "fail"; detail: string; inInbox: boolean;
  }[];
};

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: (T & { error?: string }) | null = null;
  try {
    body = JSON.parse(text) as T & { error?: string };
  } catch {
    throw new Error(`The server replied with something unexpected (${res.status}).`);
  }
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
  return body;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const BLANK: RuleBody = {
  name: "",
  enabled: true,
  match: "all",
  when: [{ field: "note", op: "contains", value: "" }],
  must: { field: "category", op: "is", value: "" },
  action: "flag",
  message: "",
};

export function useRules() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["rules"] });
    // Flags on the queue come from rule verdicts, so they move together.
    void qc.invalidateQueries({ queryKey: ["reports"] });
  };

  const list = useQuery({
    queryKey: ["rules"],
    queryFn: () => send<{
      you: string | null; youCanWrite: boolean; restricted: boolean;
      maxDecisionsPerRun: number; rules: Rule[];
    }>("/api/rules"),
  });

  const editors = useQuery({
    queryKey: ["rules", "editors"],
    queryFn: () => send<Editors>("/api/rules/editors"),
  });

  const setEditor = useMutation({
    mutationFn: (input: { email: string; allowed: boolean }) =>
      send<{ ok: true }>("/api/rules/editors", json(input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });

  const options = useQuery({
    queryKey: ["rules", "options"],
    queryFn: () => send<Options>("/api/rules/options"),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: (input: { body: RuleBody; id?: number }) =>
      send<{ rule: Rule }>(
        input.id ? `/api/rules/${input.id}` : "/api/rules",
        { ...json(input.body), method: input.id ? "PUT" : "POST" },
      ),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: number) => send<{ deleted: boolean }>(`/api/rules/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const toggle = useMutation({
    mutationFn: (input: { id: number; enabled: boolean }) =>
      send<{ rule: Rule }>(`/api/rules/${input.id}/enabled`, json({ enabled: input.enabled })),
    onSuccess: invalidate,
  });

  const runAll = useMutation({
    mutationFn: (decide: boolean) =>
      send<{ failed: number; passed: number; approved: number; denied: number; warnings: string[] }>(
        "/api/rules/run", json({ decide })),
    onSuccess: invalidate,
  });

  return { list, options, editors, setEditor, save, remove, toggle, runAll };
}

export const preview = (body: RuleBody): Promise<Preview> =>
  send<Preview>("/api/rules/preview", json(body));
