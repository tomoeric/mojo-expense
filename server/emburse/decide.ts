import type { BrowserContext, Page } from "playwright";
import { env } from "../env.js";
import {
  explainLaunch, firstVisible, gridUrl, makeStepper, openBrowser, safeUrl, signIn,
  type ChallengeHook,
  type Login, type StepResult,
} from "./auto-export.js";
import { withBrowser } from "./browser-lock.js";
import { rememberCookies } from "./browser-state.js";

/**
 * Approve or deny one expense in Emburse, by driving the UI.
 *
 * The export is read-only; this is not. It moves real money through an
 * approval chain, and the failure that matters is not "it did not work" — that
 * is visible and recoverable — but "it worked on the wrong row". Everything
 * unusual here is in service of making that impossible rather than unlikely:
 *
 *   - The row is found by searching, then **verified field by field** against
 *     the expense the reviewer actually clicked. Employee, merchant, amount and
 *     date must all agree before anything is clicked.
 *   - A search returning more than one candidate is refused outright. There is
 *     no tie-break worth guessing at when the stake is approving someone else's
 *     expense.
 *   - `dryRun` finds and verifies the row and stops, so the matching can be
 *     proven before a single decision is committed.
 *
 * Emburse's own audit log records who did what, and since the app signs in as a
 * real account, decisions appear under that account's name. That is a reason to
 * use a named service account rather than a person's login, not a reason to
 * hide it.
 */

export type Decision = "approve" | "deny";

/** What the reviewer clicked, used to prove the right row was found. */
export type Target = {
  employee: string;
  merchant: string;
  /** Dollars, as shown in the app. */
  amount: number;
  /** ISO date, YYYY-MM-DD. */
  date: string | null;
};

export type DecisionRun = {
  ok: boolean;
  steps: StepResult[];
  screenshot: string | null;
  /** The row text the decision was applied to, for the audit record. */
  matchedRow: string | null;
};

export type DecisionSelectorKey =
  | "resultRow" | "approveButton" | "rowMenu"
  | "denyButton" | "denyReason" | "denyConfirm" | "decisionApplied";

export const DECISION_SELECTORS: Record<DecisionSelectorKey, string> = {
  // Scoped to the grid body so the header row is never a candidate.
  resultRow: "table tbody tr",
  approveButton: 'button:has-text("APPROVE")',
  rowMenu: 'button[aria-label*="more" i], button:has-text("⋮")',
  denyButton: 'text=/^\\s*Deny\\s*$/i',
  denyReason: 'textarea, input[placeholder*="reason" i]',
  denyConfirm: 'button:has-text("Deny")',
  decisionApplied: "text=/approved|denied/i",
};

export const DECISION_SELECTOR_HELP: Record<DecisionSelectorKey, string> = {
  resultRow: "One row of the results table.",
  approveButton: "The APPROVE button on a row.",
  rowMenu: "The ⋮ menu at the end of a row, which holds Deny.",
  denyButton: "Deny, inside that menu.",
  denyReason: "The reason box, if Emburse asks for one.",
  denyConfirm: "The button that confirms the denial.",
  decisionApplied: "Confirmation that the decision was recorded.",
};

export const DECISION_STEP_SELECTORS: Record<string, DecisionSelectorKey[]> = {
  "search for the expense": ["resultRow"],
  "verify it is the right row": ["resultRow"],
  approve: ["approveButton", "decisionApplied"],
  deny: ["rowMenu", "denyButton", "denyReason", "denyConfirm", "decisionApplied"],
};

const money = (n: number) => n.toFixed(2);

/**
 * Whether a row's text describes the expense the reviewer clicked.
 *
 * Deliberately strict about the amount and loose about everything else.
 * Emburse truncates merchant names in the grid and writes dates in its own
 * format, so demanding an exact string match on those would refuse valid rows;
 * the amount, though, is exact, unambiguous, and the thing that makes two
 * similar rows different.
 */
export function rowMatches(rowText: string, t: Target): { ok: boolean; why: string } {
  const text = rowText.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  // Bounded, not a substring. "6.40" occurs inside "$126.40", so a plain
  // includes() would let a six-dollar expense match a hundred-and-twenty-six
  // dollar one — the precise false positive this function exists to prevent.
  const amount = money(t.amount);
  const withCommas = Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2 });
  const bounded = (n: string) =>
    new RegExp(`(?<![\\d.,])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d])`).test(text);
  if (!bounded(amount) && !bounded(withCommas)) {
    return { ok: false, why: `amount ${amount} not in the row` };
  }

  const surname = t.employee.trim().split(/\s+/).pop() ?? "";
  if (surname && !lower.includes(surname.toLowerCase())) {
    return { ok: false, why: `employee "${t.employee}" not in the row` };
  }

  // The first word of the merchant: Emburse truncates long names with an
  // ellipsis, so the whole string is often genuinely absent from the row.
  const head = t.merchant.trim().split(/\s+/)[0]?.replace(/[^\w]/g, "") ?? "";
  if (head.length >= 4 && !lower.includes(head.toLowerCase())) {
    return { ok: false, why: `merchant "${t.merchant}" not in the row` };
  }

  if (t.date) {
    const [y, m, d] = t.date.split("-").map(Number) as [number, number, number];
    const forms = [
      `${m}/${d}/${y}`,
      `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`,
      new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(y, m - 1, d)),
    ];
    if (!forms.some((f) => text.includes(f))) {
      return { ok: false, why: `date ${t.date} not in the row` };
    }
  }

  return { ok: true, why: "employee, merchant, amount and date all match" };
}

export async function runDecision(
  decision: Decision,
  target: Target,
  reason: string,
  selectors: Record<string, string>,
  emburseUrl: string,
  login: Login,
  opts: { dryRun?: boolean; onChallenge?: ChallengeHook } = {},
): Promise<DecisionRun> {
  const steps: StepResult[] = [];
  const step = makeStepper(steps);
  let close: (() => Promise<void>) | null = null;
  let page: Page | null = null;
  let matchedRow: string | null = null;

  const sel = { ...DECISION_SELECTORS, ...selectors } as Record<string, string>;

  return withBrowser(`${decision} one expense`, async () => {
  try {
    // The same persistent profile the export uses, so a device trusted once
    // is trusted for both — which is also why it has to queue behind it.
    const opened = await openBrowser();
    close = opened.close;
    page = await opened.context.newPage();
    page.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);

    const ok = await drive(page, decision, target, reason, sel, emburseUrl, login, step, opts, (t) => (matchedRow = t));
    // Whatever the decision itself did, a sign-in that got through is worth
    // keeping — including a device check somebody just cleared by hand.
    if (steps.find((st) => st.name === "sign in")?.ok) await keepTrust(opened.context);
    const screenshot = ok ? null : (await page.screenshot()).toString("base64");
    return { ok, steps, screenshot, matchedRow };
  } catch (err) {
    steps.push({ name: "start browser", ok: false, detail: explainLaunch(err), ms: 0 });
    return { ok: false, steps, screenshot: null, matchedRow };
  } finally {
    await close?.().catch(() => {});
  }
  });
}

/**
 * Apply several decisions in one browser session.
 *
 * Signs in once and then works the list. Each decision is independent: one
 * that cannot find its row fails on its own and the rest carry on, because a
 * batch that abandons nineteen good decisions over one bad one is worse than
 * no batch at all.
 */
export async function runDecisions(
  items: BatchItem[],
  selectors: Record<string, string>,
  emburseUrl: string,
  login: Login,
  opts: { dryRun?: boolean; onChallenge?: ChallengeHook } = {},
): Promise<Map<number, DecisionRun>> {
  const results = new Map<number, DecisionRun>();
  if (items.length === 0) return results;

  const sel = { ...DECISION_SELECTORS, ...selectors } as Record<string, string>;

  return withBrowser(`applying ${items.length} decision(s)`, async () => {
    let close: (() => Promise<void>) | null = null;
    let page: Page | null = null;
    try {
      const opened = await openBrowser();
      close = opened.close;
      page = await opened.context.newPage();
      page.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);

      // Once, for the whole batch.
      const shared: StepResult[] = [];
      const signedIn = await signInOnce(page, sel, emburseUrl, login, makeStepper(shared), opts.onChallenge);
      if (signedIn) await keepTrust(opened.context);
      if (!signedIn) {
        // Nothing can be applied, and each item should say why rather than
        // failing with a blank.
        for (const it of items) {
          results.set(it.id, {
            ok: false, steps: shared,
            screenshot: (await page.screenshot().catch(() => null))?.toString("base64") ?? null,
            matchedRow: null,
          });
        }
        return results;
      }

      for (const it of items) {
        const steps: StepResult[] = [...shared];
        const step = makeStepper(steps);
        let matchedRow: string | null = null;
        const ok = await applyOne(
          page, it.decision, it.target, it.reason ?? "", sel, emburseUrl, step, opts,
          (t) => (matchedRow = t),
        );
        results.set(it.id, {
          ok,
          steps,
          screenshot: ok ? null : (await page.screenshot().catch(() => null))?.toString("base64") ?? null,
          matchedRow,
        });
      }
      return results;
    } catch (err) {
      for (const it of items) {
        if (!results.has(it.id)) {
          results.set(it.id, {
            ok: false,
            steps: [{ name: "start browser", ok: false, detail: explainLaunch(err), ms: 0 }],
            screenshot: null, matchedRow: null,
          });
        }
      }
      return results;
    } finally {
      await close?.().catch(() => {});
    }
  });
}

/** One queued decision, as the batch runner needs it. */
/**
 * Why the grid is not there.
 *
 * "The results grid did not appear" is true and tells nobody what to do: the
 * grid selector could be wrong, the gridPath could be wrong, Emburse could
 * have bounced the session back to a sign-in, or the search could simply have
 * matched nothing. Those have four different fixes, and the page itself
 * distinguishes them.
 */
async function whyNoGrid(page: Page, sel: Record<string, string>): Promise<string> {
  const where = safeUrl(page.url());
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();

  if (/sign in|log in|password|code-authentication/i.test(text) || /login|auth/i.test(page.url())) {
    return `Emburse sent us back to sign in at ${where} — the session did not survive the search. ` +
      "Test your Emburse connection to sign in again.";
  }
  if (/no results|no expenses|nothing to show|0 results/i.test(text)) {
    return `the grid loaded at ${where} but Emburse says there are no results for that search.`;
  }

  // Present in the DOM but never visible is a different fault from absent, and
  // it is the one that means the selector is matching the wrong thing.
  const present = await page.locator(sel.grid!).count().catch(() => 0);
  if (present > 0) {
    return `the grid selector matched ${present} element(s) at ${where}, but none of them ever became ` +
      `visible — “${sel.grid}” is probably matching a hidden measuring table rather than the real grid.`;
  }
  return `no grid at ${where}. Nothing matched “${sel.grid}”. If the export works but this does not, ` +
    `the selector is fine and this account is the difference: “${sel.gridPath}” is Emburse's team-wide ` +
    `view, and an account without admin rights there signs in normally and simply has no grid. ` +
    `Otherwise that selector or gridPath is wrong. The page says: ` +
    `${text.slice(0, 160) || "(nothing readable)"}`;
}

/**
 * Sign in as one person and stop there.
 *
 * The connection test. Approving used to be the only way to find out whether
 * somebody's Emburse login worked — so the first thing a new reviewer learned
 * was that a real expense "did not go through", with the real cause (a device
 * that has never been verified) three screens away in the export log.
 *
 * It reaches a signed-in ADMIN view and does nothing else: no grid, no row, no
 * decision. The code prompt is offered, which is the point — answering it once
 * here leaves the device remembered, and every later approval goes straight
 * through.
 */
export async function testConnection(
  selectors: Record<string, string>,
  emburseUrl: string,
  login: Login,
  opts: { onChallenge?: ChallengeHook } = {},
): Promise<DecisionRun> {
  const steps: StepResult[] = [];
  const step = makeStepper(steps);
  const sel = { ...DECISION_SELECTORS, ...selectors } as Record<string, string>;

  return withBrowser("testing an Emburse login", async () => {
    let close: (() => Promise<void>) | null = null;
    let page: Page | null = null;
    try {
      const opened = await openBrowser();
      close = opened.close;
      const sheet = await opened.context.newPage();
      page = sheet;
      sheet.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);

      let ok = await signInOnce(sheet, sel, emburseUrl, login, step, opts.onChallenge);
      if (ok) await keepTrust(opened.context);

      // One step further than signing in, because signing in is not where it
      // has been failing. Opening the grid is everything a decision does
      // except click the button, so this reproduces the real failure on
      // demand instead of requiring somebody to approve a real expense to
      // find out.
      if (ok) {
        ok = await step("open the expenses grid", async () => {
          await sheet.goto(gridUrl(emburseUrl, { query: "", path: sel.gridPath }), {
            waitUntil: "domcontentloaded",
          });
          if (!(await firstVisible(sheet, sel.grid!, env.emburseLogin.stepTimeoutMs))) {
            throw new Error(await whyNoGrid(sheet, sel));
          }
          const rows = await sheet.locator(sel.resultRow!).count().catch(() => 0);
          return `the grid is there with ${rows} row(s) — a decision could find its expense here`;
        });
      }

      return {
        ok,
        steps,
        matchedRow: null,
        screenshot: ok ? null : (await sheet.screenshot().catch(() => null))?.toString("base64") ?? null,
      };
    } catch (err) {
      steps.push({
        name: "connect",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        ms: 0,
      });
      return {
        ok: false,
        steps,
        matchedRow: null,
        screenshot: page ? ((await page.screenshot().catch(() => null))?.toString("base64") ?? null) : null,
      };
    } finally {
      await close?.().catch(() => {});
    }
  });
}

export type BatchItem = {
  id: number;
  decision: Decision;
  target: Target;
  reason: string | null;
};

async function drive(
  page: Page,
  decision: Decision,
  target: Target,
  reason: string,
  sel: Record<string, string>,
  emburseUrl: string,
  login: Login,
  step: (name: string, fn: () => Promise<string>) => Promise<boolean>,
  opts: { dryRun?: boolean; onChallenge?: ChallengeHook },
  setRow: (text: string) => void,
): Promise<boolean> {
  if (!(await signInOnce(page, sel, emburseUrl, login, step, opts.onChallenge))) return false;
  return applyOne(page, decision, target, reason, sel, emburseUrl, step, opts, setRow);
}

/**
 * Get as far as a signed-in ADMIN view. Done once per browser session.
 *
 * Split out because a batch of decisions should pay for this once, not once
 * each: on the real tenant signing in is about fifty seconds and reaching the
 * grid another forty. Twenty decisions that each opened their own session
 * would be half an hour of browser time, and the export could not run in any
 * of it.
 */
/**
 * Keep whatever Emburse issued for getting this far — including for passing a
 * device check.
 *
 * Only the export used to do this. So somebody who verified their device while
 * approving had the trust cookie written into the browser PROFILE and nowhere
 * else — and Replit rebuilds that directory on every deploy. They were asked
 * for a code again on the next ship, and the next, with the page cheerfully
 * reporting that Emburse trusts this browser (it did; just not as them).
 */
async function keepTrust(context: BrowserContext): Promise<void> {
  await rememberCookies(context).catch(() => 0);
}

async function signInOnce(
  page: Page,
  sel: Record<string, string>,
  emburseUrl: string,
  login: Login,
  step: (name: string, fn: () => Promise<string>) => Promise<boolean>,
  /**
   * Answers a device-verification code, when somebody is there to answer it.
   *
   * Without this a decision could not get past Emburse's device check at all —
   * it simply failed, which is what a reviewer saw the first time they
   * approved something from an account the server's browser had never signed
   * in as. The export path has always had it; the decision path did not, and
   * the two share the same sign-in.
   */
  onChallenge?: ChallengeHook,
): Promise<boolean> {
  if (!(await step("open Emburse", async () => {
    await page.goto(emburseUrl, { waitUntil: "domcontentloaded" });
    return `loaded ${safeUrl(page.url())}`;
  }))) return false;

  // The same sign-in the export uses, not a second copy of it: the subtleties
  // (two-step identity page, absence not meaning success) are worth having in
  // exactly one place.
  if (!(await step("sign in", async () => signIn(page, sel as never, login, emburseUrl, onChallenge)))) return false;

  if (!(await step("switch to ADMIN", async () => {
    const tab = page.locator(sel.adminTab!).first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      return "clicked ADMIN";
    }
    if (await page.locator(sel.loggedIn!).first().isVisible().catch(() => false)) {
      // NOT a success, and it used to read like one. The ADMIN tab is how an
      // Emburse admin reaches the team-wide view, and the grid every decision
      // searches IS that view. An account without the tab signs in perfectly
      // well and then has no grid — which is reported as a grid problem three
      // steps later, when it is really a permissions one.
      return "NO ADMIN TAB — this account may not have Emburse's team view, which is where decisions look";
    }
    throw new Error(`no ADMIN tab and the app is not loaded — at ${safeUrl(page.url())}`);
  }))) return false;

  return true;
}

/**
 * Find, verify and act on one expense, on a page that is already signed in.
 *
 * Every safeguard lives here rather than in the caller, so a batch cannot get
 * a laxer version of the checks than a single decision does.
 */
async function applyOne(
  page: Page,
  decision: Decision,
  target: Target,
  reason: string,
  sel: Record<string, string>,
  emburseUrl: string,
  step: (name: string, fn: () => Promise<string>) => Promise<boolean>,
  opts: { dryRun?: boolean },
  setRow: (text: string) => void,
): Promise<boolean> {
  let row: ReturnType<Page["locator"]> | null = null;

  if (!(await step("search for the expense", async () => {
    // The search box is a query parameter, so navigate to the filtered grid
    // rather than typing into it. One less thing that can be focused wrong,
    // debounced, or left holding a previous search.
    const term = target.merchant.trim().split(/\s+/).slice(0, 2).join(" ");
    await page.goto(gridUrl(emburseUrl, { query: term, path: sel.gridPath }), {
      waitUntil: "domcontentloaded",
    });
    // Any visible match, not element number one: a grid's hidden measuring
    // rows come first in the DOM and never become visible.
    if (!(await firstVisible(page, sel.grid!, env.emburseLogin.stepTimeoutMs))) {
      throw new Error(await whyNoGrid(page, sel));
    }

    const rows = page.locator(sel.resultRow!);
    const count = await rows.count();
    if (count === 0) throw new Error("the search returned no rows");

    // Narrow by the full match rather than by position: whichever row Emburse
    // happens to put first is not evidence of anything.
    const matches: number[] = [];
    for (let i = 0; i < Math.min(count, 50); i++) {
      const text = await rows.nth(i).innerText().catch(() => "");
      if (rowMatches(text, target).ok) matches.push(i);
    }

    if (matches.length === 0) {
      const first = await rows.nth(0).innerText().catch(() => "");
      throw new Error(
        `none of the ${count} rows match this expense — ${rowMatches(first, target).why}`,
      );
    }
    if (matches.length > 1) {
      // Two rows that agree on employee, merchant, amount AND date are a real
      // possibility (a split purchase), and there is nothing here that could
      // tell them apart. Guessing would approve an expense nobody chose.
      throw new Error(
        `${matches.length} rows match this expense equally well; refusing to guess which one to ${decision}`,
      );
    }

    row = rows.nth(matches[0]!);
    return `matched 1 of ${count} rows`;
  }))) return false;

  if (!(await step("verify it is the right row", async () => {
    const text = (await row!.innerText()).replace(/\s+/g, " ").trim();
    const verdict = rowMatches(text, target);
    if (!verdict.ok) throw new Error(`the row stopped matching: ${verdict.why}`);
    setRow(text.slice(0, 300));
    return `${verdict.why} — ${text.slice(0, 120)}`;
  }))) return false;

  if (opts.dryRun) {
    await step("dry run", async () => `found the row; stopped without ${decision === "approve" ? "approving" : "denying"}`);
    return true;
  }

  if (decision === "approve") {
    return step("approve", async () => {
      await row!.locator(sel.approveButton!).first().click();
      await page.waitForTimeout(1500);
      return "approved in Emburse";
    });
  }

  return step("deny", async () => {
    await row!.locator(sel.rowMenu!).first().click();
    await page.locator(sel.denyButton!).first().click();

    // Emburse may or may not ask why. Fill it when it does — a denial with no
    // stated reason is a support ticket waiting to happen for the employee.
    const box = page.locator(sel.denyReason!).first();
    if (await box.isVisible().catch(() => false)) await box.fill(reason);

    await page.locator(sel.denyConfirm!).last().click();
    await page.waitForTimeout(1500);
    return reason ? `denied in Emburse: ${reason}` : "denied in Emburse";
  });
}
