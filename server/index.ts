import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { env, databaseHost, databaseUrlSource } from "./env.js";
import { api } from "./routes.js";
import { allowListSize, authMiddleware, authRouter, isAuthConfigured } from "./auth/index.js";
import { importRouter } from "./import/routes.js";
import { startSyncTimer } from "./import/sync.js";
import { startExportScheduler } from "./emburse/export-scheduler.js";
import { ensureSchema, isDbConfigured } from "./db.js";

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
app.use("/api", authRouter);
app.use("/api", importRouter);
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
        startSyncTimer();
        startExportScheduler();
      })
      .catch((err: unknown) => console.error("schema bootstrap failed:", err));
  } else {
    console.log("No database configured (NEON_DATABASE_URL / EXTERNAL_DATABASE_URL / DATABASE_URL) — imports are unavailable.");
  }
  console.log(
    env.audit.apiKey
      ? `Receipt checking: ${env.audit.model}${env.audit.baseUrl ? " via integration gateway" : ""}`
      : "Receipt checking: no Anthropic key — the check is unavailable",
  );
  const allowed = allowListSize();
  console.log(
    allowed > 0
      ? `AUTH_ALLOWED: ${allowed} entr${allowed === 1 ? "y" : "ies"}`
      : "AUTH_ALLOWED: not set — anyone in the tenant may sign in",
  );
});
