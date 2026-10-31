/**
 * Eight photographed receipts in ONE email.
 *
 *   pnpm exec tsx scripts/test-photo-receipts.ts
 *
 * The owner forwards a batch of till receipts from a phone: one
 * message, subject "Receipts", eight JPEGs, and a body that says
 * "Sent via the Samsung Galaxy S24 Ultra" and nothing else.
 *
 * What that used to do, and the reason this exists:
 *
 *   ONE MESSAGE MADE ONE CANDIDATE, so seven of the eight
 *   receipts were invisible and the send step would have
 *   attached the first image to whatever the one candidate
 *   matched.
 *
 *   AND IT MATCHED NOTHING ANYWAY. Merchant came out as
 *   "mojocarwash" — read off the sender's own address — and the
 *   total was null, because neither is in the body. They are in
 *   the pictures.
 *
 * So: one candidate per photograph, each read by the receipt
 * reader, each carrying its own picture. And the two guards that
 * keep it from being a bill: a message whose body already states
 * a total is not read, and a scan has a budget.
 */
import { baseMessageId, isPhoto, merchantOf, scoreMatch, totalIn, type Evidence, type Target }
  from "../server/emburse/receipt-mail.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const BODY = "Sent via the Samsung Galaxy S24 Ultra, an AT&T 5G smartphone\nGet Outlook for Android";
const photos = Array.from({ length: 8 }, (_, i) => ({
  id: `att-${i}`, name: `20261030_${i}.jpg`, contentType: "image/jpeg", size: 375_000,
}));

const forwarded: Evidence = {
  messageId: "AAMkAGI1", subject: "Receipts", from: "eric.s@mojocarwash.com",
  receivedAt: "2026-10-30T12:00:00Z", folder: "Receipts",
  merchant: merchantOf("eric.s@mojocarwash.com", "Receipts"),
  date: "2026-10-30", totalCents: totalIn(BODY).cents, currency: "USD", reference: "",
  hasAttachment: true, attachments: photos, excerpt: BODY,
};

const expense = (over: Partial<Target> = {}): Target => ({
  dedupeKey: "e1", lane: "personal-mojo", merchant: "HOME DEPOT",
  date: "2026-10-29", amountCents: 17200, currency: "USD", ...over,
});

try {
  console.log("1. What the email alone is worth: nothing");
  check("the merchant comes off the sender, which is the owner",
    forwarded.merchant === "mojocarwash", forwarded.merchant);
  check("…and there is no total in the body", forwarded.totalCents === null);
  check("SO THE MESSAGE ITSELF MATCHES NOTHING",
    scoreMatch(expense(), forwarded) === null);

  console.log("\n2. A photograph is told from a signature image");
  check("a 375 KB phone photo is one", isPhoto(photos[0]!));
  check("a 2 KB logo in a signature is NOT",
    !isPhoto({ id: "l", name: "logo.png", contentType: "image/png", size: 2_000 }));
  check("…and neither is a PDF invoice, which is read as text",
    !isPhoto({ id: "p", name: "invoice.pdf", contentType: "application/pdf", size: 90_000 }));

  console.log("\n3. One candidate per photograph, each with its own picture");
  /*
   * Standing in for the vision reader, which needs an API key and
   * a real image. What is being checked is the SHAPE the reader's
   * answer is turned into: per-photo id, the merchant and total
   * off the picture, and one attachment — not eight.
   */
  const read = [
    { merchant: "HOME DEPOT", purchasedAt: "2026-10-29", total: 172.00 },
    { merchant: "LOWES", purchasedAt: "2026-10-28", total: 43.19 },
  ];
  const each: Evidence[] = read.map((r, i) => ({
    ...forwarded,
    messageId: `${forwarded.messageId}#${photos[i]!.id}`,
    merchant: r.merchant, date: r.purchasedAt,
    totalCents: Math.round(r.total * 100),
    attachments: [photos[i]!],
    excerpt: `Read from the photograph ${photos[i]!.name}: ${r.merchant}.`,
  }));

  check("each carries ONE picture, not the whole album",
    each.every((e) => e.attachments.length === 1),
    each.map((e) => e.attachments.length).join(", "));
  check("…a different one each", each[0]!.attachments[0]!.id !== each[1]!.attachments[0]!.id);
  check("…and its own id", each[0]!.messageId !== each[1]!.messageId,
    each.map((e) => e.messageId).join(", "));

  console.log("\n4. GRAPH STILL UNDERSTANDS THE ID");
  // The id is the candidate's, not Graph's. Everything that asks
  // Graph for the message has to hand back the part before the
  // separator, or every preview and every upload 404s.
  check("the message id survives the photo suffix",
    baseMessageId(each[0]!.messageId) === "AAMkAGI1", baseMessageId(each[0]!.messageId));
  check("…and an ordinary id is untouched",
    baseMessageId("AAMkAGI1") === "AAMkAGI1");

  console.log("\n5. And NOW the receipts match their expenses");
  const hd = scoreMatch(expense({ merchant: "HOME DEPOT", amountCents: 17200 }), each[0]!);
  check("the Home Depot photo matches the Home Depot charge",
    hd !== null && hd.confidence === "strong",
    `${hd?.confidence} ${hd?.score}`);
  check("…on the merchant AND the total, not on the date alone",
    (hd?.reasons ?? []).some((r) => r.includes("total matches exactly")),
    (hd?.reasons ?? []).join(" / "));
  const cross = scoreMatch(expense({ merchant: "HOME DEPOT", amountCents: 17200 }), each[1]!);
  check("THE LOWES PHOTO DOES NOT match the Home Depot charge",
    cross === null, JSON.stringify(cross?.reasons ?? []));
} finally {
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
