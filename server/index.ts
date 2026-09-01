import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { api } from "./routes.js";
import { authMiddleware, authRouter, isAuthConfigured } from "./auth/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
// Populates req.user from the session cookie before anything reads it.
app.use(authMiddleware);
app.use("/api", authRouter);
app.use("/api", api);

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
});
