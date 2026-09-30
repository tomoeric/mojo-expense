import type { BrowserContext, Locator, Page } from "playwright";
import { env } from "../env.js";
import {
  EMPTY_GRID, explainLaunch, firstVisible, gridLoaded, gridUrl, makeStepper, openBrowser,
  openEmburse, safeUrl, signIn, userIdInUrl,
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
  /**
   * The run established that Emburse has NOTHING matching this in Needs
   * Review — not that anything went wrong.
   *
   * Set only for the unambiguous case: the grid loaded and is empty. NOT for
   * "rows came back and none of them matched", which is the shape a matching
   * bug takes — a truncated cardholder, an unpadded day, a credit read as a
   * charge — and marking that as "gone" would quietly stop anybody ever
   * retrying a real defect.
   */
  notInQueue?: boolean;
};

export type DecisionSelectorKey =
  | "resultRow" | "approveButton" | "rowMenu"
  | "denyButton" | "denyReason" | "denyConfirm" | "decisionApplied"
  | "userFilter" | "userFilterInput" | "userFilterOption";

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
  // The cardholder filter, which is a FILTER and not the text search — and
  // that distinction is the whole point of it. Emburse's text search
  // demonstrably misses rows that are in the view: searching "MADRELA"
  // returned the LA MADRELA of the 24th and not the LA MADRELA of the 9th,
  // both in Needs Review, both the same person. The users dropdown showed
  // all ten of that person's rows, the missing one among them.
  //
  // Selectors are configuration here precisely because they cannot be known
  // from outside the tenant; these are a starting point, and a failed run
  // names the step, quotes what it looked for and hands back a screenshot.
  // Ordered most specific first, because firstVisible takes the first
  // match: the users control sits before the categories one on the page,
  // so a bare [role="combobox"] lands on the right one — but only just, and
  // that is why this is configuration rather than code.
  userFilter:
    'input[role="combobox"][aria-label*="user" i], [aria-label*="all users" i], ' +
    'button:has-text("All users"), input[role="combobox"], [role="combobox"]',
  // EMPTY on purpose: clicking the dropdown focuses its own input, and
  // typing into the focused element cannot land in the page's Search box
  // the way a selector union can. Set it only if a tenant needs it.
  userFilterInput: "",
  userFilterOption: '[role="option"], li',
};

export const DECISION_SELECTOR_HELP: Record<DecisionSelectorKey, string> = {
  resultRow: "One row of the results table.",
  approveButton: "The APPROVE button on a row.",
  rowMenu: "The ⋮ menu at the end of a row, which holds Deny.",
  denyButton: "Deny, inside that menu.",
  denyReason: "The reason box, if Emburse asks for one.",
  denyConfirm: "The button that confirms the denial.",
  decisionApplied: "Confirmation that the decision was recorded.",
  userFilter: "The users dropdown above the grid — the one reading “All users”.",
  userFilterInput: "The box inside that dropdown you type a name into.",
  userFilterOption: "One name in the list the dropdown offers.",
};

export const DECISION_STEP_SELECTORS: Record<string, DecisionSelectorKey[]> = {
  "search for the expense": ["resultRow", "userFilter", "userFilterInput", "userFilterOption"],
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
/**
 * Is this figure anywhere on the row, whatever sign the page gives it?
 *
 * Sign-blind and merchant-blind on purpose. It answers one question —
 * "could this row be the expense?" — and it is the only thing allowed to
 * conclude that an expense has LEFT Needs Review. A row carrying the amount
 * but turned down on the cardholder's truncated name, an unpadded day or a
 * credit written as "($47.56)" is OUR matching failing, not a missing
 * expense, and marking that absent means nobody ever retries it.
 */
export function amountAppears(rowText: string, amount: number): boolean {
  const text = rowText.replace(/\s+/g, " ").trim();
  const abs = Math.abs(amount).toFixed(2);
  return [abs, Number(abs).toLocaleString("en-US", { minimumFractionDigits: 2 })].some((n) =>
    new RegExp(`(?<![\\d.,])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d])`).test(text));
}

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
      //
      // But a hyphen inside a WORD is not a minus sign, and Emburse truncates
      // long merchant names mid-word: the row for U-HAUL MOVING & STORAGE
      // reads "… OU- $39.94", and that trailing hyphen made a $39.94 charge
      // look like a credit, so it matched nothing and the approval failed
      // with "amount 39.94 not in the row" about a row plainly showing
      // $39.94. So a minus only counts when a letter or digit is not sitting
      // right against it.
      const before = text.slice(Math.max(0, m.index - 4), m.index);
      const sign = /([(\u2212-])\s*\$?\s*$/.exec(before);
      const negative = sign !== null
        && !(sign[1] !== "(" && /[A-Za-z0-9]$/.test(before.slice(0, sign.index)));
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

  // The cardholder column is truncated too: Emburse prints "CRAIG W
  // DEMORA…" where the expense says Craig Demoranville, so demanding the
  // whole surname refused a row that was plainly the right one. A stem
  // counts only when the PAGE says it was cut — four or more letters
  // immediately followed by an ellipsis, and a genuine prefix of the
  // surname. Guessing at prefixes without that marker would let "Smith"
  // match "Smithson".
  const surname = t.employee.trim().split(/\s+/).pop() ?? "";
  if (surname) {
    const want = surname.toLowerCase();
    let found = lower.includes(want);
    if (!found) {
      for (const m of lower.matchAll(/([a-z]{4,})(?:\.\.\.|\u2026)/g)) {
        if (want.startsWith(m[1]!)) { found = true; break; }
      }
    }
    if (!found) return { ok: false, why: `employee "${t.employee}" not in the row` };
  }

  // The first word of the merchant: Emburse truncates long names with an
  // ellipsis, so the whole string is often genuinely absent from the row.
  //
  // Punctuation is stripped from BOTH sides, which it was not. Stripping it
  // from the target alone turned "U-HAUL" into "UHAUL" and then looked for
  // that in a row containing "U-HAUL" — so no expense from a merchant whose
  // first word carries punctuation could ever be matched. U-HAUL, 7-ELEVEN,
  // McDonald's, any of them.
  // ANY substantial word of it, not only the first. Emburse's merchant
  // strings are mangled at both ends — "HELMS ACE HARDWARE #18136RAISING
  // HELM, LLC" against a row reading "ACE HARDWARE #18…" — so pinning the
  // match to the first word refuses rows that are plainly the same vendor.
  // The amount and the date are what identify the expense; the vendor name
  // is corroboration, and corroboration should be fuzzy.
  const flat = lower.replace(/[^a-z0-9]/g, "");
  const words = t.merchant.trim().split(/\s+/)
    .map((w) => w.replace(/[^\w]/g, "").toLowerCase())
    .filter((w) => w.length >= 4);
  if (words.length > 0 && !words.some((w) => flat.includes(w))) {
    return { ok: false, why: `merchant "${t.merchant}" not in the row` };
  }

  if (t.date) {
    const [y, m, d] = t.date.split("-").map(Number) as [number, number, number];
    const short = new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date(y, m - 1, d));
    const forms = [
      `${m}/${d}/${y}`,
      `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`,
      `${short} ${d}`,
      // Emburse pads the day: "Sep 07, 2026". "Sep 7" is not inside that,
      // so every expense dated before the 10th of a month was refused with
      // "date not in the row" about a date plainly in the row. Nobody had
      // approved one yet — the three that worked were the 16th, 21st and
      // 24th, where padding makes no difference.
      `${short} ${String(d).padStart(2, "0")}`,
      // Padded day, unpadded month. Cheap to allow and perfectly plausible
      // on a grid that pads one field and not the other; the string is
      // specific enough that it cannot match a different date.
      `${m}/${String(d).padStart(2, "0")}/${y}`,
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
  opts: { dryRun?: boolean; onChallenge?: ChallengeHook; automatic?: boolean; peers?: number } = {},
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
/**
 * Did the run establish that CHROMIUM, not the network, could not load the
 * page?
 *
 * `openEmburse` already answers this — it tries a plain fetch from the
 * container before giving up, and says which of the two it is. This reads
 * that finding rather than guessing at one, so a relaunch is only ever
 * attempted where a relaunch is the documented remedy.
 */
const browserWedged = (steps: StepResult[]): boolean =>
  steps.some((s) => !s.ok && /BROWSER is what could not load the page/i.test(s.detail));

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
    /**
     * Asked before each decision: should this batch stop here?
     *
     * Between decisions, never during one. Pausing used to mean "queue
     * nothing more and start no new batch", which does nothing about the
     * batch already running — and when that batch is a hundred and forty
     * decisions long, pressing Pause and watching it carry on for two more
     * hours is indistinguishable from the button not working.
     *
     * The ones not reached are simply not in the results: they were never
     * attempted, so they stay queued and go when it resumes.
     */
    shouldStop?: () => boolean | Promise<boolean>;
  } = {},
): Promise<Map<number, DecisionRun>> {
  const results = new Map<number, DecisionRun>();
  if (items.length === 0) return results;

  const sel = { ...DECISION_SELECTORS, ...selectors } as Record<string, string>;

  return withBrowser(`applying ${items.length} decision(s)`, async () => {
    let close: (() => Promise<void>) | null = null;
    let page: Page | null = null;
    try {
      let opened = await openBrowser();
      close = opened.close;
      page = await opened.context.newPage();
      page.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);

      // Once, for the whole batch.
      const shared: StepResult[] = [];
      let signedIn = await signInOnce(page, sel, emburseUrl, login, makeStepper(shared), opts.onChallenge);

      // ONE relaunch, when the diagnosis says the browser is the problem.
      //
      // A batch signs in once, so a Chromium that cannot load a page takes
      // the whole batch with it: one report had forty-one failures, twenty
      // of them five-at-a-time with identical timings, every one reading
      // "the network is fine and the BROWSER is what could not load the
      // page — a corrupt profile, a leftover process, or memory on this
      // VM". The app had worked that out and then done nothing with it.
      //
      // Throwing the context away and opening a fresh one is the remedy for
      // exactly that list of causes. Gated on the app's OWN finding, which
      // it only reaches after proving with a plain fetch that the container
      // can reach Emburse — so this never retries a network outage, where a
      // second browser would fail the same way and cost another two
      // minutes. Both attempts stay on the record.
      if (!signedIn && browserWedged(shared)) {
        console.log("decisions: the browser could not load Emburse though the network is up — reopening it");
        await close().catch(() => {});
        close = null;
        opened = await openBrowser();
        close = opened.close;
        page = await opened.context.newPage();
        page.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);
        signedIn = await signInOnce(page, sel, emburseUrl, login, makeStepper(shared), opts.onChallenge);
      }

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
        // Between decisions, never mid-click: a half-clicked approval
        // abandoned is worse than one allowed to land.
        if (opts.shouldStop && (await opts.shouldStop())) {
          console.log(`decisions: stopping after ${results.size} of ${items.length}`);
          break;
        }
        const steps: StepResult[] = [...shared];
        const step = makeStepper(steps);
        let matchedRow: string | null = null;
        const ok = await applyOne(
          page, it.decision, it.target, it.reason ?? "", sel, emburseUrl, step,
          { ...opts, automatic: it.automatic === true, peers: it.peers ?? 1 },
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
/**
 * Of several rows that all match, the one a person can actually see.
 *
 * Emburse leaves hidden copies of its rows in the DOM — a four-row grid
 * reports seven — and a copy carries the same date, merchant, cardholder
 * and amount, so it matches the expense exactly as well as the real row.
 * Without this, finding the right row TWICE is a refusal ("2 rows match
 * this expense equally well") about an expense that appears once on screen.
 *
 * It does not weaken the check it exists beside. Two VISIBLE rows that
 * agree on employee, merchant, amount and date are a real possibility — a
 * split purchase — and there is nothing here that could tell them apart,
 * so that still refuses. What is discarded is only what nobody can see.
 */
/**
 * Narrow the grid to one cardholder, using Emburse's own users FILTER.
 *
 * Not the text search, and that is the entire point. Emburse's text search
 * misses rows that are in the view: "MADRELA" returned the LA MADRELA of
 * the 24th and not the LA MADRELA of the 9th — same merchant, same person,
 * both sitting in Needs Review. The users dropdown showed all ten of that
 * person's rows with the missing one among them.
 *
 * So this is the authoritative view, and the only one from which "the
 * expense is not there" can honestly be concluded.
 *
 * Returns the URL it produced. That URL carries whatever parameter Emburse
 * uses for the filter, which nobody here knows — recording it is how this
 * becomes a plain navigation instead of three clicks.
 */
/**
 * Cardholder ids learned from the dropdown, for the life of the process.
 *
 * Emburse's id is opaque — `uk4l0byvo7zzwgfzidt34awh2afoixiphkfka8fx` — so
 * it cannot be constructed, only read off the URL after using the dropdown
 * once. Kept in memory rather than a table: it is one small string per
 * person, it never changes, and re-learning it after a restart costs three
 * clicks on the first decision of the day.
 */
const cardholderIds = new Map<string, string>();

/**
 * Forget the cached cardholder ids.
 *
 * For tests, and it is not a convenience. A cached id skips the dropdown
 * entirely, so whether a section exercises the users filter at all depends
 * on whether an EARLIER section happened to succeed for the same person —
 * which made the suite order-dependent in a way that hid a real fault: the
 * case proving a broken option selector fails safely passed only because
 * the section before it had cached the answer.
 */
export function forgetCardholderIds(): void {
  cardholderIds.clear();
}

/**
 * How many controls matching the users-filter selector are opened before
 * giving up.
 *
 * Enough to get past a decoy or two, few enough that a wrong selector
 * matching half the page does not spend a minute proving it. Each one
 * after the first is only being ruled out, so it gets a short look.
 */
const MOST_FILTER_TRIES = 4;

/**
 * What an opened menu is showing, in a few words, for the error message.
 *
 * "opened a menu reading 'No filters saved'" is a diagnosis. "nothing in it
 * named Baitx" is a symptom, and it was the only thing the failure report
 * had to offer across eight decisions.
 */
async function readMenu(page: Page): Promise<string> {
  const any = page.locator('[role="option"], [role="listbox"] li, li');
  const n = await any.count().catch(() => 0);
  const seen: string[] = [];
  for (let i = 0; i < Math.min(n, 30) && seen.length < 4; i++) {
    if (!(await any.nth(i).isVisible().catch(() => false))) continue;
    const t = (await any.nth(i).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (t) seen.push(t.slice(0, 40));
  }
  if (seen.length === 0) return "nothing";
  return `a menu reading ${seen.map((t) => `\u201c${t}\u201d`).join(", ")}`;
}

async function filterToCardholder(
  page: Page,
  sel: Record<string, string>,
  employee: string,
  emburseUrl: string,
  gridPath?: string,
): Promise<string> {
  const surname = employee.trim().split(/\s+/).pop() ?? employee.trim();
  if (!surname) throw new Error("no cardholder name to filter by");

  // Straight there, if this person's id is already known. One navigation
  // instead of a dropdown, a typed name and a click on the right option.
  const known = cardholderIds.get(employee.toLowerCase());
  if (known) {
    await page.goto(gridUrl(emburseUrl, { userId: known, path: gridPath }), {
      waitUntil: "domcontentloaded", timeout: env.emburseLogin.openTimeoutMs,
    });
    return page.url();
  }

  // EVERY control the selector matches, tried in turn — not just the first.
  //
  // Betting on the first is what broke this. The selector ends in a bare
  // [role="combobox"], a union returns DOM ORDER, and the tenant has a
  // saved-filters control sitting before the users one. So the click opened
  // the wrong menu, the surname was typed into it, and the run reported
  // "the users filter opened but nothing in it named Baitx … Visible
  // entries read: 'No filters saved'" — eight decisions in one report,
  // every one of them on the fallback that exists to rescue exactly those.
  //
  // A menu holding no name we asked for is not a reason to give up; it is a
  // reason to try the next candidate. Which one is the users filter cannot
  // be known from outside the tenant, and this is how it is found out:
  // by opening them and looking.
  // WAIT for one to appear before counting any.
  //
  // Rewriting this to try every candidate dropped the wait that was here,
  // and the wait was the load-bearing part: Emburse's transactions page
  // paints in stages, so counting immediately counts an empty page. A live
  // report then showed the giveaway — "no users filter matched … Control
  // shaped things on the page: input[role=combobox] ×2, button ×24" — the
  // diagnostic probe, which runs a moment later, saw controls the match
  // itself had not. Ten decisions failed on a page that had the dropdown.
  await firstVisible(page, sel.userFilter!, 8_000);
  const all = page.locator(sel.userFilter!);
  const found = await all.count().catch(() => 0);
  const candidates: Locator[] = [];
  for (let i = 0; i < Math.min(found, 12) && candidates.length < MOST_FILTER_TRIES; i++) {
    const one = all.nth(i);
    if (await one.isVisible().catch(() => false)) candidates.push(one);
  }

  if (candidates.length === 0) {
    // What IS there, rather than only what was not. A selector guessed from
    // outside the tenant is wrong until proven otherwise, and the fix is to
    // correct it in settings — which needs to know what to correct it TO.
    const probes = await countAll(page, [
      '[role="combobox"]', "input[role=combobox]", "select", "button",
      '[aria-haspopup="listbox"]', '[class*="autocomplete" i]', '[class*="select" i]',
    ]);
    const here = probes.filter((p) => p.n > 0).map((p) => `${p.sel} ×${p.n}`).join(", ");
    throw new Error(
      `no users filter matched \u201c${sel.userFilter}\u201d. Control-shaped things on the page: ` +
      `${here || "none"}. Set the users filter selector in Export settings to whichever of ` +
      `those is the dropdown reading \u201cAll users\u201d.`);
  }

  const tried: string[] = [];
  let picked = false;
  for (let c = 0; c < candidates.length && !picked; c++) {
    const control = candidates[c]!;
    const label = (await control.innerText().catch(() => ""))
      .replace(/\s+/g, " ").trim().slice(0, 30) || "(no text)";
    await control.click().catch(() => {});
    await page.waitForTimeout(400);

    // Typed into whatever the click FOCUSED, not into a box found by
    // selector. The page has its own Search field sitting right beside this
    // dropdown, and a union selector returns matches in DOM order, so
    // "input[role=combobox], input[placeholder*=search]" put the cardholder's
    // name into the page search box instead — which then filtered the grid to
    // nothing and left the dropdown's list unnarrowed. Clicking a combobox
    // focuses its own input; typing there cannot go anywhere else.
    //
    // A configured selector still wins, for a tenant where the click does not
    // focus anything.
    const box = sel.userFilterInput ? await firstVisible(page, sel.userFilterInput, 2_000) : null;
    if (box) await box.fill(surname).catch(() => {});
    else await page.keyboard.type(surname, { delay: 30 }).catch(() => {});

    // The option that actually names this person, not merely the first one
    // offered: a list narrowed by "Emerson" can still hold two Emersons, and
    // picking the wrong one silently filters to somebody else's expenses.
    //
    // Waited for rather than read once. The list is fetched, so a fixed pause
    // is a guess that is either wasted time or too short — and too short
    // reads as "the name is not in the list", which is a different fault
    // entirely and sent this looking in the wrong place once already.
    const options = page.locator(sel.userFilterOption!);
    const want = surname.toLowerCase();
    // The first candidate gets the long look; the rest are being ruled out,
    // and six seconds each over four of them is a minute of nothing.
    const deadline = Date.now() + (c === 0 ? 6_000 : 2_500);
    do {
      const total = await options.count().catch(() => 0);
      for (let i = 0; i < Math.min(total, 60) && !picked; i++) {
        const one = options.nth(i);
        if (!(await one.isVisible().catch(() => false))) continue;
        const text = (await one.innerText().catch(() => "")).toLowerCase();
        if (!text.includes(want)) continue;
        await one.click();
        picked = true;
      }
      if (!picked) await page.waitForTimeout(400);
    } while (!picked && Date.now() < deadline);

    if (!picked) {
      tried.push(`\u201c${label}\u201d opened ${await readMenu(page)}`);
      // Shut it and undo the typing before the next one, or the surname is
      // still sitting in whatever took it — often the page's own search box,
      // which filters the grid out from under the next attempt.
      await page.keyboard.press("Escape").catch(() => {});
      if (box) await box.fill("").catch(() => {});
      await page.waitForTimeout(200);
    }
  }

  if (!picked) {
    // What the lists actually held, which is the only thing that says
    // whether the option selector is wrong, the typing went elsewhere, or
    // the name really is not there. "Nothing named Vigna, 1 option" says
    // none of the three.
    const probes = await countAll(page, [
      sel.userFilterOption ?? "", '[role="option"]', '[role="listbox"] *',
      "li", '[class*="option" i]', '[class*="menu" i] li', "[data-value]",
    ]);
    const counts = probes.filter((p) => p.n > 0).map((p) => `${p.sel} \u00d7${p.n}`).join(", ");
    throw new Error(
      `none of the ${candidates.length} control(s) matching \u201c${sel.userFilter}\u201d is a users ` +
      `filter holding \u201c${surname}\u201d. ${tried.join("; ")}. List-shaped things on the page: ` +
      `${counts || "none"}. If one of those IS the users dropdown, name it exactly in Export ` +
      `settings so it is tried first.`);
  }
  // WAIT for the navigation the click starts, rather than guessing at it.
  //
  // Picking an option makes Emburse navigate to the filtered grid. A fixed
  // pause meant the next page.goto could be issued while that navigation
  // was still in flight, and Playwright aborts one for the other:
  // "Navigation to …filters[query]=MAVERIK… is interrupted by another
  // navigation to …filters[query]=" — which is our own filter arriving
  // late and cancelling our own search.
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  // Then until the URL actually carries the filter, since the load state
  // can settle on the page we were already on.
  await page.waitForURL((u) => userIdInUrl(u.toString()) !== null, { timeout: 10_000 })
    .catch(() => {});
  // What the dropdown put in the URL is the id, and the only way to get it.
  const id = userIdInUrl(page.url());
  if (id) cardholderIds.set(employee.toLowerCase(), id);
  return page.url();
}

async function visibleOf(rows: Locator, indexes: number[]): Promise<number[]> {
  const on: number[] = [];
  for (const i of indexes) {
    if (await rows.nth(i).isVisible().catch(() => false)) on.push(i);
  }
  return on;
}

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

  const all = page.locator(selector);
  const anywhere = await all.count().catch(() => 0);
  // Present-but-invisible and visible-but-misaligned are different faults
  // with different fixes — hidden copies a grid renders to measure itself,
  // versus a control that belongs to some other row. Collapsing them into
  // "none is both visible and on this row's line" lost the distinction the
  // earlier message made, which is the third time this refactor has traded
  // information for tidiness.
  let visible = 0;
  for (let i = 0; i < anywhere; i++) {
    if (await all.nth(i).isVisible().catch(() => false)) visible++;
  }
  const rowText = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 120);
  // A missing ⋮ menu stops denying and nothing else. Saying so keeps
  // somebody from concluding the whole row is unreachable when approving it
  // would work perfectly.
  const denyOnly = /menu/i.test(what)
    ? " Approving would still work; only denying needs this."
    : "";
  if (anywhere === 0) {
    throw new Error(`no ${what} matched “${selector}” anywhere on the page.${denyOnly}`);
  }
  throw new Error(
    visible === 0
      ? `found ${anywhere} ${what}(s) matching “${selector}” but none of them is visible — they ` +
        `are probably the hidden copies a grid renders to measure itself, not the real control. ` +
        `Clicking one would wait for it to appear and time out.${denyOnly}`
      : `the row is right, and ${visible} of the ${anywhere} ${what}(s) matching “${selector}” ` +
        `are visible — but none of them sits on this row's line, so none belongs to it. ` +
        `The row reads: “${rowText}”${denyOnly}`,
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

/**
 * Emburse has nothing matching this in Needs Review.
 *
 * Its own type rather than a phrase to grep for in the message: the queue
 * treats these differently from failures — no retry, no red row, they clear
 * at the next import — and hanging that on wording nobody would think to
 * keep stable is how it quietly stops working the next time somebody
 * improves a sentence.
 */
/**
 * What to ask Emburse for, most specific first.
 *
 * The search used to be one term: the first two words of the merchant. That
 * is wrong often enough to matter, because the merchant our export carries
 * is the card descriptor with the merchant name run into it —
 * "MAVERIK #5074MAVERIK ..." — and the first two words of that are
 * "MAVERIK #5074", which Emburse's own search box returns NO ROWS for while
 * the expense sits in the grid one filter away. Searched by hand for
 * "MAVERIK", it is right there.
 *
 * So the term is tried, and then simplified, until something comes back:
 * the first two words, then the first word with its digits and punctuation
 * taken off, then the longest run of plain letters anywhere in the string.
 *
 * Searching WIDER is the safe direction, and deliberately so. Every row that
 * comes back still has to match employee, merchant, amount AND date before
 * anything is clicked, so a broad search costs seconds; a term that silently
 * excluded the right row reports "not there" about an expense that is —
 * which is exactly what was happening.
 */
export function searchTerms(merchant: string, employee = ""): string[] {
  const words = merchant.trim().split(/\s+/).filter(Boolean);
  const letters = (w: string) => w.replace(/[^A-Za-z]/g, "");
  const runs = merchant.match(/[A-Za-z]{4,}/g) ?? [];
  const longest = runs.slice().sort((a, b) => b.length - a.length)[0] ?? "";
  // No cardholder rung. It was added on the guess that Emburse's search box
  // might look at the cardholder as well as the merchant, to be settled by
  // the first failure report that showed it returning rows. The report came
  // back with “Carroll” → no rows on every one of Brian Carroll's expenses:
  // it does not. Keeping it cost a page load per failing decision and found
  // nothing. The cardholder is reached by Emburse's users FILTER instead,
  // which is a filter and not a search — see filterToCardholder.
  void employee;

  const out = [
    words.slice(0, 2).join(" "),
    letters(words[0] ?? ""),
    longest,
  ];
  // Deduped, and anything with fewer than four letters-or-digits dropped:
  // "BP" returns the whole month, and "#1" is not a search at all. Measured
  // on the alphanumerics, not the length, or "#1 @" counts as four.
  const kept = [...new Set(out.map((t) => t.trim()))]
    .filter((t) => t.replace(/[^A-Za-z0-9]/g, "").length >= 4);
  // Never nothing: a merchant with no searchable run still gets asked for
  // as it stands, which at worst returns nothing and says so.
  return kept.length > 0 ? kept : (merchant.trim() ? [merchant.trim()] : []);
}

export class NotInQueue extends Error {}

/**
 * Turn an explanation into the error to throw, preserving its kind.
 *
 * These helpers either RETURN a sentence (an ordinary failure) or THROW a
 * NotInQueue (the expense is simply not there). Wrapping the call in
 * `new Error(await …)` would turn the second into the first at the one
 * point where the difference matters.
 */
async function asError(explain: Promise<string>): Promise<Error> {
  try {
    return new Error(await explain);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

async function whyNoGrid(page: Page, sel: Record<string, string>, asEmail?: string): Promise<string> {
  const where = safeUrl(page.url());
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();

  // Emburse's own error page. It says so in plain words, and reporting it
  // as a selector problem sends somebody to fix configuration that is
  // fine — "Oops, something went wrong! Try refreshing the page." was
  // filed under "the grid or row selector did not match what is on the
  // page" for want of reading the sentence underneath.
  if (/oops,? something went wrong|try refreshing the page/i.test(text)) {
    return `Emburse itself errored at ${where} — its page says \u201cOops, something went ` +
      `wrong! Try refreshing the page.\u201d Nothing here is misconfigured; the decision ` +
      `is worth trying again.`;
  }
  if (/sign in|log in|password|code-authentication/i.test(text) || /login|auth/i.test(page.url())) {
    return `Emburse sent us back to sign in at ${where} — the session did not survive the search. ` +
      "Test your Emburse connection to sign in again.";
  }
  if (EMPTY_GRID.test(text)) {
    // Reported, NOT concluded. This used to throw NotInQueue — "already
    // approved or denied, nothing to retry" — on the strength of one text
    // search coming back empty, and that inference is the one this whole
    // area exists to undo: Emburse's search demonstrably omits rows that
    // ARE in the view (two LA MADRELA expenses, same person, same queue,
    // one returned and one not). An expense written off here is never
    // retried by anybody.
    //
    // Absence is decided in exactly one place now — the cardholder's own
    // filtered queue, on the amount — and this is one of the observations
    // that feeds it, not a verdict of its own.
    return `the grid loaded at ${where} and is empty — Emburse returned nothing for that ` +
      `search. Its text search is known to miss rows that ARE in the view, so this on its ` +
      `own does not mean the expense has gone.`;
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
  if (EMPTY_GRID.test(text)) {
    // Reported, not concluded — see whyNoGrid. One empty text search is not
    // evidence that an expense has been actioned, because Emburse's search
    // omits rows that are in the view. Absence is decided in one place: the
    // cardholder's own filtered queue, on the amount.
    return `Emburse returned nothing for “${term}”. Its text search is known to miss ` +
      `rows that ARE in the view, so an empty result here says nothing on its own about ` +
      `whether the expense is still in Needs Review.`;
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
/**
 * What is actually in Emburse's Edit form?
 *
 * Changing an expense's category before approving it means driving a dialog
 * nobody here has seen, and tonight has been a long lesson in what guessing
 * at somebody else's markup costs: the grid was divs not a table, the rows
 * had hidden measuring copies, the Action column was pinned. Three rounds,
 * each invisible until the one before it was fixed.
 *
 * So this looks before anything is written. It finds the row the ordinary
 * way — same search, same four-field verification — opens the ⋮ menu,
 * clicks Edit, and reports every control in the form that appears: its
 * role, its label, its current value, and for a dropdown the options it
 * offers. Then it closes without saving.
 *
 * It CHANGES NOTHING. Escape, and out.
 */
export async function inspectEditForm(
  target: Target,
  selectors: Record<string, string>,
  emburseUrl: string,
  login: Login,
  opts: { onChallenge?: ChallengeHook } = {},
): Promise<DecisionRun & { fields: string[] }> {
  const steps: StepResult[] = [];
  const step = makeStepper(steps);
  const sel = { ...DECISION_SELECTORS, ...selectors } as Record<string, string>;
  const fields: string[] = [];

  const run = await withBrowser("looking at Emburse's edit form", async () => {
    let close: (() => Promise<void>) | null = null;
    let page: Page | null = null;
    try {
      const opened = await openBrowser();
      close = opened.close;
      page = await opened.context.newPage();
      page.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);

      if (!(await signInOnce(page, sel, emburseUrl, login, step, opts.onChallenge))) {
        return { ok: false, steps, matchedRow: null, screenshot: null };
      }
      await keepTrust(opened.context);

      let row: Locator | null = null;
      const ms = env.emburseLogin.stepTimeoutMs;

      if (!(await step("find the expense", async () => {
        // The same ladder as the decision path: one term is not enough on a
        // tenant whose merchant strings carry the card descriptor.
        const term = searchTerms(target.merchant, target.employee)[0] ?? target.merchant;
        await page!.goto(gridUrl(emburseUrl, { query: term, path: sel.gridPath }), {
          waitUntil: "domcontentloaded",
        });
        if (!(await gridLoaded(page!, sel as never))) throw await asError(whyNoGrid(page!, sel, login.email));
        const rows = page!.locator(sel.resultRow!);
        const count = await rows.count();
        if (count === 0) throw await asError(whyNoRows(page!, sel, term));
        const hits: number[] = [];
        for (let i = 0; i < Math.min(count, ROWS_EXAMINED); i++) {
          if (rowMatches(await rows.nth(i).innerText().catch(() => ""), target).ok) hits.push(i);
        }
        const only = hits.length > 1 ? await visibleOf(rows, hits) : hits;
        if (only.length !== 1) {
          throw new Error(
            `${only.length} of ${count} rows match this expense${
              hits.length !== only.length ? ` (${hits.length - only.length} hidden copies ignored)` : ""
            }; need exactly one to look at its edit form.`);
        }
        row = rows.nth(only[0]!);
        return `matched 1 of ${count} rows`;
      }))) return { ok: false, steps, matchedRow: null, screenshot: null };

      if (!(await step("open the \u22ee menu", async () => {
        await (await controlForRow(page!, row!, sel.rowMenu!, "\u22ee row menu", ms)).click();
        await page!.waitForTimeout(400);
        const items = await countAll(page!, ['[role="menuitem"]', "[role=menu] button", "li button", "li"]);
        const seen = items.filter((i) => i.n > 0).map((i) => `${i.sel} \u00d7${i.n}`).join(", ");
        return `menu open \u2014 ${seen || "nothing menu-shaped found"}`;
      }))) return { ok: false, steps, matchedRow: null, screenshot: null };

      if (!(await step("click Edit", async () => {
        const edit = page!.locator('text=/^\\s*Edit\\s*$/i');
        const n = await edit.count();
        for (let i = 0; i < n; i++) {
          if (await edit.nth(i).isVisible().catch(() => false)) {
            await edit.nth(i).click();
            await page!.waitForTimeout(1200);
            return "the edit form is open";
          }
        }
        throw new Error(`nothing visible in the \u22ee menu matched Edit (${n} candidate(s)).`);
      }))) return { ok: false, steps, matchedRow: null, screenshot: null };

      await step("read the form", async () => {
        // Everything a person could type into or choose from, with whatever
        // names the page gives it. This is the whole point of the exercise:
        // the next change is written against what is really there.
        const controls = page!.locator("input, select, textarea, [role=combobox], [role=listbox], [contenteditable=true]");
        const n = Math.min(await controls.count(), 40);
        for (let i = 0; i < n; i++) {
          const c = controls.nth(i);
          if (!(await c.isVisible().catch(() => false))) continue;
          const [tag, name, id, ph, label, value, role] = await Promise.all([
            c.evaluate((el) => el.tagName.toLowerCase()).catch(() => "?"),
            c.getAttribute("name").catch(() => null),
            c.getAttribute("id").catch(() => null),
            c.getAttribute("placeholder").catch(() => null),
            c.getAttribute("aria-label").catch(() => null),
            c.inputValue().catch(() => null),
            c.getAttribute("role").catch(() => null),
          ]);
          const bits = [tag, role && `role=${role}`, name && `name=${name}`, id && `id=${id}`,
            label && `aria-label=${label}`, ph && `placeholder=${ph}`,
            value && `value=${value.slice(0, 40)}`].filter(Boolean);
          fields.push(bits.join(" "));
        }
        return fields.length > 0
          ? `${fields.length} control(s): ${fields.slice(0, 6).join(" | ")}`
          : "no form controls are visible \u2014 the edit form may open elsewhere";
      });

      // Never save. Out the way it came in.
      await page.keyboard.press("Escape").catch(() => undefined);
      return {
        ok: true,
        steps,
        matchedRow: null,
        screenshot: (await page.screenshot().catch(() => null))?.toString("base64") ?? null,
      };
    } catch (err) {
      steps.push({ name: "look at the edit form", ok: false, ms: 0,
        detail: err instanceof Error ? err.message : String(err) });
      return {
        ok: false, steps, matchedRow: null,
        screenshot: (await page?.screenshot().catch(() => null))?.toString("base64") ?? null,
      };
    } finally {
      await close?.().catch(() => undefined);
    }
  });

  return { ...run, fields };
}

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
            throw await asError(whyNoGrid(sheet, sel, login.email));
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
  /**
   * Decided by the automation rather than by somebody clicking.
   *
   * It decides what happens when several rows match the expense equally
   * well. A person who clicked Approve looked at the expense; the
   * automation did not, and the difference is the whole basis for letting
   * one of them pick and not the other.
   */
  automatic?: boolean;
  /**
   * How many expenses we hold that are indistinguishable from this one.
   *
   * Same person, merchant, amount and day, still in Emburse's inbox. One
   * purchase divided across sites gives several, and each has its own
   * decision queued — which is what lets the automation take one of
   * several matching rows without guessing.
   */
  peers?: number;
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
  opts: { dryRun?: boolean; onChallenge?: ChallengeHook; automatic?: boolean; peers?: number },
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
  // The export's open, not a second copy of it. A bare goto on the 30s step
  // budget is what made a whole batch of queued approvals fail at the first
  // step with "page.goto: Timeout 30000ms exceeded" — against a screenshot
  // of a sign-in page that had plainly finished rendering. Cold TLS plus
  // Emburse's OAuth redirect chain does not fit in 30 seconds on this
  // tenant, where signing in alone takes 27.
  if (!(await step("open Emburse", () => openEmburse(page, emburseUrl)))) return false;

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
  opts: { dryRun?: boolean; automatic?: boolean; peers?: number },
  setRow: (text: string) => void,
  asEmail?: string,
): Promise<boolean> {
  let row: ReturnType<Page["locator"]> | null = null;
  /**
   * How many visible rows matched the expense BEFORE the click.
   *
   * The confirmation needs it. "Has the expense left Needs Review" is not a
   * question the grid can answer when a split receipt puts six identical
   * rows in it — five are still there after a perfectly good approval. What
   * the grid CAN answer is whether there is one fewer than there was.
   */
  let matchedRows = 1;

  if (!(await step("search for the expense", async () => {
    // The search box is a query parameter, so navigate to the filtered grid
    // rather than typing into it. One less thing that can be focused wrong,
    // debounced, or left holding a previous search.
    //
    // Several terms, simplified in turn, because one was not enough: see
    // searchTerms. Each is tried until rows come back that contain the
    // expense; every row still has to match on all four fields before
    // anything is clicked, so widening the search costs seconds and risks
    // nothing.
    const terms = searchTerms(target.merchant, target.employee);
    /** What each term returned, so a total failure can say what was tried. */
    const tried: string[] = [];
    let rows = page.locator(sel.resultRow!);
    let count = 0;
    let matches: number[] = [];
    let term = terms[0] ?? target.merchant;
    let emptyEveryTime = true;
    let filtered = false;
    /**
     * How many rows the CARDHOLDER'S OWN view held, kept apart from `count`.
     *
     * `count` is whatever the last grid read saw, and the text-search
     * fallback runs after the filter — so reading the absence guard off it
     * asks "did the last search return rows" when the question is "was this
     * person's whole queue readable". A search coming back empty afterwards
     * would wipe the one number that matters.
     */
    let filteredCount = 0;
    /** Did any row we looked at carry this amount, whatever else was wrong? */
    let sawAmount = false;

    /** Read the grid in front of us: how many rows, which of them match. */
    const readGrid = async (): Promise<void> => {
      rows = page.locator(sel.resultRow!);
      count = await rows.count();
      // Narrow by the full match rather than by position: whichever row
      // Emburse happens to put first is not evidence of anything.
      const examined = Math.min(count, ROWS_EXAMINED);
      matches = [];
      for (let i = 0; i < examined; i++) {
        const text = await rows.nth(i).innerText().catch(() => "");
        if (amountAppears(text, target.amount)) sawAmount = true;
        if (rowMatches(text, target).ok) matches.push(i);
      }
    };

    // THE CARDHOLDER FILTER FIRST, and the text search only if it cannot be
    // used. This is the right way round and it took a failure report to see
    // it. Emburse's merchant search is a keyword search over a mangled
    // string — "MENARDS 3065MENARD" returns nothing, "MENARDS" returns five
    // rows belonging to other people — and it demonstrably omits rows that
    // ARE in the view. The users control is a FILTER: it returns everything
    // that person has, and their own queue is a handful of rows in which an
    // amount and a date identify an expense exactly.
    //
    // Screenshot from the failure that settled it: search "MENARDS", two
    // rows, neither $312.44. Filter to Dustin Suppi: three rows, all
    // $312.44, all his. The expense was never missing.
    if (target.employee.trim()) {
      try {
        // The grid page FIRST, because the users control lives on it. Moving
        // the filter to the front of the ladder moved it ahead of the only
        // navigation that put the dropdown on screen, and every decision
        // reported "no users filter matched … Control-shaped things on the
        // page: none" — on a page that simply was not the transactions page
        // yet. A cached cardholder id skips straight past this.
        if (!cardholderIds.get(target.employee.trim().toLowerCase())) {
          await page.goto(gridUrl(emburseUrl, { path: sel.gridPath }), {
            waitUntil: "domcontentloaded", timeout: env.emburseLogin.openTimeoutMs,
          });
        }
        const where = await filterToCardholder(page, sel, target.employee, emburseUrl, sel.gridPath);
        filtered = true;
        if (!(await gridLoaded(page, sel as never))) throw await asError(whyNoGrid(page, sel, asEmail));
        await readGrid();
        filteredCount = count;
        term = `the ${target.employee} filter`;
        // The URL is worth recording: it carries whatever parameter Emburse
        // uses, which is how this becomes one navigation instead of three
        // clicks. Redacted, since a grid URL can carry a session token.
        tried.push(`${safeUrl(where)} → ${count} row(s), ${matches.length} matching`);

        // A cardholder with more rows than we read gets the merchant put
        // back on — as a NARROWING of their own queue, not as a search of
        // everybody's. Only then, because it reintroduces the unreliable
        // part, and only when the honest alternative is reading 50 of 300.
        const id = cardholderIds.get(target.employee.trim().toLowerCase());
        if (matches.length === 0 && count > ROWS_EXAMINED && id) {
          for (const candidate of terms) {
            await page.goto(
              gridUrl(emburseUrl, { userId: id, query: candidate, path: sel.gridPath }),
              { waitUntil: "domcontentloaded", timeout: env.emburseLogin.openTimeoutMs });
            if (!(await gridLoaded(page, sel as never))) break;
            await readGrid();
            filteredCount = count;
            tried.push(`that filter + \u201c${candidate}\u201d \u2192 ${count} row(s), ${matches.length} matching`);
            if (matches.length > 0) {
              term = `the ${target.employee} filter narrowed by \u201c${candidate}\u201d`;
              break;
            }
          }
        }
      } catch (err) {
        tried.push(`the users filter could not be used (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    for (const candidate of matches.length > 0 ? [] : terms) {
      term = candidate;
      // Its own budget, like the first navigation. This was left on the
      // shared 30s step timeout while only the OPEN got 90s — and then the
      // search ladder made four of these per decision, so half of one
      // morning's failures were "page.goto: Timeout 30000ms exceeded" on a
      // grid, not on the sign-in page anybody was looking at.
      await page.goto(gridUrl(emburseUrl, { query: candidate, path: sel.gridPath }), {
        waitUntil: "domcontentloaded", timeout: env.emburseLogin.openTimeoutMs,
      });
      // The same two signals the export accepts, not just the grid selector.
      // The export has always taken the item-count line as proof the grid
      // arrived — "34 items, $42,249.94" cannot be on screen unless the rows
      // are — while this path demanded the grid element itself. So on a
      // tenant whose grid selector is stale the export ran fine and every
      // decision failed, and the difference looked like an account problem.
      if (!(await gridLoaded(page, sel as never))) {
        throw await asError(whyNoGrid(page, sel, asEmail));
      }

      await readGrid();
      // Whether the page was genuinely empty, for the one conclusion that
      // must not be drawn from a bad search term: "this expense has already
      // been actioned". A term Emburse does not understand produces an empty
      // grid too, and calling THAT gone is how an expense that is sitting
      // there gets written off.
      //
      // The PAGE's own words, not our row count. `count === 0` also counted
      // as empty, and that conflates the two things this whole file exists
      // to keep apart: a grid with nothing in it, and a row selector that
      // does not describe this grid. With a stale selector every search
      // looked empty, so a misconfiguration was reported as "Emburse
      // returned nothing for this expense, whichever way it was searched
      // for" — which sends somebody to look in Emburse for an expense that
      // is sitting there, instead of at the selector that cannot see it.
      const emptyHere =
        EMPTY_GRID.test((await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " "));
      if (!emptyHere) emptyEveryTime = false;
      tried.push(`“${candidate}” → ${emptyHere ? "no rows" : `${count} row(s), ${matches.length} matching`}`);
      if (matches.length > 0) break;
    }

    if (matches.length === 0) {
      const examined = Math.min(count, ROWS_EXAMINED);
      // Why EACH row was turned down, not just the first. "None of the 4
      // rows match — amount 39.94 not in the row" was the first row's
      // reason presented as all four, and the row that mattered had a
      // different one. Distinct reasons only, since a grid of forty rows
      // rejected for the same cause says it once.
      const reasons: string[] = [];
      for (let i = 0; i < examined && reasons.length < 4; i++) {
        const why = rowMatches(await rows.nth(i).innerText().catch(() => ""), target).why;
        if (!reasons.includes(why)) reasons.push(why);
      }
      const spread = reasons.length > 0 ? ` The rows were turned down for: ${reasons.join("; ")}.` : "";
      const attempts = `Searched ${tried.join(", ")}.`;

      // Nothing row-shaped matched our selector ANYWHERE — not in the
      // cardholder's own filtered queue, not under any search. That is the
      // row selector failing to describe this grid, and the answer is to
      // say what IS row-shaped on the page so somebody can set it. Saying
      // "none of the rows match" about zero rows is true and useless, and
      // saying the expense is not there would be a lie about a page we
      // cannot read.
      // "It is not there" is claimed from the FILTER, and only on the
      // amount.
      //
      // It used to be claimed from an empty text search, on the reasoning
      // that an expense which has been approved leaves Needs Review. The
      // reasoning was fine; the premise was not. Emburse's text search
      // misses rows that ARE in the view — proven on two LA MADRELA
      // expenses of the same person, one returned and one not — so an empty
      // search says nothing about whether the expense is there.
      //
      // Four conditions, and every one of them earned:
      //
      //   filtered      — the person's own queue is the only complete view.
      //   count > 0     — rows came back. Nothing row-shaped means the row
      //                   selector does not describe this grid, which is
      //                   our configuration, not an empty queue.
      //   within the cap— we read ALL of their rows. "Not in their queue"
      //                   after reading 50 of 303 is a false statement
      //                   about the other 253.
      //   !sawAmount    — no row in their queue carries this figure at all.
      //                   A row that DOES carry it and was turned down on a
      //                   truncated cardholder, an unpadded day or a credit
      //                   written "($47.56)" is OUR matching failing.
      //
      // That last one is the whole guard. NotInQueue means "already
      // approved or denied, nothing to retry", so an expense written off
      // this way is never tried again by anybody. A live report had MENARDS
      // $312.44 turned down for "amount 312.44 not in the row" on three
      // expenses that were sitting in Emburse the whole time.
      if (filtered && filteredCount > 0 && filteredCount <= ROWS_EXAMINED && !sawAmount) {
        throw new NotInQueue(
          `${target.employee}'s own queue in Emburse does not hold this expense \u2014 none of ` +
          `the ${filteredCount} row(s) in it is for ${money(target.amount)}. ${attempts} An expense that ` +
          `has already been approved or denied leaves Needs Review, so the commonest reason for ` +
          `this is that the decision already went through \u2014 trying again searches the same ` +
          `empty view. It has been taken off the queue here; the next import brings it back ` +
          `if Emburse does still hold it.`);
      }
      // Nothing row-shaped matched our selector anywhere — not in the
      // cardholder's own queue, not under any search. That is the row
      // selector failing to describe this grid, and the answer is to say
      // what IS row-shaped so somebody can set it. "None of the rows match"
      // about zero rows is true and useless.
      if (filteredCount === 0 && count === 0) {
        // With everything that was tried appended. The diagnosis names the
        // selector and what IS row-shaped; the attempts name the terms, and
        // a failure report is only readable with both.
        throw await asError(whyNoRows(page, sel, term).then((t) => `${t} ${attempts}`));
      }

      if (emptyEveryTime) {
        throw new Error(
          `Emburse returned nothing for this expense, whichever way it was searched for, ` +
          `and its users filter could not be used to check properly. ${attempts} ` +
          `Emburse's text search is known to miss rows that ARE in the view, so this does ` +
          `not mean the expense has gone — check it in Emburse.`);
      }
      // Never claim none of N matched when only the first few were read. A
      // merchant like DOORDASH returns the whole month, and "none of the 340
      // rows match" — said after looking at fifty — is a false statement
      // about the other 290, in the one place a false statement means an
      // expense gets reported as missing when it is sitting there.
      if (examined < count) {
        throw new Error(
          `looked at the first ${examined} of ${count} rows and none match this expense. ` +
          `The search is too broad to find it this way — narrow it in Emburse, or the ` +
          `expense may genuinely not be in this view. ${attempts}${spread}`);
      }
      throw new Error(
        `none of the rows match this expense. ${attempts}${spread} ` +
        // The other reading of "it is not there", and the one nobody thinks
        // of: an expense that has ALREADY been approved or denied leaves
        // Needs Review. So a decision that was applied and then reported as
        // unconfirmed looks exactly like this on the retry.
        `An expense that has already been actioned leaves Needs Review, so this also looks ` +
        `like a decision that went through and was reported as unconfirmed — check the ` +
        `expense in Emburse before deciding it again.`,
      );
    }

    // Hidden copies first: a grid that keeps them matches the same expense
    // more than once, and none of the copies is the row on screen.
    const chosen = matches.length > 1 ? await visibleOf(rows, matches) : matches;
    let several = 0;
    if (chosen.length > 1) {
      // Several rows match the expense on employee, merchant, amount AND
      // date. They are interchangeable with respect to everything this
      // decision names; where they differ — the site, the batch id, the
      // posted date — is not something it named.
      //
      // Dustin Suppi has three Menards charges of $312.44 on the same day:
      // one receipt split evenly across three sites, which is ordinary.
      // Three expenses, three queued decisions, three rows. Refusing each
      // of them as ambiguous left all three red for ever.
      //
      // Whether picking one is allowed turns on WHO decided, and on
      // nothing else.
      //
      //   A PERSON clicked Approve. They looked at the expense and meant
      //   it, and approving "a $312.44 Menards charge of Dustin Suppi on
      //   Sep 24" is satisfied by any row that is one. The other decisions
      //   take the others. Same principle as flags, where a person may
      //   approve a flagged expense and the automation may not.
      //
      //   The AUTOMATION looked at nothing. It refuses, every time, and it
      //   does not matter whether the rows read alike: unattended, the
      //   question is not "can these be told apart" but "is there anybody
      //   here to take responsibility for picking". There is not.
      //
      // The automation may take one when OUR QUEUE ACCOUNTS FOR THEM ALL.
      //
      // Six rows in Emburse, six expenses of ours, six decisions queued:
      // each decision takes a row and all six are approved, so which one
      // goes first is bookkeeping. That is the shape a split receipt makes
      // — seven shares of a lunch, three of a Menards run — and refusing
      // every one of them left the whole set stuck while the rules had
      // already found the split sound and cleared it.
      //
      // Fewer of ours than rows is the case to refuse: something is there
      // that we do not hold a decision for, and picking blind among them
      // is guessing with somebody else's money.
      const held = opts.peers ?? 1;
      if (opts.automatic && held < chosen.length) {
        throw new Error(
          `${chosen.length} rows match this expense equally well and we hold only ${held} like ` +
          `it, so the automation cannot say which is which; refusing to guess which one to ` +
          `${decision}. Approve it yourself if any of them will do.`,
        );
      }
      several = chosen.length;
    }
    matchedRows = chosen.length;
    if (chosen.length === 0) {
      throw new Error(
        `${matches.length} rows match this expense but none of them is visible — they are the ` +
        `copies the grid keeps to measure itself, and the row itself is not on this page.`,
      );
    }

    row = rows.nth(chosen[0]!);
    const ghosts = matches.length - chosen.length;
    // Which term found it, because the first one often does not and that is
    // the single most useful thing this step can report.
    return `matched 1 of ${count} rows searching “${term}”` +
      (ghosts > 0 ? ` (${ghosts} hidden ${ghosts === 1 ? "copy" : "copies"} ignored)` : "") +
      (several > 1
        ? ` (${several} rows matched equally well — took one; they are interchangeable for ` +
          `this decision, and the others belong to the other decisions queued for them)`
        : "");
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
      return await confirmActioned(page, sel, target, "approved", matchedRows);
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
    const said = await confirmActioned(page, sel, target, "denied", matchedRows);
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
 * The check is that there is ONE FEWER matching row than before the click,
 * which is what actioning one does. Polled rather than slept on, so a fast
 * tenant is not waited out and a slow one is not called a failure.
 *
 * Counting rather than asking "is it still there" is the whole of it, and
 * the difference only shows on a split receipt. Jessica Kwan's one MENOS
 * bill divided across six sites is six identical rows; approving one leaves
 * five, every one of which matches the expense on employee, merchant,
 * amount and date, because they ARE that expense six times over. Asked
 * whether the expense is still in Needs Review, the grid says yes and is
 * right — and four perfectly good approvals came back as "it may have gone
 * through, go and look". For an ordinary expense the two readings are the
 * same question: one row before, none after.
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
  /** Visible matching rows before the click. One, for an ordinary expense. */
  before: number,
): Promise<string> {
  // Long enough for a slow link, and it costs nothing when things are
  // normal: the loop exits the moment the row goes, which is usually the
  // first or second pass. Six seconds was the old budget, and on the
  // morning a plain HEAD to Emburse was taking fourteen seconds an
  // approval that had landed perfectly well was reported as unconfirmed —
  // which sends somebody to check it by hand, the exact work this exists
  // to remove.
  const CONFIRM_MS = 20_000;
  const deadline = Date.now() + CONFIRM_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    // Re-scanned rather than held as a locator: the grid re-renders after an
    // action, so the row that was nth(3) is a different expense now.
    const rows = page.locator(sel.resultRow!);
    const n = Math.min(await rows.count().catch(() => 0), 60);
    let still = 0;
    for (let j = 0; j < n; j++) {
      const text = await rows.nth(j).innerText().catch(() => "");
      if (!rowMatches(text, target).ok) continue;
      // Visible, or it is not evidence the expense is still there. The grid
      // keeps hidden copies of its rows, and a copy of the row just
      // approved outlives the row itself — so a click that worked perfectly
      // reported "still in Needs Review six seconds later", which sends
      // somebody to Emburse to check an approval that had already landed.
      if (!(await rows.nth(j).isVisible().catch(() => false))) continue;
      still++;
    }
    if (still < before) {
      return before > 1
        ? `${what} in Emburse — ${before} rows matched this expense and ${still} ` +
          `${still === 1 ? "remains" : "remain"}, so one left Needs Review`
        : `${what} in Emburse — the row left Needs Review`;
    }
  }
  throw new Error(
    `clicked ${what === "approved" ? "APPROVE" : "Deny"}, but ` +
    (before > 1
      ? `all ${before} rows matching this expense are still in Needs Review `
      : `the expense is still in Needs Review `) +
    `${Math.round(CONFIRM_MS / 1000)} seconds later, so nothing confirms Emburse ` +
    `recorded it. It may have gone through — check the expense in Emburse before deciding it ` +
    `again.`);
}
