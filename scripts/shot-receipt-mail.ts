/**
 * A picture of the receipts page, for looking at.
 *
 *   pnpm run build && pnpm exec tsx scripts/shot-receipt-mail.ts
 *
 * Not a test — the layout is the thing the owner judged, so it
 * gets looked at rather than asserted on.
 */
import { chromium } from "playwright";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

process.env.SESSION_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.AUTH_ALLOWED ||= "mojocarwash.com";
process.env.AUTH_ADMINS ||= "eric.s@mojocarwash.com";

const APP = "eric.s@mojocarwash.com";
const ID = "shot-receipt-mail";
const PORT = 5633;
const OUT = process.argv[2] ?? "/tmp/receipt-mail.png";

const payload = Buffer.from(JSON.stringify({
  id: ID, email: APP, name: APP, exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");

const { db, ensureSchema } = await import("../server/db.js");
const { addConnection } = await import("../server/emburse/connections.js");
const { recordCandidates } = await import("../server/emburse/receipt-mail.js");

await ensureSchema();

const MERCHANTS = [
  ["REPLIT", 10660, "2026-10-28"], ["GITHUB", 1719, "2026-10-24"],
  ["REPLIT", 1150, "2026-10-24"], ["ADOBE", 103152, "2026-10-02"],
  ["AMAZON WEB SERVICES", 343470, "2026-10-01"], ["ANTHROPIC", 21320, "2026-09-14"],
] as const;

const server = spawn("node", ["dist/server.js"], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => undefined);
server.stderr.on("data", () => undefined);

const browser = await chromium.launch();
try {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-shot-%'");
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID]);
  await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "pw", label: "MOJO",
  });
  for (const [i, [merchant, cents, date]] of MERCHANTS.entries()) {
    await db().query(
      `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                             category, department, location, note, method, in_inbox,
                             reviewer, source, lane)
       VALUES ($1,'Eric S',$2,$3,$4,'Software, Licenses','IT & Compliance','',
               'IT & Compliance Department Spend','Card',true,$5,'','personal-mojo')
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [`zz-shot-${i}`, date, merchant, cents, APP]);
    await recordCandidates([{
      dedupeKey: `zz-shot-${i}`, lane: "personal-mojo", messageId: `shot-msg-${i}`,
      confidence: i % 3 === 0 ? "strong" : "likely", score: i % 3 === 0 ? 80 : 50,
      reasons: [`The merchant matches: “${merchant}”.`,
        `The total matches exactly: $${(cents / 100).toFixed(2)}.`, "Same date."],
      evidence: {
        messageId: `shot-msg-${i}`, subject: `Your ${merchant} receipt`,
        from: `invoice@${merchant.toLowerCase().split(" ")[0]}.com`,
        receivedAt: `${date}T12:00:00Z`, folder: "Receipts", merchant,
        date, totalCents: cents, currency: "USD", reference: `#${2723 + i}`,
        hasAttachment: true,
        attachments: [{ id: "a", name: "receipt.pdf", contentType: "application/pdf", size: 1 }],
        excerpt: `Amount due $${(cents / 100).toFixed(2)}`,
      },
    }]);
  }

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/me`)).status < 500) break; }
    catch { /* still coming up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addCookies([{
    name: "mojo_sid", value: `${payload}.${mac}`,
    domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax",
  }]);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/#/receipt-mail`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: OUT, fullPage: true });
  console.log(`wrote ${OUT}`);
} finally {
  await browser.close();
  await db().query("DELETE FROM receipt_mail_matches WHERE dedupe_key LIKE 'zz-shot-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-shot-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID])
    .catch(() => undefined);
  server.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300);
}
