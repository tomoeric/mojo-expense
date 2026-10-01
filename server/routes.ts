import { Router } from "express";
import { allFlags, flagOwner, getLimit, setFlag, setLimit, FLAGS, type FlagKey } from "./flags.js";
import { aiSpend } from "./ai/usage.js";
import {
  DEFAULT_PER_RUN, MOST_PER_RUN, autoApproveReport, autoQueueApprovals,
} from "./rules/auto-approve.js";
import { env, isAuditConfigured, isEmburseConfigured } from "./env.js";
import { TtlCache } from "./cache.js";
import { HttpError } from "./http.js";
import { resolveProvider } from "./emburse/provider.js";
import { isAuthConfigured, requireAdmin, requireAuth } from "./auth/index.js";
import type { ExpenseReport, ProviderResult } from "./emburse/types.js";
import { fetchReceipt, ReceiptError } from "./emburse/receipts.js";
import { scopeFor } from "./emburse/credentials.js";
import { db, isDbConfigured } from "./db.js";
import { checkAi } from "./ai.js";
import { isKind, listTaxonomy, taxonomyCounts } from "./import/taxonomy.js";
import type { ExpenseLine } from "./emburse/types.js";

const cache = new TtlCache<ProviderResult & { demo: boolean }>(env.emburse.cacheTtlSec * 1000);

const DAY_MS = 86_400_000;
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Clamp a caller-supplied window to something sane; default the last 90 days. */
function readWindow(q: Record<string, unknown>): { startDate: string; endDate: string } {
  const parse = (v: unknown): Date | null => {
    if (typeof v !== "string" || !v) return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t);
  };
  const end = parse(q.endDate) ?? new Date();
  const start = parse(q.startDate) ?? new Date(end.getTime() - 90 * DAY_MS);
  // Cap the span so a bad query cannot walk the whole pager.
  const capped = start.getTime() < end.getTime() - 730 * DAY_MS ? new Date(end.getTime() - 730 * DAY_MS) : start;
  return { startDate: iso(capped), endDate: iso(end) };
}

/**
 * `reviewer` is part of the cache key, not only of the query.
 *
 * Emburse's Needs Review is per account, so two people asking for the same
 * date window are asking two different questions. Keyed on the window alone,
 * whoever asked first would serve their queue to everybody for the life of
 * the entry — which is the same bug as showing everybody everything, only
 * intermittent and far harder to see.
 */
async function load(
  window: { startDate: string; endDate: string },
  force: boolean,
  reviewer: string,
) {
  if (force) cache.clear();
  // Rows no import has claimed belong to whoever the shared import runs
  // as — not to everybody, which was the first attempt and showed Brian all
  // 26 of Eric's the moment he signed in. Every row imported before the
  // reviewer column existed is blank, so "blank is everyone's" was the old
  // behaviour wearing a new name. One definition, in `scopeFor`, shared with
  // every other read that has to decide whose data something is.
  const { reviewer: who, ownsBlanks } = await scopeFor(reviewer);
  return cache.get(`${who}:${ownsBlanks}:${window.startDate}:${window.endDate}`, async () => {
    // The signed-in person's own queue. While an admin is viewing as
    // somebody else, `req.user` IS that person, so this is also what makes
    // "view as Brian" show Brian's expenses rather than a copy of Eric's.
    const { provider, demo } = resolveProvider(who, ownsBlanks);
    const result = await provider.fetchReports(window);
    return { ...result, demo };
  });
}

export const api = Router();

api.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
});

/**
 * Fail closed exactly where it matters. Sign-in being unconfigured leaves the
 * app open so a fresh import is explorable — but the moment real Emburse
 * credentials exist, serving expense data to anonymous callers would be a
 * genuine leak. So: real data requires sign-in; demo data does not.
 */
function refusesUnauthenticated(): string | null {
  if (isAuthConfigured()) return null;
  if (!isEmburseConfigured()) return null;
  return (
    "Emburse is connected but Microsoft sign-in is not configured, so real expense " +
    "data will not be served. Set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET."
  );
}

/** What the UI needs to render its "connected / not connected" state. */
/**
 * When this server process started.
 *
 * A failed decision keeps the error from the attempt that failed, for ever
 * — which is right, it is a record. But a fix ships, the app restarts, and
 * the row still reads exactly as it did before, so the same stale sentence
 * gets read as a fresh verdict. ("This approval error didn't go away": the
 * cause had been fixed two deploys earlier and nothing had re-run it.)
 *
 * Comparing this with a decision's timestamp is all the queue needs to say
 * "the app has been updated since this ran". A restart is not proof the
 * cause is fixed, so the page says only what is true and offers the retry.
 */
const BOOTED_AT = new Date().toISOString();

api.get("/config", (_req, res) => {
  const configured = isEmburseConfigured();
  res.json({
    configured,
    bootedAt: BOOTED_AT,
    /**
     * What is actually behind the data. The old header keyed off the Emburse
     * API being configured, which now never happens — so a page full of
     * imported expenses announced itself as "demo mode".
     */
    source: isDbConfigured() ? "imported" : configured ? env.emburse.product : "demo",
    authConfigured: isAuthConfigured(),
    auditConfigured: isAuditConfigured(),
    product: env.emburse.product,
    baseUrl: configured ? env.emburse.baseUrl : null,
    policy: env.policy,
    // Named so the UI can list exactly what is still missing.
    missing: configured
      ? []
      : env.emburse.product === "professional"
        ? ["EMBURSE_API_KEY", "EMBURSE_API_SECRET"]
        : ["EMBURSE_ACCESS_TOKEN — or EMBURSE_CLIENT_ID + EMBURSE_CLIENT_SECRET + EMBURSE_TOKEN_URL"],
  });
});

/**
 * The permanent lists: Categories, Locations/Sites and Departments.
 *
 * Read-only on purpose. The lists are derived from what Emburse has actually
 * sent, so there is nothing here a person could usefully edit — a name typed in
 * by hand would belong to no expense, and a name deleted here would come back
 * with the next export that mentions it.
 */
/**
 * Is the Anthropic credential actually working?
 *
 * Admin-only and rate-limited by hand, because every call costs a fraction of
 * a cent and there is no reason to press it in a loop.
 */
let lastAiCheck = 0;
api.post("/ai-check", requireAuth, requireAdmin, async (_req, res) => {
  const since = Date.now() - lastAiCheck;
  if (since < 3000) {
    res.status(429).json({ error: "Give it a moment before testing again." });
    return;
  }
  lastAiCheck = Date.now();
  try {
    res.json(await checkAi());
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

/**
 * What the AI has cost. Admin-only: it is a spend figure, not queue data.
 *
 * Read from stored token counts and priced at display time, so a corrected
 * price needs no backfill.
 */
api.get("/ai-usage", requireAuth, requireAdmin, async (_req, res) => {
  try {
    // The backlog rides along with the spend rather than getting its own
    // endpoint: "why is this climbing" is a question about the number on this
    // card, and the answer belongs beside it.
    const { readingBacklog } = await import("./emburse/receipt-items.js");
    const [spend, backlog] = await Promise.all([
      aiSpend(),
      readingBacklog().catch(() => null),
    ]);
    res.json({ ...spend, backlog });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

/**
 * The small admin switches. Reading them is open to any signed-in user,
 * because the queue needs to know whether to offer a trace; setting them is
 * admin, because they change what the server records.
 */
const flagState = async () => ({
  ...(await allFlags()),
  // The number and the person, alongside the switches. Automatic
  // approvals are made under a real login and the page has to name whose.
  autoApprovePerRun: (await getLimit("autoApprove")) ?? DEFAULT_PER_RUN,
  autoApproveOwner: await flagOwner("autoApprove"),
});

api.get("/flags", requireAuth, async (_req, res) => {
  try {
    res.json(await flagState());
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

/**
 * Why nothing is being approved automatically.
 *
 * Its own endpoint rather than part of the flag state, which every signed-in
 * user reads on every page load: this counts the whole inbox, and only an
 * admin has any use for the answer.
 */
api.get("/flags/autoApprove/report", requireAuth, requireAdmin, async (_req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "No database is configured." });
    return;
  }
  try {
    res.json(await autoApproveReport());
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

/**
 * Run the automatic approvals now, instead of at the next sweep.
 *
 * This exists because there was no way to see whether the setting worked.
 * It ran after an import and after a receipt-reading pass, both of which
 * are quiet on a settled queue, so switching it on produced nothing
 * observable for hours — identical, from the outside, to a broken feature.
 *
 * Restricted to the OWNER, not merely to admins. Every approval this makes
 * is recorded in Emburse against whoever switched the automation on, so an
 * admin pressing this would be putting a colleague's name on approvals
 * they never made. Same rule as everywhere else in the app: a decision is
 * applied under the decider's own login, never somebody else's.
 */
api.post("/flags/autoApprove/run", requireAuth, requireAdmin, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "No database is configured." });
    return;
  }
  try {
    const owner = await flagOwner("autoApprove");
    const who = req.user?.email ?? "";
    if (owner && who.toLowerCase() !== owner.toLowerCase()) {
      res.status(403).json({
        error: `Automatic approvals are made under ${owner}'s Emburse login, so only ${owner} can run them by hand. Switch the setting off and on again to take it over.`,
      });
      return;
    }
    const result = await autoQueueApprovals();
    res.json({ ...result, report: await autoApproveReport() });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

api.post("/flags/:key", requireAuth, requireAdmin, async (req, res) => {
  const key = String(req.params.key);
  if (!(key in FLAGS)) {
    res.status(404).json({ error: `There is no “${key}” setting.` });
    return;
  }
  try {
    const body = req.body as { enabled?: unknown; amount?: unknown };
    const who = req.user?.email ?? "unknown";
    if (typeof body.amount === "number" && Number.isFinite(body.amount)) {
      // Clamped here, not trusted from the page. This number is how many
      // of somebody's expenses a single unattended pass may approve.
      await setLimit(key as FlagKey, Math.min(Math.max(1, Math.round(body.amount)), MOST_PER_RUN), who);
    }
    if ("enabled" in body) await setFlag(key as FlagKey, Boolean(body.enabled), who);
    res.json(await flagState());
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

api.get("/taxonomy", requireAuth, async (_req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "No database is configured, so there are no lists yet." });
    return;
  }
  try {
    res.json({ counts: await taxonomyCounts() });
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

api.get("/taxonomy/:kind", requireAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "No database is configured, so there are no lists yet." });
    return;
  }
  const kind = String(req.params.kind);
  if (!isKind(kind)) {
    res.status(404).json({ error: `No such list: ${kind}` });
    return;
  }
  try {
    res.json(await listTaxonomy(kind));
  } catch (err) {
    res.status(500).json({ error: describe(err) });
  }
});

api.get("/reports", requireAuth, async (req, res) => {
  const blocked = refusesUnauthenticated();
  if (blocked) {
    res.status(503).json({ error: blocked });
    return;
  }
  const window = readWindow(req.query as Record<string, unknown>);
  try {
    const data = await load(window, req.query.refresh === "1", req.user?.email ?? "");
    res.json({
      window,
      demo: data.demo,
      fetchedAt: data.fetchedAt,
      warnings: data.warnings,
      reports: data.reports,
      summary: summarise(data.reports),
    });
  } catch (err) {
    res.status(502).json({ error: describe(err) });
  }
});

api.get("/reports/:id", requireAuth, async (req, res) => {
  const blocked = refusesUnauthenticated();
  if (blocked) {
    res.status(503).json({ error: blocked });
    return;
  }
  const window = readWindow(req.query as Record<string, unknown>);
  try {
    const data = await load(window, false, req.user?.email ?? "");
    const report = data.reports.find((r) => r.id === req.params.id);
    if (!report) {
      res.status(404).json({ error: "Report not found in the current window" });
      return;
    }
    res.json({ report, demo: data.demo });
  } catch (err) {
    res.status(502).json({ error: describe(err) });
  }
});

/**
 * Streams one line's receipt through this server.
 *
 * The client passes only a line id, which is resolved against the cached
 * report set — it can never supply a URL, so this is not an open proxy. The
 * response headers below matter because we are serving externally-sourced
 * bytes from our own origin: `nosniff` stops the browser second-guessing the
 * type, and the CSP sandbox neutralises anything active inside an SVG or PDF.
 */
api.get("/receipts/:lineId", requireAuth, async (req, res) => {
  const blocked = refusesUnauthenticated();
  if (blocked) {
    res.status(503).json({ error: blocked });
    return;
  }

  const window = readWindow(req.query as Record<string, unknown>);
  try {
    const line = await findLine(String(req.params.lineId ?? ""), window, req.user?.email ?? "");
    if (!line) {
      res.status(404).json({ error: "No such expense line." });
      return;
    }

    const receipt = await fetchReceipt(line);
    res.setHeader("content-type", receipt.contentType);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader("content-disposition", `inline; filename="receipt-${encodeURIComponent(line.id)}"`);
    // Private: a receipt is one user's data, never shared-cacheable.
    res.setHeader("cache-control", "private, max-age=300");
    res.send(receipt.body);
  } catch (err) {
    if (err instanceof ReceiptError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: describe(err) });
  }
});




/**
 * Find one expense line by id.
 *
 * With imported data the id IS the row's primary key, so it is looked up
 * directly. Routing that through the windowed report cache used to 404 any
 * line whose date fell outside the caller's window — which is every older
 * expense, because the receipt viewer does not send a window.
 */
async function findLine(
  lineId: string,
  window: { startDate: string; endDate: string },
  reviewer: string,
): Promise<ExpenseLine | null> {
  if (isDbConfigured()) {
    const { rows } = await db().query<{
      dedupe_key: string; expense_date: Date | null; merchant: string; amount_cents: string;
      category: string | null; note: string | null; location: string | null; receipts: string;
    }>(
      `SELECT e.dedupe_key, e.expense_date, e.merchant, e.amount_cents, e.category, e.note, e.location,
              (SELECT count(*) FROM expense_receipts r WHERE r.dedupe_key = e.dedupe_key) AS receipts
         FROM expenses e WHERE e.dedupe_key = $1`,
      [lineId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      // Only used to fetch a receipt, which does not need the diff.
      changes: [],
      section: null,
      id: r.dedupe_key, reportId: "", date: r.expense_date ? r.expense_date.toISOString().slice(0, 10) : null,
      category: r.category || "Uncategorised", merchant: r.merchant || "—",
      amount: Number(r.amount_cents) / 100, currency: "USD",
      reimbursable: true, billable: false, hasReceipt: Number(r.receipts) > 0,
      receiptId: r.dedupe_key, receiptUrl: "", glCode: "", note: r.note ?? "",
      location: "", method: "",
    };
  }
  const data = await load(window, false, reviewer);
  return data.reports.flatMap((r) => r.lines).find((l) => l.id === lineId) ?? null;
}

function summarise(reports: ExpenseReport[]) {
  const byStatus: Record<string, number> = {};
  const byDepartment = new Map<string, { count: number; total: number }>();
  const byCategory = new Map<string, number>();
  let awaitingTotal = 0;
  let flagged = 0;

  for (const r of reports) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === "submitted") awaitingTotal += r.total;
    if (r.flags.some((f) => f.severity === "warn")) flagged += 1;

    const dept = byDepartment.get(r.department) ?? { count: 0, total: 0 };
    byDepartment.set(r.department, { count: dept.count + 1, total: dept.total + r.total });

    for (const l of r.lines) {
      byCategory.set(l.category, (byCategory.get(l.category) ?? 0) + l.amount);
    }
  }

  return {
    reportCount: reports.length,
    total: reports.reduce((a, r) => a + r.total, 0),
    awaitingTotal,
    flagged,
    byStatus,
    byDepartment: [...byDepartment.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.total - a.total),
    byCategory: [...byCategory.entries()]
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total),
  };
}

function describe(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) {
      return "Emburse rejected the credentials (401/403). Check EMBURSE_API_KEY / EMBURSE_API_SECRET.";
    }
    if (err.status === 404) {
      return "Emburse returned 404. The resource path may differ on this tenant — check EMBURSE_REPORTS_PATH against your Swagger.";
    }
    return `Emburse returned HTTP ${err.status}.`;
  }
  if (err instanceof Error && err.name === "AbortError") return "Emburse request timed out.";
  return err instanceof Error ? err.message : String(err);
}
