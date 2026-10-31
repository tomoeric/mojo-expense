/**
 * The Receipt matched tab, in a browser: picture, not a word.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-matched-tab-ui.ts
 *
 * Asked for three times and delivered twice as the wrong thing.
 * The first version made the tab and left it empty; the second
 * filled it with the SAME TABLE as every other tab, whose Receipt
 * column said "matched". Neither answers the question the tab
 * exists for — is this the right receipt for this expense — and
 * that question is answered by looking at the receipt.
 *
 * So what is checked here is that the tab shows the receipt
 * ITSELF, beside the expense's own merchant, date and amount.
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
const ID = "ui-matched-tab";
const PORT = 5621;
const KEY = "zz-mt-1";

const payload = Buffer.from(JSON.stringify({
  id: ID, email: APP, name: APP, exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");

const { db, ensureSchema } = await import("../server/db.js");
const { addConnection } = await import("../server/emburse/connections.js");
const { linkReceipt } = await import("../server/emburse/receipt-link.js");
const { recordCandidates, decideMatch } = await import("../server/emburse/receipt-mail.js");

// A one-pixel PNG, so the frame has something real to render and
// the test is looking at an <img> rather than a PDF object.
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
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-mt-%'");
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID]);
  await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "mojo-pw", label: "MOJO",
  });
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox,
                           reviewer, source, lane)
     VALUES ($1,'Eric S','2026-10-24','REPLIT',10660,'Software, Licenses','IT & Compliance',
             '','IT & Compliance Department Spend','Card',true,$2,'','personal-mojo')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [KEY, APP]);

  // Matched, chosen, and the image pulled in — the state the tab
  // is about.
  await recordCandidates([{
    dedupeKey: KEY, lane: "personal-mojo", messageId: "mt-msg-1",
    confidence: "strong", score: 80,
    reasons: ["The total matches exactly: $106.60.", "Same date."],
    evidence: {
      messageId: "mt-msg-1", subject: "Your Replit receipt", from: "invoice@mail.replit.com",
      receivedAt: "2026-10-24T12:00:00Z", folder: "Receipts", merchant: "Replit",
      date: "2026-10-24", totalCents: 10660, currency: "USD", reference: "",
      hasAttachment: false, attachments: [], excerpt: "Amount due $106.60",
    },
  }]);
  await decideMatch({ dedupeKey: KEY, messageId: "mt-msg-1", choose: true, by: APP });
  await linkReceipt({ dedupeKey: KEY, bytes: PNG, contentType: "image/png" });

  /*
   * AND ONE WHOSE IMAGE PULL FAILED.
   *
   * Five expenses read "waiting to be sent" above "No receipt was
   * imported for this expense" — both true, neither the cause.
   * The cause was written on the match row when the pull failed
   * and read by nothing. Seeded before the first load rather than
   * poked in afterwards, because the queue is cached server-side
   * and a mid-run edit is simply not visible yet.
   */
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox,
                           reviewer, source, lane)
     VALUES ($1,'Eric S','2026-10-20','REPLIT',5944,'Software, Licenses','IT & Compliance',
             '','','Card',true,$2,'','personal-mojo')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    ["zz-mt-2", APP]);
  await recordCandidates([{
    dedupeKey: "zz-mt-2", lane: "personal-mojo", messageId: "mt-msg-2",
    confidence: "strong", score: 80, reasons: ["Same date."],
    evidence: {
      messageId: "mt-msg-2", subject: "Your Replit receipt", from: "invoice@mail.replit.com",
      receivedAt: "2026-10-20T12:00:00Z", folder: "Receipts", merchant: "Replit",
      date: "2026-10-20", totalCents: 5944, currency: "USD", reference: "",
      hasAttachment: false, attachments: [], excerpt: "Amount due $59.44",
    },
  }]);
  await decideMatch({ dedupeKey: "zz-mt-2", messageId: "mt-msg-2", choose: true, by: APP });
  await db().query(
    `UPDATE receipt_mail_matches
        SET link_error = 'Graph would not hand over the attachment (404).',
            linked_sha256 = NULL
      WHERE dedupe_key = 'zz-mt-2'`);

  check("the server comes up", await up());
  const ctx = await browser.newContext();
  await ctx.addCookies([{
    name: "mojo_sid", value: `${payload}.${mac}`,
    domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax",
  }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));

  console.log("1. The tab is there, on the queue that has matches");
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const mojo = page.getByRole("button", { name: /Personal Tab - MOJO/ });
  if (await mojo.count() > 0) { await mojo.first().click(); await page.waitForTimeout(1200); }
  const tab = page.getByRole("button", { name: /Receipt matched/ });
  check("THE TAB EXISTS", await tab.count() > 0,
    (await page.locator("body").innerText()).replace(/\n/g, " | ").slice(0, 300));

  console.log("\n2. What it shows is the receipt, not another table row");
  await tab.first().click();
  await page.waitForTimeout(2500);
  const text = await page.locator("body").innerText();
  check("the expense is named", text.includes("REPLIT"), text.slice(0, 200));
  check("…with its amount", text.includes("106.60"));
  check("…and where the match has got to", /matched, not sent yet|waiting to be sent|sent to Emburse/.test(text),
    text.replace(/\n/g, " | ").slice(0, 400));
  check("THE RECEIPT IMAGE IS ON SCREEN",
    await page.locator("img[alt*='receipt matched to']").count() > 0,
    `${await page.locator("img").count()} images, ${await page.locator("object").count()} objects`);
  check("…and it is NOT the ordinary table", await page.locator("table").count() === 0,
    `${await page.locator("table").count()} tables`);

  console.log("\n3. A FAILED PULL SHOWS ITS REASON, not just an empty frame");
  const why = await page.locator("body").innerText();
  check("THE REASON IS ON SCREEN",
    why.includes("Graph would not hand over the attachment"),
    why.replace(/\n/g, " | ").slice(-500));
  check("…said as a failed download rather than a failed match",
    why.includes("only the download went wrong"));
  check("…with a way to try the pull again",
    (await page.getByRole("button", { name: /Pull the receipt in again/ }).count()) > 0);
  check("…while the one that worked still shows its picture",
    (await page.locator("img[alt*='receipt matched to']").count()) > 0,
    `${await page.locator("img[alt*='receipt matched to']").count()} images`);

  console.log("\n4. No console errors");
  check("the page produced none", errors.length === 0, errors.slice(0, 3).join(" · "));
} finally {
  await browser.close();
  await db().query(
    `DELETE FROM expense_receipts er USING receipt_blobs b
      WHERE er.sha256 = b.sha256 AND er.dedupe_key LIKE 'zz-mt-%'`).catch(() => undefined);
  await db().query("DELETE FROM receipt_mail_matches WHERE dedupe_key LIKE 'zz-mt-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-mt-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID])
    .catch(() => undefined);
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
