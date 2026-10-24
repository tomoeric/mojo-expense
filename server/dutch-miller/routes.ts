import express, {
  Router, type IRouter, type NextFunction, type Request, type Response,
} from "express";
import { parseRfidFile } from "./rfid-parse.js";
import { addRfids, listRfids, rfidCounts, setRfidActive, useRfid } from "./rfid.js";
import {
  DM_PAGES, dmAccessFor, isDmPage, listDmUsers, removeDmUser, saveDmUser,
  type DmPageKey, type DmRole,
} from "./users.js";

/**
 * Dutch Miller — the second app on this deployment.
 *
 * A shell for now, deliberately. The split it sits behind is the part that
 * had to exist first: assignment by email, a server that refuses the other
 * product's routes rather than merely hiding them, and a switcher for the
 * one person who holds both. Configuration and the actual pages follow.
 *
 * Everything under here is mounted behind `requireApp("dutch-miller")`, so
 * a route added to this file is access-controlled by being here. Nothing
 * Dutch Miller needs should be hung off the Emburse routers instead.
 */
export const dutchMillerRouter: IRouter = Router();

/**
 * What the person signing in may see.
 *
 * The shell asks once and builds its rail from the answer, so a page
 * somebody cannot open is never offered. The guards below are what make
 * that true rather than cosmetic.
 */
dutchMillerRouter.get("/me", async (req: Request, res: Response) => {
  const email = req.viewingAs?.real.email ?? req.user?.email ?? "";
  res.json({ ...(await dmAccessFor(email)), email, allPages: DM_PAGES });
});

/** 403 unless this person may open that page. */
function requirePage(page: DmPageKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const email = req.viewingAs?.real.email ?? req.user?.email ?? "";
    const access = await dmAccessFor(email);
    if (access.role === "admin" || access.pages.includes(page)) { next(); return; }
    res.status(403).json({ error: "You do not have access to that page." });
  };
}

/** 403 unless this person administers Dutch Miller. */
async function requireDmAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const email = req.viewingAs?.real.email ?? req.user?.email ?? "";
  if ((await dmAccessFor(email)).role === "admin") { next(); return; }
  res.status(403).json({ error: "Only a Dutch Miller administrator can do that." });
}

dutchMillerRouter.get("/users", requireDmAdmin, async (_req: Request, res: Response) => {
  res.json({ users: await listDmUsers(), allPages: DM_PAGES });
});

dutchMillerRouter.post("/users", requireDmAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: unknown; role?: unknown; pages?: unknown };
  const role: DmRole = body.role === "admin" ? "admin" : "user";
  const pages = Array.isArray(body.pages) ? body.pages.filter(isDmPage) : [];
  try {
    const user = await saveDmUser(
      String(body.email ?? ""), role, pages, req.user?.email ?? "");
    res.json({ user, users: await listDmUsers() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

dutchMillerRouter.delete("/users/:email", requireDmAdmin, async (req: Request, res: Response) => {
  const out = await removeDmUser(String(req.params.email ?? ""));
  if (!out.ok) { res.status(409).json({ error: out.reason }); return; }
  res.json({ users: await listDmUsers() });
});

/** 25 MB. A spreadsheet of a million numbers is about 12. */
const MAX_UPLOAD = 25 * 1024 * 1024;

/**
 * The file arrives as a raw body rather than multipart — one file, no
 * other fields, exactly as the Emburse PDF import does. Multipart would
 * add a dependency and a parser for a form with a single part in it.
 */
dutchMillerRouter.post(
  "/rfid/upload",
  requirePage("rfid-review"),
  express.raw({
    type: [
      "text/csv", "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ],
    limit: MAX_UPLOAD,
  }),
  async (req: Request, res: Response) => {
    const file = req.body as Buffer;
    if (!Buffer.isBuffer(file) || file.length === 0) {
      res.status(400).json({ error: "No file arrived." });
      return;
    }
    try {
      const parsed = parseRfidFile(file);
      const result = await addRfids(
        parsed.numbers, parsed.rejected, parsed.cells, req.user?.email ?? "");
      res.json({ ...result, counts: await rfidCounts() });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

dutchMillerRouter.get("/rfid", requirePage("rfid-review"), async (req: Request, res: Response) => {
  const status = String(req.query.status ?? "all");
  res.json({
    ...(await listRfids({
      status: status === "active" || status === "inactive" || status === "used"
        ? status : "all",
      search: String(req.query.search ?? ""),
      limit: Number(req.query.limit ?? 100),
      offset: Number(req.query.offset ?? 0),
    })),
    counts: await rfidCounts(),
  });
});

/** Issue one. The server decides, once; see `useRfid`. */
dutchMillerRouter.post("/rfid/use", requirePage("rfid-review"), async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { number?: unknown; usedFor?: unknown };
  const out = await useRfid(
    String(body.number ?? ""), req.user?.email ?? "", String(body.usedFor ?? ""));
  if (!out.ok) { res.status(409).json({ error: out.reason }); return; }
  res.json({ row: out.row, counts: await rfidCounts() });
});

/** Hold back, or put back in play. Never a used one. */
dutchMillerRouter.post("/rfid/active", requirePage("rfid-review"), async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { numbers?: unknown; active?: unknown };
  const numbers = Array.isArray(body.numbers) ? body.numbers.map(String) : [];
  const out = await setRfidActive(numbers, body.active !== false);
  res.json({ ...out, counts: await rfidCounts() });
});
