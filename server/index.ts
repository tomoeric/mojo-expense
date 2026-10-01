import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { logAiCredential } from "./ai.js";
import { env, databaseHost, databaseUrlSource } from "./env.js";
import { api } from "./routes.js";
import { allowListSize, authMiddleware, authRouter, isAuthConfigured } from "./auth/index.js";
import { viewAsMiddleware } from "./auth/view-as.js";
import { importRouter } from "./import/routes.js";
import { decisionRouter } from "./emburse/decision-routes.js";
import { startExportScheduler } from "./emburse/export-scheduler.js";
import { startDecisionWorker } from "./emburse/decision-worker.js";
import { startReceiptReader } from "./emburse/receipt-reader.js";
import { reapplyAlcoholFloor } from "./emburse/receipt-items.js";
import { startAutoApprove } from "./rules/auto-approve.js";
import { runRules } from "./rules/run.js";
import { ensureSchema, isDbConfigured } from "./db.js";
import { rulesRouter } from "./rules/routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable("x-powered-by");
// JSON parsing must not touch /api/import, whose body is a raw PDF.
app.use((req, res, next) =>
  req.path === "/api/import" ? next() : express.json({ limit: "1mb" })(req, res, next),
);
app.use(cookieParser());
// Populates req.user from the session cookie before anything reads it.
app.use(authMiddleware);
// After the identity is read and before anything uses it. Swaps req.user for
// an admin who is looking through somebody else's eyes, and refuses every
// write while they are.
app.use(viewAsMiddleware);
app.use("/api", authRouter);
app.use("/api", importRouter);
app.use("/api", decisionRouter);
app.use("/api", rulesRouter);
app.use("/api", api);

// Anything left under /api is a genuine 404. Without this it falls through to
// the SPA catch-all below and a mistyped endpoint answers 200 with HTML, which
// surfaces on the client as an unintelligible JSON parse error.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "No such endpoint" });
});

if (env.isProd) {
  // The bundled server sits in dist/, next to the Vite output in dist/public.
  const staticDir = path.resolve(here, "public");
  app.use(express.static(staticDir));
  app.get("*splat", (_req, res) => res.sendFile(path.join(staticDir, "index.html")));
} else {
  // One process, one port in dev: Vite runs as Express middleware so the API
  // and the client share an origin and there is no proxy to keep in sync.
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: path.resolve(here, ".."),
    server: { middlewareMode: true },
    appType: "custom",
  });
  app.use(vite.middlewares);
  app.get("*splat", async (req, res, next) => {
    try {
      const template = fs.readFileSync(path.resolve(here, "..", "index.html"), "utf8");
      res.status(200).set({ "content-type": "text/html" }).end(await vite.transformIndexHtml(req.originalUrl, template));
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Re-evaluate every rule against every expense, once, on boot.
 *
 * Verdicts are STORED — that is what makes the queue fast and what lets
 * "when did this start failing" be answerable. It also means a deploy that
 * changes how a rule is judged leaves the queue showing the old answer,
 * with nothing on screen admitting it.
 *
 * That gap cost real trust. A money rule was flagging everything because
 * "$75.00" parsed as NaN; the fix shipped, the live preview immediately read
 * 16 failing instead of 116 — and the queue still showed a $10.53 day
 * flagged, because nothing had re-run the rules. The answer was "press
 * Re-check all", which is a fine button and a terrible requirement: it asks
 * somebody to know that the screen might be lying, and to remember the
 * remedy, every single deploy.
 *
 * So it runs itself. Flags only — boot must never approve or deny anything,
 * and `decide: false` is what guarantees that. Failure is logged and
 * swallowed: a rule run is not a reason to refuse to serve.
 */
function recheckRulesOnBoot(): void {
  // After the workers, and not in the way of the first request.
  setTimeout(() => {
    // Before the re-check, not after: the floor changes what the rules will
    // conclude, and running them first would leave every expense it clears
    // flagged until something else happened to re-judge it.
    void reapplyAlcoholFloor()
      .catch((err: unknown) => { console.error("receipts: the alcohol floor could not be re-applied:", err); return 0; })
      .then(() => runRules({ decide: false }))
      .then((r) =>
        console.log(
          `rules: re-checked ${r.expenses} expense(s) against ${r.rulesRun} rule(s) — ` +
          `${r.failed} failing, ${r.passed} passing`))
      .catch((err: unknown) => console.error("rules: boot re-check failed:", err));
  }, 5_000);
}

// 0.0.0.0 so Replit's router can reach the process.
app.listen(env.port, "0.0.0.0", () => {
  console.log(`MOJO Expense listening on :${env.port} (${env.isProd ? "production" : "development"})`);
  console.log(`Emburse product: ${env.emburse.product}`);
  console.log(`Microsoft sign-in: ${isAuthConfigured() ? "configured" : "NOT configured"}`);
  if (isDbConfigured()) {
    // Name the source and host so a wrong-database mix-up is visible at a
    // glance rather than showing up as mysteriously empty data.
    console.log(`Database: ${databaseHost()} (from ${databaseUrlSource()})`);
    // Create the tables on boot; the app still serves if this fails so the
    // error is visible in the UI rather than only in a crash loop.
    ensureSchema()
      .then(() => {
        startExportScheduler();
        startDecisionWorker();
        startReceiptReader();
        // On a clock of its own: the import and the receipt reader are both
        // quiet on a settled queue, and this used to run only on the back of
        // one of them.
        startAutoApprove();
        recheckRulesOnBoot();
      })
      .catch((err: unknown) => console.error("schema bootstrap failed:", err));
  } else {
    console.log("No database configured (NEON_DATABASE_URL / EXTERNAL_DATABASE_URL / DATABASE_URL) — imports are unavailable.");
  }
  console.log(
    env.audit.apiKey
      ? `Receipt checking: ${env.audit.model}`
      : "Receipt checking: no Anthropic key — the check is unavailable",
  );
  // Which credential, spelled out. A copied integration key looks identical to
  // a working one in the secrets list and only differs at the first call.
  logAiCredential();
  const allowed = allowListSize();
  console.log(
    allowed > 0
      ? `AUTH_ALLOWED: ${allowed} entr${allowed === 1 ? "y" : "ies"}`
      : "AUTH_ALLOWED: not set — anyone in the tenant may sign in",
  );
});
