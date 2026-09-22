import { Router, type IRouter, type Request, type Response } from "express";
import express from "express";
import { db, ensureSchema, isDbConfigured } from "../db.js";
import { requireAdmin, requireAuth } from "../auth/index.js";
import { ingestExport } from "./ingest.js";
import { syncFromSharePoint, syncOnPageLoad } from "./sync.js";
import { isSharePointConfigured } from "./sharepoint.js";
import { describeSchedule } from "./schedule.js";
import { ALL_SECTIONS, cleanSchedule, readSettings, writeSettings } from "./settings.js";
import { DEFAULT_SELECTORS, SELECTOR_HELP, STEP_SELECTORS, envLogin } from "../emburse/auto-export.js";
import { credentialStatus, deleteCredential, listCredentials, saveCredential } from "../emburse/credentials.js";
import { attemptExport, nextDue, recentRuns, runScreenshot } from "../emburse/export-scheduler.js";
import { answerChallenge, cancelChallenge, currentChallenge } from "../emburse/challenge.js";
import { cookiesSavedAt, forgetCookies } from "../emburse/browser-state.js";

/**
 * Upload and history for the daily Emburse export.
 *
 * The file arrives as a raw PDF body rather than multipart: there is exactly
 * one file and no other fields, so multipart would add a dependency and a
 * parsing step for nothing.
 */

// The sample export is 11 MB; allow generous headroom without inviting abuse.
const MAX_UPLOAD = "64mb";

export const importRouter: IRouter = Router();

function guard(res: Response): boolean {
  if (isDbConfigured()) return true;
  res.status(503).json({
    error: "No database is configured. Set DATABASE_URL to a Neon connection string and restart.",
  });
  return false;
}

importRouter.post(
  "/import",
  requireAuth,
  express.raw({ type: ["application/pdf", "application/octet-stream"], limit: MAX_UPLOAD }),
  async (req: Request, res: Response) => {
    if (!guard(res)) return;

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Send the PDF as the request body with Content-Type: application/pdf." });
      return;
    }
    if (body.subarray(0, 4).toString("latin1") !== "%PDF") {
      res.status(400).json({ error: "That does not look like a PDF." });
      return;
    }

    const filename = String(req.query.filename ?? "export.pdf").slice(0, 200);
    try {
      await ensureSchema();
      const result = await ingestExport(body, filename, req.user?.email ?? "unknown", {
        force: req.query.force === "1",
      });
      res.json(result);
    } catch (err) {
      console.error("import failed:", err);
      res.status(422).json({ error: err instanceof Error ? err.message : "Import failed." });
    }
  },
);

importRouter.post("/import/sync", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    res.json(await syncFromSharePoint(req.user?.email ?? "manual"));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Sync failed." });
  }
});

importRouter.get("/imports", requireAuth, async (_req: Request, res: Response) => {
  if (!guard(res)) return;
  // Fire-and-forget: the page renders against what is already stored, and a
  // freshly-arrived export shows up on the next load rather than blocking this
  // one behind a download.
  syncOnPageLoad();
  try {
    await ensureSchema();
    const { rows } = await db().query(
      `SELECT id, filename, imported_at, imported_by, parsed_rows, inserted_count,
              updated_count, unchanged_count, left_inbox_count, receipts_added,
              total_cents, stated_total_cents, reconciled, warnings, export_sections
         FROM expense_imports ORDER BY imported_at DESC LIMIT 25`,
    );
    const { rows: stat } = await db().query(
      `SELECT count(*) AS expenses,
              count(*) FILTER (WHERE in_inbox) AS in_inbox,
              coalesce(sum(amount_cents), 0) AS total_cents,
              min(expense_date) AS earliest, max(expense_date) AS latest,
              (SELECT count(*) FROM receipt_blobs) AS receipts,
              (SELECT coalesce(sum(byte_size), 0) FROM receipt_blobs) AS receipt_bytes
         FROM expenses`,
    );
    // The watched-folder history is only meaningful once sync is set up.
    let sources: unknown[] = [];
    if (isSharePointConfigured()) {
      const seen = await db()
        .query(`SELECT filename, status, imported_at, error FROM import_sources ORDER BY imported_at DESC LIMIT 10`)
        .catch(() => ({ rows: [] }));
      sources = seen.rows;
    }
    // The newest row is the last export that actually brought new bytes in —
    // a re-uploaded duplicate returns early and never inserts one.
    const lastImport = rows[0]?.imported_at ? new Date(rows[0].imported_at as string) : null;

    res.json({
      imports: rows,
      stats: stat[0] ?? null,
      sharepoint: isSharePointConfigured(),
      sources,
      schedule: describeSchedule((await readSettings()).schedule, lastImport),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read import history." });
  }
});


/**
 * What the export is supposed to contain.
 *
 * Readable by anyone signed in — the Import page shows it as context for the
 * warnings — but only an admin may change it, since it governs how every future
 * import is judged.
 */
importRouter.get("/export-settings", requireAuth, async (_req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    res.json({
      ...(await readSettings()),
      allSections: ALL_SECTIONS,
      // So the UI can show which selectors a failed step used, and what
      // each one is for, without keeping its own copy to drift.
      selectorHelp: SELECTOR_HELP,
      stepSelectors: STEP_SELECTORS,
      defaultSelectors: DEFAULT_SELECTORS,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read settings." });
  }
});

importRouter.put("/export-settings", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!guard(res)) return;

  const body = req.body as { sections?: unknown; receiptsOnly?: unknown; schedule?: unknown; selectors?: unknown; emburseUrl?: unknown };
  const sections = Array.isArray(body.sections) ? body.sections.filter((s): s is string => typeof s === "string") : null;
  if (!sections) {
    res.status(400).json({ error: "sections must be an array of section names." });
    return;
  }
  const unknown = sections.filter((s) => !(ALL_SECTIONS as readonly string[]).includes(s));
  if (unknown.length) {
    res.status(400).json({ error: `Not an Emburse section: ${unknown.join(", ")}.` });
    return;
  }
  if (sections.length === 0) {
    res.status(400).json({ error: "Choose at least one section, or every import will be flagged." });
    return;
  }

  try {
    const current = await readSettings();
    const saved = await writeSettings(
      sections,
      body.receiptsOnly !== false,
      cleanSchedule(body.schedule as never, current.schedule),
      cleanSelectors(body.selectors, current.selectors),
      (body.emburseUrl as string) ?? current.emburseUrl,
      req.user?.email ?? "unknown",
    );
    res.json({ ...saved, allSections: ALL_SECTIONS, selectorHelp: SELECTOR_HELP,
      stepSelectors: STEP_SELECTORS, defaultSelectors: DEFAULT_SELECTORS });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not save settings." });
  }
});


/**
 * Drive Emburse and fetch today's export.
 *
 * `dryRun` stops at the point of clicking Export, which is the setting to use
 * while correcting selectors: it exercises sign-in, navigation, the filter and
 * the whole dialog without asking Emburse to produce a file or sending anybody
 * an email. Only a real run imports.
 *
 * The response is the step list either way. A failed run is not an error to be
 * swallowed — it is the diagnostic, naming the step that broke and carrying a
 * screenshot of the page it broke on.
 */
importRouter.post("/export-run", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const dryRun = req.query.dryRun === "1";
  try {
    // Start it, do not wait for it. A run takes minutes — longer still when it
    // stops to ask somebody for a verification code — and the proxy in front
    // of the app gives up well before that, answering the page with
    // `upstream request timeout` as plain text. The run carried on regardless,
    // invisibly, while the page showed a JSON parse error and the code prompt
    // it was supposed to be watching for never got polled.
    //
    // So this returns as soon as the run has an id, and the page follows it
    // through the run list it already polls.
    const id = await new Promise<number>((resolve, reject) => {
      void attemptExport(dryRun ? "dry-run" : "manual", req.user?.email ?? "manual", {
        dryRun,
        onStarted: resolve,
      }).catch(reject); // only reaches here if it failed before recording itself
    });
    res.status(202).json({ id, running: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Export run failed." });
  }
});

/**
 * Keep only known selector keys, as non-empty strings.
 *
 * These are fed straight to Playwright, so an unbounded object from the client
 * would be both a way to grow the stored blob without limit and a way to smuggle
 * keys a later build might start trusting.
 */
function cleanSelectors(raw: unknown, current: Record<string, string>): Record<string, string> {
  if (!raw || typeof raw !== "object") return current;
  const out = { ...current };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k in DEFAULT_SELECTORS && typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 500);
  }
  return out;
}


/** The last few export attempts, why one is or is not due, and any parked sign-in. */
importRouter.get("/export-runs", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    const { schedule } = await readSettings();
    const challenge = currentChallenge();
    res.json({
      configured: (await listCredentials()).length > 0 || envLogin() !== null,
      due: await nextDue(schedule),
      runs: await recentRuns(20),
      // Carried on the list rather than its own endpoint: this is already the
      // thing the page polls while a run is going, and a challenge is only
      // ever raised during one.
      // `mine` rather than making the page compare emails: only the owner can
      // answer, and the page should say who is being waited on either way.
      challenge: challenge && { ...challenge, mine: challenge.owner === (req.user?.email ?? "") },
      // When the browser last kept a session. The only visible sign that a
      // device is still trusted, and the thing to look at when a code gets
      // asked for that should not have been.
      deviceRememberedAt: await cookiesSavedAt(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read export runs." });
  }
});

/**
 * Hand Emburse the verification code it is waiting for.
 *
 * The run that raised this is parked inside sign-in with a live browser open,
 * so this call does not start anything — it unblocks something. The answer is
 * checked against the caller's own session identity inside `answerChallenge`:
 * a parked challenge is a half-open session to a finance system, and being an
 * administrator is not the same as being the person who started it.
 */
importRouter.post("/export-challenge", requireAuth, requireAdmin, (req: Request, res: Response) => {
  if (!guard(res)) return;
  const { code } = req.body as { code?: unknown };
  const result = answerChallenge(code, req.user?.email ?? "");
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  // The run itself carries on in the request that started it; the page finds
  // out how it went by polling the run list, as it already does.
  res.json({ ok: true });
});

/**
 * Forget the remembered device.
 *
 * The escape hatch for a cookie jar that has gone stale — an Emburse session
 * that is somehow half-valid can be worse than none, because it gets the run
 * past sign-in and then fails somewhere stranger. Clearing it costs one
 * verification code.
 */
importRouter.delete("/export-device", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  if (!guard(res)) return;
  await forgetCookies();
  res.json({ ok: true });
});

/** Give up on a parked sign-in rather than waiting out its timeout. */
importRouter.delete("/export-challenge", requireAuth, requireAdmin, (req: Request, res: Response) => {
  if (!guard(res)) return;
  const result = cancelChallenge("Cancelled from the app.", req.user?.email ?? "");
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

/** The page a failed run died on. Served as an image so it can be looked at. */
importRouter.get("/export-runs/:id/screenshot", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const shot = await runScreenshot(Number(req.params.id));
  if (!shot) {
    res.status(404).json({ error: "No screenshot for that run." });
    return;
  }
  res.setHeader("content-type", "image/png");
  res.setHeader("cache-control", "private, max-age=3600");
  res.send(shot);
});


/**
 * Your own Emburse login.
 *
 * Deliberately keyed on the caller's own user id rather than anything in the
 * request: there is no path here that reads or writes somebody else's, so no
 * ownership check to get wrong and no id for an administrator to substitute.
 * The password is never returned — not to an admin, and not to its owner.
 */
importRouter.get("/my-emburse-login", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const id = req.user?.id;
  if (!id) {
    res.json({ credential: null, signedIn: false });
    return;
  }
  try {
    res.json({ credential: await credentialStatus(id), signedIn: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read your login." });
  }
});

importRouter.put("/my-emburse-login", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "Sign in first." });
    return;
  }

  const body = req.body as { loginEmail?: unknown; password?: unknown };
  const loginEmail = typeof body.loginEmail === "string" ? body.loginEmail.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!loginEmail || !password) {
    res.status(400).json({ error: "Both the Emburse email and the password are required." });
    return;
  }

  try {
    await saveCredential(user.id, user.email, loginEmail, password);
    res.json({ credential: await credentialStatus(user.id) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not save your login." });
  }
});

importRouter.delete("/my-emburse-login", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const id = req.user?.id;
  if (!id) {
    res.status(401).json({ error: "Sign in first." });
    return;
  }
  res.json({ removed: await deleteCredential(id) });
});

/**
 * Who has stored a login, for an administrator setting the export up.
 *
 * Whose and whether, never what: knowing a working credential exists is what
 * an admin needs in order to know the export can run. Its contents are not
 * part of that, and this route has no way to reach them.
 */
importRouter.get("/emburse-logins", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    res.json({ credentials: await listCredentials(), envFallback: envLogin() !== null });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not list logins." });
  }
});
