import { canReadReceipts, extractReceipt, unreadReceipts } from "./receipt-items.js";

/**
 * Reads the line items off receipts we have not read yet.
 *
 * Runs in the background rather than during an import: a hundred new receipts
 * is a hundred vision calls, and an import that waited for them would hold a
 * transaction open for minutes and fail as a unit. Here, each receipt is read
 * on its own and a failure costs one receipt.
 *
 * Timing matters more than it looks. Receipts are deleted once an approval is
 * confirmed, so anything unread when that happens is unread forever — the
 * image cannot be fetched again. Running shortly after each import, rather
 * than on a daily schedule, keeps the gap between "a receipt arrived" and "we
 * know what is on it" smaller than the gap before anyone can approve it.
 */

/** Read at most this many per pass, so one backlog cannot run unbounded. */
const PER_PASS = 25;

/** Between calls, so a backlog does not arrive as a burst. */
const SPACING_MS = 1500;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function nudgeReceiptReader(): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = setTimeout(() => void tick(), 10_000);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!canReadReceipts()) return;

    const pending = await unreadReceipts(PER_PASS);
    if (pending.length === 0) return;

    console.log(`receipts: reading ${pending.length}`);
    let read = 0;
    for (const sha of pending) {
      try {
        const detail = await extractReceipt(sha);
        if (detail && !detail.error) read++;
      } catch (err) {
        // One unreadable receipt is not a reason to stop reading the rest.
        console.error(`receipts: could not read ${sha.slice(0, 8)}:`, err);
      }
      await new Promise((r) => setTimeout(r, SPACING_MS));
    }
    console.log(`receipts: read ${read} of ${pending.length}`);

    // More waiting: come back promptly rather than at the idle cadence.
    if ((await unreadReceipts(1)).length > 0) {
      clearTimeout(timer!);
      timer = setTimeout(() => void tick(), 30_000);
    }
  } catch (err) {
    console.error("receipt reader:", err);
  } finally {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), 30 * 60_000);
    }
  }
}

export function startReceiptReader(): void {
  if (timer) return;
  if (!canReadReceipts()) {
    console.log("Receipt reading is off — no Anthropic key, or no database.");
    return;
  }
  timer = setTimeout(() => void tick(), 90_000);
  console.log("Receipt reader running (pulls line items off new receipts)");
}
