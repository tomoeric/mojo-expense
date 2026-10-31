/**
 * A failed send says what failed, on the card it failed on.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-failed-send-card.ts
 *
 * The screenshot that prompted this: a REPLIT $106.60 card, pill
 * reading "needs a look", and under it, in red,
 *
 *   The receipt is held here but Emburse did not take it.
 *   Try it again from Receipts in email.
 *
 * Both halves wrong. The retry is on this card, not on that page —
 * it moved here when sending did — and "Emburse did not take it" is
 * the one state where the browser's own step log exists and was the
 * one state that did not render it. So the card said "needs a look"
 * and gave nothing to look at, then sent the reader somewhere else
 * to find a button that was already in front of them.
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
const ID = "ui-failed-send";
const PORT = 5642;
const KEY = "zz-fs-1";

const payload = Buffer.from(JSON.stringify({
  id: ID, email: APP, name: APP, exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");

const { db, ensureSchema } = await import("../server/db.js");
const { addConnection } = await import("../server/emburse/connections.js");
const { linkReceipt } = await import("../server/emburse/receipt-link.js");
const { recordCandidates, decideMatch } = await import("../server/emburse/receipt-mail.js");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

await ensureSchema();

const server = spawn("node", ["dist/server.js"], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => undefined);
server.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));

const up = async (): Promise<boolean> => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/me`);
      if (res.status < 500) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const browser = await chromium.launch();
try {
  await db().query("DELETE FROM receipt_writebacks WHERE dedupe_key LIKE 'zz-fs-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM receipt_mail_matches WHERE dedupe_key LIKE 'zz-fs-%'");
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID]);
  await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "mojo-pw", label: "MOJO",
  });
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-fs-%'");
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox,
                           reviewer, source, lane)
     VALUES ($1,'Eric S','2026-10-24','REPLIT',10660,'Software, Licenses','IT & Compliance',
             '','','Card',true,$2,'','personal-mojo')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [KEY, APP]);
  await recordCandidates([{
    dedupeKey: KEY, lane: "personal-mojo", messageId: "fs-msg-1",
    confidence: "strong", score: 80, reasons: ["The total matches exactly."],
    evidence: {
      messageId: "fs-msg-1", subject: "Your Replit receipt",
      from: "invoice@mail.replit.com", receivedAt: "2026-10-24T12:00:00Z",
      folder: "Receipts", merchant: "Replit", totalCents: 10660,
      date: "2026-10-24", currency: "USD", reference: "", hasAttachment: true,
      excerpt: "Thanks for your payment of $106.60.",
      attachments: [{
        id: "att-1", name: "receipt.png", contentType: "image/png", size: PNG.length,
      }],
    },
  }]);
  await decideMatch({
    dedupeKey: KEY, messageId: "fs-msg-1", choose: true, by: APP,
  });
  const linked = await linkReceipt({
    dedupeKey: KEY, bytes: PNG, contentType: "image/png",
  });

  /*
   * The state the screenshot is of: the receipt is in the app, and
   * Emburse refused the attach. Written straight in, because the
   * only other way to reach it is a real Emburse login.
   */
  await db().query(
    `INSERT INTO receipt_writebacks
       (dedupe_key, kind, lane, proposed, was, message_id, attachment_id,
        state, attempts, error, proposed_by, proposed_at, settled_at, steps)
     VALUES ($1,'receipt','personal-mojo','receipt.png','','fs-msg-1','att-1',
             'failed',2,'The attach control never appeared on the edit form.',
             $2, now(), now(), $3::jsonb)
     ON CONFLICT (dedupe_key, kind) DO UPDATE
       SET state = 'failed', error = excluded.error, steps = excluded.steps`,
    [KEY, APP, JSON.stringify([
      { name: "sign in", ok: true, detail: "Signed in as eric.s@mojocarwash.com." },
      { name: "find the row", ok: true, detail: "REPLIT $106.60 on 24 Oct." },
      { name: "open the edit form", ok: true, detail: "Edit Expense Details opened." },
      { name: "attach the receipt", ok: false,
        detail: "No file input and no Add Receipt button within 20s." },
    ])]);

  check("the receipt is in the app", linked.sha256.length === 64);
  check("the server comes up", await up());

  const ctx = await browser.newContext();
  await ctx.addCookies([{
    name: "mojo_sid", value: `${payload}.${mac}`,
    domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax",
  }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // The candidate frame asks the mailbox for a picture and there is
    // no Graph here; that 400 is expected and is not what is on trial.
    if (/receipt-mail\/preview|status of 400/.test(m.text())) return;
    errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  console.log("\n1. The failed card is on the Receipts tab");
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const mojo = page.getByRole("button", { name: /Personal Tab - MOJO/ });
  if (await mojo.count() > 0) { await mojo.first().click(); await page.waitForTimeout(1200); }
  const tab = page.getByRole("button", { name: /^Receipts/ });
  check("the tab is there", await tab.count() > 0,
    (await page.locator("body").innerText()).replace(/\n/g, " | ").slice(0, 300));
  await tab.first().click();
  await page.waitForTimeout(3000);
  const body = (await page.locator("body").innerText());
  check("the expense is shown", body.includes("REPLIT"), body.slice(0, 200));
  check("with the state it is in", body.includes("needs a look"));

  console.log("\n2. It no longer sends the reader to another page");
  check("the stale advice is gone",
    !body.includes("Try it again from Receipts in email"),
    body.replace(/\n/g, " | ").slice(0, 400));
  check("and it points at what is on this card",
    body.includes("What it did") || body.includes("Try that part again"),
    body.replace(/\n/g, " | ").slice(-400));

  console.log("\n3. What Emburse refused, and how far the browser got");
  check("the line that failed is named", body.includes("Attach"),
    body.replace(/\n/g, " | ").slice(-400));
  check("and the header does not call a refusal a send",
    body.includes("Emburse refused part of this")
      && !body.includes("Sent to Emburse under your own login"),
    body.replace(/\n/g, " | ").slice(-400));
  check("with Emburse's own reason",
    body.includes("The attach control never appeared on the edit form."),
    body.replace(/\n/g, " | ").slice(-400));
  await page.locator("summary").filter({ hasText: "What it did" }).first().click();
  await page.waitForTimeout(600);
  const open = await page.locator("body").innerText();
  check("the step log opens", open.includes("open the edit form"),
    open.replace(/\n/g, " | ").slice(-400));
  check("and shows the step that stopped",
    open.includes("No file input and no Add Receipt button"),
    open.replace(/\n/g, " | ").slice(-400));

  console.log("\n4. The retry is here, where the failure is");
  check("one press re-runs just what failed",
    await page.getByRole("button", { name: "Try that part again" }).first().isVisible());

  console.log("\n5. No console errors");
  check("the page produced none", errors.length === 0, errors.slice(0, 3).join(" · "));
} finally {
  await browser.close();
  await db().query("DELETE FROM receipt_writebacks WHERE dedupe_key LIKE 'zz-fs-%'")
    .catch(() => undefined);
  await db().query(
    `DELETE FROM expense_receipts WHERE dedupe_key LIKE 'zz-fs-%'`).catch(() => undefined);
  await db().query("DELETE FROM receipt_mail_matches WHERE dedupe_key LIKE 'zz-fs-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-fs-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID])
    .catch(() => undefined);
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
