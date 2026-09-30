import { isDbConfigured } from "../db.js";
import { readSettings } from "../import/settings.js";
import { credentialForUser } from "./credentials.js";
import { runDecisions, type BatchItem } from "./decide.js";
import type { ChallengeHook } from "./auto-export.js";
import { waitForCode } from "./challenge.js";
import {
  cancelBecauseFlagged, flaggedNow, noteAttemptFailed, peersFor, pendingDecisions, settleDecision,
} from "./decisions.js";
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
let started = false;
/** A nudge that arrived mid-pass, to be honoured when the pass ends. */
let again = false;

/** Whether the worker exists at all, so a button can say when it does not. */
export const decisionWorkerStarted = (): boolean => started;

/**
 * Ask the worker to look.
 *
 * `immediate` is the difference between the automatic nudge and the Send now
 * button, and it used to not exist. Both went through the same twenty-second
 * gather delay — which is right when somebody has just clicked Approve and
 * may click nine more, and plainly wrong for a button that says Send now.
 *
 * Worse, every press RESET that delay. Pressing it again because nothing
 * seemed to be happening pushed the run twenty seconds further away, so the
 * button did the opposite of its label the more it was used.
 *
 * Two other ways a nudge used to vanish, both silent:
 *
 *   - `if (!timer) return` meant a nudge before the worker had started, or
 *     after a boot where it never did, was a no-op — while the caller got a
 *     cheerful 202.
 *   - A nudge arriving mid-pass hit `if (running) return` inside tick and
 *     was dropped, and the only re-arm was the five-minute idle timer. The
 *     decision queued one second too late waited five minutes.
 *
 * Returns whether the worker is there to do anything at all.
 */
export function nudgeDecisionWorker(opts: { immediate?: boolean } = {}): boolean {
  if (!started) return false;
  // Mid-pass: remember, rather than drop it on the floor. The pass that is
  // running may already have read the queue before this decision landed.
  if (running) {
    again = true;
    return true;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), opts.immediate ? 0 : GATHER_MS);
  return true;
}

async function tick(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  again = false;
  try {
    // Paused by hand. Checked here rather than at the queueing end, because
    // "stop" has to mean the hundred already waiting as well as the next
    // one — those are the ones holding the browser the import needs.
    //
    // Nothing is cancelled or lost: they stay pending and go when it is
    // lifted. A batch already at the browser is not interrupted, because
    // abandoning a half-clicked approval is worse than letting it land.
    if (await getFlag("holdDecisions").catch(() => false)) return;

    let waiting = await pendingDecisions();
    if (waiting.length === 0) return;

    // A flag beats a queued approval, and this is the last moment it can.
    //
    // The automation only ever queues expenses nothing flagged — but the
    // receipt is often read minutes later, the rules run again on what it
    // said, and the expense is flagged AFTER its approval is already in the
    // queue. Nothing re-checked, so it went to Emburse regardless: rows sat
    // in the Flagged tab reading "Approved · sending".
    //
    // Only the machine's approvals are stopped. A person who clicks Approve
    // on a flagged expense means it, and often should — that is what the
    // flag is for, a prompt to look rather than a prohibition.
    const machine = waiting.filter((d) => d.automatic && d.decision === "approve");
    if (machine.length > 0) {
      const flagged = await flaggedNow(machine.map((d) => d.dedupeKey));
      const stop = machine.filter((d) => flagged.has(d.dedupeKey)).map((d) => d.id);
      if (stop.length > 0) {
        const n = await cancelBecauseFlagged(stop);
        console.log(`decisions: held back ${n} automatic approval(s) a rule has since flagged`);
        const stopped = new Set(stop);
        waiting = waiting.filter((d) => !stopped.has(d.id));
        if (waiting.length === 0) return;
      }
    }

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
      // Per decider, so one person's broken credential does not silently
      // strand everybody else's decisions in the same pass.
      try {
      const login = await credentialForUser(decider);
      if (!login) {
        // Left pending, not failed: the decision is sound, it just cannot be
        // carried out yet. Marking it failed would make somebody decide twice
        // for a problem that is theirs to fix in one place.
        console.warn(
          `decisions: ${items.length} from ${decider} waiting — they have no Emburse login stored`,
        );
        // Still pending, but no longer silent. This is the commonest reason
        // a decision never moves, and it used to be visible only in a log.
        await noteAttemptFailed(items.map((d) => d.id),
          `${decider} has no Emburse login stored, so this cannot be applied. ` +
          `Add one under Your Emburse login and it goes on the next pass, within a few minutes.`);
        continue;
      }

      // How many expenses we hold that are indistinguishable from each of
      // these. It decides whether the automation may take one of several
      // matching rows: it may when we hold a decision for every one of
      // them, because then each decision takes a row and the choice is
      // bookkeeping rather than a guess.
      const peers = await peersFor(items.map((d) => d.dedupeKey));

      const batch: BatchItem[] = items.map((d) => ({
        id: d.id, decision: d.decision, target: d.target, reason: d.reason,
        // Carried through because it changes what the run is allowed to do
        // when several rows match the expense equally well.
        automatic: d.automatic,
        peers: peers.get(d.dedupeKey) ?? 1,
      }));

      console.log(`decisions: applying ${batch.length} as ${decider}`);
      /**
       * Whether there is anybody to ask for a verification code.
       *
       * A code CAN be asked for here, unlike a 6am scheduled export — the
       * decider clicked Approve moments ago, so somebody is at the screen.
       * Without it a decision could not get past Emburse's device check at
       * all, which is what happens the first time anybody decides from an
       * account this browser has never signed in as.
       *
       * But "somebody clicked" is not true of an AUTOMATIC approval. The
       * sweep queued it on a timer a quarter of an hour ago and nobody is
       * watching. Parking there holds the browser, the profile lock and the
       * whole rest of the batch for the full ten-minute wait, and then
       * abandons the sign-in anyway — which is how a queue sat at "applying
       * 10 of 12, 1080s so far" with nothing approved and no failure to
       * show for it either.
       *
       * So a batch nobody is present for fails fast instead, exactly as the
       * scheduled export does. The moment a person decides anything the
       * prompt comes back, and answering it once re-trusts the device for
       * everything that follows, automatic approvals included.
       */
      const somebodyIsHere = anybodyToAsk(batch);
      // Read once per batch, not per decision: it is the same answer for all
      // of them and this runs while a browser is held open.
      const tracing = await getFlag("traceDecisions").catch(() => false);

      const settle = (id: number, run: Awaited<ReturnType<typeof runDecisions>> extends Map<number, infer R> ? R : never) =>
        settleDecision(
          id,
          run.ok
            ? { ok: true, matchedRow: run.matchedRow }
            : {
                ok: false,
                error: run.steps.find((s) => !s.ok)?.detail ?? "The decision did not go through.",
                // Not a failure to fix: Emburse has nothing matching this in
                // Needs Review. Kept apart so it neither invites a retry nor
                // buries the handful of failures that do need somebody.
                notInQueue: run.steps.some((s) => !s.ok && s.absent === true),
              },
          tracing ? run.steps : null,
          tracing ? run.screenshot : null,
        );

      const results = await runDecisions(batch, settings.selectors, settings.emburseUrl, login, {
        ...(somebodyIsHere
          ? { onChallenge: ((ctx) => waitForCode({ ...ctx, owner: decider })) as ChallengeHook }
          : {}),
        // Pause has to reach the batch already running, or it only stops
        // work that had not started — which, mid-way through a hundred and
        // forty, is not what anybody means by stop.
        shouldStop: () => getFlag("holdDecisions").catch(() => false),
        // Recorded as each one finishes, so the queue shows them landing one
        // by one instead of sitting still and then changing all at once.
        onResult: settle,
      });

      const missed: number[] = [];
      for (const item of items) {
        const run = results.get(item.id);
        // Never attempted — the batch stopped before reaching it. It stays
        // pending for the next pass, but says so rather than saying nothing.
        if (!run) { missed.push(item.id); continue; }
        // Anything onResult already handled is settled; this catches the
        // ones filled in by the batch's own error paths, which never went
        // through the callback.
        await settle(item.id, run);
      }
      if (missed.length > 0) {
        // Paused is not a fault, and saying "the run stopped" about a
        // deliberate stop reads like one. Asked again here rather than
        // remembered, because the pause may have been lifted since.
        const paused = await getFlag("holdDecisions").catch(() => false);
        await noteAttemptFailed(missed, paused
          ? "Paused before this one was reached. It is still queued and goes when you resume."
          : "The run stopped before reaching this one. It is still queued and will be tried again.");
      }
      const applied = [...results.values()].filter((r) => r.ok).length;
      console.log(`decisions: ${applied} of ${batch.length} applied as ${decider}`);
      } catch (err) {
        // The case that produced "nothing comes back to say why it failed":
        // a throw here — a browser that would not launch, settings that
        // would not load, a password that would not decrypt — was caught
        // outside the loop, logged, and that was the end of it. Every
        // decision stayed pending with no record of an attempt.
        const why = err instanceof Error ? err.message : String(err);
        console.error(`decisions: the pass for ${decider} failed:`, err);
        await noteAttemptFailed(items.map((d) => d.id), why).catch(() => {});
      }
    }
  } catch (err) {
    // Whatever failed before the per-decider loop — reading the queue or the
    // settings. Recorded against everything waiting, for the same reason:
    // a queue that will not move has to say so on the page.
    console.error("decision worker:", err);
    const why = err instanceof Error ? err.message : String(err);
    await pendingDecisions()
      .then((all) => noteAttemptFailed(all.map((d) => d.id), why))
      .catch(() => {});
  } finally {
    running = false;
    // Always re-arm: a pass that found nothing should still be checking later,
    // and one that failed must not leave the queue unattended forever. A
    // nudge that arrived while this pass was running comes round promptly
    // instead of waiting out the idle timer.
    if (timer) clearTimeout(timer);
    const wanted = again;
    again = false;
    timer = setTimeout(() => void tick(), wanted ? 1_000 : IDLE_MS);
  }
}

/**
 * Is there a person at the screen who could read a verification code?
 *
 * One line, but it decides whether a run may block for ten minutes, so it is
 * named, exported and tested rather than inlined. A batch is attended when
 * ANY of it came from somebody's click — the browser signs in once for the
 * whole batch, so one person present is enough to clear the device check for
 * everything in it.
 */
export const anybodyToAsk = (batch: readonly BatchItem[]): boolean =>
  batch.some((b) => b.automatic !== true);

export function startDecisionWorker(): void {
  if (started) return;
  if (!isDbConfigured()) return;
  started = true;
  timer = setTimeout(() => void tick(), 60_000);
  console.log("Decision worker running (applies queued approvals and denials)");
}
