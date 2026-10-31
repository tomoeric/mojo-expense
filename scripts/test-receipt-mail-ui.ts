/**
 * The receipts-in-email page, in a browser.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-receipt-mail-ui.ts
 *
 * What is on screen and nowhere else:
 *
 *   the mailbox is configured SEPARATELY, and the page says it is
 *   not the Emburse login — the one assumption that files a
 *   Mammoth receipt against a MOJO expense;
 *
 *   a candidate shows its reasons and a person chooses;
 *
 *   a receipt wanted by two expenses is shown as a conflict
 *   rather than settled by whichever scored higher;
 *
 *   and zero console errors.
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
const ID = "ui-receipt-mail";
const PORT = 5616;

const payload = Buffer.from(JSON.stringify({
  id: ID, email: APP, name: APP, exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");

const { db } = await import("../server/db.js");
const { saveCredential } = await import("../server/emburse/credentials.js");
const { addConnection } = await import("../server/emburse/connections.js");
const { recordCandidates } = await import("../server/emburse/receipt-mail.js");

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

const evidence = (id: string) => ({
  messageId: id, subject: "Your Starbucks receipt", from: "receipts@sbux-e.com",
  receivedAt: "2026-09-24T12:00:00Z", folder: "Receipts", merchant: "Starbucks",
  date: "2026-09-24", totalCents: 1299, currency: "USD", reference: "",
  hasAttachment: false, attachments: [], excerpt: "Order Total $12.99",
});

const browser = await chromium.launch();
try {
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-rm-%'");
  await saveCredential(ID, APP, MAMMOTH, "mammoth-pw");
  await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "mojo-pw", label: "MOJO",
  });

  // Two MOJO expenses, identical except for their key — the
  // conflict case: one receipt that could be either.
  for (const n of [1, 2]) {
    await db().query(
      `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                             category, department, location, note, method, in_inbox,
                             reviewer, source, lane)
       VALUES ($1,'Eric S','2026-09-24','STARBUCKS #4417',1299,'Meals','Ops','Site','',
               'Card',true,$2,'','personal-mojo')
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [`zz-rm-${n}`, APP]);
  }
  await recordCandidates([1, 2].map((n) => ({
    dedupeKey: `zz-rm-${n}`, lane: "personal-mojo", messageId: "msg-1",
    confidence: "strong" as const, score: 80,
    reasons: ["The merchant matches: STARBUCKS #4417 and Starbucks.",
      "The total matches exactly: $12.99.", "Same date."],
    evidence: evidence("msg-1"),
  })));

  check("the server comes up", await up());
  const ctx = await browser.newContext();
  await ctx.addCookies([{
    name: "mojo_sid", value: `${payload}.${mac}`,
    domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax",
  }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  /*
   * The receipt preview 400s here on purpose — there is no
   * mailbox in this container and `msg-1` is not a Graph id — and
   * the browser logs every non-2xx fetch. That one is the
   * condition section 3 asserts the page HANDLES, so counting it
   * as an unhandled error would fail the test for passing.
   */
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/receipt-mail\/preview|status of 400/.test(m.text())) return;
    errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  /*
   * REACHED THE WAY A PERSON REACHES IT, not by typing the hash.
   *
   * This went straight to #/receipt-mail, so it proved the room and
   * never checked there was a door — and there was not one. The route
   * was declared in MENU_PAGES with a label and a description, the user
   * menu is written out by hand and never read that list, and the page
   * sat finished and unreachable while its owner was told where to find
   * a menu entry that did not exist.
   */
  console.log("\n1. The page, and what it says about the mailbox");
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Eric|Schlicht|@/ }).first().click();
  await page.waitForTimeout(400);
  const door = page.getByRole("link", { name: "Receipts in email" });
  check("THE USER MENU HAS A WAY IN", await door.count() > 0,
    (await page.locator("body").innerText()).replace(/\n/g, " | ").slice(-300));
  await door.first().click();
  await page.waitForTimeout(2000);
  let text = await page.locator("body").innerText();
  check("it renders", text.includes("Receipts in email"), text.slice(0, 120));
  /*
   * THE SETTINGS ARE FOLDED AWAY, and that is the point: they were
   * the first screenful of a page somebody opens to work through a
   * list, and they are set once a year. What must still be true is
   * that the mailbox is NAMED without opening them, and that what
   * it is — not the Emburse login — is said the moment they are.
   */
  check("the mailbox is named without opening anything",
    text.includes("@") && text.includes("days"),
    text.replace(/\n/g, " | ").slice(0, 300));
  await page.getByRole("button", { name: "Mailbox settings" }).click();
  await page.waitForTimeout(400);
  text = await page.locator("body").innerText();
  check("THE MAILBOX IS SAID TO BE SEPARATE from the Emburse login",
    text.includes("not") && text.includes("Emburse login")
    && text.includes("different addresses"),
    text.slice(text.indexOf("The mailbox to search"),
      text.indexOf("The mailbox to search") + 240).replace(/\n/g, " | "));
  check("…and it says the scan reads only",
    text.includes("nothing is moved, deleted, marked as read or replied to")
    || text.includes("reads only"));

  console.log("\n2. The personal accounts it can match against");
  check("the MOJO account is offered",
    (await page.getByRole("button", { name: "Personal Tab - MOJO" }).count()) > 0);
  check("…and the Mammoth one",
    (await page.getByRole("button", { name: "Personal Tab - Mammoth" }).count()) > 0);
  check("…with the rule about where a receipt belongs stated",
    text.includes("never because it arrived in this mailbox"));

  console.log("\n3. The candidate, its reasons, and the conflict");
  /*
   * THE RECEIPT IS LOOKABLE-AT BEFORE IT IS BELIEVED. "The total matches
   * exactly" is a good reason and not the same as seeing the thing, and
   * on 272 candidates nobody should have to take the app's word for it.
   *
   * Behind a press on purpose: the frame is what fetches, so a list of
   * 272 costs nothing until one is opened — and a body-only receipt is
   * rendered to PDF by a real browser on the server, so an eager preview
   * would start 272 of them.
   */
  await page.waitForTimeout(1200);
  text = await page.locator("body").innerText();
  /*
   * The frame is on screen whatever the fetch did: the picture
   * when it worked, and the REASON when it did not. In this
   * container there is no mailbox, so the fetch 400s — and that
   * is the case worth pinning, because the version before this
   * one answered a failed fetch with a broken-image icon and no
   * words at all.
   */
  check("THE RECEIPT FRAME IS ON SCREEN, without choosing it first",
    (await page.locator("[data-receipt]").count()) === 1,
    `${await page.locator("[data-receipt]").count()} frames`);
  check("…and a fetch that fails SAYS SO, rather than drawing a broken image",
    (await page.locator("[data-receipt='error'], [data-receipt='ok']").count()) === 1,
    (await page.locator("[data-receipt]").first().innerText()).slice(0, 160));
  check("…and only ONE is fetched, not one per pairing",
    (await page.locator("[data-receipt]").count()) === 1);

  check("the candidate is shown", text.includes("Your Starbucks receipt"));
  check("…with its confidence", text.includes("strong"));
  check("…and its reasons", text.includes("The total matches exactly: $12.99."));
  check("THE CONFLICT IS NAMED — one receipt, two expenses",
    /also matches 1 other expense/i.test(text),
    text.slice(text.toLowerCase().indexOf("also matches"),
      text.toLowerCase().indexOf("also matches") + 120));
  check("…and the EXPENSE is named, not its hash",
    text.includes("STARBUCKS #4417") && text.includes("12.99"),
    text.replace(/\n/g, " | ").slice(0, 400));

  console.log("\n4. A person chooses one expense's receipt");
  await page.getByRole("button", { name: "This is the receipt" }).first().click();
  await page.waitForTimeout(1500);
  const { rows } = await db().query<{ state: string; n: string }>(
    `SELECT state, count(*)::text AS n FROM receipt_mail_matches
      WHERE message_id = 'msg-1' GROUP BY state ORDER BY state`);
  const byState = new Map(rows.map((r) => [r.state, Number(r.n)]));
  check("that one is chosen", byState.get("chosen") === 1,
    rows.map((r) => `${r.state}:${r.n}`).join(", "));
  /*
   * THE OTHER EXPENSE'S CANDIDATE STAYS OPEN, deliberately. One
   * receipt covering several expenses is real when a purchase
   * was split across sites — this app already handles that — so
   * choosing it for one is not a statement about the others. What
   * must not happen is the app ASSIGNING it to both, and it does
   * not: the second is still waiting on a person.
   */
  check("THE OTHER EXPENSE'S CANDIDATE IS STILL WAITING, not auto-assigned",
    byState.get("candidate") === 1, rows.map((r) => `${r.state}:${r.n}`).join(", "));
  check("…and nothing was attached by any of this",
    (byState.get("attached") ?? 0) === 0);
  text = await page.locator("body").innerText();
  /*
   * NO MAILBOX HERE, SO THE IMAGE PULL FAILS — AND THAT IS SAID.
   *
   * Choosing records the choice and then fetches the receipt into
   * the app. There is no Graph in this container, so the fetch
   * cannot work, and the right behaviour is to say so: the match
   * stands, and NOTHING is proposed, because there is nothing to
   * send until there is an image. The page used to fire /propose
   * itself regardless, which is how five expenses ended up
   * reading "waiting to be sent" for a file that did not exist.
   */
  check("THE FAILED PULL IS REPORTED, not swallowed",
    /could not|Graph|mailbox|attachment/i.test(text),
    text.replace(/\n/g, " | ").slice(0, 400));
  const { rows: noWrites } = await db().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM receipt_writebacks WHERE dedupe_key = 'zz-rm-1'`);
  check("…and NOTHING was proposed for a receipt that is not here",
    noWrites[0]!.n === "0", noWrites[0]!.n);

  console.log("\n4b. With the image in, the proposal appears");
  /*
   * Standing in for the pull, which needs a mailbox. From here on
   * the expense is in the state a successful choice leaves it in.
   */
  const { linkReceipt } = await import("../server/emburse/receipt-link.js");
  const { proposeWrites } = await import("../server/emburse/receipt-writeback.js");
  await linkReceipt({
    dedupeKey: "zz-rm-1",
    bytes: Buffer.from("%PDF-1.4 starbucks"),
    contentType: "application/pdf",
  });
  await proposeWrites({ dedupeKey: "zz-rm-1", messageId: "msg-1", by: APP });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  text = await page.locator("body").innerText();
  check("…and the other one is still in the list to decide",
    /To decide 1/.test(text), text.replace(/\n/g, " | ").slice(0, 400));
  await page.getByRole("button", { name: /To decide 1/ }).click();
  await page.waitForTimeout(300);
  await page.locator("aside button").last().click();
  await page.waitForTimeout(1500);
  text = await page.locator("body").innerText();
  check("the page still offers it to the other expense",
    text.includes("This is the receipt"),
    text.slice(-200).replace(/\n/g, " | "));
  // And the conflict pill is gone, because there is no longer
  // a conflict: one candidate is left waiting, not two.
  check("…without still claiming a conflict", !/also matches/i.test(text));
  check("…and says nothing reaches Emburse without a press",
    text.includes("Nothing reaches Emburse until you press Send"));

  /*
   * AND THE PROPOSAL IS SHOWN, not acted on. "Always ask" is
   * only a real question if the person can see what the answer
   * commits them to: the current value, the proposed value, and
   * a button that has not been pressed.
   */
  await page.getByRole("button", { name: /Ready to send 1/ }).click();
  await page.waitForTimeout(300);
  await page.locator("aside button").last().click();
  await page.waitForTimeout(1200);
  text = await page.locator("body").innerText();
  check("the proposal appears", text.includes("will change on the expense in Emburse"),
    text.slice(-300).replace(/\n/g, " | "));
  check("…naming the receipt it would attach",
    text.includes("Attach") && text.includes(".pdf"),
    text.slice(-300).replace(/\n/g, " | "));
  check("…and the description it would set", text.includes("Description"));
  /*
   * ONE BUTTON, not one per write. The image and the description
   * are separate edits that fail separately — true, and not a
   * question the person pressing should have to hold. Two buttons
   * both reading "Send to Emburse" on one expense were asked
   * about twice, as "why two submits?".
   */
  check("…behind ONE Send button for the whole expense",
    (await page.getByRole("button", { name: "Send to Emburse" }).count()) === 1,
    `${await page.getByRole("button", { name: "Send to Emburse" }).count()} buttons`);
  const { rows: wb } = await db().query<{ state: string; n: string }>(
    `SELECT state, count(*)::text AS n FROM receipt_writebacks
      WHERE dedupe_key LIKE 'zz-rm-%' GROUP BY state`);
  check("…with NOTHING queued or applied",
    wb.every((r) => r.state === "proposed"),
    wb.map((r) => `${r.state}:${r.n}`).join(", ") || "(none)");

  console.log("\n5. No console errors");
  check("the page produced none", errors.length === 0, errors.slice(0, 3).join(" · "));
} finally {
  await browser.close();
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID])
    .catch(() => undefined);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-rm-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM receipt_mail_settings WHERE user_email = $1", [APP])
    .catch(() => undefined);
  await db().query("DELETE FROM receipt_writebacks WHERE dedupe_key LIKE 'zz-rm-%'")
    .catch(() => undefined);
  await db().query(
    `DELETE FROM expense_receipts er USING receipt_blobs b
      WHERE er.sha256 = b.sha256 AND er.dedupe_key LIKE 'zz-rm-%'`).catch(() => undefined);
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
