import type { BrowserContext, Locator, Page } from "playwright";
import { env } from "../env.js";
import {
  explainLaunch, firstVisible, gridLoaded, gridUrl, makeStepper, openBrowser, safeUrl, signIn,
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
  // Both grid shapes, because Emburse uses the second one.
  //
  // Scoped to the body in each case so the header row is never a candidate.
  // This was "table tbody tr" alone, which describes a grid built from a
  // real <table> — and spend.emburse.com builds its transactions grid from
  // divs with ARIA roles, so it matched nothing at all and every decision
  // died at "the search returned no rows". Matching too widely is not a
  // risk worth worrying about here: every candidate row still has to agree
  // on employee, merchant, amount AND date, and two rows matching equally
  // well is refused rather than guessed at.
  resultRow: 'table tbody tr, [role="rowgroup"] [role="row"]',
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
  //
  // And the SIGN has to agree, which it did not. Emburse writes a credit in
  // accounting style — "($47.56)" — with no minus sign anywhere, so:
  //
  //   - a refund could never be actioned at all: "-47.56" is not in the row,
  //     and every approve or deny of one failed with "amount not in the row";
  //   - far worse, a $47.56 CHARGE matched a ($47.56) credit, because "(" and
  //     "$" are neither digits nor separators and sailed through the
  //     boundary check. One car-rental row on a real grid is "($47.56)" and
  //     the one below it is "$636.79"; a charge and its refund sitting
  //     together is ordinary, and this could have approved the wrong one.
  //
  // So the figure is compared unsigned, and each occurrence is then read for
  // the sign the page gives it.
  const abs = Math.abs(t.amount).toFixed(2);
  const forms = [abs, Number(abs).toLocaleString("en-US", { minimumFractionDigits: 2 })];
  const wantNegative = t.amount < 0;

  /** Does the row show this figure with the sign we are looking for? */
  const shownWithRightSign = (n: string): boolean => {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\d.,])${esc}(?![\\d])`, "g");
    for (let m = re.exec(text); m; m = re.exec(text)) {
      // An opening bracket or a minus just before it — past an optional
      // currency symbol — is how a negative is written either way.
      const before = text.slice(Math.max(0, m.index - 3), m.index);
      const negative = /[(\u2212-]\s*\$?\s*$/.test(before);
      if (negative === wantNegative) return true;
    }
    return false;
  };

  if (!forms.some(shownWithRightSign)) {
    const amount = money(t.amount);
    // Say which of the two it is. "Not in the row" about a figure that is
    // plainly in the row, with brackets round it, is the sort of message
    // that sends somebody looking in the wrong place.
    const unsignedThere = forms.some((n) =>
      new RegExp(`(?<![\\d.,])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d])`).test(text));
    return {
      ok: false,
      why: unsignedThere
        ? `amount ${amount} is in the row but with the wrong sign — this row is ` +
          `${wantNegative ? "a charge, and the expense is a credit" : "a credit, and the expense is a charge"}`
        : `amount ${amount} not in the row`,
    };
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
  /**
   * `onResult` fires as each decision finishes, rather than the caller
   * waiting for the whole batch. Three decisions take three minutes, and
   * with only a final Map to go on the queue showed nothing at all for
   * three minutes and then flipped all three at once — indistinguishable,
   * while it is happening, from nothing happening. Settling one at a time
   * also means a batch that dies on the third does not leave the first two
   * unrecorded, having already actioned them in Emburse.
   */
  opts: {
    dryRun?: boolean;
    onChallenge?: ChallengeHook;
    onResult?: (id: number, run: DecisionRun) => Promise<void> | void;
  } = {},
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
          (t) => (matchedRow = t), login.email,
        );
        const run: DecisionRun = {
          ok,
          steps,
          screenshot: ok ? null : (await page.screenshot().catch(() => null))?.toString("base64") ?? null,
          matchedRow,
        };
        results.set(it.id, run);
        // Reported now, not at the end. A reporting failure must not abandon
        // the rest of the batch: the browser is held and the remaining
        // decisions are what it is held for.
        if (opts.onResult) {
          try { await opts.onResult(it.id, run); }
          catch (err) { console.error("decisions: could not record one as it finished:", err); }
        }
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

/**
 * How many result rows are read before giving up on finding the expense.
 *
 * Every row costs a round trip for its text, so this is not free — but it
 * was 50, and a search for a merchant like DOORDASH returns a month of
 * them. Past the cap the run reported "none of the 340 rows match", which
 * it could not know, having read fifty. The number is generous now and the
 * message is honest when it is reached.
 */
const ROWS_EXAMINED = 250;

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
/**
 * Click the first VISIBLE match inside a locator, or say why nothing was.
 *
 * `row.locator(sel).first().click()` is what this replaces, and it is how
 * approving spent thirty seconds doing nothing and then reported
 * "locator.click: Timeout 30000ms exceeded". A virtualised grid renders
 * hidden copies of its rows to measure them, so the FIRST APPROVE button in
 * the DOM is routinely one that will never be visible — and Playwright
 * waits out the whole timeout for it to become clickable.
 *
 * The export has done it this way for a long time (firstVisible /
 * clickVisible in auto-export). The decision path simply never got the same
 * treatment, so it kept walking into the trap the export had already mapped.
 */
/**
 * The control belonging to this row, even when it is not inside it.
 *
 * Emburse PINS the Action column. A pinned column is rendered in its own
 * container so it can stay put while the rest scrolls sideways — which
 * means the APPROVE button for a row is NOT a descendant of that row. It is
 * a descendant of the matching row in the pinned container, aligned to the
 * pixel and unrelated in the DOM.
 *
 * So `row.locator(approveButton)` matched nothing on a page that visibly
 * had an APPROVE button on the very row just verified, and reported "no
 * APPROVE button matched" — true, and useless.
 *
 * Position is what actually relates the two: the button for a row sits on
 * the same horizontal band as the row. So when nothing is inside, look
 * page-wide for visible matches whose vertical centre falls within the
 * row's box.
 *
 * It still refuses to guess. Exactly one aligned control is a match; two
 * means the rows are not what this thinks they are, and clicking either
 * would be picking somebody's expense at random.
 */
async function controlForRow(
  page: Page,
  row: Locator,
  selector: string,
  what: string,
  timeoutMs: number,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;

  do {
    // Inside the row first: the ordinary case, and the cheapest.
    const inner = row.locator(selector);
    const n = await inner.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      if (await inner.nth(i).isVisible().catch(() => false)) return inner.nth(i);
    }

    // Then by alignment, for a pinned column.
    const box = await row.boundingBox().catch(() => null);
    if (box && box.height > 0) {
      const all = page.locator(selector);
      const total = await all.count().catch(() => 0);
      const aligned: Locator[] = [];
      for (let i = 0; i < total; i++) {
        const one = all.nth(i);
        if (!(await one.isVisible().catch(() => false))) continue;
        const b = await one.boundingBox().catch(() => null);
        if (!b) continue;
        const middle = b.y + b.height / 2;
        if (middle >= box.y && middle <= box.y + box.height) aligned.push(one);
      }
      if (aligned.length === 1) return aligned[0]!;
      if (aligned.length > 1) {
        throw new Error(
          `${aligned.length} ${what}s line up with this row, so which one belongs to it ` +
          `cannot be told apart — refusing to pick one.`);
      }
    }

    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);

  const anywhere = await page.locator(selector).count().catch(() => 0);
  const rowText = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 120);
  // A missing ⋮ menu stops denying and nothing else. Saying so keeps
  // somebody from concluding the whole row is unreachable when approving it
  // would work perfectly.
  const denyOnly = /menu/i.test(what)
    ? " Approving would still work; only denying needs this."
    : "";
  throw new Error(
    anywhere > 0
      ? `the row is right, but none of the ${anywhere} thing(s) matching “${selector}” on the ` +
        `page is both visible and on this row's line. The row reads: “${rowText}”${denyOnly}`
      : `no ${what} matched “${selector}” anywhere on the page.${denyOnly}`,
  );
}

async function clickFirstVisible(
  scope: Locator | Page,
  selector: string,
  what: string,
  timeoutMs: number,
): Promise<void> {
  const all = scope.locator(selector);
  const deadline = Date.now() + timeoutMs;
  do {
    const n = await all.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const one = all.nth(i);
      if (await one.isVisible().catch(() => false)) {
        await one.click();
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);

  const n = await all.count().catch(() => 0);
  throw new Error(
    n > 0
      ? `found ${n} ${what} matching “${selector}” but none of them is visible — they are ` +
        `probably the hidden copies a grid renders to measure itself, not the real control.`
      : `no ${what} matched “${selector}”.`,
  );
}

/** How many of each selector are on the page, ignoring the ones that throw. */
async function countAll(
  page: Page, selectors: string[],
): Promise<{ sel: string; n: number }[]> {
  const seen = new Set<string>();
  const out: { sel: string; n: number }[] = [];
  for (const sel of selectors) {
    if (!sel.trim() || seen.has(sel)) continue;
    seen.add(sel);
    // An invalid selector is a possibility here — these come partly from
    // settings somebody typed — and one bad one must not lose the rest.
    out.push({ sel, n: await page.locator(sel).count().catch(() => 0) });
  }
  return out;
}

async function whyNoGrid(page: Page, sel: Record<string, string>, asEmail?: string): Promise<string> {
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
  const who = asEmail ? `signed in as ${asEmail}` : "signed in";

  // What IS on the page, rather than a theory about why it is not.
  //
  // This used to name the account as the likely cause — the export signs in
  // as whichever login last worked, a decision as the person who made it, so
  // blaming the difference between them sounded reasonable. It was wrong,
  // and confidently so: the page text underneath showed the reviewer on the
  // Transactions page, with EXPORT and "Needs Review 99+" right there. The
  // grid was on screen. The SELECTOR was stale. A guess dressed as a
  // diagnosis sends somebody to ask IT for permissions they already have.
  const probes = await countAll(page, [
    "table", "table tbody tr", '[role="grid"]', '[role="table"]',
    '[role="rowgroup"]', '[role="row"]', sel.itemCount ?? "", sel.resultRow ?? "",
  ]);
  const found = probes.filter((p) => p.n > 0);

  return `no grid at ${where}, ${who}. Nothing matched the grid selector “${sel.grid}” ` +
    `or the item-count line “${sel.itemCount}”. ` +
    (found.length > 0
      ? `What IS on the page: ${found.map((p) => `${p.sel} ×${p.n}`).join(", ")} — ` +
        `so the page loaded and one of those is the grid. Set the grid and row selectors in ` +
        `Settings to match, rather than changing anything about the account.`
      : `Nothing table-like is on the page at all, so either it had not finished ` +
        `rendering or “${sel.gridPath}” is not where this tenant keeps its transactions.`) +
    ` The page says: ${text.slice(0, 200) || "(nothing readable)"}`;
}

/**
 * Why the search found nothing, in terms of what is on the page.
 *
 * Two quite different things produce no rows: Emburse really has no match
 * for the search, or it has plenty and `resultRow` does not describe them.
 * The second is far more likely on a tenant whose selectors have drifted —
 * the shipped default is "table tbody tr", and a grid built from divs has no
 * tbody and no tr at all. Guessing a replacement is not an option here: this
 * function sits one step away from clicking APPROVE on somebody's expense,
 * and a selector that matched the wrong container is precisely how the wrong
 * row gets approved. So it reports, in enough detail to set the selector by
 * hand, and refuses.
 */
async function whyNoRows(
  page: Page, sel: Record<string, string>, term: string,
): Promise<string> {
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/no results|no expenses|no transactions|nothing to show|0 results/i.test(text)) {
    return `Emburse says there are no results for “${term}”, so the expense is not in ` +
      `this view — it may already have been actioned, or be in a different section.`;
  }

  const candidates = await countAll(page, [
    sel.resultRow ?? "", "table tbody tr", "tbody tr", "tr",
    '[role="rowgroup"] [role="row"]', '[role="row"]', "[data-row-id]", "li",
  ]);
  const best = candidates.filter((c) => c.n > 0 && c.sel !== sel.resultRow);
  if (best.length === 0) {
    return `no rows matched “${sel.resultRow}”, and nothing else row-shaped is on the page ` +
      `either. The page says: ${text.slice(0, 200) || "(nothing readable)"}`;
  }

  // Several samples, skipping blanks. Reporting only the FIRST said
  // "(empty)" on a real tenant — a virtualised grid puts a spacer row ahead
  // of the data — which reads as "that selector is wrong" about the
  // selector that was in fact right.
  const rows = page.locator(best[0]!.sel);
  const samples: string[] = [];
  for (let i = 0; i < Math.min(best[0]!.n, 8) && samples.length < 3; i++) {
    const t = (await rows.nth(i).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (t) samples.push(t.slice(0, 120));
  }

  return `the grid is on screen but nothing matched the row selector “${sel.resultRow}”. ` +
    `Row-shaped things that ARE here: ${best.map((c) => `${c.sel} ×${c.n}`).join(", ")}. ` +
    (samples.length > 0
      ? `“${best[0]!.sel}” reads: ${samples.map((t) => `“${t}”`).join(" / ")}. `
      : `Every “${best[0]!.sel}” is empty, so those are spacers rather than data rows. `) +
    `If those are grid rows, set the row selector in Settings to it — nothing is guessed here, ` +
    `because a selector matching the wrong container is how the wrong expense gets approved.`;
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
          if (!(await gridLoaded(sheet, sel as never))) {
            throw new Error(await whyNoGrid(sheet, sel, login.email));
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
  return applyOne(page, decision, target, reason, sel, emburseUrl, step, opts, setRow, login.email);
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

  if (!(await step("switch to the team view", async () => {
    const tab = page.locator(sel.adminTab!).first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      return "clicked the team-wide tab";
    }
    if (await page.locator(sel.loggedIn!).first().isVisible().catch(() => false)) {
      // NOT a success, and it used to read like one. The team-wide tab is how
      // an Emburse admin reaches the view every decision searches. An account
      // without it signs in perfectly well and then has no grid — reported as
      // a grid problem three steps later, when it is really a permissions one.
      //
      // But name the selector too. Emburse calls this tab ADMIN on some
      // tenants and MANAGER on others, and while it matched only ADMIN this
      // line told people on a MANAGER tenant that their account might lack a
      // view that was on screen the whole time.
      return `no team-wide tab matched ${sel.adminTab} — either this account lacks Emburse's ` +
        `team view, or the tab is named something else here and that selector needs correcting`;
    }
    throw new Error(`no team-wide tab and the app is not loaded — at ${safeUrl(page.url())}`);
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
  asEmail?: string,
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
    // The same two signals the export accepts, not just the grid selector.
    // The export has always taken the item-count line as proof the grid
    // arrived — "34 items, $42,249.94" cannot be on screen unless the rows
    // are — while this path demanded the grid element itself. So on a tenant
    // whose grid selector is stale the export ran fine and every decision
    // failed, and the difference looked like an account problem. It was not.
    if (!(await gridLoaded(page, sel as never))) {
      throw new Error(await whyNoGrid(page, sel, asEmail));
    }

    const rows = page.locator(sel.resultRow!);
    const count = await rows.count();
    // "the search returned no rows" is true and tells nobody what to do. The
    // rows are almost always right there — it is the SELECTOR that does not
    // describe them, and which selector would is readable off the page.
    if (count === 0) throw new Error(await whyNoRows(page, sel, term));

    // Narrow by the full match rather than by position: whichever row Emburse
    // happens to put first is not evidence of anything.
    //
    // The search is deliberately WIDE — two words of the merchant — and the
    // narrowing happens here, against employee, merchant, amount and date
    // together. That is the safe direction: fetching too much costs a few
    // seconds, while a filter that silently excluded the right row would
    // report "not there" about an expense that is.
    const examined = Math.min(count, ROWS_EXAMINED);
    const matches: number[] = [];
    for (let i = 0; i < examined; i++) {
      const text = await rows.nth(i).innerText().catch(() => "");
      if (rowMatches(text, target).ok) matches.push(i);
    }

    if (matches.length === 0) {
      const first = await rows.nth(0).innerText().catch(() => "");
      // Never claim none of N matched when only the first few were read. A
      // merchant like DOORDASH returns the whole month, and "none of the 340
      // rows match" — said after looking at fifty — is a false statement
      // about the other 290, in the one place a false statement means an
      // expense gets reported as missing when it is sitting there.
      if (examined < count) {
        throw new Error(
          `looked at the first ${examined} of ${count} rows and none match this expense. ` +
          `The search for “${term}” is too broad to find it this way — narrow it in ` +
          `Emburse, or the expense may genuinely not be in this view. ` +
          `The first row reads differently: ${rowMatches(first, target).why}.`);
      }
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

  // The dry run used to stop the moment the row was found, which meant it
  // proved everything EXCEPT the part most likely to be wrong. Approve is one
  // button inside the row; deny is a ⋮ menu, an item in it, a reason box and
  // a confirm — four more selectors, none of which a dry run ever touched. So
  // a green test told you nothing about whether denying would work.
  //
  // It now reaches for the controls without using them. For deny that means
  // opening the menu and looking for Deny, then pressing Escape. Opening a
  // menu changes nothing; the confirm is never clicked, on any path.
  if (opts.dryRun) {
    return step("dry run", async () => {
      // Exactly the lookup the real click uses — inside the row, then by
      // alignment for a pinned column. A dry run that searched only inside
      // the row would fail on a page where approving works, which is worse
      // than not testing at all: it is a test that disagrees with the thing
      // it tests.
      const ms = env.emburseLogin.stepTimeoutMs;
      if (decision === "approve") {
        await controlForRow(page, row!, sel.approveButton!, "APPROVE button", ms);
        return "found the row and its APPROVE button; stopped without approving";
      }

      const menu = await controlForRow(page, row!, sel.rowMenu!, "⋮ row menu", ms);
      await menu.click();
      await page.waitForTimeout(300);
      const items = page.locator(sel.denyButton!);
      let there = false;
      const n = await items.count().catch(() => 0);
      for (let i = 0; i < n && !there; i++) {
        there = await items.nth(i).isVisible().catch(() => false);
      }
      // Always close it, whatever was found. A menu left open over the grid
      // is the next run's problem.
      await page.keyboard.press("Escape").catch(() => undefined);
      if (!there) {
        throw new Error(
          `opened the row's ⋮ menu, but ${n === 0 ? "nothing" : `none of the ${n} thing(s)`} ` +
          `in it matched “${sel.denyButton}” visibly. ` +
          `Approving would still work; denying would fail at this point.`);
      }
      return "found the row, opened its ⋮ menu and found Deny; stopped without denying";
    });
  }

  const ms = env.emburseLogin.stepTimeoutMs;

  if (decision === "approve") {
    return step("approve", async () => {
      await (await controlForRow(page, row!, sel.approveButton!, "APPROVE button", ms)).click();
      await page.waitForTimeout(300);
      return await confirmActioned(page, sel, target, "approved");
    });
  }

  return step("deny", async () => {
    await (await controlForRow(page, row!, sel.rowMenu!, "⋮ row menu", ms)).click();
    await page.waitForTimeout(300);
    await clickFirstVisible(page, sel.denyButton!, "Deny item in the row menu", ms);

    // Emburse may or may not ask why. Fill it when it does — a denial with no
    // stated reason is a support ticket waiting to happen for the employee.
    const box = await (async () => {
      const all = page.locator(sel.denyReason!);
      const n = await all.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        if (await all.nth(i).isVisible().catch(() => false)) return all.nth(i);
      }
      return null;
    })();
    if (box) await box.fill(reason);

    await clickFirstVisible(page, sel.denyConfirm!, "Deny confirm button", ms);
    const said = await confirmActioned(page, sel, target, "denied");
    return reason ? `${said}, reason: ${reason}` : said;
  });
}

/**
 * Did the click actually do anything?
 *
 * Both paths used to click, wait a flat second and a half, and report
 * "approved in Emburse" unconditionally — whether or not the button was hit,
 * whether or not Emburse recorded a thing. That is the worst available
 * failure on an audit-relevant action: the queue says applied, the expense
 * sits unapproved, and nobody looks again.
 *
 * The check is that the expense leaves the Needs Review grid, which is what
 * actioning it does. Polled rather than slept on, so a fast tenant is not
 * waited out and a slow one is not called a failure.
 *
 * When it does NOT disappear this throws, which marks the decision failed.
 * That is the safer of the two mistakes: a decision wrongly marked failed
 * gets tried again and the retry finds no matching row, while one wrongly
 * marked applied is simply lost. The message says as much, because "it may
 * have worked, go and look" is the honest state and the reviewer can settle
 * it in ten seconds.
 */
async function confirmActioned(
  page: Page,
  sel: Record<string, string>,
  target: Target,
  what: string,
): Promise<string> {
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500);
    // Re-scanned rather than held as a locator: the grid re-renders after an
    // action, so the row that was nth(3) is a different expense now.
    const rows = page.locator(sel.resultRow!);
    const n = Math.min(await rows.count().catch(() => 0), 60);
    let still = false;
    for (let j = 0; j < n; j++) {
      const text = await rows.nth(j).innerText().catch(() => "");
      if (rowMatches(text, target).ok) { still = true; break; }
    }
    if (!still) return `${what} in Emburse — the row left Needs Review`;
  }
  throw new Error(
    `clicked ${what === "approved" ? "APPROVE" : "Deny"}, but the expense is still in ` +
    `Needs Review six seconds later, so nothing confirms Emburse recorded it. It may ` +
    `have gone through — check the expense in Emburse before deciding it again.`);
}
