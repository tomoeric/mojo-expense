import { Router, type IRouter, type Request, type Response } from "express";
import express from "express";
import { db, ensureSchema, isDbConfigured } from "../db.js";
import { requireAdmin, requireAuth } from "../auth/index.js";
import { ingestExport } from "./ingest.js";
import { syncFromSharePoint, syncOnPageLoad } from "./sync.js";
import { isSharePointConfigured } from "./sharepoint.js";
import { describeSchedule } from "./schedule.js";
import { ALL_SECTIONS, cleanSchedule, readSettings, writeSettings } from "./settings.js";

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
    res.json({ ...(await readSettings()), allSections: ALL_SECTIONS });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not read settings." });
  }
});

importRouter.put("/export-settings", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  if (!guard(res)) return;

  const body = req.body as { sections?: unknown; receiptsOnly?: unknown; schedule?: unknown };
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
      req.user?.email ?? "unknown",
    );
    res.json({ ...saved, allSections: ALL_SECTIONS });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Could not save settings." });
  }
});
