import type { Browser, Page } from "playwright";
import { env } from "../env.js";
import type { ExportSettings } from "../import/settings.js";

/**
 * Drive the Emburse UI and fetch the daily export, from the server.
 *
 * Why here rather than Power Automate on a laptop: the export is the one thing
 * this app cannot work without, and a laptop is the worst place to put it — it
 * sleeps, it travels, it belongs to one person, and the automation has to be
 * built by hand on it. This process is already awake on a Reserved VM.
 *
 * The hard part is not the driving, it is that Emburse's markup is not knowable
 * from outside their tenant. So every selector is configuration rather than
 * code, each step reports whether it matched, and a failed run says which step
 * broke and hands back a screenshot. Getting this working is then a matter of
 * correcting one selector at a time against real feedback, instead of guessing
 * at a whole flow.
 *
 * Nothing here runs unless EMBURSE_LOGIN_EMAIL and EMBURSE_LOGIN_PASSWORD are
 * set, and Playwright is imported dynamically so the app still boots without it.
 */

export type StepResult = {
  name: string;
  ok: boolean;
  /** What actually happened — the selector tried, the text seen, the error. */
  detail: string;
  ms: number;
};

export type ExportRun = {
  ok: boolean;
  /**
   * Whether the failure was the sign-in itself.
   *
   * The one condition that should send its owner back to re-enter a password —
   * every other step failing means Emburse moved something, not that the
   * credential went bad.
   */
  signInFailed: boolean;
  steps: StepResult[];
  /** PNG of the page where it stopped, base64, present only on failure. */
  screenshot: string | null;
  /** The downloaded PDF, on success. */
  pdf: Buffer | null;
  /** The "N items, $X" line, for cross-checking the import. */
  itemLine: string | null;
};

/**
 * Every element the run needs, as a CSS or Playwright selector.
 *
 * The defaults are guesses from screenshots of the Emburse UI and are expected
 * to be wrong. `text=` matching is used wherever possible: Emburse's class names
 * are generated and will churn, but the words on the buttons are what the people
 * using it actually see, so they change far less often.
 */
export type Selectors = Record<SelectorKey, string>;

export type SelectorKey =
  | "loginEmail" | "loginPassword" | "loginSubmit" | "loggedIn"
  | "adminTab" | "transactionsNav" | "grid" | "itemCount"
  | "gridPath"
  | "exportButton" | "dialog" | "dialogRoot" | "dialogScope" | "formatSelect"
  | "dialogExport" | "exportStarted"
  | "exportsNav" | "newestExportReady" | "newestExportDownload";

export const DEFAULT_SELECTORS: Selectors = {
  // Emburse signs in through account.emburse.app, whose box is often a plain
  // text input rather than type=email.
  loginEmail: 'input[type="email"], input[name="username"], input[name="email"], input[placeholder*="@"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")',
  loggedIn: 'text=Transactions',

  adminTab: 'text=ADMIN',
  transactionsNav: 'a:has-text("Transactions")',
  grid: 'table',
  // The "34 items, $42,249.94" line above the grid.
  itemCount: 'text=/\\d[\\d,]* items?, \\$[\\d,]+\\.\\d{2}/',

  // A path, not a selector: the grid's filters live in the query string.
  gridPath: "/transactions/team",

  exportButton: 'button:has-text("EXPORT")',
  dialog: 'text=Export Expenses',
  // The element the section chips live inside, used to scope chip lookups.
  dialogRoot: '[role="dialog"]',
  // Used to prove the dialog is exporting everything, not a row selection.
  dialogScope: 'text=all expense(s)',
  formatSelect: 'text=Select a format',
  dialogExport: 'button:has-text("EXPORT")',
  exportStarted: 'text=/export .*(started|queued|processing)/i',

  exportsNav: 'a:has-text("Exports")',
  newestExportReady: 'tr:has-text("Complete") >> nth=0',
  newestExportDownload: 'tr:has-text("Complete") >> nth=0 >> text=Download',
};

/** Every chip the export dialog offers, in the order it shows them. */
const ALL_CHIPS = [
  "Needs Review", "Needs Manager Review", "Pending Submission", "Denied", "Completed",
] as const;

/** A stored credential, or the env fallback for a deployment without one. */
export type Login = { userId: string | null; email: string; password: string };

/**
 * Which selectors each step depends on.
 *
 * Exported so a failed run can offer the exact fields to correct rather than
 * the whole list. Knowing a run stopped at "open the export dialog" is only
 * half an answer; the useful half is which two selectors that step used.
 */
export const STEP_SELECTORS: Record<string, SelectorKey[]> = {
  "open Emburse": [],
  "sign in": ["loginEmail", "loginPassword", "loginSubmit", "loggedIn"],
  "switch to ADMIN": ["adminTab"],
  "open Transactions": ["transactionsNav", "grid"],
  "filter Receipts: true": ["gridPath"],
  "read the item count": ["itemCount"],
  "open the export dialog": ["exportButton", "dialog"],
  "set the sections": ["dialogRoot", "dialog"],
  "choose PDF": ["formatSelect"],
  "confirm the scope is everything": ["dialog", "dialogScope"],
  "start the export": ["dialogRoot", "dialogExport"],
  "wait for the export and download it": ["exportsNav", "newestExportReady", "newestExportDownload"],
};

/** What each selector is for, shown beside its field. */
export const SELECTOR_HELP: Record<SelectorKey, string> = {
  loginEmail: "The email box on the Emburse sign-in page.",
  loginPassword: "The password box.",
  loginSubmit: "The sign-in button.",
  loggedIn: "Something that only appears once signed in.",
  adminTab: "The ADMIN tab, top left. PERSONAL would export one person's expenses.",
  transactionsNav: "Cards → Transactions in the left nav.",
  grid: "The transactions table itself — used to tell the page has loaded.",
  itemCount: "The \u201cN items, $X\u201d line above the grid.",
  gridPath: "Path to the transactions grid. Filters are added as query parameters.",
  exportButton: "The EXPORT button above the grid, not the one in the dialog.",
  dialog: "Text that proves the Export Expenses dialog is open.",
  dialogRoot: "The dialog element itself; section chips are looked for inside it.",
  dialogScope: "The line saying whether all expenses or a selection will be exported.",
  formatSelect: "The format dropdown in the dialog.",
  dialogExport: "The EXPORT button inside the dialog.",
  exportStarted: "Confirmation that the export was queued.",
  exportsNav: "The link to the list of finished exports.",
  newestExportReady: "The newest export's row once it reads Complete.",
  newestExportDownload: "The Download link on that row.",
};

/**
 * The transactions grid, with its filters already applied.
 *
 * Emburse keeps the grid's filters in the query string —
 * `/transactions/team?filters[section]=inbox&filters[receipt]=true` — which
 * means the whole ADVANCED FILTERS dance is avoidable. Navigating straight to
 * the filtered view removes three clicks, two of them on toggles whose state
 * had to be read before being changed; a URL has no state to misread.
 *
 * `query` fills the search box, used when looking for one expense to decide on.
 */
export function gridUrl(
  base: string,
  opts: { section?: string; receiptsOnly?: boolean; query?: string; path?: string } = {},
): string {
  const url = new URL(opts.path ?? "/transactions/team", base);
  url.searchParams.set("filters[section]", opts.section ?? "inbox");
  if (opts.receiptsOnly) url.searchParams.set("filters[receipt]", "true");
  url.searchParams.set("filters[query]", opts.query ?? "");
  return url.toString();
}

export function envLogin(): Login | null {
  const { email, password } = env.emburseLogin;
  return email && password ? { userId: null, email, password } : null;
}

/**
 * The host's Chromium, if it has one.
 *
 * Imported lazily and tolerantly: the detector is a plain script that shells
 * out to `which`, and a host where that is unavailable should fall back to
 * Playwright's own browser rather than failing the run before it starts.
 */
export async function systemChromium(): Promise<string | null> {
  if (env.emburseLogin.chromiumPath) return env.emburseLogin.chromiumPath;
  try {
    const { findSystemChromium } = await import("../../scripts/find-chromium.mjs");
    return findSystemChromium();
  } catch {
    return null;
  }
}

/** Playwright is optional; the app must boot on a host that has no browser. */
export async function loadPlaywright() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    throw new Error(
      "Playwright is not installed. Add it with `pnpm add playwright` and make sure a Chromium " +
        "build is available on the host, then restart.",
    );
  }
}

/**
 * A step recorder.
 *
 * Shared with the approve/deny runner because the two want identical
 * behaviour: record what happened either way, keep only the first line of an
 * error, and hand back whether to carry on. Two copies of that would drift,
 * and the difference would only show up in a failure report nobody could
 * compare.
 */
export function makeStepper(steps: StepResult[]) {
  return async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    const started = Date.now();
    try {
      steps.push({ name, ok: true, detail: await fn(), ms: Date.now() - started });
      return true;
    } catch (err) {
      steps.push({
        name,
        ok: false,
        detail: err instanceof Error ? err.message.split("\n")[0]! : String(err),
        ms: Date.now() - started,
      });
      return false;
    }
  };
}

export async function runAutoExport(
  settings: ExportSettings,
  selectors: Selectors,
  login: Login,
  opts: { dryRun?: boolean } = {},
): Promise<ExportRun> {
  const steps: StepResult[] = [];
  let browser: Browser | null = null;
  let page: Page | null = null;
  let pdf: Buffer | null = null;
  let itemLine: string | null = null;

  /** Run one step, timing it and recording what happened either way. */
  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    const started = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail, ms: Date.now() - started });
      return true;
    } catch (err) {
      steps.push({
        name,
        ok: false,
        detail: err instanceof Error ? err.message.split("\n")[0]! : String(err),
        ms: Date.now() - started,
      });
      return false;
    }
  };

  try {
    const chromium = await loadPlaywright();
    // Prefer a browser the host provides. Playwright's own build is linked
    // against libraries a Nix host does not carry, so there it installs
    // cleanly and then will not start — and finding the host's own is not
    // something anyone should have to do by hand, because a Nix store path
    // contains a content hash and changes whenever the package does.
    const executablePath = (await systemChromium()) ?? undefined;
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);

    const ok = await runSteps(page, settings, selectors, login, step, opts, (v) => (itemLine = v), (b) => (pdf = b));

    const screenshot = ok ? null : (await page.screenshot({ fullPage: false })).toString("base64");
    return { ok, signInFailed: signInBroke(steps), steps, screenshot, pdf, itemLine };
  } catch (err) {
    steps.push({
      name: "start browser",
      ok: false,
      detail: explainLaunch(err),
      ms: 0,
    });
    let screenshot: string | null = null;
    try {
      if (page) screenshot = (await page.screenshot()).toString("base64");
    } catch {
      /* A dead page cannot be photographed; the step detail is what matters. */
    }
    return { ok: false, signInFailed: signInBroke(steps), steps, screenshot, pdf, itemLine };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * Turn a browser-launch failure into something actionable.
 *
 * Playwright's own message is several lines of box-drawing characters that
 * render as noise in a web page, and the command it suggests is not the one to
 * run here. A missing browser is by far the most likely first failure on a new
 * host, so it is worth answering precisely rather than passing the error along.
 */
export function explainLaunch(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/Executable doesn't exist|playwright install/i.test(raw)) {
    return (
      "No browser is installed for Playwright on this host. Run " +
      "`pnpm exec playwright install --only-shell chromium` in the shell, or redeploy — " +
      "`pnpm install` now does it automatically. If the download works but launching still " +
      "fails, the host is missing shared libraries and PLAYWRIGHT_CHROMIUM_PATH should point " +
      "at a browser it already has."
    );
  }
  if (/libnss3|libatk|error while loading shared libraries|cannot open shared object/i.test(raw)) {
    return (
      "A browser is installed but cannot start — the host is missing shared libraries it needs. " +
      "Set PLAYWRIGHT_CHROMIUM_PATH to a Chromium the host already provides. Details: " +
      raw.split("\n")[0]
    );
  }
  if (/ERR_NAME_NOT_RESOLVED|getaddrinfo|ENOTFOUND/i.test(raw)) {
    return (
      "That Emburse address does not exist — the hostname did not resolve. Open Emburse in a " +
      "browser, copy what is in the address bar, and set it as the Emburse address in Export " +
      "settings. Details: " + raw.split("\n")[0]
    );
  }
  // Anything else: the first line only. The rest is a stack nobody reads here.
  return raw.split("\n")[0]!;
}

/**
 * Sign in, and be certain about whether it worked.
 *
 * Two things this gets wrong if written the obvious way.
 *
 * First, "the form is not on screen" is not the same as "already signed in".
 * It is equally what a wrong selector looks like — and reporting that as
 * success meant a failed login sailed through three green steps before timing
 * out on one that could not pretend. Absence is now only accepted when the app
 * itself is visibly loaded.
 *
 * Second, Emburse hands sign-in to account.emburse.app, which asks for the
 * email, then the password on a second screen. Filling both at once fills one
 * box and submits nothing.
 */
export async function signIn(page: Page, sel: Selectors, login: Login): Promise<string> {
  const loggedIn = page.locator(sel.loggedIn).first();
  const emailBox = page.locator(sel.loginEmail).first();

  if (!(await emailBox.isVisible().catch(() => false))) {
    if (await loggedIn.isVisible().catch(() => false)) return "already signed in";
    throw new Error(
      `no sign-in form and the app is not loaded — at ${page.url()}. ` +
        "Check the loginEmail selector against that page.",
    );
  }

  await emailBox.fill(login.email);
  await page.locator(sel.loginSubmit).first().click();

  // The password may share the page or arrive on the next one.
  const passwordBox = page.locator(sel.loginPassword).first();
  await passwordBox.waitFor({ state: "visible" }).catch(() => {});
  if (await passwordBox.isVisible().catch(() => false)) {
    await passwordBox.fill(login.password);
    await page.locator(sel.loginSubmit).first().click();
  }

  await loggedIn.waitFor({ state: "visible" }).catch(() => {});
  if (!(await loggedIn.isVisible().catch(() => false))) {
    throw new Error(
      `signed in as ${login.email} but the app did not appear — at ${page.url()}. ` +
        "Either the password was rejected, a second factor is being asked for, or the " +
        "loggedIn selector does not match.",
    );
  }
  return `signed in as ${login.email}`;
}

const signInBroke = (steps: StepResult[]) => steps.some((s) => s.name === "sign in" && !s.ok);

async function runSteps(
  page: Page,
  settings: ExportSettings,
  sel: Selectors,
  login: Login,
  step: (name: string, fn: () => Promise<string>) => Promise<boolean>,
  opts: { dryRun?: boolean },
  setItemLine: (v: string) => void,
  setPdf: (b: Buffer) => void,
): Promise<boolean> {
  // From settings, so a wrong host can be corrected without a redeploy.
  const url = settings.emburseUrl || env.emburseLogin.url;

  if (!(await step("open Emburse", async () => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return `loaded ${page.url()}`;
  }))) return false;

  if (!(await step("sign in", async () => signIn(page, sel, login)))) return false;

  if (!(await step("switch to ADMIN", async () => {
    // Emburse reopens on whichever of ADMIN / PERSONAL was last used, and
    // PERSONAL holds only this account's own expenses.
    const tab = page.locator(sel.adminTab).first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      return "clicked ADMIN";
    }
    // Absence is only acceptable if this is the app at all. Treating a missing
    // element as "fine" is how a failed sign-in got reported as three green
    // steps and then a thirty-second timeout on the one that could not skip.
    if (await page.locator(sel.loggedIn).first().isVisible().catch(() => false)) {
      return "no ADMIN tab on this page, but the app is loaded";
    }
    throw new Error(`no ADMIN tab and the app is not loaded — at ${page.url()}`);
  }))) return false;

  if (!(await step("open Transactions", async () => {
    // Clicking ADMIN can land on the grid already. Navigating to where you
    // are is not an error, but waiting for a link that is no longer on the
    // page is a hang — so check the destination before insisting on the route.
    const grid = page.locator(sel.grid).first();
    if (await grid.isVisible().catch(() => false)) return "already on the grid";

    await page.locator(sel.transactionsNav).first().click();
    await grid.waitFor({ state: "visible" });
    return "grid visible";
  }))) return false;

  if (!(await step("filter Receipts: true", async () => {
    // Straight to the filtered grid rather than clicking ADVANCED FILTERS and
    // a checkbox. The filters live in the query string, so there is no toggle
    // whose state could be misread and silently inverted.
    const target = gridUrl(url, { receiptsOnly: settings.receiptsOnly, path: sel.gridPath });
    await page.goto(target, { waitUntil: "domcontentloaded" });
    await page.locator(sel.grid).first().waitFor({ state: "visible" });
    return settings.receiptsOnly ? "receipts only, via the URL" : "unfiltered, via the URL";
  }))) return false;

  await step("read the item count", async () => {
    // Not fatal: the count is a cross-check, not a precondition. A run that
    // cannot find it should still produce the export.
    const line = (await page.locator(sel.itemCount).first().innerText()).trim();
    setItemLine(line);
    return line;
  });

  if (!(await step("open the export dialog", async () => {
    await page.locator(sel.exportButton).first().click();
    await page.locator(sel.dialog).first().waitFor({ state: "visible" });
    return "Export Expenses dialog open";
  }))) return false;

  if (!(await step("set the sections", async () => {
    // The chips are toggles, so a blind click turns an already-on section off.
    // Read each one's state and click only when it needs changing.
    //
    // One pass is not enough: clicking a chip re-renders the dialog, which
    // detaches every locator taken before it — the rest of the pass then reads
    // stale nodes and silently skips them. So change one chip, let the dialog
    // settle, and start again, until a whole pass finds nothing left to do.
    const want = new Set(settings.sections);
    const changed: string[] = [];

    for (let pass = 0; pass <= ALL_CHIPS.length; pass++) {
      let clicked = false;
      for (const name of ALL_CHIPS) {
        const chip = chipLocator(page, sel, name);
        if (!(await chip.isVisible().catch(() => false))) continue;
        if ((await isChipOn(chip)) === want.has(name)) continue;

        await chip.click();
        await page.locator(sel.dialog).first().waitFor({ state: "visible" });
        changed.push(`${want.has(name) ? "+" : "-"}${name}`);
        clicked = true;
        break;
      }
      if (!clicked) return changed.length ? changed.join(" ") : "already correct";
    }
    // A chip that never takes means the state could not be read, and exporting
    // the wrong sections looks exactly like exporting the right ones.
    throw new Error(`section chips would not settle after ${changed.join(" ")}`);
  }))) return false;

  if (!(await step("choose PDF", async () => {
    // Choosing PDF also greys out the template selector, so nothing else needed.
    const select = page.locator(sel.formatSelect).first();
    await select.click();
    await page.locator('text="PDF"').last().click();
    return "format set to PDF";
  }))) return false;

  if (!(await step("confirm the scope is everything", async () => {
    // With rows ticked the dialog says "1 expense(s)" and exports only those —
    // a valid PDF of almost nothing, which every later check would accept.
    const body = await page.locator(sel.dialog).first().locator("xpath=ancestor::*[3]").innerText();
    if (!/all\s+expense/i.test(body)) {
      throw new Error(`dialog is scoped to a row selection, not all expenses: ${body.slice(0, 120)}`);
    }
    return "exporting all expenses";
  }))) return false;

  if (opts.dryRun) {
    await step("dry run", async () => "stopped before clicking Export");
    return true;
  }

  if (!(await step("start the export", async () => {
    await page.locator(sel.dialogRoot).locator(sel.dialogExport).last().click();
    return "export requested";
  }))) return false;

  if (!(await step("wait for the export and download it", async () => {
    // Emburse queues the export and mails a link when it is ready, so the page
    // has to be watched rather than awaited: poll the exports list until the
    // newest row is complete, then take the download.
    const deadline = Date.now() + env.emburseLogin.exportWaitMs;
    await page.locator(sel.exportsNav).first().click().catch(() => {});

    while (Date.now() < deadline) {
      const ready = page.locator(sel.newestExportReady).first();
      if (await ready.isVisible().catch(() => false)) {
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          page.locator(sel.newestExportDownload).first().click(),
        ]);
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(c as Buffer);
        const buf = Buffer.concat(chunks);
        if (buf.subarray(0, 4).toString("latin1") !== "%PDF") {
          throw new Error(`downloaded ${buf.length} bytes but it is not a PDF`);
        }
        setPdf(buf);
        return `downloaded ${(buf.length / 1e6).toFixed(1)} MB`;
      }
      await page.waitForTimeout(10_000);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    throw new Error(`no completed export appeared within ${Math.round(env.emburseLogin.exportWaitMs / 60000)} min`);
  }))) return false;

  return true;
}

/**
 * Find one section chip, whatever decoration its label is wearing.
 *
 * A selected chip reads "✓ Denied" rather than "Denied", so exact text matching
 * finds only the chips that are already off — which looks exactly like a run
 * that had nothing to change, and quietly exports the wrong sections. Matching
 * on a regex anchored at both ends tolerates the tick while still refusing to
 * confuse "Needs Review" with "Needs Manager Review"; the anchoring also rules
 * out ancestors, whose text contains the label plus everything around it.
 */
function chipLocator(page: Page, sel: Selectors, name: string) {
  const label = new RegExp(`^[\\s\u2713\u2714\u2705*]*${escapeRe(name)}[\\s]*$`, "i");
  return page
    .locator(sel.dialogRoot)
    .locator('a, button, [role="button"], [role="checkbox"], label, span, div')
    .filter({ hasText: label })
    .first();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a section chip is switched on.
 *
 * Emburse marks the active chips with a tick and a filled background. Neither
 * is a reliable attribute, so this reads whatever signals the DOM offers and
 * falls back to the tick character in the label.
 */
async function isChipOn(chip: ReturnType<Page["locator"]>): Promise<boolean> {
  const aria = await chip.getAttribute("aria-pressed").catch(() => null);
  if (aria !== null) return aria === "true";
  const checked = await chip.getAttribute("aria-checked").catch(() => null);
  if (checked !== null) return checked === "true";
  const cls = (await chip.getAttribute("class").catch(() => "")) ?? "";
  if (/\b(selected|active|checked|on)\b/i.test(cls)) return true;
  const text = (await chip.innerText().catch(() => "")) ?? "";
  return text.includes("✓") || text.includes("✔");
}
