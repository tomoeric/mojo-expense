import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth/index.js";
import { db, isDbConfigured } from "../db.js";
import { isGraphConfigured, mailProblem } from "../mail.js";
import { MANAGER_LANE, laneTag, linkedLanesOf } from "./connections.js";
import {
  decideMatch, listFolders, mailSettings, matchAll, matchesFor, noteLink,
  recordCandidates, saveMailSettings, searchMailbox, conflicts,
  type Target,
} from "./receipt-mail.js";
import { proposeWrites, queueWrite, receiptBytes, writesFor } from "./receipt-writeback.js";
import { bytesFromMessage, linkReceipt, readingOf } from "./receipt-link.js";

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

/**
 * Recompute the proposals that nobody has approved yet.
 *
 * The reader runs on its own clock, so a receipt chosen a minute
 * ago has no reading and its proposed description came from the
 * email. Once the reading lands, the description it would write
 * is better — and a person about to approve one should be
 * looking at the better version.
 *
 * ONLY rows still in `proposed`. Anything a person has already
 * said yes to is left exactly as they saw it: changing the text
 * under an approval, however much better the new text is, means
 * what gets written is not what was agreed to.
 */
async function refreshedProposals(me: string) {
  const open = (await writesFor()).filter((w) => w.state === "proposed" && w.kind === "note");
  for (const w of open.slice(0, 25)) {
    await proposeWrites({ dedupeKey: w.dedupeKey, messageId: w.messageId, by: me })
      .catch(() => undefined);
  }
  return writesFor();
}

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
      /* Every proposal and its state, so the page can show what
         is waiting on a click and what has already landed. */
      writes: await refreshedProposals(me),
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
    const asked = typeof b.lane === "string" ? b.lane : MANAGER_LANE;
    /*
     * ONE MAILBOX FEEDS BOTH PERSONAL ACCOUNTS, so one scan can serve
     * both. A receipt belongs to an account because it matches an
     * expense in it, never because of where it arrived — so scanning
     * per account meant reading the same mailbox twice and deciding in
     * advance which half of the answer to look at.
     *
     * "all" is the personal accounts only. The manager queue is other
     * people's expenses and write-back refuses it outright, so pulling
     * it into a receipt scan would only offer matches nothing can act
     * on.
     */
    const everyPersonal = asked === "all";
    const lanes = everyPersonal
      ? (await linkedLanesOf(me).catch(() => []))
        .filter((l) => l.kind === "personal").map((l) => laneTag(l.key))
      : [laneTag(asked)];
    if (lanes.length === 0) {
      res.status(400).json({
        error: "No personal Emburse account is linked, so there is nothing to match "
          + "receipts against.",
      });
      return;
    }
    const lane = lanes[0]!;

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
          WHERE in_inbox AND lower(reviewer) = lower($1) AND lane = ANY($2::text[])
          ORDER BY expense_date DESC NULLS LAST
          LIMIT 500`,
        [me, lanes]);
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
        // Every lane that was scanned, not just the first. `matchesFor`
        // takes null for "all", which is right here because the targets
        // above were already limited to the personal accounts.
        matches: await matchesFor(everyPersonal ? null : lane),
        lanes,
      });
    } catch (err) {
      res.status(400).json({
        error: explainGraph(err, (await mailSettings(me).catch(() => null))?.mailbox ?? "", me),
      });
    }
  });

/**
 * A Graph refusal, with the reason this deployment actually hits.
 *
 * The token is app-only and belongs to ONE tenant, so a mailbox in
 * another domain is not a permissions problem that can be granted — it
 * cannot be read with these credentials at all. The generic 403 text
 * offers two causes and not that one, so somebody reading it goes to
 * check a consent that is already fine. Said only when the domains
 * actually differ, because a same-domain 403 really is consent or an
 * application access policy.
 */
function explainGraph(err: unknown, mailbox: string, me: string): string {
  const text = err instanceof Error ? err.message : "The scan could not run.";
  if (!/\b40[34]\b/.test(text) || !mailbox) return text;
  const at = (s: string) => s.split("@")[1]?.toLowerCase() ?? "";
  /*
   * The domain note goes FIRST, not appended after a wall of Graph JSON.
   *
   * It was last, and it was read last — past the sentence about consent,
   * which is the cause this check makes less likely. A second domain CAN
   * sit on one tenant (Mammoth Holdings and MOJO plausibly do), so it is
   * phrased as the thing to rule out rather than as the answer.
   */
  if (at(mailbox) && at(me) && at(mailbox) !== at(me)) {
    return `${mailbox} is on ${at(mailbox)} and you sign in as ${me} on ${at(me)}. `
      + `Rule that out first: the app reads mail with credentials belonging to ONE `
      + `Microsoft tenant, so a mailbox in another tenant cannot be read whatever is `
      + `consented. Two domains CAN share one tenant, in which case this is fine and `
      + `the reason is below. If the receipts you want are in your ${at(me)} mailbox, `
      + `put that address here instead.\n\n${text}`;
  }
  return text;
}

/**
 * THE RECEIPT ITSELF, so a match can be looked at before it is believed.
 *
 * A candidate card said merchant, total and date and showed none of the
 * thing it was talking about. "The total matches exactly" is a good
 * reason and it is not the same as seeing the receipt, and on 272 of
 * them nobody should be asked to take the app's word for it.
 *
 * These are the SAME BYTES the upload would send — `receiptBytes`, the
 * one the write-back uses — so the preview is not a representation of
 * the file, it is the file. A body-only receipt is rendered the same way
 * too, with all network aborted so a tracking pixel cannot report the
 * message opened.
 *
 * Fetched per press rather than with the list: 272 previews at once is
 * 272 Graph calls and, for the body-only ones, 272 browsers.
 *
 * Scoped to messages THIS PERSON'S OWN SCAN RECORDED. The id comes from
 * the page, and without that check it would be a route for reading any
 * message in any mailbox the app can reach, by id.
 */
receiptMailRouter.get("/receipt-mail/preview", requireAuth,
  async (req: Request, res: Response) => {
    if (!guard(res)) return;
    const me = owner(req, res);
    if (!me) return;
    const messageId = String((req.query as { message?: string }).message ?? "").trim();
    if (!messageId) {
      res.status(400).json({ error: "Name the message to show." });
      return;
    }
    try {
      const { rows } = await db().query<{ evidence: unknown }>(
        `SELECT m.evidence
           FROM receipt_mail_matches m
           JOIN expenses e ON e.dedupe_key = m.dedupe_key
          WHERE m.message_id = $1 AND lower(e.reviewer) = lower($2)
          LIMIT 1`,
        [messageId, me]);
      if (rows.length === 0) {
        res.status(404).json({
          error: "That message is not one of your matches, so there is nothing to show.",
        });
        return;
      }
      const ev = (rows[0]!.evidence ?? {}) as {
        subject?: string;
        attachments?: { id: string; name: string; contentType: string }[];
      };
      // The same rule the proposal uses to pick what to attach, so the
      // preview cannot be of a different file from the one that goes.
      const file = (ev.attachments ?? []).find(
        (a) => /pdf|image\//i.test(a.contentType)
          || /\.(pdf|png|jpe?g|gif|webp)$/i.test(a.name));
      const settings = await mailSettings(me);
      if (!settings.mailbox) {
        res.status(400).json({ error: "No mailbox is configured." });
        return;
      }
      const got = await receiptBytes({
        mailbox: settings.mailbox,
        messageId,
        attachmentId: file?.id ?? "",
        subject: ev.subject ?? "receipt",
      });
      res.setHeader("content-type", got.contentType);
      // Inline, and named, so a browser shows it rather than saving it.
      res.setHeader("content-disposition",
        `inline; filename="${got.name.replace(/[^\w.\- ]+/g, "_")}"`);
      // A receipt is somebody's own spending. Private, and short, because
      // the message can be deleted or moved out from under this.
      res.setHeader("cache-control", "private, max-age=300");
      res.send(got.bytes);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "That receipt could not be fetched.",
      });
    }
  });

/* ------------------------------------------------------------------ *
 * Sending it back
 * ------------------------------------------------------------------ */

/**
 * What would be written, before anything is.
 *
 * Current value, proposed value, and the evidence it came from —
 * which is the whole of the owner's "always ask". Proposing
 * writes nothing to Emburse and queues nothing; it records what
 * a person is being asked about.
 */
receiptMailRouter.post("/receipt-mail/propose", requireAuth,
  async (req: Request, res: Response) => {
    if (!guard(res)) return;
    const me = owner(req, res);
    if (!me) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out = await proposeWrites({
      dedupeKey: String(b.dedupeKey ?? ""),
      messageId: String(b.messageId ?? ""),
      by: me,
    });
    if (!out.ok) { res.status(400).json({ error: out.problem }); return; }
    res.json({ writes: out.writes });
  });

/**
 * A person says yes to one change.
 *
 * The only way a write becomes eligible to run. Nothing is
 * scheduled, nothing is queued by a rule, and a strong match does
 * not queue itself — the owner's instruction is that even a
 * strong match waits for a click, and this route is that click.
 *
 * It does not submit, approve or deny, and there is no parameter
 * that would make it.
 */
receiptMailRouter.post("/receipt-mail/send", requireAuth,
  async (req: Request, res: Response) => {
    if (!guard(res)) return;
    const me = owner(req, res);
    if (!me) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = b.kind === "note" ? "note" : "receipt";
    const out = await queueWrite(String(b.dedupeKey ?? ""), kind);
    if (!out.ok) { res.status(400).json({ error: out.problem }); return; }
    res.json({ writes: await writesFor(String(b.dedupeKey ?? "")) });
  });

/** A person chooses one candidate, or rejects it. Nothing is attached here. */
receiptMailRouter.post("/receipt-mail/decide", requireAuth,
  async (req: Request, res: Response) => {
    if (!guard(res)) return;
    const me = owner(req, res);
    if (!me) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const dedupeKey = String(b.dedupeKey ?? "");
    const messageId = String(b.messageId ?? "");
    const choose = b.choose !== false;
    const out = await decideMatch({ dedupeKey, messageId, choose, by: me });
    if (!out.ok) { res.status(400).json({ error: out.problem }); return; }

    /*
     * CHOOSING PULLS THE RECEIPT IN.
     *
     * Before anything goes to Emburse, and that order is the
     * point: a linked receipt is read by the reader that already
     * exists, and that reading — merchant, date, total, line
     * items — is what the field fill is made of. Uploading
     * straight to Emburse would attach a picture and learn
     * nothing from it.
     *
     * A failure here does not undo the choice. The match is
     * still the right one; the pull can be retried, and the
     * reason is recorded on the row rather than thrown away.
     */
    let linked: string | null = null;
    let linkError = "";
    if (choose) {
      try {
        const chosen = (await matchesFor(null, "chosen"))
          .find((m) => m.dedupeKey === dedupeKey && m.messageId === messageId);
        const box = await mailSettings(me);
        if (!chosen) throw new Error("That match is no longer here.");
        if (!box.mailbox) throw new Error("No mailbox is configured to fetch it from.");
        const file = await bytesFromMessage({
          mailbox: box.mailbox,
          messageId,
          attachmentId: chosen.evidence.attachments.find(
            (a) => /pdf|image\//i.test(a.contentType))?.id ?? "",
          subject: chosen.evidence.subject,
        });
        const got = await linkReceipt({
          dedupeKey, bytes: file.bytes, contentType: file.contentType,
        });
        linked = got.sha256;
      } catch (err) {
        linkError = err instanceof Error ? err.message : String(err);
      }
      await noteLink(dedupeKey, messageId, linked, linkError).catch(() => undefined);
      // Only propose once the image is in: the proposal is about
      // what to send, and there is nothing to send until there is.
      if (linked) {
        await proposeWrites({ dedupeKey, messageId, by: me }).catch(() => undefined);
      }
    }

    res.json({
      matches: await matchesFor(null),
      writes: await writesFor(),
      linked,
      linkError,
      reading: linked ? await readingOf(linked) : null,
    });
  });
