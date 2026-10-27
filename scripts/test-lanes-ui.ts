/**
 * Three tabs in Export settings, in a browser.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-lanes-ui.ts
 *
 * The claim is that Eric now has a Manager tab and two
 * distinguishable personal tabs, that each one shows its own
 * Emburse address, and that selecting one selects which account
 * the panel below configures and runs. All of that is on screen
 * and none of it is visible to a typecheck.
 *
 * The case worth most: a personal tab with no Emburse account
 * linked says so and is switched off, rather than appearing ready
 * and failing twenty minutes later.
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
const MAMMOTH = "eric.s@mammothholdings.com";
const ID = "ui-lanes-user";
const PORT = 5615;

const payload = Buffer.from(JSON.stringify({
  id: ID, email: APP, name: APP, exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");

const { db } = await import("../server/db.js");
const { saveCredential } = await import("../server/emburse/credentials.js");
const { addConnection } = await import("../server/emburse/connections.js");

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
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID]);
  await db().query("DELETE FROM reviewer_imports WHERE user_email = $1", [APP]);
  // The connection as it exists today: Mammoth, stored the old way.
  await saveCredential(ID, APP, MAMMOTH, "mammoth-password");

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

  console.log("\n1. The three tabs");
  await page.goto(`http://127.0.0.1:${PORT}/#/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  let text = await page.locator("body").innerText();
  check("Manager tab is offered",
    (await page.getByRole("button", { name: "Manager tab" }).count()) > 0,
    text.slice(0, 160).replace(/\n/g, " | "));
  check("Personal Tab - MOJO is offered",
    (await page.getByRole("button", { name: /^Personal Tab - MOJO/ }).count()) > 0);
  check("Personal Tab - Mammoth is offered",
    (await page.getByRole("button", { name: /^Personal Tab - Mammoth/ }).count()) > 0);

  console.log("\n2. The Mammoth tab, which IS linked");
  await page.getByRole("button", { name: /^Personal Tab - Mammoth/ }).click();
  await page.waitForTimeout(800);
  text = await page.locator("body").innerText();
  check("it names the Emburse address it signs in as", text.includes(MAMMOTH),
    text.slice(0, 200).replace(/\n/g, " | "));
  check("…and says its settings are its own",
    text.includes("nothing here touches the manager queue"));

  console.log("\n3. The MOJO tab, which is NOT linked");
  await page.getByRole("button", { name: /^Personal Tab - MOJO/ }).click();
  await page.waitForTimeout(800);
  text = await page.locator("body").innerText();
  check("it says it has no Emburse account linked",
    text.includes("has no Emburse account linked"),
    text.slice(0, 220).replace(/\n/g, " | "));
  check("…and says it is switched off rather than failing",
    text.includes("switched off rather than failing"));
  check("…and names the address it is waiting for", text.includes(APP));

  console.log("\n4. Linking it changes what the tab says");
  const added = await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "mojo-password", label: "MOJO",
  });
  check("the MOJO account is stored", added.ok === true);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: /^Personal Tab - MOJO/ }).click();
  await page.waitForTimeout(800);
  text = await page.locator("body").innerText();
  check("THE TAB IS LINKED NOW", !text.includes("has no Emburse account linked"));
  check("…and signs in as the MOJO address", text.includes(APP));

  console.log("\n5. A setting saved on one tab does not appear on the other");
  // Saved through the API, because the point under test is which
  // tab the page READS BACK, not which control writes it.
  await fetch(`http://127.0.0.1:${PORT}/api/reviewer-imports`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `mojo_sid=${payload}.${mac}` },
    body: JSON.stringify({ email: APP, lane: "personal-mojo", gridQuery: "?only=mojo" }),
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: /^Personal Tab - MOJO/ }).click();
  await page.waitForTimeout(600);
  // The filter is shown inside "Advanced", which is a closed
  // <details>; a closed one contributes nothing to innerText.
  const advanced = page.locator("summary", { hasText: "Advanced" });
  if (await advanced.count() > 0) { await advanced.first().click(); }
  await page.waitForTimeout(400);
  const mojoText = await page.locator("body").innerText();
  check("the MOJO tab shows it", mojoText.includes("?only=mojo"),
    mojoText.replace(/\n/g, " | ").slice(-400));
  const openAdvanced = async () => {
    const d = page.locator("summary", { hasText: "Advanced" });
    if (await d.count() > 0) await d.first().click();
    await page.waitForTimeout(400);
  };
  await page.getByRole("button", { name: /^Personal Tab - Mammoth/ }).click();
  await openAdvanced();
  check("THE MAMMOTH TAB DOES NOT",
    !(await page.locator("body").innerText()).includes("?only=mojo"));
  await page.getByRole("button", { name: "Manager tab" }).click();
  await openAdvanced();
  check("…nor does the manager tab",
    !(await page.locator("body").innerText()).includes("?only=mojo"));

  console.log("\n6. No console errors");
  check("the page produced none", errors.length === 0, errors.slice(0, 3).join(" · "));
} finally {
  await browser.close();
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID])
    .catch(() => undefined);
  await db().query("DELETE FROM reviewer_imports WHERE user_email = $1", [APP])
    .catch(() => undefined);
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
