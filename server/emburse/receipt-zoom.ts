import * as mupdf from "mupdf";

/**
 * A second, enlarged look at where the money is printed.
 *
 * The figures that matter sit in a block at the foot of a receipt, in the
 * smallest type on the page, on thermal paper that has usually been folded,
 * creased and photographed at an angle. The model reads the item lines off
 * these images perfectly well and then misses "TOTAL SALE 13.54" — not
 * because it cannot reason about which line is the charge, but because at
 * the scale it sees, 13.54 and 12.49 are four smudges each.
 *
 * So it is shown the same receipt twice: whole, and then the lower part
 * enlarged. The crop is the bottom two thirds rather than a found region —
 * finding the block would need a first pass to locate it, and the whole
 * image is in the message anyway, so a crop that misses costs nothing but
 * the tokens.
 *
 * Failures are silent by design: an unreadable, tiny or oddly-encoded image
 * simply gets no second look. A receipt read from one image is the state of
 * affairs this improves on, not a fault it introduces.
 */

/**
 * Where to cut, as a fraction down the image.
 *
 * The summary block is in the lower half but not at the very bottom — a
 * receipt ends with card authorisation codes, rebate notices and thank-yous.
 * On both of the receipts that were read wrongly it sat between 45% and 95%
 * down, so the cut is above both and the tail is kept.
 */
const FROM = 0.4;

/**
 * The long edge of what is sent.
 *
 * This is the number that decides whether any of this helps. A vision model
 * scales an image down to roughly 1568px on its long edge, so a tall
 * photograph of a receipt — 2000 by 3000 — arrives at about half size and
 * every figure on it is half as legible as it could be.
 *
 * Cutting the top off makes the crop WIDER than it is tall, so the long
 * edge is now the 2000px width rather than the 3000px height, and the same
 * budget buys around 1.4 times the detail on the characters that matter.
 * Sending more than this is paying for pixels that get thrown away at the
 * far end.
 */
const LONG_EDGE = 1500;

/** Below this there is nothing to enlarge; the original is already the detail. */
const LEAST_PIXELS = 200;

/** Never blow a small image up more than this: it adds pixels, not detail. */
const MOST_SCALE = 2;

export function enlargeTotals(bytes: Buffer): { data: Buffer; mediaType: "image/jpeg" } | null {
  try {
    const pix = new mupdf.Image(bytes).toPixmap();
    const w = pix.getWidth();
    const h = pix.getHeight();
    if (w < LEAST_PIXELS || h < LEAST_PIXELS) return null;

    const top = Math.floor(h * FROM);
    const cropH = h - top;
    if (cropH < LEAST_PIXELS / 2) return null;

    // Scaled to the budget, up or DOWN. Down still helps: a 2000x1800 crop
    // sent at 1500 wide keeps more detail on the figures than the whole
    // 2000x3000 photograph does, because the long edge is no longer the
    // height. An earlier version refused to touch anything it would have to
    // shrink, which meant it did nothing at all for phone photographs —
    // exactly the images this is for.
    const scale = Math.min(MOST_SCALE, LONG_EDGE / Math.max(w, cropH));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(cropH * scale));

    const warped = pix.warp([[0, top], [w, top], [w, h], [0, h]], outW, outH);
    // 85: thermal print is high-contrast, and the artefacts that matter are
    // the ones already in the photograph.
    return { data: Buffer.from(warped.asJPEG(85, false)), mediaType: "image/jpeg" };
  } catch {
    return null;
  }
}
