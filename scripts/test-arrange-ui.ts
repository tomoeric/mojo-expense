/**
 * The arranging canvas, in a browser.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-arrange-ui.ts
 *
 * Four of the things asked for are claims about the SCREEN, and a
 * typecheck cannot see any of them:
 *
 *   the bucket's remove and drag controls are at its TOP RIGHT, and
 *   each field's remove is at its TOP LEFT — opposite corners on
 *   purpose, so the two can never be mistaken for each other;
 *
 *   the width and height controls actually change the bucket on the
 *   canvas. The height one did not: the class was applied to the
 *   live page and not to the thing being edited, so the slider moved
 *   and nothing happened until after saving and leaving;
 *
 *   a bucket's field inventory offers only what that bucket could
 *   still show — never a field it is already showing, which is the
 *   duplicate somebody would make first;
 *
 *   and the page renders with NO console errors, because a React
 *   crash below the fold is invisible to every other check.
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
const PORT = 5611;
const payload = Buffer.from(JSON.stringify({
  id: OWNER, email: OWNER, name: OWNER, exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");
const COOKIE = `mojo_sid=${payload}.${mac}`;
const PAGE = "rfid-instructions";

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
let baseWas: { blockId: string; position: number; width: number; height: string }[] = [];
try {
  check("the server comes up", await up());
  const ctx = await browser.newContext();
  await ctx.addCookies([
    {
      name: "mojo_sid", value: `${payload}.${mac}`,
      domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax",
    },
    /* This person holds both products; the shell shows whichever the
       preference cookie names, and over http the real endpoint cannot
       set it because it is marked secure. */
    {
      name: "mojo_app", value: "dutch-miller",
      domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));

  console.log("\n1. The page renders");
  await page.goto(`http://127.0.0.1:${PORT}/dutchmiller#/rfid-instructions`,
    { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const arrange = page.getByRole("button", { name: /^Arrange / });
  check("the Arrange button is there", await arrange.count() > 0);

  console.log("\n2. Opening the editor");
  await arrange.first().click();
  await page.waitForTimeout(800);
  check("the inspector opens",
    await page.locator('aside[aria-label="Bucket settings"]').count() > 0);

  const bucket = page.locator("section").filter({
    has: page.locator('button[aria-label*="bucket settings"]'),
  }).first();
  check("a bucket is on the canvas", await bucket.count() > 0);

  console.log("\n3. Where the controls are");
  const box = await bucket.boundingBox();
  const removeBucket = bucket.locator('button[aria-label^="Remove"][aria-label$="bucket"]')
    .first();
  const bb = await removeBucket.boundingBox();
  check("the bucket's remove X is in its top half",
    Boolean(box && bb && bb.y < box.y + box.height / 2),
    `${bb?.y} vs ${box?.y}`);
  check("…and on its RIGHT",
    Boolean(box && bb && bb.x > box.x + box.width / 2),
    `${bb?.x} vs ${box && box.x + box.width / 2}`);

  const fieldRemove = bucket.locator('button[aria-label^="Remove"][aria-label$="field"]')
    .first();
  const fb = await fieldRemove.boundingBox();
  check("a field's remove X is in the top half of the bucket",
    Boolean(box && fb && fb.y < box.y + box.height / 2));
  check("…and on the LEFT — the opposite corner from the bucket's",
    Boolean(box && fb && bb && fb.x < bb.x),
    `field ${fb?.x} vs bucket ${bb?.x}`);

  console.log("\n4. The size controls change the bucket, visibly");
  const widthWas = (await bucket.boundingBox())?.width ?? 0;
  await page.locator('aside[aria-label="Bucket settings"]')
    .getByRole("button", { name: "2/6" }).click();
  await page.waitForTimeout(400);
  const widthNow = (await bucket.boundingBox())?.width ?? 0;
  check("2/6 makes it narrower on the canvas", widthNow < widthWas - 20,
    `${Math.round(widthWas)} → ${Math.round(widthNow)}`);
  await page.locator('aside[aria-label="Bucket settings"]')
    .getByRole("button", { name: "6/6" }).click();
  await page.waitForTimeout(400);
  check("…and 6/6 puts it back",
    Math.abs(((await bucket.boundingBox())?.width ?? 0) - widthWas) < 20);

  const tallWas = (await bucket.boundingBox())?.height ?? 0;
  const slider = page.locator('aside[aria-label="Bucket settings"] input[type="range"]');
  await slider.fill("1");
  await page.waitForTimeout(400);
  const tallShort = (await bucket.boundingBox())?.height ?? 0;
  await slider.fill("2");
  await page.waitForTimeout(400);
  const tallTall = (await bucket.boundingBox())?.height ?? 0;
  check("the height control changes the bucket on the canvas",
    tallShort !== tallWas || tallTall !== tallWas,
    `auto ${Math.round(tallWas)} · short ${Math.round(tallShort)} · tall ${Math.round(tallTall)}`);
  check("…and the panel says what it is now",
    (await page.locator('aside[aria-label="Bucket settings"]').innerText()).includes("tall"));
  await slider.fill("0");

  console.log("\n5. The inventory offers only what is not already shown");
  const shown = await bucket.locator('button[aria-label^="Remove"][aria-label$="field"]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? "")
      .replace(/^Remove /, "").replace(/ field$/, "")));
  const panel = page.locator('aside[aria-label="Bucket settings"]');
  const spare = await panel.locator("button").evaluateAll(
    (els) => els.map((e) => e.textContent?.trim() ?? ""));
  const overlap = shown.filter((s) => spare.includes(s));
  check("no field is both in the bucket and in its inventory",
    overlap.length === 0, overlap.join(", "));
  check("the inventory has a heading that says so",
    (await panel.innerText()).includes("Fields it is not showing"));

  console.log("\n6. Taking a field off puts it back in the inventory");
  const optional = bucket.locator(
    'button[aria-label^="Remove"][aria-label$="field"]:not([disabled])').first();
  const name = ((await optional.getAttribute("aria-label")) ?? "")
    .replace(/^Remove /, "").replace(/ field$/, "");
  await optional.click();
  await page.waitForTimeout(400);
  const after = await panel.locator("button").evaluateAll(
    (els) => els.map((e) => e.textContent?.trim() ?? ""));
  check(`${name} is offered again`, after.includes(name), after.slice(0, 8).join(" | "));

  console.log("\n7. The notice when the shared layout moves on");
  /*
   * The headline change, and the one that is invisible from the
   * server: a page this account arranged does NOT stop hearing from
   * the template. It keeps its arrangement and is told, with the
   * correction one click away.
   */
  await page.getByRole("button", { name: "Save this page's arrangement" }).click();
  await page.waitForTimeout(1200);
  check("the arrangement saved", await page.getByRole("button", { name: /^Arrange / })
    .count() > 0);
  check("…and the page says it is this account's",
    (await page.locator("body").innerText()).includes("own arrangement of this page"));
  check("no notice yet — nothing has changed since",
    !(await page.locator("body").innerText()).includes("shared layout has changed"));

  const read = await fetch(
    `http://127.0.0.1:${PORT}/api/dutch-miller/blocks/${PAGE}`, { headers: { cookie: COOKIE } });
  const answer = await read.json() as {
    available: { id: string }[];
    layout: { id: string; position: number; width: number; height: string }[];
  };
  // Remembered so the finally can put the SHARED layout back. This
  // test changes the template, not only an account, and leaving a
  // page reversed is not a thing to do to the next run.
  baseWas = answer.layout.map((b) => ({
    blockId: b.id, position: b.position, width: b.width, height: b.height,
  }));
  /*
   * A WIDTH change rather than a reordering. Reordering by the
   * catalogue's own order is not stable across runs — the first run
   * leaves the base in exactly the order the second one would
   * "change" it to, and the second run then finds no difference and
   * reports a bug that is the test's.
   */
  const moved = baseWas.map((b, i) => ({
    ...b, position: (i + 1) * 10, width: i === 0 ? (b.width === 6 ? 3 : 6) : b.width,
  }));
  const bumped = await fetch(
    `http://127.0.0.1:${PORT}/api/dutch-miller/template/layout/${PAGE}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify({ layout: moved }),
    });
  check("the shared layout is corrected", bumped.ok, String(bumped.status));

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const text = await page.locator("body").innerText();
  check("THE ACCOUNT IS TOLD", text.includes("shared layout has changed"),
    text.slice(0, 120).replace(/\n/g, " | "));
  check("…and told that nothing of theirs was changed",
    text.includes("still arranged the way you left it"));
  check("there is a way to take all of it",
    await page.getByRole("button", { name: "Take all of it" }).count() > 0);
  check("…and a way to keep theirs",
    await page.getByRole("button", { name: "Keep ours" }).count() > 0);

  await page.getByRole("button", { name: "Keep ours" }).click();
  await page.waitForTimeout(1200);
  check("keeping theirs clears the notice",
    !(await page.locator("body").innerText()).includes("shared layout has changed"));
  check("…and the page is still their own",
    (await page.locator("body").innerText()).includes("own arrangement of this page"));

  console.log("\n8. No console errors");
  check("the page produced none", errors.length === 0, errors.slice(0, 3).join(" · "));
} finally {
  // Put the account back on the shared layout, so a second run of
  // this file starts where the first one did.
  await fetch(`http://127.0.0.1:${PORT}/api/dutch-miller/blocks/${PAGE}/reset`,
    { method: "POST", headers: { cookie: COOKIE } }).catch(() => undefined);
  if (baseWas.length > 0) {
    await fetch(`http://127.0.0.1:${PORT}/api/dutch-miller/template/layout/${PAGE}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify({ layout: baseWas }),
    }).catch(() => undefined);
  }
  await browser.close();
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
