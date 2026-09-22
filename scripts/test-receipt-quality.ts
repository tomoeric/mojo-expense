/**
 * Are receipts kept at the best resolution available?
 *
 *   pnpm exec tsx scripts/test-receipt-quality.ts
 *
 * They were not. A receipt in an Emburse export is a photo embedded in a PDF
 * page, and the old renderer rasterised the *page* at a fixed scale and
 * cropped — which caps the result at the page's geometry and throws away
 * whatever the camera actually saw. On a 2400x3200 photo placed on a 576x768pt
 * page that produced 1268x1690: less than half the linear detail, on faded
 * thermal paper, for both the person squinting at it and the model reading
 * line items off it.
 *
 * This holds the renderer to taking the photo itself.
 */

import fs from "node:fs";
import * as mupdf from "mupdf";
import { renderReceiptPage, RENDER_VERSION } from "../server/import/ingest.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** A JPEG's dimensions, read from its SOF header rather than by decoding it. */
const size = (jpeg: Buffer) => {
  for (let i = 2; i + 9 < jpeg.length; ) {
    if (jpeg[i] !== 0xff) { i++; continue; }
    const marker = jpeg[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: jpeg.readUInt16BE(i + 5), w: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return { w: 0, h: 0 };
};

const FIXTURE = process.argv[2] ?? "/tmp/claude-0/receipt-page.pdf";
if (!fs.existsSync(FIXTURE)) {
  console.error(`Needs a PDF with a photo on page 1: ${FIXTURE}`);
  console.error("Any Emburse export will do — pass one as the first argument.");
  process.exit(2);
}

const doc = mupdf.Document.openDocument(fs.readFileSync(FIXTURE), "application/pdf");
const page = doc.loadPage(0);
const [x0, y0, x1, y1] = page.getBounds();
const pagePx = { w: Math.round(x1 - x0), h: Math.round(y1 - y0) };

// What the photo itself holds.
let native = { w: 0, h: 0 };
page.toStructuredText("preserve-images").walk({
  onImageBlock(_b, _c, image) {
    if (image.getWidth() * image.getHeight() > native.w * native.h) {
      native = { w: image.getWidth(), h: image.getHeight() };
    }
  },
});

const out = size(renderReceiptPage(doc, 0));

console.log("\n1. The photo is kept at its own resolution");
console.log(`     page ${pagePx.w}x${pagePx.h}pt · photo ${native.w}x${native.h} · stored ${out.w}x${out.h}`);
check("something was produced", out.w > 0 && out.h > 0, `${out.w}x${out.h}`);
// The contract is the photo untouched, unless it is beyond the cap — in which
// case it is the cap, with the shape kept. Anything smaller than both means
// detail was lost for no reason.
const CAP = 4200;
const want = Math.max(native.w, native.h) <= CAP
  ? native
  : { w: Math.round(native.w * (CAP / Math.max(native.w, native.h))),
      h: Math.round(native.h * (CAP / Math.max(native.w, native.h))) };
check("it matches the embedded photo, not the page box",
  Math.abs(out.w - want.w) <= 1 && Math.abs(out.h - want.h) <= 1,
  `${out.w}x${out.h}, wanted ${want.w}x${want.h}`);
check("…and keeps the photo's shape",
  Math.abs(out.w / out.h - native.w / native.h) < 0.01,
  `${(out.w / out.h).toFixed(3)} vs ${(native.w / native.h).toFixed(3)}`);

console.log("\n2. It beats rasterising the page, which is what it replaced");
const old = size(Buffer.from(
  page.toPixmap(mupdf.Matrix.scale(2.2, 2.2), mupdf.ColorSpace.DeviceRGB, false, true).asJPEG(85, false),
));
check("more pixels across than the old renderer gave", out.w > old.w, `${out.w} vs ${old.w}`);
check("…and down", out.h > old.h, `${out.h} vs ${old.h}`);
console.log(`     ${(((out.w * out.h) / (old.w * old.h) - 1) * 100).toFixed(0)}% more pixels`);

console.log("\n3. The version is bumped, so existing receipts get upgraded");
check("RENDER_VERSION is past the page-rasterising one", RENDER_VERSION >= 3, `${RENDER_VERSION}`);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
