/**
 * A submitted expense leaves the queue the moment it is pressed.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-queued-tab.ts
 *
 * Pressing Approve queues the decision for the worker, which
 * signs into Emburse and applies it minutes later. Until this,
 * the row stayed exactly where it was in All and Unflagged with
 * a small "sending" beside it — so a queue of 26 still read 26
 * after ten had been decided, and the only way to see what you
 * had done was to read every row.
 *
 * Three stages, three places: waiting on you · Queued · Approved.
 */
import { chromium } from "playwright";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

process.env.SESSION_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.AUTH_ALLOWED ||= "mojocarwash.com";
process.env.AUTH_ADMINS ||= "eric.s@mojocarwash.com";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const APP = "eric.s@mojocarwash.com";
const ID = "ui-queued-tab";
const PORT = 5639;

const payload = Buffer.from(JSON.stringify({
  id: ID, email: APP, name: APP, exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");

const { db, ensureSchema } = await import("../server/db.js");

await ensureSchema();

const expense = (key: string, merchant: string, cents: number) => db().query(
  `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                         category, department, location, note, method, in_inbox,
                         reviewer, source, lane)
   VALUES ($1,'Eric S','2026-10-24',$2,$3,'Software, Licenses','IT & Compliance','','',
           'Card',true,$4,'','')
   ON CONFLICT (dedupe_key) DO NOTHING`,
  [key, merchant, cents, APP]);

const server = spawn("node", ["dist/server.js"], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => undefined);
server.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));

const browser = await chromium.launch();
try {
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE 'zz-qt-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-qt-%'");
  await expense("zz-qt-1", "REPLIT", 10660);
  await expense("zz-qt-2", "GITHUB", 1719);
  await expense("zz-qt-3", "ADOBE", 103152);

  /*
   * One of each stage, written straight in. The point under test
   * is WHICH LIST each lands in, not the deciding machinery —
   * that has its own suites, and driving a real approval here
   * would need an Emburse to approve into.
   */
  await db().query(
    `INSERT INTO expense_decisions (dedupe_key, decision, state, decided_by, target)
     VALUES ('zz-qt-2','approve','pending',$1,'{}'::jsonb),
            ('zz-qt-3','approve','applied',$1,'{}'::jsonb)`,
    [APP]);

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/me`)).status < 500) break; }
    catch { /* still coming up */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  const ctx = await browser.newContext();
  await ctx.addCookies([{
    name: "mojo_sid", value: `${payload}.${mac}`,
    domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax",
  }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  console.log("1. Three stages, three tabs");
  const text = await page.locator("body").innerText();
  check("THE QUEUED TAB IS THERE", /Queued\s*1/.test(text.replace(/\n/g, " ")),
    text.replace(/\n/g, " | ").slice(0, 400));
  check("…and it sits before Approved",
    text.indexOf("Queued") < text.indexOf("Approved"),
    `Queued@${text.indexOf("Queued")} Approved@${text.indexOf("Approved")}`);
  check("…with Approved holding the one Emburse confirmed",
    /Approved\s*1/.test(text.replace(/\n/g, " ")),
    text.replace(/\n/g, " | ").slice(0, 400));

  console.log("\n2. A SUBMITTED EXPENSE IS NOT STILL IN THE QUEUE");
  check("All counts only what is undecided",
    /All\s*1\b/.test(text.replace(/\n/g, " ")),
    text.replace(/\n/g, " | ").slice(0, 300));
  const all = await page.locator("tbody").innerText();
  check("…and the submitted one is not in the list",
    all.includes("REPLIT") && !all.includes("GITHUB"),
    all.replace(/\n/g, " | ").slice(0, 300));

  console.log("\n3. It is in Queued, where it belongs");
  await page.getByRole("button", { name: /^Queued/ }).click();
  await page.waitForTimeout(800);
  const queued = await page.locator("tbody").innerText();
  check("the submitted one is here", queued.includes("GITHUB"),
    queued.replace(/\n/g, " | ").slice(0, 300));
  check("…and the undecided one is not", !queued.includes("REPLIT"),
    queued.replace(/\n/g, " | ").slice(0, 300));
  check("…nor the finished one", !queued.includes("ADOBE"));

  console.log("\n4. No console errors");
  check("the page produced none", errors.length === 0, errors.slice(0, 3).join(" · "));
} finally {
  await browser.close();
  await db().query("DELETE FROM expense_decisions WHERE dedupe_key LIKE 'zz-qt-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-qt-%'")
    .catch(() => undefined);
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
