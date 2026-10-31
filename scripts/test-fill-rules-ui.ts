/**
 * The Vendor rules page, in a browser.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-fill-rules-ui.ts
 *
 * REACHED THE WAY A PERSON REACHES IT. "Receipts in email" was
 * built, routable, tested and unreachable for a week because the
 * user menu is written out by hand and nobody added the link —
 * the test went straight to the hash, so it proved the room and
 * never checked there was a door. This one opens the menu.
 *
 * And the two things the page exists to do: show what this
 * person's own expenses already imply about a vendor, and turn
 * one of those into a rule in one press.
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
const ID = "ui-fill-rules";
const PORT = 5627;

const payload = Buffer.from(JSON.stringify({
  id: ID, email: APP, name: APP, exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");

const { db, ensureSchema } = await import("../server/db.js");
const { addConnection } = await import("../server/emburse/connections.js");
const { ensureFillRules } = await import("../server/emburse/fill-rules.js");

await ensureSchema();
await ensureFillRules();

const server = spawn("node", ["dist/server.js"], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => undefined);
server.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));

const browser = await chromium.launch();
try {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-fru-%'");
  await db().query("DELETE FROM expense_fill_rules WHERE lower(owner) = lower($1)", [APP]);
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID]);
  await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "pw", label: "MOJO",
  });
  // Three REPLIT expenses already categorised by hand: the
  // history the suggestion is read out of.
  for (const n of [1, 2, 3]) {
    await db().query(
      `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                             category, department, location, note, method, in_inbox,
                             reviewer, source, lane)
       VALUES ($1,'Eric S','2026-10-24','REPLIT',10660,
               'Technology/Software, Licenses, and Subscriptions','IT & Compliance',
               'Corporate-Pure Magic','','Card',true,$2,'','personal-mojo')
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [`zz-fru-${n}`, APP]);
  }

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

  console.log("1. There is a way in, WHERE SOMEBODY LOOKS FOR IT");
  /*
   * In the rail, under Rules. This shipped reachable only from
   * the avatar menu — a defensible place for a setting, and the
   * wrong one for this: the owner clicked Rules in the left nav,
   * found the flagging rules, and asked "I want a rule section,
   * don't see one". They are rules.
   */
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Rules" }).first().click();
  await page.waitForTimeout(800);
  const door = page.getByRole("button", { name: "Vendor rules" });
  check("RULES IN THE LEFT NAV LEADS TO IT", await door.count() > 0,
    (await page.locator("body").innerText()).replace(/\n/g, " | ").slice(0, 300));
  await door.first().click();
  await page.waitForTimeout(2000);

  let text = await page.locator("body").innerText();
  console.log("\n2. What it says it will and will not do");
  check("it renders", text.includes("Vendor rules"), text.slice(0, 120));
  check("A RULE DOES NOT SEND — it is said on the page",
    /Nothing is written to Emburse by a rule on its own/i.test(text),
    text.replace(/\n/g, " | ").slice(0, 400));

  console.log("\n3. The history writes the rule");
  check("the vendor is suggested from its own expenses",
    text.includes("REPLIT"), text.replace(/\n/g, " | ").slice(-400));
  check("…with the count that makes it checkable", /\(3 of 3\)/.test(text),
    text.replace(/\n/g, " | ").slice(-400));
  await page.getByRole("button", { name: "Make this a rule" }).first().click();
  await page.waitForTimeout(400);
  text = await page.locator("body").innerText();
  check("…and pressing it fills the form rather than saving behind your back",
    text.includes("A new vendor rule"), text.replace(/\n/g, " | ").slice(-300));
  // The four boxes on Emburse's own Edit Expense Details form,
  // named as that form names them — this is checked on the FORM
  // rather than the empty page, where only the suggestion chips
  // are on screen and they are abbreviated.
  check("…with the four fields named as Emburse's form names them",
    text.includes("Business Purpose") && text.includes("Location / Site")
    && text.includes("Department") && text.includes("Category"),
    text.replace(/\n/g, " | ").slice(-400));
  const { rows: none } = await db().query<{ n: string }>(
    "SELECT count(*)::text AS n FROM expense_fill_rules WHERE lower(owner) = lower($1)",
    [APP]);
  check("NOTHING WAS SAVED BY THE PRESS", none[0]!.n === "0", none[0]!.n);

  console.log("\n4. Saving it");
  await page.getByRole("button", { name: "Save the rule" }).click();
  await page.waitForTimeout(1500);
  const { rows: saved } = await db().query<{
    vendor: string; category: string; department: string;
  }>("SELECT vendor, category, department FROM expense_fill_rules WHERE lower(owner) = lower($1)",
    [APP]);
  check("the rule is stored", saved.length === 1, JSON.stringify(saved));
  check("…with the category the history implied",
    saved[0]?.category === "Technology/Software, Licenses, and Subscriptions",
    saved[0]?.category);
  text = await page.locator("body").innerText();
  check("…and it is in the table now", /1 vendor rule/.test(text),
    text.replace(/\n/g, " | ").slice(0, 300));
  check("…and no longer offered as a suggestion",
    !text.includes("Make this a rule"));

  console.log("\n5. No console errors");
  check("the page produced none", errors.length === 0, errors.slice(0, 3).join(" · "));
} finally {
  await browser.close();
  await db().query("DELETE FROM expense_fill_rules WHERE lower(owner) = lower($1)", [APP])
    .catch(() => undefined);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-fru-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID])
    .catch(() => undefined);
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
