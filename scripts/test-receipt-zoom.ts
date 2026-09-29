/**
 * The second, enlarged look at where the money is printed.
 *
 *   pnpm exec tsx scripts/test-receipt-zoom.ts
 *
 * The figures that matter are in the smallest type on the page, on thermal
 * paper that has been folded and photographed at an angle. The item lines
 * read fine and "TOTAL SALE 13.54" comes back as 12.49, because at the
 * scale the model sees, those are four smudges each.
 *
 * What has to hold: it enlarges, it never grows without bound, and it
 * fails silently — a receipt read from one image is the state of affairs
 * this improves on, not a fault it introduces.
 */

export {};

import * as mupdf from "mupdf";
import { enlargeTotals } from "../server/emburse/receipt-zoom.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** A plain grey JPEG of a given size, standing in for a photograph. */
function jpegOf(w: number, h: number): Buffer {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.clear(200);
  return Buffer.from(pix.asJPEG(85, false));
}
const sizeOf = (b: Buffer) => {
  const img = new mupdf.Image(b);
  return { w: img.getWidth(), h: img.getHeight() };
};

console.log("\n1. An ordinary photograph");
{
  const out = enlargeTotals(jpegOf(600, 1200));
  check("it produces a second image", out !== null);
  const s = out ? sizeOf(out.data) : { w: 0, h: 0 };
  check("…wider than the original, because that is the point", s.w > 600, `${s.w}px`);
  check("…and only the lower part of it", s.h < 1200 * 2, `${s.h}px tall`);
  check("…as a jpeg, since the artefacts that matter are already in the photo",
    out?.mediaType === "image/jpeg");
}

console.log("\n2. A phone photograph is where this has to earn its keep");
{
  // The whole point. A vision model scales to ~1568px on the long edge, so
  // a 2000x3000 photograph arrives at half size. Cutting the top off makes
  // the crop wider than it is tall, so the long edge is the width and the
  // same budget buys more detail on the figures.
  //
  // An earlier version refused to touch anything it would have to shrink,
  // which meant it did nothing at all for exactly these images.
  const out = enlargeTotals(jpegOf(2000, 3000));
  check("a big photograph still gets a second look", out !== null);
  const s = out ? sizeOf(out.data) : { w: 0, h: 0 };
  check("…capped, so nothing is paid for pixels that get thrown away",
    Math.max(s.w, s.h) <= 1500, `${s.w}x${s.h}`);
  check("…and wider than it is tall, which is what buys the detail",
    s.w > s.h, `${s.w}x${s.h}`);
  // 1500 across for 2000px of receipt is 0.75 of full size; the whole
  // photograph arrives at 1568/3000, barely half.
  check("…at better than half scale, which the whole photograph is not",
    s.w / 2000 > 1568 / 3000, `${(s.w / 2000).toFixed(2)} vs ${(1568 / 3000).toFixed(2)}`);
}

console.log("\n3. Nothing to enlarge, nothing returned");
check("a thumbnail is left alone", enlargeTotals(jpegOf(80, 80)) === null);
check("…and so is something that is not an image at all",
  enlargeTotals(Buffer.from("this is not a receipt")) === null);
check("…and an empty buffer does not throw", enlargeTotals(Buffer.alloc(0)) === null);

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
