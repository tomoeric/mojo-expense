import { Router, type Request, type Response } from "express";
import { db, isDbConfigured } from "../db.js";
import { readSettings } from "../import/settings.js";
import { requireAuth } from "../auth/index.js";
import { answerChallenge, cancelChallenge, currentChallenge, waitForCode } from "../emburse/challenge.js";
import { browserQueue, whyWaiting } from "./browser-lock.js";
import { credentialForUser, hasCredential, noteResult } from "./credentials.js";
import { inspectEditForm, runDecision, testConnection, type Decision, type Target } from "./decide.js";
import {
  appliedCount, cancelDecision, decisionsFor, pendingDecisions, queueApprovalFor, queueDecision,
  failureReport, failureSummary, recentDecisions, retryFailedDecisions,
} from "./decisions.js";
import { decisionWorkerStarted, nudgeDecisionWorker } from "./decision-worker.js";
import { getFlag, setFlag } from "../flags.js";
import { exportInFlight } from "./export-scheduler.js";

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
 * Test this person's own Emburse connection.
 *
 * Signs in as them and stops. Approving used to be the only way to find out
 * whether a login worked, so the first thing a new reviewer learned was that a
 * real expense "did not go through".
 *
 * Always the REAL signed-in person, never an impersonated one: this signs in
 * to Emburse, and the verification code it may raise goes to that person's own
 * phone. An admin cannot answer it for them, so there is nothing to gain by
 * letting them try.
 */
decisionRouter.post("/emburse-check", requireAuth, async (req: Request, res: Response) => {
  const who = req.user?.email ?? "";
  const login = await credentialForUser(who);
  if (!login) {
    res.status(400).json({
      error: "You have no Emburse login stored. Add one under “Your Emburse login” in the user menu.",
    });
    return;
  }

  try {
    const settings = await readSettings();
    const run = await testConnection(settings.selectors, settings.emburseUrl, login, {
      // Somebody pressed a button and is watching, so a code CAN be asked for —
      // and answering it here is the whole reason to press it.
      onChallenge: (ctx: { prompt: string; screenshot: string | null; attempt: number; lastError: string | null }) =>
        waitForCode({ ...ctx, owner: who }),
    });
    // A failed connection test is NOT automatically a wrong password: a device
    // check and a moved button fail the same way, and flagging those for
    // re-entry asks somebody to retype a password that was never the problem.
    const why = run.ok ? null : lastFailure(run.steps);
    await noteResult(who, run.ok, why, Boolean(why && /password|credential|rejected/i.test(why)));
    res.json({
      ok: run.ok,
      who,
      steps: run.steps,
      screenshot: run.screenshot,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "The test could not run." });
  }
});

const lastFailure = (steps: { ok: boolean; detail: string }[]): string =>
  steps.filter((s) => !s.ok).map((s) => s.detail).join(" — ") || "The sign-in did not complete.";

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

/**
 * Approve a batch of expenses that were checked off together.
 *
 * One request rather than two hundred, because that is what a reviewer
 * does after working down the unflagged list: tick the lot and send them.
 * Two hundred separate posts would each nudge the worker and each race the
 * others for the queue.
 *
 * Every expense still goes through the SAME checks as a single one — it
 * exists, the decider has an Emburse login, nothing is already in flight
 * for it. A batch is a convenience for the person, not a lighter standard
 * for the decision. Whatever cannot be queued is named and the rest still
 * go, rather than the whole batch failing over one.
 *
 * Approve only. Denying wants a reason per expense, and a single reason
 * pasted across a hundred denials is worse than making somebody write
 * them.
 */
decisionRouter.post("/decisions/bulk", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const body = req.body as { dedupeKeys?: unknown };
  const keys = Array.isArray(body.dedupeKeys)
    ? [...new Set(body.dedupeKeys.filter((k): k is string => typeof k === "string" && k.length > 0))]
    : [];
  if (keys.length === 0) {
    res.status(400).json({ error: "Nothing was selected." });
    return;
  }
  // A ceiling, deliberately. Approving is the irreversible half of this
  // app, and a runaway click that queued four thousand of them would be
  // discovered by somebody in Emburse rather than here.
  if (keys.length > 250) {
    res.status(400).json({ error: `That is ${keys.length} expenses. Approve at most 250 at once.` });
    return;
  }

  const decider = req.user?.email ?? "";
  if (!(await hasCredential(decider))) {
    res.status(400).json({
      error:
        "Add your Emburse login first, under Your Emburse login in the user menu. " +
        "Decisions are made in Emburse as you, so the approval carries your name and not somebody else's.",
    });
    return;
  }

  let queued = 0;
  const refused: string[] = [];
  for (const dedupeKey of keys) {
    const result = await queueApprovalFor(dedupeKey, decider);
    if (result.ok) queued++;
    else refused.push(result.error);
  }

  if (queued > 0) nudgeDecisionWorker();
  res.status(202).json({
    queued,
    // Named, not counted. "3 could not be queued" sends somebody hunting.
    refused: [...new Set(refused)].slice(0, 10),
    waiting: whyWaiting(),
  });
});

/**
 * Run every failed decision again.
 *
 * A whole batch can fail on one cause. That is what happened: a slow
 * morning where the first navigation timed out on the 30-second step
 * budget, and every queued approval failed at "open Emburse" against a
 * sign-in page that had plainly rendered. Recovering from it meant
 * pressing Approve on each row — eighteen clicks that are not eighteen
 * decisions, just typing.
 *
 * Re-queued under the login of whoever presses it, like every other
 * decision in this app, and the page says so before they do.
 */
decisionRouter.post("/decisions/retry-failed", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const decider = req.user?.email ?? "";
  if (!(await hasCredential(decider))) {
    res.status(400).json({
      error:
        "Add your Emburse login first, under Your Emburse login in the user menu. " +
        "Decisions are made in Emburse as you, so the approval carries your name and not somebody else's.",
    });
    return;
  }
  try {
    const { queued, refused } = await retryFailedDecisions(decider);
    if (queued > 0) nudgeDecisionWorker();
    res.status(202).json({ queued, refused: refused.slice(0, 10), waiting: whyWaiting() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Pause, or let it go again.
 *
 * On the queue rather than buried in Configuration, because the moment
 * somebody wants this is the moment they are watching a hundred decisions
 * march into Emburse and a morning import waiting behind them.
 */
decisionRouter.post("/decisions/hold", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const body = req.body as { held?: unknown };
  const held = Boolean(body.held);
  await setFlag("holdDecisions", held, req.user?.email ?? "unknown");
  // Lifting it should not mean waiting out the idle timer. Nudged rather
  // than run here: the worker owns the browser, not a request.
  if (!held) nudgeDecisionWorker();
  res.json({ held });
});

/**
 * What the failures are, grouped by cause.
 *
 * "99 did not go through" is a number, not a diagnosis, and reading ninety-
 * nine dialogs one at a time is how three separate causes got taken for one.
 */
decisionRouter.get("/decisions/failures", requireAuth, async (_req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    res.json({ groups: await failureSummary() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * The same failures as a markdown file, to read properly or send on.
 *
 * Served as an attachment rather than as a page: a .md rendered in a browser
 * tab is a wall of pipes, and the point of it is to be opened in something
 * that reads markdown, or pasted somewhere.
 */
decisionRouter.get("/decisions/failures.md", requireAuth, async (_req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("content-type", "text/markdown; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="decision-failures-${day}.md"`);
    res.send(await failureReport());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
    // Expenses still in the local table that this app has already approved
    // or denied. The Live strip counts "awaiting a decision" off the
    // reports payload, which knows nothing about decisions — so after a
    // morning's approvals it said 212 while the queue showed twelve. They
    // stay until the next sync deletes them, which is minutes away at
    // best, and for that whole window the headline contradicted the list
    // underneath it.
    applied: await appliedCount(),
    // Whether to show the stage-by-stage trace at all. It rides on the poll
    // the queue already makes rather than getting a request of its own: it
    // is one boolean and the page is useless without this response anyway.
    trace: await getFlag("traceDecisions").catch(() => false),
    // Paused, and whether an import is holding things up by itself. Both
    // ride on the poll the queue already makes: the strip has to be able to
    // say why nothing is moving, and "paused" and "waiting for the import"
    // are the two answers that are not a fault.
    held: await getFlag("holdDecisions").catch(() => false),
    importing: await exportInFlight().catch(() => false),
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
/**
 * Send now, meaning now.
 *
 * This used to nudge the worker the same way queueing a decision does —
 * through a twenty-second gather delay that every press RESET. So a button
 * labelled Send now waited, and pressing it again because nothing had
 * happened pushed the run further away. It also answered 202 whether or not
 * the worker existed to be nudged: with no worker started the press did
 * nothing at all, for ever, cheerfully.
 */
decisionRouter.post("/decisions/apply", requireAuth, (_req: Request, res: Response) => {
  if (!guard(res)) return;
  if (!nudgeDecisionWorker({ immediate: true })) {
    res.status(503).json({
      error: decisionWorkerStarted()
        ? "The decision worker could not be reached."
        : "The decision worker is not running, so nothing would be sent. It starts with the " +
          "server when a database is configured — check the server log for why it did not.",
    });
    return;
  }
  const busy = whyWaiting();
  res.status(202).json({
    ok: true,
    waiting: busy,
    // What actually happens next, in the words of what is true. "Sent" would
    // be a lie: the browser may be held by the export, and this returns
    // before a single page has loaded.
    message: busy
      ? `Starting as soon as the browser is free — ${busy}`
      : "Starting now — signing in and applying takes a minute or two.",
  });
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
 * Look at Emburse's Edit form for one queued expense, and change nothing.
 *
 * Groundwork for editing a category before approving. Every attempt so far
 * at writing selectors for a part of Emburse nobody has looked at has cost
 * a round of failures — divs instead of a table, hidden measuring rows, a
 * pinned Action column. One click here reports what the form really
 * contains, and the change gets written against that.
 */
decisionRouter.post("/decisions/:id/edit-form", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const queued = (await pendingDecisions()).find((d) => d.id === Number(req.params.id));
  if (!queued) {
    res.status(404).json({ error: "No decision is waiting with that id." });
    return;
  }
  // As the person whose decision it is, like everything else that touches
  // their Emburse account.
  const login = await credentialForUser(queued.decidedBy);
  if (!login) {
    res.status(400).json({ error: `${queued.decidedBy} has no Emburse login stored.` });
    return;
  }
  try {
    const settings = await readSettings();
    const run = await inspectEditForm(queued.target, settings.selectors, settings.emburseUrl, login);
    res.json({ ok: run.ok, steps: run.steps, fields: run.fields, screenshot: run.screenshot });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not look at the form." });
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
