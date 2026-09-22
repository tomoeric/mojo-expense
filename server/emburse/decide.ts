import type { Browser, Page } from "playwright";
import { env } from "../env.js";
import {
  explainLaunch, gridUrl, loadPlaywright, makeStepper, signIn, systemChromium,
  type Login, type StepResult,
} from "./auto-export.js";

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
  opts: { dryRun?: boolean } = {},
): Promise<DecisionRun> {
  const steps: StepResult[] = [];
  const step = makeStepper(steps);
  let browser: Browser | null = null;
  let page: Page | null = null;
  let matchedRow: string | null = null;

  const sel = { ...DECISION_SELECTORS, ...selectors } as Record<string, string>;

  try {
    const chromium = await loadPlaywright();
    const executablePath = (await systemChromium()) ?? undefined;
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);

    const ok = await drive(page, decision, target, reason, sel, emburseUrl, login, step, opts, (t) => (matchedRow = t));
    const screenshot = ok ? null : (await page.screenshot()).toString("base64");
    return { ok, steps, screenshot, matchedRow };
  } catch (err) {
    steps.push({ name: "start browser", ok: false, detail: explainLaunch(err), ms: 0 });
    return { ok: false, steps, screenshot: null, matchedRow };
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function drive(
  page: Page,
  decision: Decision,
  target: Target,
  reason: string,
  sel: Record<string, string>,
  emburseUrl: string,
  login: Login,
  step: (name: string, fn: () => Promise<string>) => Promise<boolean>,
  opts: { dryRun?: boolean },
  setRow: (text: string) => void,
): Promise<boolean> {
  if (!(await step("open Emburse", async () => {
    await page.goto(emburseUrl, { waitUntil: "domcontentloaded" });
    return `loaded ${page.url()}`;
  }))) return false;

  // The same sign-in the export uses, not a second copy of it: the subtleties
  // (two-step identity page, absence not meaning success) are worth having in
  // exactly one place.
  if (!(await step("sign in", async () => signIn(page, sel as never, login)))) return false;

  if (!(await step("switch to ADMIN", async () => {
    const tab = page.locator(sel.adminTab!).first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      return "clicked ADMIN";
    }
    if (await page.locator(sel.loggedIn!).first().isVisible().catch(() => false)) {
      return "no ADMIN tab on this page, but the app is loaded";
    }
    throw new Error(`no ADMIN tab and the app is not loaded — at ${page.url()}`);
  }))) return false;

  let row: ReturnType<Page["locator"]> | null = null;

  if (!(await step("search for the expense", async () => {
    // The search box is a query parameter, so navigate to the filtered grid
    // rather than typing into it. One less thing that can be focused wrong,
    // debounced, or left holding a previous search.
    const term = target.merchant.trim().split(/\s+/).slice(0, 2).join(" ");
    await page.goto(gridUrl(emburseUrl, { query: term, path: sel.gridPath }), {
      waitUntil: "domcontentloaded",
    });
    await page.locator(sel.grid!).first().waitFor({ state: "visible" });

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
