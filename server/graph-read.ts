import { GRAPH, graphToken, forgetGraphToken } from "./mail.js";

/**
 * Every READ of Microsoft Graph, through one door, so throttling is
 * handled once.
 *
 * Graph rate-limits. It does not do it politely by slowing down: it
 * answers 429 with a `Retry-After` header and expects the caller to
 * wait that long. Three places here called `fetch` directly and none
 * of them read that header, so the first throttled call turned into a
 * red line on a card — *"Graph would not hand over the message
 * (429)"* — which is not a problem a person can act on. The fix is to
 * wait and ask again, which is what Microsoft's own guidance says to
 * do, rather than to report it.
 *
 * Why it started happening now: the matching page shows the RECEIPT on
 * every card, and the photo reader fetches one attachment per
 * photograph. A screen of twelve cards is twelve message reads, in a
 * second, from one app registration — and Graph's per-app budget is
 * measured over ten-second windows. The previous version of this
 * feature read one message per press.
 *
 * Two mechanisms, both small:
 *
 *   PER CALL — retry on the statuses Microsoft names as retryable
 *   (429 and the 503/504 pair a throttled service answers with),
 *   sleeping exactly as long as `Retry-After` asks, capped so a rude
 *   header cannot hang a request for an hour.
 *
 *   ACROSS CALLS — a 429 sets a shared gate. Every other Graph read in
 *   this process waits behind it rather than spending the retry budget
 *   discovering the same thing. Twelve cards therefore back off once,
 *   together, instead of twelve times each.
 *
 * The 403 token refresh that used to live in the mailbox scanner is
 * here too, so the attachment and body reads get it as well — they
 * never had it, and a grant that had just been made failed there for
 * an hour with no explanation.
 */

/** What Graph answers when it is throttling rather than refusing. */
export const RETRYABLE = new Set([429, 503, 504]);

/** Long enough to outlast a throttle window, short enough to not hang a page. */
export const MAX_WAIT_MS = 20_000;

/** Attempts in all, so a persistent throttle still ends in an answer. */
export const TRIES = 4;

/**
 * How long to wait, from what Graph said.
 *
 * `Retry-After` is seconds, or an HTTP date. Both appear. Without the
 * header — a 503 from something else entirely — back off exponentially
 * with a little jitter, so parallel callers do not come back in step.
 */
export function waitMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_WAIT_MS);
    }
    const when = Date.parse(header);
    if (Number.isFinite(when)) {
      return Math.min(Math.max(when - Date.now(), 0), MAX_WAIT_MS);
    }
  }
  return Math.min(1000 * 2 ** attempt, MAX_WAIT_MS) + Math.floor(Math.random() * 250);
}

/* The shared gate: no Graph read starts before this moment. */
let openAt = 0;

/** For a test, and for a restart that should not inherit a stale gate. */
export function clearGate(): void {
  openAt = 0;
}

/** How much longer every Graph read is holding off, in ms. 0 when open. */
export function gateMs(): number {
  return Math.max(openAt - Date.now(), 0);
}

const nap = (ms: number): Promise<void> =>
  new Promise((done) => { setTimeout(done, ms); });

/**
 * A Graph GET, retried through throttling.
 *
 * Returns the Response, successful or not — the callers each have
 * their own words for a refusal and keep them. What they no longer see
 * is a 429, unless Graph is still throttling after the whole budget.
 */
export async function graphRead(path: string, opts?: {
  /** Overridden in tests, so a retry does not take twenty seconds. */
  sleep?: (ms: number) => Promise<void>;
  tries?: number;
  /** Called with each wait, so a scan can report that it was throttled. */
  waited?: (ms: number, status: number) => void;
}): Promise<Response> {
  const sleep = opts?.sleep ?? nap;
  const tries = Math.max(opts?.tries ?? TRIES, 1);
  const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
  let res: Response | null = null;

  for (let attempt = 0; attempt < tries; attempt += 1) {
    const held = gateMs();
    if (held > 0) await sleep(held);

    res = await fetch(url, { headers: { authorization: `Bearer ${await graphToken()}` } });

    /*
     * A 403 can be an hour out of date: the token carries the app's
     * roles frozen at issue, and it is cached for most of an hour. One
     * fresh token settles whether the grant took.
     */
    if (res.status === 403 && attempt === 0) {
      forgetGraphToken();
      res = await fetch(url, { headers: { authorization: `Bearer ${await graphToken()}` } });
    }

    if (!RETRYABLE.has(res.status)) return res;

    const ms = waitMs(res.headers.get("retry-after"), attempt);
    // Everyone waits, not just this call.
    openAt = Math.max(openAt, Date.now() + ms);
    opts?.waited?.(ms, res.status);
    if (attempt === tries - 1) return res;
    await sleep(ms);
    // Read the body nobody will use, so the socket is not left hanging.
    await res.text().catch(() => "");
  }
  // Unreachable: the loop runs at least once and every path returns.
  return res as Response;
}
