import { Router, type Request, type Response } from "express";
import { db, isDbConfigured } from "../db.js";
import { readSettings } from "../import/settings.js";
import { requireAuth } from "../auth/index.js";
import { answerChallenge, cancelChallenge, currentChallenge } from "../emburse/challenge.js";
import { browserQueue, whyWaiting } from "./browser-lock.js";
import { credentialForUser, hasCredential } from "./credentials.js";
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

/**
 * Answer the verification code a decision is parked on.
 *
 * requireAuth rather than requireAdmin: the gate that matters is OWNERSHIP,
 * which answerChallenge enforces itself — only the person whose sign-in
 * raised it can complete it. Requiring admin as well would lock out exactly
 * the reviewer who has the code on their phone.
 */
decisionRouter.post("/decisions/challenge", requireAuth, (req: Request, res: Response) => {
  const { code } = req.body as { code?: unknown };
  const result = answerChallenge(code, req.user?.email ?? "");
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

decisionRouter.delete("/decisions/challenge", requireAuth, (req: Request, res: Response) => {
  const result = cancelChallenge("Cancelled from the queue.", req.user?.email ?? "");
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

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

  // Refused now rather than queued and stuck. A decision is applied under the
  // decider's own Emburse login — Emburse records it against whoever signed
  // in, and putting somebody else's name on a denial is not a thing to do
  // quietly — so without one there is nothing that could ever carry it out.
  const decider = req.user?.email ?? "";
  if (!(await hasCredential(decider))) {
    res.status(400).json({
      error:
        "Add your Emburse login first, under Your Emburse login in the user menu. " +
        "Decisions are made in Emburse as you, so the approval carries your name and not somebody else's.",
    });
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
    // Whether this person can decide at all. The buttons ask first rather
    // than letting somebody work through a queue and be refused each time.
    canDecide: await hasCredential(req.user?.email ?? ""),
    // Carried on the thing the queue already polls. A decision can park on a
    // device-verification code, and the person who has to type it is the one
    // who just clicked Approve — not an admin looking at the Import page,
    // which is the only place this used to appear.
    challenge: (() => {
      const c = currentChallenge();
      return c && { ...c, mine: c.owner === (req.user?.email ?? "") };
    })(),
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

  // Tested as the person who made it, for the same reason it is applied that
  // way: a test signed in as somebody else proves the wrong thing.
  const login = await credentialForUser(queued.decidedBy);
  if (!login) {
    res.status(400).json({
      error: `${queued.decidedBy} has no Emburse login stored, so this cannot be tested or applied.`,
    });
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

/**
 * What a receipt says was bought.
 *
 * Read from our own stored image, keyed by its content hash — so one receipt
 * shared by several expenses is read once, and the items survive the image
 * being released after an approval.
 */
decisionRouter.get("/receipt-items", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const keys = String((req.query as { keys?: string }).keys ?? "")
    .split(",").map((k) => k.trim()).filter(Boolean).slice(0, 500);
  const { detailsForExpenses, canReadReceipts } = await import("./receipt-items.js");
  res.json({
    enabled: canReadReceipts(),
    byExpense: Object.fromEntries(await detailsForExpenses(keys)),
  });
});

/** Read one now, rather than waiting for the background pass. */
decisionRouter.post("/receipt-items/:sha", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const sha = String(req.params.sha ?? "");
  if (!/^[0-9a-f]{64}$/i.test(sha)) {
    res.status(400).json({ error: "Not a receipt id." });
    return;
  }
  const { extractReceipt, canReadReceipts } = await import("./receipt-items.js");
  if (!canReadReceipts()) {
    res.status(400).json({ error: "Reading receipts needs an Anthropic API key." });
    return;
  }
  try {
    const detail = await extractReceipt(sha, { force: req.query.force === "1" });
    if (!detail) {
      res.status(404).json({ error: "That receipt image is no longer stored." });
      return;
    }
    res.json(detail);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "The receipt could not be read." });
  }
});
