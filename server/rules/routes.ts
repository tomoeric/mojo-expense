import { Router, type IRouter, type Request, type Response } from "express";
import { adminListSize, isAdmin, isAuthConfigured, requireAdmin, requireAuth } from "../auth/index.js";
import { canWriteRules, isRestricted, listEditors, requireRuleEditor, setEditor } from "./editors.js";
import { isDbConfigured } from "../db.js";
import { hasCredential, listCredentials } from "../emburse/credentials.js";
import { listTaxonomy } from "../import/taxonomy.js";
import {
  ACTIONS, FIELDS, FIELD_LABEL, FIELD_LIST, MONEY_TOLERANCE_ABS, MONEY_TOLERANCE_PCT,
  OPS, OP_LABEL, comparableTo, opLabel, opsFor,
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
export function readBody(raw: unknown): RuleBody | { error: string } {
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
      return { error: `${FIELD_LABEL[field]} cannot be tested with “${opLabel(field, op)}”.` };
    }
    // A comparison against another column, which is how "the receipt's own
    // total must equal the amount claimed" is expressed.
    const compare = c.compare ? (String(c.compare) as Field) : null;
    if (compare && !comparableTo(field).includes(compare)) {
      return { error: `${FIELD_LABEL[field]} cannot be compared with “${compare}”.` };
    }
    return { field, op, value: String(c.value ?? "").slice(0, 300), compare };
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
        ops: opsFor(f).map((o) => ({ value: o, label: opLabel(f, o) })),
        // Which other columns this one may be compared against, so the editor
        // cannot offer a comparison the server would refuse.
        comparable: comparableTo(f).map((c) => ({ value: c, label: FIELD_LABEL[c] })),
      })),
      lists: {
        category: categories.entries.map((e) => e.name),
        location: locations.entries.map((e) => e.name),
        department: departments.entries.map((e) => e.name),
      },
      maxDecisionsPerRun: MAX_DECISIONS_PER_RUN,
      moneyTolerance: { abs: MONEY_TOLERANCE_ABS, pct: MONEY_TOLERANCE_PCT },
    });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

/**
 * Who may write rules, and everybody who could be added.
 *
 * Candidates are people the app already knows — anyone with a stored Emburse
 * login, anyone who has authored a rule, and the viewer. So Brian appears here
 * on his own once he stores his Emburse login, which he has to do anyway
 * before a rule of his could decide anything.
 */
rulesRouter.get("/rules/editors", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    const [editors, credentials, rules] = await Promise.all([
      listEditors(), listCredentials(), listRules(),
    ]);
    // Only things that could actually be toggled. A rule authored before
    // sign-in was configured carries `createdBy: "unknown"`, which is not a
    // person and would be refused by setEditor anyway.
    const known = new Set<string>();
    const add = (v: string | null | undefined) => {
      const email = (v ?? "").trim().toLowerCase();
      if (email.includes("@")) known.add(email);
    };
    for (const e of editors) add(e.email);
    for (const c of credentials) add(c.userEmail);
    for (const r of rules) add(r.createdBy);
    add(req.user?.email);

    const allowed = new Set(editors.map((e) => e.email));
    res.json({
      you: req.user?.email?.toLowerCase() ?? null,
      youAreAdmin: !isAuthConfigured() || (req.user ? isAdmin(req.user.email) : false),
      restricted: allowed.size > 0,
      // With AUTH_ADMINS unset every signed-in person is an admin and could
      // add themselves back, so the page must not imply this is a lock.
      adminsRestricted: adminListSize() > 0,
      people: [...known].sort().map((email) => ({
        email,
        allowed: allowed.has(email),
        hasEmburseLogin: credentials.some((c) => c.userEmail.toLowerCase() === email),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

/** Admin-only: the toggle itself. */
rulesRouter.post("/rules/editors", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const body = req.body as { email?: unknown; allowed?: unknown };
  const email = String(body?.email ?? "").trim();
  if (!email) {
    res.status(400).json({ error: "Which person?" });
    return;
  }
  try {
    await setEditor(email, body?.allowed === true, req.user?.email ?? "unknown");
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: describe(err) });
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
      youCanWrite: await canWriteRules(req.user?.email),
      restricted: await isRestricted(),
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

rulesRouter.post("/rules", requireAuth, requireRuleEditor, async (req: Request, res: Response) => {
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

rulesRouter.put("/rules/:id", requireAuth, requireRuleEditor, async (req: Request, res: Response) => {
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

rulesRouter.post("/rules/:id/enabled", requireAuth, requireRuleEditor, async (req: Request, res: Response) => {
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

rulesRouter.delete("/rules/:id", requireAuth, requireRuleEditor, async (req: Request, res: Response) => {
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
rulesRouter.post("/rules/run", requireAuth, requireRuleEditor, async (req: Request, res: Response) => {
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
