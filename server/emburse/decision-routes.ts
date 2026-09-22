import { Router, type Request, type Response } from "express";
import { db, isDbConfigured } from "../db.js";
import { readSettings } from "../import/settings.js";
import { requireAuth } from "../auth/index.js";
import { browserQueue, whyWaiting } from "./browser-lock.js";
import { envLogin } from "./auto-export.js";
import { credentialForExport } from "./credentials.js";
import { runDecision, type Decision, type Target } from "./decide.js";
import {
  cancelDecision, decisionsFor, pendingDecisions, queueDecision, recentDecisions,
} from "./decisions.js";
import { nudgeDecisionWorker } from "./decision-worker.js";

export const decisionRouter = Router();

const guard = (res: Response): boolean => {
  if (isDbConfigured()) return true;
  res.status(503).json({ error: "No database is configured, so decisions cannot be recorded." });
  return false;
};

/**
 * What the reviewer is deciding about, read from our own records.
 *
 * Built here rather than accepted from the request on purpose. This object is
 * what the browser verifies the Emburse row against, so a client that could
 * supply it could name one expense and describe another — and the verification
 * would pass while approving something nobody chose. The client says which
 * expense; the server says what that expense is.
 */
async function targetFor(dedupeKey: string): Promise<Target | null> {
  const { rows } = await db().query<{
    employee: string; merchant: string; amount_cents: string; expense_date: Date | null;
    in_inbox: boolean;
  }>(
    `SELECT employee, merchant, amount_cents, expense_date, in_inbox
       FROM expenses WHERE dedupe_key = $1`,
    [dedupeKey],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    employee: r.employee,
    merchant: r.merchant,
    amount: Number(r.amount_cents) / 100,
    date: r.expense_date ? r.expense_date.toISOString().slice(0, 10) : null,
  };
}

/** Approve or deny an expense. Recorded now, applied by the worker shortly after. */
decisionRouter.post("/decisions", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const { dedupeKey, decision, reason } = req.body as {
    dedupeKey?: unknown; decision?: unknown; reason?: unknown;
  };

  if (typeof dedupeKey !== "string" || !dedupeKey) {
    res.status(400).json({ error: "Which expense?" });
    return;
  }
  if (decision !== "approve" && decision !== "deny") {
    res.status(400).json({ error: "A decision is either approve or deny." });
    return;
  }

  const target = await targetFor(dedupeKey);
  if (!target) {
    res.status(404).json({ error: "That expense is not in the queue." });
    return;
  }

  const result = await queueDecision({
    dedupeKey,
    decision: decision as Decision,
    reason: typeof reason === "string" ? reason : "",
    decidedBy: req.user?.email ?? "unknown",
    target,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  nudgeDecisionWorker();
  res.status(202).json({ queued: result.queued, waiting: whyWaiting() });
});

/** The queue, the history, and what the browser is busy with. */
decisionRouter.get("/decisions", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const keys = String((req.query as { keys?: string }).keys ?? "")
    .split(",").map((k) => k.trim()).filter(Boolean).slice(0, 500);

  res.json({
    pending: await pendingDecisions(),
    recent: await recentDecisions(50),
    // Keyed by expense, so the queue page can badge each row without a
    // request per row.
    byExpense: Object.fromEntries(await decisionsFor(keys)),
    browser: browserQueue(),
  });
});

/** Take one back, while it is still only a record. */
decisionRouter.delete("/decisions/:id", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const ok = await cancelDecision(Number(req.params.id), req.user?.email ?? "unknown");
  if (!ok) {
    res.status(409).json({ error: "That decision has already been applied, or was already cancelled." });
    return;
  }
  res.json({ ok: true });
});

/** Apply what is queued now, rather than waiting for the worker's next pass. */
decisionRouter.post("/decisions/apply", requireAuth, (_req: Request, res: Response) => {
  if (!guard(res)) return;
  nudgeDecisionWorker();
  res.status(202).json({ ok: true, waiting: whyWaiting() });
});

/**
 * Prove a decision would find the right row, without making it.
 *
 * The same code path, stopped one click short: it signs in, searches, and
 * verifies the row field by field, then reports what it matched. This is how
 * the matching gets trusted before anything irreversible depends on it.
 */
decisionRouter.post("/decisions/:id/test", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;

  const queued = (await pendingDecisions()).find((d) => d.id === Number(req.params.id));
  if (!queued) {
    res.status(404).json({ error: "No decision is waiting with that id." });
    return;
  }

  const login = (await credentialForExport()) ?? envLogin();
  if (!login) {
    res.status(400).json({ error: "No Emburse login is stored, so nothing can be tested." });
    return;
  }

  try {
    const settings = await readSettings();
    const run = await runDecision(
      queued.decision, queued.target, queued.reason ?? "",
      settings.selectors, settings.emburseUrl, login, { dryRun: true },
    );
    res.json({
      ok: run.ok,
      steps: run.steps,
      matchedRow: run.matchedRow,
      screenshot: run.screenshot,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "The test could not run." });
  }
});
