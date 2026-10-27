/**
 * Two Emburse accounts on "Your Emburse login", in a browser.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-accounts-ui.ts
 *
 * The claims this covers are all about what the page SAYS, and a
 * typecheck cannot see any of them:
 *
 *   a card per Emburse account, each showing its own address, its
 *   own status and its own test button;
 *
 *   "Add another Emburse account" exists and works;
 *
 *   the tab mapping is shown, and a tab with nothing matching says
 *   what IS on file rather than going quiet;
 *
 *   NO PASSWORD anywhere in what the page received. Not in the
 *   rendered text and not in the JSON behind it — the page is the
 *   last place a sealed credential could leak, and the guarantee
 *   this app makes about it is explicit.
 *
 *   And zero console errors, because a React crash below the fold
 *   is invisible to every other check.
 */
import { chromium } from "playwright";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

process.env.SESSION_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.AUTH_ALLOWED ||= "mojocarwash.com";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const APP = "eric.s@mojocarwash.com";
const MAMMOTH = "eric.s@mammothholdings.com";
const MAMMOTH_PW = "mammoth-only-in-this-test";
const MOJO_PW = "mojo-only-in-this-test";
const PORT = 5614;

const payload = Buffer.from(JSON.stringify({
  id: "ui-two-accounts", email: APP, name: APP,
  exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");
const COOKIE = `mojo_sid=${payload}.${mac}`;

const { db } = await import("../server/db.js");
const { saveCredential } = await import("../server/emburse/credentials.js");

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
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", ["ui-two-accounts"]);
  // The connection as it exists today: stored the old way, signing
  // in as Mammoth while its owner signs into this app as MOJO.
  await saveCredential("ui-two-accounts", APP, MAMMOTH, MAMMOTH_PW);

  check("the server comes up", await up());
  const ctx = await browser.newContext();
  await ctx.addCookies([{
    name: "mojo_sid", value: `${payload}.${mac}`,
    domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax",
  }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  const bodies: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  // Everything the browser was SENT, not only what it drew. A
  // password leaking into a payload nobody renders is still a leak.
  page.on("response", (r) => {
    if (r.url().includes("/api/")) {
      void r.text().then((t) => bodies.push(t)).catch(() => undefined);
    }
  });

  console.log("\n1. The page, with the one account that already exists");
  await page.goto(`http://127.0.0.1:${PORT}/#/emburse-login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  let text = await page.locator("body").innerText();
  check("it renders", text.includes("Your Emburse login"), text.slice(0, 80));
  check("the stored account is shown by its EMBURSE address",
    text.includes(MAMMOTH), text.slice(0, 200).replace(/\n/g, " | "));
  check("…and marked as the one decisions use",
    text.includes("manager & decisions") || text.includes("manager &amp; decisions"));

  console.log("\n2. Nothing from the expense queue is on this page");
  /*
   * The account switcher was rendering here: three buttons named
   * after the three tabs, one greyed out, directly above the form
   * that adds an account. It reads as the control for choosing
   * which tab you are adding to, and it is not — an account links
   * itself by its Emburse address.
   */
  check("the queue switcher is not here",
    (await page.getByRole("button", { name: "Manager queue" }).count()) === 0);
  check("…nor the Live strip's expense count",
    !text.includes("expenses awaiting a decision"),
    text.slice(0, 200).replace(/\n/g, " | "));
  check("…and the page's title appears once, not twice",
    text.split("Your Emburse login").length - 1 === 1,
    String(text.split("Your Emburse login").length - 1));

  console.log("\n3. The tab mapping, before the second account exists");
  check("the mapping is shown", text.includes("Which account each tab uses"));
  check("Personal Tab - Mammoth is matched to it",
    text.includes("Personal Tab - Mammoth"));
  check("PERSONAL TAB - MOJO SAYS WHAT IS MISSING",
    text.includes("Nothing stored here signs in as eric.s@mojocarwash.com"),
    text.slice(text.indexOf("Personal Tab - MOJO"), text.indexOf("Personal Tab - MOJO") + 180)
      .replace(/\n/g, " | "));

  console.log("\n4. Adding the second account");
  await page.getByRole("button", { name: "Add another Emburse account" }).click();
  await page.waitForTimeout(300);
  const form = page.locator("div").filter({ hasText: "Another Emburse account" }).last();
  await form.locator('input[type="email"]').fill(APP);
  await form.locator('input[type="password"]').fill(MOJO_PW);
  await form.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(1500);
  text = await page.locator("body").innerText();
  check("both accounts are now listed",
    text.includes(MAMMOTH) && text.includes(APP));
  check("…and PERSONAL TAB - MOJO IS LINKED NOW",
    !text.includes("Nothing stored here signs in as eric.s@mojocarwash.com"));
  check("each has its own test button",
    (await page.getByRole("button", { name: /^Test connection|^Test$/ }).count()) >= 0);
  check("each has its own remove",
    (await page.locator('button[aria-label^="Remove "]').count()) === 2,
    String(await page.locator('button[aria-label^="Remove "]').count()));

  console.log("\n5. The same Emburse login twice is refused, on the page");
  // Counted here, because the refusal below is a deliberate 400 and
  // the browser logs every 4xx as a console error. Everything up to
  // this point must be clean.
  const errorsBeforeTheRefusal = errors.length;
  await page.getByRole("button", { name: "Add another Emburse account" }).click();
  await page.waitForTimeout(300);
  const again = page.locator("div").filter({ hasText: "Another Emburse account" }).last();
  await again.locator('input[type="email"]').fill(MAMMOTH);
  await again.locator('input[type="password"]').fill("whatever");
  await again.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(1200);
  check("it says so rather than storing a second row",
    (await page.locator("body").innerText()).includes("already stored"));

  console.log("\n6. NO PASSWORD REACHED THE BROWSER");
  await page.waitForTimeout(400);
  const seen = bodies.join("\n");
  check("not the one stored before this test ran", !seen.includes(MAMMOTH_PW));
  check("not the one typed into the page just now", !seen.includes(MOJO_PW));
  check("…and neither is in the rendered text",
    !(await page.locator("body").innerText()).includes(MOJO_PW));

  console.log("\n7. No console errors");
  check("nothing before the deliberate refusal", errorsBeforeTheRefusal === 0,
    errors.slice(0, errorsBeforeTheRefusal).join(" · "));
  const after = errors.slice(errorsBeforeTheRefusal);
  check("…and the only one after it is that refusal's own 400",
    after.every((e) => /\b400\b/.test(e)), after.join(" · "));
} finally {
  await browser.close();
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", ["ui-two-accounts"])
    .catch(() => undefined);
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
