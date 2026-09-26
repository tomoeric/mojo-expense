import { isDbConfigured } from "../db.js";
import { readSettings } from "../import/settings.js";
import { credentialForUser } from "./credentials.js";
import { runDecisions, type BatchItem } from "./decide.js";
import { waitForCode } from "./challenge.js";
import { pendingDecisions, settleDecision } from "./decisions.js";
import { getFlag } from "../flags.js";

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
    const waiting = await pendingDecisions();
    if (waiting.length === 0) return;

    const settings = await readSettings();

    // Grouped by who decided, and applied under that person's own Emburse
    // login. Emburse records an approval against whichever account signed in,
    // so applying one person's decision under another's would put the wrong
    // name on it in the finance system — permanently, and where nobody would
    // think to doubt it. One batch each is the cost of that being true.
    const byDecider = new Map<string, typeof waiting>();
    for (const d of waiting) {
      (byDecider.get(d.decidedBy) ?? byDecider.set(d.decidedBy, []).get(d.decidedBy)!).push(d);
    }

    for (const [decider, items] of byDecider) {
      const login = await credentialForUser(decider);
      if (!login) {
        // Left pending, not failed: the decision is sound, it just cannot be
        // carried out yet. Marking it failed would make somebody decide twice
        // for a problem that is theirs to fix in one place.
        console.warn(
          `decisions: ${items.length} from ${decider} waiting — they have no Emburse login stored`,
        );
        continue;
      }

      const batch: BatchItem[] = items.map((d) => ({
        id: d.id, decision: d.decision, target: d.target, reason: d.reason,
      }));

      console.log(`decisions: applying ${batch.length} as ${decider}`);
      // A verification code CAN be asked here, unlike a 6am scheduled export:
      // the decider clicked Approve moments ago, so there is somebody to ask.
      // Without this a decision could not get past Emburse's device check at
      // all — which is what happens the first time anybody decides from an
      // account this browser has never signed in as, and it failed with no
      // way to put it right.
      const results = await runDecisions(batch, settings.selectors, settings.emburseUrl, login, {
        onChallenge: (ctx) => waitForCode({ ...ctx, owner: decider }),
      });

      // Read once per batch, not per decision: it is the same answer for all
      // of them and this runs while a browser is held open.
      const tracing = await getFlag("traceDecisions").catch(() => false);

      for (const item of items) {
        const run = results.get(item.id);
        if (!run) continue; // never attempted; stays pending for the next pass
        await settleDecision(
          item.id,
          run.ok
            ? { ok: true, matchedRow: run.matchedRow }
            : { ok: false, error: run.steps.find((s) => !s.ok)?.detail ?? "The decision did not go through." },
          tracing ? run.steps : null,
        );
      }
      const applied = [...results.values()].filter((r) => r.ok).length;
      console.log(`decisions: ${applied} of ${batch.length} applied as ${decider}`);
    }
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
