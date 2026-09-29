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

    if (read > 0) {
      // THE RULES FIRST, and this was missing.
      //
      // A rule about a receipt — its total, its merchant, alcohol on it —
      // returns UNKNOWN while the receipt is unread, so it records no hit.
      // Reading the receipt does not change that on its own: the verdicts
      // stored at import time stay exactly as they were, so an expense
      // whose receipt turned out to disagree with the claim sat there
      // unflagged, and one that was flagged before a re-read corrected the
      // figures stayed flagged with the amounts plainly matching.
      //
      // Worse, it made the automation's central promise untrue. It refuses
      // to approve anything until every enabled rule has run since the
      // expense arrived — but `last_run_at` is per rule, not per expense,
      // so a rule that ran at import time counted as run for a receipt
      // read hours later. The one case the whole module exists to prevent,
      // through the back door.
      try {
        const { expensesForReceipts } = await import("./receipt-items.js");
        const keys = await expensesForReceipts(pending);
        if (keys.length > 0) {
          const { runRules } = await import("../rules/run.js");
          const ran = await runRules({ keys });
          console.log(`receipts: re-judged ${keys.length} expense(s), ${ran.failed} flagged`);
        }
      } catch (err) {
        console.error("receipts: the rules could not be re-run:", err);
      }

      // Then the automatic approvals, which wait on all of the above.
      // Without this, an expense whose receipt is read at 09:15 could not
      // be approved until the NEXT import — tomorrow — because that is the
      // only other thing that runs the automation.
      try {
        const { autoQueueApprovals } = await import("../rules/auto-approve.js");
        const auto = await autoQueueApprovals();
        if (auto.queued > 0) console.log(`receipts: that freed ${auto.queued} automatic approval(s)`);
      } catch (err) {
        console.error("receipts: automatic approvals could not run:", err);
      }
    }

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
