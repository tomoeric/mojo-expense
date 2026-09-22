import { isDbConfigured } from "../db.js";
import { readSettings } from "../import/settings.js";
import { envLogin } from "./auto-export.js";
import { credentialForExport } from "./credentials.js";
import { runDecisions, type BatchItem } from "./decide.js";
import { pendingDecisions, settleDecision } from "./decisions.js";

/**
 * Apply queued decisions, in batches, on one browser session.
 *
 * Runs soon after a decision is made rather than on a fixed clock: somebody
 * who has just approved ten receipts should see them land within a minute, not
 * at the top of the hour. A short delay before starting lets a review pass
 * accumulate, so ten clicks become one session instead of ten.
 */

/** How long to let more decisions arrive before starting a batch. */
const GATHER_MS = 20_000;

/** Nothing queued for a while, so stop checking until something is. */
const IDLE_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Ask the worker to look soon — called when a decision is queued. */
export function nudgeDecisionWorker(): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = setTimeout(() => void tick(), GATHER_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const items = await pendingDecisions();
    if (items.length === 0) return;

    const login = (await credentialForExport()) ?? envLogin();
    if (!login) {
      // Not a failure of the decisions — a failure to be able to act on any of
      // them. Left pending rather than marked failed, so they go through once
      // a login exists instead of needing to be made again.
      console.warn(`decisions: ${items.length} waiting, but no Emburse login is stored`);
      return;
    }

    const settings = await readSettings();
    const batch: BatchItem[] = items.map((d) => ({
      id: d.id, decision: d.decision, target: d.target, reason: d.reason,
    }));

    console.log(`decisions: applying ${batch.length}`);
    const results = await runDecisions(batch, settings.selectors, settings.emburseUrl, login);

    for (const item of items) {
      const run = results.get(item.id);
      if (!run) continue; // never attempted; stays pending for the next pass
      await settleDecision(
        item.id,
        run.ok
          ? { ok: true, matchedRow: run.matchedRow }
          : { ok: false, error: run.steps.find((s) => !s.ok)?.detail ?? "The decision did not go through." },
      );
    }
    const applied = [...results.values()].filter((r) => r.ok).length;
    console.log(`decisions: ${applied} of ${batch.length} applied`);
  } catch (err) {
    console.error("decision worker:", err);
  } finally {
    running = false;
    // Always re-arm: a pass that found nothing should still be checking later,
    // and one that failed must not leave the queue unattended forever.
    if (timer) {
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), IDLE_MS);
    }
  }
}

export function startDecisionWorker(): void {
  if (timer) return;
  if (!isDbConfigured()) return;
  timer = setTimeout(() => void tick(), 60_000);
  console.log("Decision worker running (applies queued approvals and denials)");
}
