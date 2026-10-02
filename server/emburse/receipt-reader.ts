import { canReadReceipts, extractReceipt, unreadReceipts } from "./receipt-items.js";
import { rereadMismatched } from "./reread-mismatched.js";

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

/**
 * Flagged receipts re-read per pass.
 *
 * Small, because each is a vision call and this runs unattended; the loop
 * comes straight back round while it keeps filling the slice, so a backlog
 * still clears in minutes rather than in slices half an hour apart.
 */
const REREAD_PER_PASS = 10;

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
  /** Set when this pass asked to come back promptly, so `finally` leaves it. */
  let soon = false;
  try {
    if (!canReadReceipts()) return;

    const pending = await unreadReceipts(PER_PASS);
    if (pending.length > 0) await readBatch(pending);

    // Then the ones already read whose total does not match the charge.
    // Outside the block above on purpose: this is the pass that matters on
    // a SETTLED queue, where there is nothing new to read and the flags
    // sitting there are exactly the ones a second reading tends to fix.
    let more = false;
    try {
      const pass = await rereadMismatched({ limit: REREAD_PER_PASS });
      more = pass.reread >= REREAD_PER_PASS;
      if (pass.reread > 0) {
        console.log(
          `receipts: re-read ${pass.reread} image(s) on ${pass.mismatched} flagged expense(s)` +
          ` — ${pass.cleared} came out of the flag`);
      }
      // An expense that just lost its flag may now qualify for automatic
      // approval, and the only other thing that would notice is tomorrow's
      // import. Same reasoning as after a first reading.
      if (pass.cleared > 0) {
        const { autoQueueApprovals } = await import("../rules/auto-approve.js");
        const auto = await autoQueueApprovals();
        if (auto.queued > 0) console.log(`receipts: that freed ${auto.queued} automatic approval(s)`);
      }
    } catch (err) {
      console.error("receipts: the mismatch re-read could not run:", err);
    }

    // More waiting: come back promptly rather than at the idle cadence.
    // A full re-read slice counts as "more waiting" too — a queue with forty
    // flagged mismatches would otherwise clear ten every half hour, which is
    // most of a day to do something the app could finish in two minutes.
    if (more || (await unreadReceipts(1)).length > 0) {
      clearTimeout(timer!);
      timer = setTimeout(() => void tick(), 30_000);
      soon = true;
    }
  } catch (err) {
    console.error("receipt reader:", err);
  } finally {
    running = false;
    /*
     * Only when nothing sooner was asked for.
     *
     * This cancelled the timer unconditionally and replaced it with the
     * half-hourly one — including the 30-second "there is more waiting"
     * re-tick set moments earlier, which made that whole branch dead code.
     * The reader therefore drained at most one batch every thirty minutes
     * however much was queued, which for a few dozen receipts is most of a
     * day and reads exactly like a count that is not moving.
     */
    if (!soon) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), 30 * 60_000);
    }
  }
}

/** Read a batch of never-read images, then re-judge and re-approve. */
async function readBatch(pending: string[]): Promise<void> {
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
