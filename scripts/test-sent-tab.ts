/**
 * A send that landed leaves Sending and shows up under Sent.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-sent-tab.ts
 *
 * Asked for the moment the first one went through: *"worked, when
 * completed with no errors. Move this to a new Sent tab."*
 *
 * Sending held both the ones in flight and the ones that had arrived,
 * so it answered neither question it exists for — "is anything stuck"
 * and "did it work" are different, and a pile that mixes them answers
 * the first wrongly. A refusal stays in Sending, where the retry and
 * the step log are.
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
const ID = "ui-sent-tab";
const PORT = 5647;

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

/** One expense with one receipt write in the state being tested. */
const seed = async (key: string, merchant: string, cents: number, state: string) => {
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox,
                           reviewer, source, lane)
     VALUES ($1,'Eric S','2026-10-24',$2,$3,'Software, Licenses','IT & Compliance','','',
             'Card',true,$4,'','personal-mojo')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [key, merchant, cents, APP]);
  await recordCandidates([{
    dedupeKey: key, lane: "personal-mojo", messageId: `${key}-msg`,
    confidence: "strong", score: 80, reasons: ["The total matches exactly."],
    evidence: {
      messageId: `${key}-msg`, subject: "Your receipt", from: "invoice@mail.replit.com",
      receivedAt: "2026-10-24T12:00:00Z", folder: "Receipts", merchant: "Replit",
      totalCents: cents, date: "2026-10-24", currency: "USD", reference: "",
      hasAttachment: true, excerpt: "",
      attachments: [{
        id: "att-1", name: "receipt.png", contentType: "image/png", size: PNG.length,
      }],
    },
  }]);
  await decideMatch({ dedupeKey: key, messageId: `${key}-msg`, choose: true, by: APP });
  await linkReceipt({ dedupeKey: key, bytes: PNG, contentType: "image/png" });
  await db().query(
    `INSERT INTO receipt_writebacks
       (dedupe_key, kind, lane, proposed, was, message_id, attachment_id,
        state, attempts, error, proposed_by, proposed_at, settled_at, steps)
     VALUES ($1,'receipt','personal-mojo','receipt.png','',$2,'att-1',
             $3,1,'',$4, now(), now(), '[]'::jsonb)
     ON CONFLICT (dedupe_key, kind) DO UPDATE SET state = excluded.state`,
    [key, `${key}-msg`, state, APP]);
};

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
  await db().query("DELETE FROM receipt_writebacks WHERE dedupe_key LIKE 'zz-st-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM expense_receipts WHERE dedupe_key LIKE 'zz-st-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM receipt_mail_matches WHERE dedupe_key LIKE 'zz-st-%'");
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-st-%'");
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID]);
  await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "mojo-pw", label: "MOJO",
  });

  // One of each: landed, landed-because-Emburse-had-it, still going,
  // and refused.
  await seed("zz-st-1", "REPLIT", 10660, "applied");
  await seed("zz-st-2", "GITHUB", 1719, "already");
  await seed("zz-st-3", "STRIPE", 2999, "queued");
  await seed("zz-st-4", "VERCEL", 4200, "failed");

  {
    const { rows } = await db().query<{ n: string }>(
      "SELECT count(*) AS n FROM expenses WHERE dedupe_key LIKE 'zz-st-%'");
    check("the four expenses are in the table", rows[0]!.n === "4", rows[0]!.n);
    const { rows: w } = await db().query<{ dedupe_key: string; state: string }>(
      "SELECT dedupe_key, state FROM receipt_writebacks WHERE dedupe_key LIKE 'zz-st-%'"
      + " ORDER BY dedupe_key");
    check("…each with its write in the state being tested", w.length === 4,
      w.map((x) => `${x.dedupe_key}:${x.state}`).join(" "));
  }
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
    if (/receipt-mail\/preview|status of 400/.test(m.text())) return;
    errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const mojo = page.getByRole("button", { name: /Personal Tab - MOJO/ });
  if (await mojo.count() > 0) { await mojo.first().click(); await page.waitForTimeout(1200); }

  // The queue renders after its own fetch; asserting before that is
  // asserting about a page that has not drawn its tabs yet.
  await page.getByRole("button", { name: /^All\s*\d/ }).first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => undefined);
  await page.waitForTimeout(2000);

  console.log("\n1. The tab exists, and counts only what landed");
  const sentTab = page.getByRole("button", { name: /^Sent\s*\d/ });
  check("THERE IS A SENT TAB", await sentTab.count() > 0,
    (await page.locator("body").innerText()).replace(/\n/g, " | ").slice(0, 320));
  check("…counting the applied one and the already-there one, and no others",
    /Sent\s*2/.test((await sentTab.first().innerText()).replace(/\s+/g, " ")),
    (await sentTab.first().innerText()).replace(/\s+/g, " "));

  console.log("\n2. Sending holds only what is still going");
  const sendingTab = page.getByRole("button", { name: /^Sending\s*\d/ });
  check("Sending is down to the one in flight",
    /Sending\s*1/.test((await sendingTab.first().innerText()).replace(/\s+/g, " ")),
    (await sendingTab.first().innerText()).replace(/\s+/g, " "));

  console.log("\n3. What each tab actually shows");
  await sentTab.first().click();
  await page.waitForTimeout(2500);
  {
    const body = await page.locator("body").innerText();
    check("REPLIT, which was applied, is under Sent", body.includes("REPLIT"),
      body.replace(/\n/g, " | ").slice(-300));
    check("…and GITHUB, which Emburse already had", body.includes("GITHUB"));
    check("…while the one still going is NOT here", !body.includes("STRIPE"),
      body.replace(/\n/g, " | ").slice(-300));
    check("…nor the one Emburse refused", !body.includes("VERCEL"),
      body.replace(/\n/g, " | ").slice(-300));
  }

  await sendingTab.first().click();
  await page.waitForTimeout(2500);
  {
    const body = await page.locator("body").innerText();
    check("Sending shows the one in flight", body.includes("STRIPE"),
      body.replace(/\n/g, " | ").slice(-300));
    check("…and not the ones that landed",
      !body.includes("REPLIT") && !body.includes("GITHUB"),
      body.replace(/\n/g, " | ").slice(-300));
  }

  console.log("\n4. A refusal stays where the retry is");
  {
    const receipts = page.getByRole("button", { name: /^Receipts\s*\d/ });
    check("there is still a Receipts tab", await receipts.count() > 0);
    await receipts.first().click();
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    check("the refused one is in Receipts, not Sent", body.includes("VERCEL"),
      body.replace(/\n/g, " | ").slice(-300));
  }

  console.log("\n5. No console errors");
  check("the page produced none", errors.length === 0, errors.slice(0, 3).join(" · "));
} finally {
  await browser.close();
  await db().query("DELETE FROM receipt_writebacks WHERE dedupe_key LIKE 'zz-st-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM expense_receipts WHERE dedupe_key LIKE 'zz-st-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM receipt_mail_matches WHERE dedupe_key LIKE 'zz-st-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-st-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID])
    .catch(() => undefined);
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
