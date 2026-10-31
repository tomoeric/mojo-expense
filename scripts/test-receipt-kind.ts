/**
 * What the reader is actually being handed.
 *
 *   pnpm exec tsx scripts/test-receipt-kind.ts
 *
 * The reader took the declared content type and CAST it to the
 * four the image block accepts:
 *
 *   media_type: contentType as "image/jpeg" | "image/png" | …
 *
 * A cast is not a check. Every emailed receipt is a PDF — the
 * merchant's own attachment, or the message body rendered — so
 * every one went up as an image block and came back
 *
 *   400 … media_type: Input should be 'image/jpeg', 'image/png',
 *   'image/gif' or 'image/webp'
 *
 * which means NO emailed receipt had ever been read, and
 * everything downstream of the reading was running on the email
 * text alone. A PDF goes up as a DOCUMENT block instead.
 *
 * Sniffed from the bytes, not the header, for the same reason
 * the preview frame sniffs: an attachment's declared type is
 * whatever the sending client felt like putting there.
 */
import { receiptKind } from "../server/emburse/receipt-items.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const pdf = Buffer.from("%PDF-1.4\nReceipt from Replit");
const png = Buffer.concat([
  Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n", "latin1"), Buffer.alloc(8),
]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
const gif = Buffer.from("GIF89a" + "\0".repeat(8), "latin1");
const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
const heic = Buffer.concat([
  Buffer.alloc(4), Buffer.from("ftypheic", "latin1"), Buffer.alloc(4),
]);

try {
  console.log("1. A PDF IS A DOCUMENT, NOT AN IMAGE");
  const k = receiptKind(pdf, "application/pdf");
  check("…which is the whole bug", k.block === "document", JSON.stringify(k));
  check("…with the right media type",
    k.block === "document" && k.mediaType === "application/pdf");

  console.log("\n2. And the real images are still images");
  for (const [name, bytes, want] of [
    ["PNG", png, "image/png"], ["JPEG", jpeg, "image/jpeg"],
    ["GIF", gif, "image/gif"], ["WebP", webp, "image/webp"],
  ] as const) {
    const got = receiptKind(bytes, "application/octet-stream");
    check(`${name} is read as ${want}`,
      got.block === "image" && got.mediaType === want, JSON.stringify(got));
  }

  console.log("\n3. THE BYTES WIN OVER THE HEADER");
  /*
   * A merchant's attachment arrives declared as whatever the
   * sending client felt like. Navan's came through in a way that
   * had the preview showing a plug-in error; the same lie would
   * send a PDF up as a JPEG here.
   */
  check("a PDF declared as a JPEG is still a document",
    receiptKind(pdf, "image/jpeg").block === "document");
  check("…and a PNG declared as a PDF is still an image",
    receiptKind(png, "application/pdf").block === "image");

  console.log("\n4. What it cannot read, it SAYS, rather than being 400'd");
  const h = receiptKind(heic, "image/heic");
  check("a HEIC phone photo is refused here", h.block === "unreadable", JSON.stringify(h));
  check("…naming the file rather than an API field",
    h.block === "unreadable" && /HEIC/.test(h.why) && /Most Compatible/.test(h.why),
    h.block === "unreadable" ? h.why : "");
  const junk = receiptKind(Buffer.from("not a receipt at all"), "text/plain");
  check("and anything else says what it reads",
    junk.block === "unreadable" && /PDFs, JPEG, PNG/.test(junk.why),
    junk.block === "unreadable" ? junk.why : "");
} finally {
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
