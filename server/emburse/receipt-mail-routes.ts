import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth/index.js";
import { db, isDbConfigured } from "../db.js";
import { isGraphConfigured, mailProblem } from "../mail.js";
import { MANAGER_LANE, laneTag, linkedLanesOf } from "./connections.js";
import {
  decideMatch, listFolders, mailSettings, matchAll, matchesFor, recordCandidates,
  saveMailSettings, searchMailbox, conflicts,
  type Target,
} from "./receipt-mail.js";

/**
 * Finding receipts in a mailbox, and offering them.
 *
 * Nothing here writes to Emburse and nothing here writes to the
 * mailbox. A scan reads, scores and records candidates; a person
 * chooses. Attaching is a separate step with a separate route, and
 * it is not in this file.
 *
 * Every route is the signed-in person's own: the mailbox setting
 * is keyed on their address, the expenses searched are the ones
 * their queue holds, and view-as cannot write.
 */

export const receiptMailRouter = Router();

const guard = (res: Response): boolean => {
  if (isDbConfigured()) return true;
  res.status(503).json({ error: "No database is configured." });
  return false;
};

const owner = (req: Request, res: Response): string | null => {
  if (req.viewingAs) {
    res.status(403).json({
      error: "You are viewing as somebody else; this is read-only.",
    });
    return null;
  }
  const email = req.user?.email ?? "";
  if (!email) { res.status(401).json({ error: "Sign in first." }); return null; }
  return email;
};

receiptMailRouter.get("/receipt-mail", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const me = req.user?.email ?? "";
  try {
    const lanes = await linkedLanesOf(me).catch(() => []);
    res.json({
      settings: await mailSettings(me),
      /** The accounts whose expenses a scan can match against. */
      accounts: lanes.filter((l) => l.kind === "personal").map((l) => ({
        lane: l.key, label: l.label, loginEmail: l.loginEmail,
        connected: l.connection !== null,
      })),
      graphConfigured: isGraphConfigured(),
      graphProblem: isGraphConfigured() ? "" : mailProblem(),
      matches: await matchesFor(null),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read it." });
  }
});

receiptMailRouter.post("/receipt-mail/settings", requireAuth,
  async (req: Request, res: Response) => {
    if (!guard(res)) return;
    const me = owner(req, res);
    if (!me) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json({
        settings: await saveMailSettings(me, {
          mailbox: typeof b.mailbox === "string" ? b.mailbox : undefined,
          folders: Array.isArray(b.folders) ? (b.folders as unknown[]).map(String) : undefined,
          days: b.days === undefined ? undefined : Number(b.days),
          enabled: b.enabled === undefined ? undefined : b.enabled === true,
        }, me),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Could not save it.",
      });
    }
  });

/** The folders in the configured mailbox, so the picker offers real ones. */
receiptMailRouter.get("/receipt-mail/folders", requireAuth,
  async (req: Request, res: Response) => {
    if (!guard(res)) return;
    const me = req.user?.email ?? "";
    try {
      const { mailbox } = await mailSettings(me);
      if (!mailbox) { res.json({ folders: [], mailbox: "" }); return; }
      res.json({ mailbox, folders: await listFolders(mailbox) });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Could not list the folders.",
      });
    }
  });

/**
 * Search the mailbox and score what it finds.
 *
 * Read only, on both sides: it reads the mailbox and it reads the
 * expenses. The only write is the candidate list, which is this
 * app's own record of what it found and what it thought.
 *
 * The expenses it matches against are the ones in the chosen
 * personal account, because ACCOUNT IDENTITY COMES FROM THE
 * EXPENSE — the mailbox holds receipts for both and which one a
 * receipt belongs to is decided by which expense it matches, not
 * by where it was found.
 */
receiptMailRouter.post("/receipt-mail/scan", requireAuth,
  async (req: Request, res: Response) => {
    if (!guard(res)) return;
    const me = owner(req, res);
    if (!me) return;
    const b = (req.body ?? {}) as { lane?: unknown };
    const lane = laneTag(typeof b.lane === "string" ? b.lane : MANAGER_LANE);

    try {
      const settings = await mailSettings(me);
      if (!settings.mailbox) {
        res.status(400).json({
          error: "No mailbox is configured to search. It is set separately from your "
            + "Emburse login — they are often different addresses.",
        });
        return;
      }

      const { rows } = await db().query<{
        dedupe_key: string; lane: string; merchant: string; expense_date: Date | null;
        amount_cents: string;
      }>(
        `SELECT dedupe_key, lane, merchant, expense_date, amount_cents
           FROM expenses
          WHERE in_inbox AND lower(reviewer) = lower($1) AND lane = $2
          ORDER BY expense_date DESC NULLS LAST
          LIMIT 500`,
        [me, lane]);
      const targets: Target[] = rows.map((r) => ({
        dedupeKey: r.dedupe_key,
        lane: r.lane,
        merchant: r.merchant,
        date: r.expense_date ? r.expense_date.toISOString().slice(0, 10) : null,
        amountCents: Number(r.amount_cents),
        currency: "USD",
      }));

      const found = await searchMailbox({
        mailbox: settings.mailbox, folders: settings.folders, days: settings.days,
      });
      const candidates = matchAll(targets, found.messages);
      const written = await recordCandidates(candidates);
      const clash = conflicts(candidates);

      res.json({
        /* What was actually searched, named. "We searched a folder
           that is not there" and "we searched nothing" look
           identical from a result list. */
        mailbox: settings.mailbox,
        searched: found.searched,
        missingFolders: found.missing,
        messages: found.messages.length,
        expenses: targets.length,
        candidates: candidates.length,
        recorded: written,
        needsReview: clash.byMessage.size + clash.byExpense.size,
        matches: await matchesFor(lane),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "The scan could not run.",
      });
    }
  });

/** A person chooses one candidate, or rejects it. Nothing is attached here. */
receiptMailRouter.post("/receipt-mail/decide", requireAuth,
  async (req: Request, res: Response) => {
    if (!guard(res)) return;
    const me = owner(req, res);
    if (!me) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out = await decideMatch({
      dedupeKey: String(b.dedupeKey ?? ""),
      messageId: String(b.messageId ?? ""),
      choose: b.choose !== false,
      by: me,
    });
    if (!out.ok) { res.status(400).json({ error: out.problem }); return; }
    res.json({ matches: await matchesFor(null) });
  });
