/**
 * One browser at a time, in a queue rather than a collision.
 *
 * Every run — the export, a batch of decisions, a single test — drives the
 * same persistent Chromium profile, because that profile is what keeps Emburse
 * trusting this device. Chromium takes an exclusive lock on it, so two runs at
 * once is not slow, it is a crash.
 *
 * Before this existed the scheduler could start the 6am export while somebody
 * was mid-decision, and whichever lost the race failed with a lock error that
 * said nothing about the real cause. Now the second one waits, and anybody
 * looking can see what it is waiting for.
 *
 * Deliberately in memory and deliberately process-wide: a browser only exists
 * inside the process driving it, so a queue that outlived the process would be
 * describing browsers that are gone.
 */

export type BrowserHolder = { label: string; since: number };

let chain: Promise<unknown> = Promise.resolve();
let holder: BrowserHolder | null = null;
let waiting: string[] = [];

/**
 * Run `fn` with exclusive use of the browser.
 *
 * Queued in the order asked. The label is what a waiting caller is told it is
 * waiting for, so make it something a person would recognise.
 */
export function withBrowser<T>(label: string, fn: () => Promise<T>): Promise<T> {
  waiting.push(label);

  const run = chain.then(async () => {
    waiting = waiting.filter((w, i) => !(w === label && i === waiting.indexOf(label)));
    holder = { label, since: Date.now() };
    try {
      return await fn();
    } finally {
      holder = null;
    }
  });

  // The chain must not break on a failed run, or every later caller inherits
  // that rejection and nothing can use the browser again.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** What has the browser, and who is queued behind it. */
export function browserQueue(): { holder: BrowserHolder | null; waiting: string[] } {
  return { holder: holder ? { ...holder } : null, waiting: [...waiting] };
}

/** A sentence for a caller that is about to wait, or null when it will not. */
export function whyWaiting(): string | null {
  if (!holder) return null;
  const secs = Math.round((Date.now() - holder.since) / 1000);
  return `${holder.label} has the browser (${secs}s so far); this will start when it finishes.`;
}
