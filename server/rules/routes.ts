import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../auth/index.js";
import { isDbConfigured } from "../db.js";
import { hasCredential } from "../emburse/credentials.js";
import { listTaxonomy } from "../import/taxonomy.js";
import {
  ACTIONS, FIELDS, FIELD_LABEL, FIELD_LIST, OPS, OP_LABEL, opsFor,
  type Action, type Condition, type Field, type Op, type RuleBody,
} from "./engine.js";
import {
  deleteRule, getRule, listRules, problems, ruleStats, saveRule, setEnabled, summarise,
} from "./store.js";
import { MAX_DECISIONS_PER_RUN, previewRule, runRules } from "./run.js";

export const rulesRouter: IRouter = Router();

function guard(res: Response): boolean {
  if (isDbConfigured()) return true;
  res.status(503).json({ error: "No database is configured, so there are no rules." });
  return false;
}

/**
 * Read a rule off a request.
 *
 * Everything is re-derived rather than trusted: a field or operator the client
 * invented would otherwise be stored and then evaluate to false forever, which
 * on an approve rule means it silently stops approving and on a deny rule means
 * it silently starts denying everything.
 */
function readBody(raw: unknown): RuleBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Send a rule." };
  const r = raw as Record<string, unknown>;

  const condition = (v: unknown): Condition | { error: string } => {
    if (!v || typeof v !== "object") return { error: "A condition is missing." };
    const c = v as Record<string, unknown>;
    const field = String(c.field ?? "") as Field;
    const op = String(c.op ?? "") as Op;
    if (!(FIELDS as readonly string[]).includes(field)) return { error: `Unknown field “${field}”.` };
    if (!(OPS as readonly string[]).includes(op)) return { error: `Unknown test “${op}”.` };
    if (!opsFor(field).includes(op)) {
      return { error: `${FIELD_LABEL[field]} cannot be tested with “${OP_LABEL[op]}”.` };
    }
    return { field, op, value: String(c.value ?? "").slice(0, 300) };
  };

  const whenRaw = Array.isArray(r.when) ? r.when : [];
  if (whenRaw.length > 10) return { error: "Ten conditions is the limit for one rule." };
  const when: Condition[] = [];
  for (const v of whenRaw) {
    const c = condition(v);
    if ("error" in c) return c;
    when.push(c);
  }

  let must: Condition | null = null;
  if (r.must) {
    const c = condition(r.must);
    if ("error" in c) return c;
    must = c;
  }

  const action = String(r.action ?? "flag") as Action;
  if (!(ACTIONS as readonly string[]).includes(action)) return { error: `Unknown action “${action}”.` };

  return {
    name: String(r.name ?? "").slice(0, 120),
    enabled: r.enabled !== false,
    match: r.match === "any" ? "any" : "all",
    when,
    must,
    action,
    message: String(r.message ?? "").slice(0, 500),
  };
}

/** Everything the rule editor needs to offer sensible choices. */
rulesRouter.get("/rules/options", requireAuth, async (_req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    const [categories, locations, departments] = await Promise.all([
      listTaxonomy("category"), listTaxonomy("location"), listTaxonomy("department"),
    ]);
    res.json({
      fields: FIELDS.map((f) => ({
        value: f, label: FIELD_LABEL[f], list: FIELD_LIST[f] ?? null,
        ops: opsFor(f).map((o) => ({ value: o, label: OP_LABEL[o] })),
      })),
      lists: {
        category: categories.entries.map((e) => e.name),
        location: locations.entries.map((e) => e.name),
        department: departments.entries.map((e) => e.name),
      },
      maxDecisionsPerRun: MAX_DECISIONS_PER_RUN,
    });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

rulesRouter.get("/rules", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    const [rules, stats] = await Promise.all([listRules(), ruleStats()]);
    // Whether each deciding rule can actually decide. Worked out here rather
    // than in the browser, because it depends on a stored credential the
    // client has no business being told the contents of.
    const owners = new Set(rules.filter((r) => r.action !== "flag").map((r) => r.createdBy ?? ""));
    const canDecide = new Map<string, boolean>();
    for (const o of owners) canDecide.set(o, o ? await hasCredential(o) : false);

    res.json({
      you: req.user?.email ?? null,
      maxDecisionsPerRun: MAX_DECISIONS_PER_RUN,
      rules: rules.map((r) => ({
        ...r,
        summary: summarise(r),
        problems: problems(r),
        stats: stats.get(r.id) ?? { fail: 0, pass: 0, waiting: 0 },
        ownerCanDecide: r.action === "flag" ? true : (canDecide.get(r.createdBy ?? "") ?? false),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

rulesRouter.post("/rules", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const body = readBody(req.body);
  if ("error" in body) {
    res.status(400).json(body);
    return;
  }
  try {
    const saved = await saveRule(body, req.user?.email ?? "unknown");
    if (!saved.ok) {
      res.status(400).json({ error: saved.error });
      return;
    }
    // Run it now so the page is not lying about what it has caught. Flags
    // only — a brand-new rule does not get to decide anything before somebody
    // has looked at what it caught.
    const ran = await runRules({ decide: false });
    res.json({ rule: saved.rule, ran: { failed: ran.failed, passed: ran.passed } });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

rulesRouter.put("/rules/:id", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Which rule?" });
    return;
  }
  const body = readBody(req.body);
  if ("error" in body) {
    res.status(400).json(body);
    return;
  }
  try {
    const saved = await saveRule(body, req.user?.email ?? "unknown", id);
    if (!saved.ok) {
      res.status(400).json({ error: saved.error });
      return;
    }
    const ran = await runRules({ decide: false });
    res.json({ rule: saved.rule, ran: { failed: ran.failed, passed: ran.passed } });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

rulesRouter.post("/rules/:id/enabled", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const id = Number(req.params.id);
  const enabled = (req.body as { enabled?: unknown })?.enabled === true;
  try {
    const rule = await setEnabled(id, enabled, req.user?.email ?? "unknown");
    if (!rule) {
      res.status(404).json({ error: "That rule no longer exists." });
      return;
    }
    if (enabled) await runRules({ decide: false });
    res.json({ rule });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

rulesRouter.delete("/rules/:id", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    const gone = await deleteRule(Number(req.params.id));
    res.json({ deleted: gone });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

/**
 * What a rule would do, without doing it.
 *
 * Accepts an unsaved rule in the body so a rule can be checked BEFORE it
 * exists, which is the only moment the check is worth much. Nothing is
 * written and nothing is queued.
 */
rulesRouter.post("/rules/preview", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const body = readBody(req.body);
  if ("error" in body) {
    res.status(400).json(body);
    return;
  }
  const bad = problems(body);
  if (bad.length > 0) {
    res.json({ incomplete: true, problems: bad, matched: 0, failing: 0, passing: 0, wouldAct: 0, sample: [] });
    return;
  }
  try {
    const rule = { ...body, id: 0, createdBy: req.user?.email ?? null, createdAt: "",
                   updatedBy: null, updatedAt: "", lastRunAt: null };
    res.json({ incomplete: false, problems: [], summary: summarise(body), ...(await previewRule(rule)) });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

/** Re-run every rule over everything. Decides only if asked, and says so. */
rulesRouter.post("/rules/run", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const decide = (req.body as { decide?: unknown })?.decide === true;
  try {
    res.json(await runRules({ decide }));
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

rulesRouter.get("/rules/:id", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    const rule = await getRule(Number(req.params.id));
    if (!rule) {
      res.status(404).json({ error: "No such rule." });
      return;
    }
    res.json({ rule, summary: summarise(rule), problems: problems(rule) });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

function describe(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}
