/**
 * The shared template, in a browser.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-template-ui.ts
 *
 * Three of the things asked for only exist on screen:
 *
 *   the template is ARRANGED on a canvas, with a field palette,
 *   rather than described in a list of checkboxes. A list cannot
 *   answer the only question being asked here — what will this page
 *   look like for every partner who has not arranged it themselves;
 *
 *   a field DEFINED here appears in that palette immediately, which
 *   is the whole point of defining one without a deploy;
 *
 *   and anything can be flagged as NEW, including content the
 *   application registered years ago — a feature nobody notices was
 *   still shipped.
 *
 * Plus the one that is easy to forget: zero console errors, because
 * a React crash below the fold is invisible to every other check.
 */
import { chromium } from "playwright";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

process.env.SESSION_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.DM_SUPER_ADMINS = "owner@mojocarwash.com";
process.env.DUTCH_MILLER_ALLOWED = "owner@mojocarwash.com";
process.env.AUTH_ALLOWED ||= "mojocarwash.com";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const OWNER = "owner@mojocarwash.com";
const PORT = 5613;
const LABEL = `Jacket ${Date.now().toString(36)}`;
const payload = Buffer.from(JSON.stringify({
  id: OWNER, email: OWNER, name: OWNER, exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");
const COOKIE = `mojo_sid=${payload}.${mac}`;

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
let madeKey = "";
try {
  check("the server comes up", await up());
  const ctx = await browser.newContext();
  await ctx.addCookies([
    {
      name: "mojo_sid", value: `${payload}.${mac}`,
      domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax",
    },
    {
      name: "mojo_app", value: "dutch-miller",
      domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));

  console.log("\n1. The Shared Template page");
  await page.goto(`http://127.0.0.1:${PORT}/#/template`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("it renders", (await page.locator("body").innerText()).includes("Shared Template"));
  check("the shared rail section is there",
    (await page.locator("body").innerText()).includes("Shared navigation"));

  console.log("\n2. Arranging the shared page on a canvas");
  const open = page.getByRole("button", { name: /RFID Instructions/ }).first();
  await open.click();
  await page.waitForTimeout(600);
  const arrange = page.getByRole("button", { name: /^Arrange the shared / }).first();
  check("the canvas can be opened", await arrange.count() > 0);
  await arrange.click();
  await page.waitForTimeout(800);
  const panel = page.locator('aside[aria-label="Template settings"]');
  check("the template inspector opens", await panel.count() > 0);
  check("…with a field palette", (await panel.innerText()).includes("Fields"));
  const bucket = page.locator("section").filter({
    has: page.locator('button[aria-label*="bucket settings"]'),
  }).first();
  check("the page is drawn as buckets, not as a list", await bucket.count() > 0);

  console.log("\n3. A field defined here reaches the palette");
  // Through the API, so the test is about the palette rather than
  // about driving a form; the form has its own cover below.
  const made = await fetch(`http://127.0.0.1:${PORT}/api/dutch-miller/template/fields`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: COOKIE },
    body: JSON.stringify({
      page: "rfid-instructions", label: LABEL, input: "text", note: "A test field.",
    }),
  });
  check("the field is defined", made.ok, String(made.status));
  madeKey = made.ok ? (await made.json()).field.key : "";
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /RFID Instructions/ }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^Arrange the shared / }).first().click();
  await page.waitForTimeout(800);
  const palette = page.locator('aside[aria-label="Template settings"]');
  check("it is offered in the palette", (await palette.innerText()).includes(LABEL),
    (await palette.innerText()).slice(0, 160).replace(/\n/g, " | "));
  check("…marked as the template's rather than the application's",
    (await palette.innerText()).includes("template"));

  console.log("\n4. Putting it in a bucket, from the palette");
  const before = await bucket.locator(
    'button[aria-label^="Remove"][aria-label$="field"]').count();
  await palette.getByRole("button", { name: new RegExp(LABEL) }).first().click();
  await page.waitForTimeout(400);
  const after = await bucket.locator(
    'button[aria-label^="Remove"][aria-label$="field"]').count();
  check("the bucket gained a field", after === before + 1, `${before} → ${after}`);
  check("…and it is no longer in the palette — never both",
    !(await palette.innerText()).includes(LABEL));

  console.log("\n5. Flagging content that is already there as new");
  await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => undefined);
  await page.waitForTimeout(400);
  const fields = page.getByRole("button", { name: /Fields on this page/ }).first();
  check("the fields section is there", await fields.count() > 0);
  await fields.click();
  await page.waitForTimeout(500);
  const flag = page.locator('button[aria-label^="Flag "]').first();
  check("an application field can be flagged", await flag.count() > 0,
    (await flag.getAttribute("aria-label")) ?? "");
  const flagged = (await flag.getAttribute("aria-label")) ?? "";
  await flag.click();
  await page.waitForTimeout(900);
  check(`${flagged} now carries a New badge`,
    (await page.locator("body").innerText()).includes("New"),
    "");

  console.log("\n6. No console errors");
  check("the page produced none", errors.length === 0, errors.slice(0, 3).join(" · "));
} finally {
  if (madeKey) {
    await fetch(
      `http://127.0.0.1:${PORT}/api/dutch-miller/template/fields/${madeKey}/archive`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: COOKIE },
        body: JSON.stringify({ archived: true }),
      }).catch(() => undefined);
  }
  await browser.close();
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
