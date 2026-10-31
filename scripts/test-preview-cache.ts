/**
 * Looking at a receipt is not a trip to Outlook.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-preview-cache.ts
 *
 * The Receipts tab shows the PICTURE on every card, and every look
 * at one was a fresh Graph read. A screen of twelve cards is twelve
 * message reads inside a second from one app registration, and
 * Microsoft answers that the way it answers that:
 *
 *   Graph would not hand over the message (429). It may have…
 *
 * on a card, in red, about a receipt that is perfectly fine. So the
 * bytes are kept the first time they are fetched — the same bytes the
 * upload sends, in the blob store every other receipt lives in — and
 * every look after the first is a database read.
 *
 * Proved by taking Graph away entirely: there are no Microsoft
 * credentials in this container, so a preview that answers at all can
 * only have come from the app's own copy.
 *
 * Also checked, because it would be a real fault: storing the preview
 * must NOT put a receipt on the expense. Scrolling past a candidate is
 * not a decision that it is the right receipt.
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";

process.env.SESSION_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.AUTH_ALLOWED ||= "mojocarwash.com";
process.env.AUTH_ADMINS ||= "eric.s@mojocarwash.com";
// The point of the test: no mailbox is reachable.
delete process.env.AZURE_TENANT_ID;
delete process.env.AZURE_CLIENT_ID;
delete process.env.AZURE_CLIENT_SECRET;

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const APP = "eric.s@mojocarwash.com";
const ID = "ui-preview-cache";
const PORT = 5634;
const KEY = "zz-pv-1";

const payload = Buffer.from(JSON.stringify({
  id: ID, email: APP, name: APP, exp: Date.now() + 3_600_000, via: "microsoft",
})).toString("base64url");
const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
  .update(payload).digest("base64url");
const cookie = `mojo_sid=${payload}.${mac}`;

const { db, ensureSchema } = await import("../server/db.js");
const { storeBlob } = await import("../server/emburse/receipt-link.js");
const { recordCandidates } = await import("../server/emburse/receipt-mail.js");

const PDF = Buffer.from("%PDF-1.4\nREPLIT 106.60 — the receipt itself\n%%EOF");

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

const preview = (message: string) => fetch(
  `http://127.0.0.1:${PORT}/api/receipt-mail/preview?message=${encodeURIComponent(message)}`,
  { headers: { cookie } });

try {
  await db().query("DELETE FROM receipt_mail_matches WHERE dedupe_key LIKE 'zz-pv-%'");
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-pv-%'");
  await db().query(
    `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                           category, department, location, note, method, in_inbox,
                           reviewer, source, lane)
     VALUES ($1,'Eric S','2026-10-24','REPLIT',10660,'Software, Licenses','IT & Compliance',
             '','','Card',true,$2,'','personal-mojo')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [KEY, APP]);
  await recordCandidates([{
    dedupeKey: KEY, lane: "personal-mojo", messageId: "pv-msg-1",
    confidence: "strong", score: 80, reasons: ["The total matches exactly."],
    evidence: {
      messageId: "pv-msg-1", subject: "Your Replit receipt",
      from: "invoice@mail.replit.com", receivedAt: "2026-10-24T12:00:00Z",
      folder: "Receipts", merchant: "Replit", totalCents: 10660,
      date: "2026-10-24", currency: "USD", reference: "", hasAttachment: true,
      excerpt: "Thanks for your payment of $106.60.",
      attachments: [{
        id: "att-1", name: "receipt.pdf", contentType: "application/pdf",
        size: PDF.length,
      }],
    },
  }]);

  check("the server comes up", await up());

  console.log("\n1. With nothing kept, the mailbox is the only source — and it is gone");
  {
    const res = await preview("pv-msg-1");
    check("so the preview fails, as it did before this change", res.status === 400,
      `${res.status}`);
  }

  console.log("\n2. With the bytes kept, the same request is served from the app");
  const sha = await storeBlob(PDF, "application/pdf");
  await db().query(
    "UPDATE receipt_mail_matches SET preview_sha256 = $2 WHERE message_id = $1",
    ["pv-msg-1", sha]);
  {
    const res = await preview("pv-msg-1");
    check("it answers", res.status === 200, `${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    check("with the receipt's own bytes, not a re-render",
      body.equals(PDF), `${body.length} bytes`);
    check("typed as what it is", res.headers.get("content-type") === "application/pdf",
      res.headers.get("content-type") ?? "none");
    check("shown rather than downloaded",
      (res.headers.get("content-disposition") ?? "").startsWith("inline"),
      res.headers.get("content-disposition") ?? "none");
    check("and kept private", (res.headers.get("cache-control") ?? "").includes("private"));
  }

  console.log("\n3. Ten more looks, and Graph is still not needed");
  {
    const codes = await Promise.all(
      Array.from({ length: 10 }, () => preview("pv-msg-1").then((r) => r.status)));
    check("every one of them answers from the app",
      codes.every((c) => c === 200), codes.join(","));
  }

  console.log("\n4. Keeping a preview is not deciding the match");
  {
    const { rows } = await db().query<{ n: string }>(
      "SELECT count(*) AS n FROM expense_receipts WHERE dedupe_key = $1", [KEY]);
    check("no receipt was put on the expense", rows[0]!.n === "0", rows[0]!.n);
    const { rows: m } = await db().query<{ state: string; linked: string | null }>(
      "SELECT state, linked_sha256 AS linked FROM receipt_mail_matches WHERE message_id = $1",
      ["pv-msg-1"]);
    check("and the match is still only a candidate", m[0]!.state === "candidate",
      m[0]!.state);
    check("with nothing linked", m[0]!.linked === null, String(m[0]!.linked));
  }

  console.log("\n5. A chosen match's own file is used before any preview copy");
  {
    const other = await storeBlob(
      Buffer.from("%PDF-1.4\nthe one that was chosen\n%%EOF"), "application/pdf");
    await db().query(
      "UPDATE receipt_mail_matches SET linked_sha256 = $2 WHERE message_id = $1",
      ["pv-msg-1", other]);
    const body = Buffer.from(await (await preview("pv-msg-1")).arrayBuffer());
    check("the linked receipt is what is shown",
      body.toString().includes("the one that was chosen"), body.toString().slice(0, 60));
  }

  console.log("\n6. Somebody else's match is still none of this person's business");
  {
    await db().query("UPDATE expenses SET reviewer = $2 WHERE dedupe_key = $1",
      [KEY, "someone.else@mojocarwash.com"]);
    const res = await preview("pv-msg-1");
    check("scoping did not become a cache lookup that skips it", res.status === 404,
      `${res.status}`);
  }
} finally {
  await db().query("DELETE FROM receipt_mail_matches WHERE dedupe_key LIKE 'zz-pv-%'")
    .catch(() => undefined);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-pv-%'")
    .catch(() => undefined);
  server.kill("SIGTERM");
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
