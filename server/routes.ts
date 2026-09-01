import { Router } from "express";
import { env, isEmburseConfigured } from "./env.js";
import { TtlCache } from "./cache.js";
import { HttpError } from "./http.js";
import { resolveProvider } from "./emburse/provider.js";
import { isAuthConfigured, requireAuth } from "./auth/index.js";
import type { ExpenseReport, ProviderResult } from "./emburse/types.js";
import { fetchReceipt, ReceiptError } from "./emburse/receipts.js";

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

async function load(window: { startDate: string; endDate: string }, force: boolean) {
  if (force) cache.clear();
  return cache.get(`${window.startDate}:${window.endDate}`, async () => {
    const { provider, demo } = resolveProvider();
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
api.get("/config", (_req, res) => {
  const configured = isEmburseConfigured();
  res.json({
    configured,
    authConfigured: isAuthConfigured(),
    product: env.emburse.product,
    baseUrl: configured ? env.emburse.baseUrl : null,
    policy: env.policy,
    // Named so the UI can list exactly what is still missing.
    missing: configured
      ? []
      : env.emburse.product === "professional"
        ? ["EMBURSE_API_KEY", "EMBURSE_API_SECRET"]
        : ["EMBURSE_CLIENT_ID", "EMBURSE_CLIENT_SECRET", "EMBURSE_TOKEN_URL"],
  });
});

api.get("/reports", requireAuth, async (req, res) => {
  const blocked = refusesUnauthenticated();
  if (blocked) {
    res.status(503).json({ error: blocked });
    return;
  }
  const window = readWindow(req.query as Record<string, unknown>);
  try {
    const data = await load(window, req.query.refresh === "1");
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
    const data = await load(window, false);
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
    const data = await load(window, false);
    const line = data.reports.flatMap((r) => r.lines).find((l) => l.id === req.params.lineId);
    if (!line) {
      res.status(404).json({ error: "Line not found in the current window" });
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
