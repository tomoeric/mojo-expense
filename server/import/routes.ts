import { Router, type IRouter, type Request, type Response } from "express";
import express from "express";
import { db, ensureSchema, isDbConfigured } from "../db.js";
import { requireAdmin, requireAuth } from "../auth/index.js";
import { ingestExport } from "./ingest.js";
import { describeSchedule } from "./schedule.js";
import { ALL_SECTIONS, cleanSchedule, readSettings, writeSettings } from "./settings.js";
import { DEFAULT_SELECTORS, SELECTOR_HELP, STEP_SELECTORS, envLogin } from "../emburse/auto-export.js";
import { claimUnclaimed, credentialStatus, deleteCredential, hasCredential, listCredentials, saveCredential,
         scopeFor, unclaimedExpenses } from "../emburse/credentials.js";
import { attemptExport, nextDue, recentRuns, reviewerImports, runScreenshot, setReviewerImport,
         stopRun } from "../emburse/export-scheduler.js";
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

importRouter.get("/imports", requireAuth, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    await ensureSchema();
    // Whose imports. Inside a view this page is about the person being
    // viewed: it showed Brian "45 expenses stored · 44 awaiting review ·
    // $9,649" and a history of files he had never imported, every one of
    // them Eric's, which is a straight answer to "whose data am I looking
    // at" and the wrong one.
    const { reviewer, ownsBlanks } = await scopeFor(req.user?.email ?? "");
    const { rows } = await db().query(
      `SELECT id, filename, imported_at, imported_by, parsed_rows, inserted_count,
              updated_count, unchanged_count, left_inbox_count, receipts_added,
              total_cents, stated_total_cents, reconciled, warnings, export_sections,
              reviewer, source
         FROM expense_imports
        WHERE reviewer = $1 OR (reviewer = '' AND $2)
        ORDER BY imported_at DESC LIMIT 25`,
      [reviewer, ownsBlanks],
    );
    // Receipt storage is shared by content hash across everybody, so it is
    // counted whole rather than pretending to a per-reviewer figure.
    const { rows: stat } = await db().query(
      `SELECT count(*) AS expenses,
              count(*) FILTER (WHERE in_inbox) AS in_inbox,
              coalesce(sum(amount_cents), 0) AS total_cents,
              min(expense_date) AS earliest, max(expense_date) AS latest,
              (SELECT count(*) FROM receipt_blobs) AS receipts,
              (SELECT coalesce(sum(byte_size), 0) FROM receipt_blobs) AS receipt_bytes
         FROM expenses e
        WHERE e.reviewer = $1 OR (e.reviewer = '' AND $2)`,
      [reviewer, ownsBlanks],
    );
    // The newest row is the last export that actually brought new bytes in —
    // a re-uploaded duplicate returns early and never inserts one.
    const lastImport = rows[0]?.imported_at ? new Date(rows[0].imported_at as string) : null;

    res.json({
      imports: rows,
      stats: stat[0] ?? null,
      schedule: describeSchedule((await readSettings()).schedule, lastImport),
      // Whose page this is, and the rows nobody holds. Both exist so the
      // answer to "whose data is this" is on the screen rather than worked
      // out from the numbers — which is how it was got wrong.
      you: req.user?.email ?? null,
      viewingAs: req.viewingAs?.viewed ?? null,
      unclaimed: await unclaimedExpenses().catch(() => null),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read import history." });
  }
});


/**
 * Which Emburse list each reviewer's import reads.
 *
 * It exists because approval here is a CHAIN — one person approves and the
 * expense then goes to the next — so the reviewers have different queues at
 * any given moment, and one URL cannot describe both. The export asked
 * everybody for the team-wide review list, which is every stage at once, so
 * two accounts exported the identical 320 expenses and the app spent a day
 * looking like it was leaking one person's data to the other.
 *
 * Readable by any admin; the path and section are what to change when a
 * reviewer's export comes back with somebody else's rows in it.
 */
importRouter.get("/reviewer-imports", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  if (!guard(res)) return;
  try {
    res.json({ reviewers: await reviewerImports() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read them." });
  }
});

importRouter.post("/reviewer-imports", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const body = req.body as {
    email?: unknown; enabled?: unknown; gridPath?: unknown; gridSection?: unknown;
    autoApprove?: unknown; autoApprovePerRun?: unknown; schedule?: unknown;
  };
  const email = String(body.email ?? "").trim();
  if (!email) {
    res.status(400).json({ error: "Name the reviewer." });
    return;
  }
  // Only what was sent. Three screens write to this one row — the schedule,
  // the import list and the approval switch — and a save that wrote every
  // column would have each of them quietly undoing the others.
  const sent = <T,>(key: string, read: () => T): { [k: string]: T } =>
    key in (body as object) ? { [key]: read() } : {};
  const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback;
  try {
    const sc = body.schedule as Record<string, unknown> | null | undefined;
    await setReviewerImport(email, {
      ...sent("enabled", () => body.enabled !== false),
      ...sent("schedule", () => sc === null ? null : {
        timezone: typeof sc?.timezone === "string" ? sc.timezone.slice(0, 64) : undefined,
        firstRun: typeof sc?.firstRun === "string" ? sc.firstRun.slice(0, 8) : undefined,
        retryHours: num(sc?.retryHours, 1, 24, 4),
        attemptsPerDay: num(sc?.attemptsPerDay, 1, 48, 4),
        graceMinutes: num(sc?.graceMinutes, 0, 600, 90),
        allDay: sc?.allDay === true,
      }),
      // Deliberately NOT validated against a list of known paths. Emburse's
      // own URLs are the only source of truth for what its lists are called,
      // they differ per tenant, and a guard built from guesses would refuse
      // the correct answer the first time somebody found it.
      ...sent("gridPath", () =>
        typeof body.gridPath === "string" ? body.gridPath.slice(0, 200) : null),
      ...sent("gridSection", () =>
        typeof body.gridSection === "string" ? body.gridSection.slice(0, 80) : null),
      // The one setting here that approves money. Explicitly true or it is
      // off: a missing field must never read as "switch it on".
      ...sent("autoApprove", () => body.autoApprove === true),
      ...sent("autoApprovePerRun", () => typeof body.autoApprovePerRun === "number"
        ? Math.max(1, Math.min(100, Math.round(body.autoApprovePerRun))) : null),
      // The REAL admin, never the viewed person. This is reachable from
      // inside a view, and a setting changed by Eric while looking at
      // Brian's screen was changed by Eric.
    }, req.viewingAs?.real.email ?? req.user?.email ?? "unknown");
    res.json({ reviewers: await reviewerImports() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not save." });
  }
});

/**
 * Settle who owns the expenses nobody claimed.
 *
 * Admin-only and refused inside a view, like every other write: it decides
 * whose queue a batch of real expenses is, and an admin looking through
 * somebody else's eyes is not that person.
 */
importRouter.post("/imports/claim", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  const { email, scope } = req.body as { email?: unknown; scope?: unknown };
  const how = scope === "all" ? "all" : scope === "reset" ? "reset" : "unclaimed";
  try {
    const n = await claimUnclaimed(String(email ?? ""), how);
    console.log(`imports: ${n} ${how} expense(s) claimed for ${String(email)}`);
    res.json({ claimed: n });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not claim them." });
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

  const body = req.body as { sections?: unknown; receiptsOnly?: unknown; schedule?: unknown; selectors?: unknown; emburseUrl?: unknown; sources?: unknown };
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
      (body.sources as never) ?? current.sources,
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

  /**
   * Whose Needs Review to read, and who asked.
   *
   * An admin looking at the app as Brian needs to be able to pull Brian's
   * import — otherwise his queue is whatever it was when he last signed in,
   * and the view they came to check is stale by exactly the thing they came
   * to check.
   *
   * This is the one action allowed from inside the view, and it is allowed
   * because of what it IS: an import reads Emburse and writes our own
   * tables. Nothing is approved, denied or edited, and nothing in Emburse
   * carries anybody's name as a decision. The run is recorded as asked for
   * by the REAL admin and read as the viewed person, so the log says both.
   *
   * Judged on the real user, like every other control: an admin who lost
   * their rights cannot keep them by staying inside a view.
   */
  const real = req.viewingAs?.real.email ?? req.user?.email ?? "manual";

  /*
   * A manual run is the caller's OWN queue, not "whoever worked last".
   *
   * This said `req.viewingAs ? viewed : ""`, and the empty string means the
   * shared import, which picks a login by `credentialForExport()` — whose
   * fallback is still "the credential most recently proven to work". So on
   * a Tuesday when Brian's export had succeeded most recently, Eric pressed
   * Run export now on his own settings page, not viewing as anybody, and
   * the run signed in as brian.c@mojocarwash.com and imported Brian's
   * Needs Review. Nothing on the page said it would.
   *
   * The same rule as everywhere else now: a run reads the queue of the
   * person who asked for it. Only somebody with no stored login of their
   * own falls back to the shared import, which is the single-login
   * deployment and the env fallback, both of which have one queue anyway.
   */
  const asker = req.user?.email ?? "";
  const reviewer = req.viewingAs
    ? req.viewingAs.viewed
    : (asker && await hasCredential(asker).catch(() => false)) ? asker : "";
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
      void attemptExport(
        dryRun ? "dry-run" : "manual",
        reviewer ? `${real} (for ${reviewer})` : real,
        { dryRun, onStarted: resolve, ...(reviewer ? { reviewer } : {}) },
      ).catch(reject); // only reaches here if it failed before recording itself
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
    // Inside a view, this page is about the person being viewed: their runs
    // and their timeline, not a mixture. Outside one it is the admin's
    // overview of every reviewer, and each row says whose queue it read.
    //
    // Outside a view it is the signed-in person's own, not everybody's.
    // "Import queues need to be separated" — and a history that mixes two
    // reviewers' runs is where this went wrong twice: a 320-item success
    // sitting above your own run, and no way to tell whose it was.
    const viewed = req.viewingAs?.viewed;
    const mine = viewed
      ?? ((req.user?.email && await hasCredential(req.user.email).catch(() => false))
            ? req.user.email : undefined);
    res.json({
      configured: (await listCredentials()).length > 0 || envLogin() !== null,
      due: await nextDue(schedule, new Date(), mine ?? ""),
      runs: await recentRuns(20, mine),
      // Who this page is about, so it can say so rather than leaving somebody
      // to work it out from the rows.
      viewingAs: viewed ?? null,
      // Whose runs and whose timeline these are, so the page can say it.
      runsFor: mine ?? null,
      // Carried on the list rather than its own endpoint: this is already the
      // thing the page polls while a run is going, and a challenge is only
      // ever raised during one.
      // `mine` rather than making the page compare emails: only the owner can
      // answer, and the page should say who is being waited on either way.
      challenge: challenge && { ...challenge, mine: challenge.owner === (req.user?.email ?? "") },
      // When the browser last kept a session. The only visible sign that a
      // device is still trusted, and the thing to look at when a code gets
      // asked for that should not have been.
      // Their device, not whoever signed in last. One shared jar was both
      // a wrong readout and a way for one person's run to pick up another's
      // session, which is why there is one per account now.
      deviceRememberedAt: await cookiesSavedAt(
        await ownLoginEmail(req.user?.email ?? "")),
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
importRouter.delete("/export-device", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!guard(res)) return;
  // Everybody's. This is the "the browser has gone strange" button, and a
  // stale jar for one account is rarely the only stale one; the cost is one
  // verification code each, which is the point of pressing it.
  await forgetCookies();
  console.log(`export: remembered devices cleared by ${req.user?.email ?? "unknown"}`);
  res.json({ ok: true });
});

/**
 * The Emburse login email behind an app user, for keying their cookie jar.
 *
 * The jar belongs to the Emburse account that signed in, which is not the
 * app address when somebody signs into Emburse under a different one — as
 * here, where mojocarwash.com users hold mammothholdings.com logins.
 */
async function ownLoginEmail(appUser: string): Promise<string> {
  if (!appUser) return "";
  const found = (await listCredentials().catch(() => []))
    .find((c) => c.userEmail.toLowerCase() === appUser.trim().toLowerCase());
  return found?.loginEmail ?? "";
}

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

/**
 * Call off a run that is still going.
 *
 * Checked between steps and inside the long wait for Emburse to build the
 * file, so it takes effect in seconds rather than at the next restart. Without
 * it the only way out of a run gone wrong was to restart the server — and a
 * run holds the browser profile, so nothing else could start meanwhile.
 */
importRouter.post("/export-runs/:id/stop", requireAuth, requireAdmin, (req: Request, res: Response) => {
  if (!guard(res)) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Not a run id." });
    return;
  }
  stopRun(id);
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
