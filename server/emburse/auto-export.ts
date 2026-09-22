import fs from "node:fs/promises";
import type { BrowserContext, Locator, Page } from "playwright";
import { env } from "../env.js";
import { rememberCookies, restoreCookies } from "./browser-state.js";
import { withBrowser } from "./browser-lock.js";
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
  /**
   * Whether the stored password is what needs changing.
   *
   * Narrower than `signInFailed` on purpose: a device check and a renamed
   * button are also failed sign-ins, and neither is fixed by typing the
   * password again.
   */
  credentialFault: boolean;
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
  | "mfaCode" | "mfaSubmit" | "mfaRemember"
  | "adminTab" | "grid" | "itemCount"
  | "gridPath"
  | "exportButton" | "dialog" | "dialogRoot" | "dialogScope" | "formatSelect" | "formatOption"
  | "dialogExport" | "exportStarted"
  | "exportsNav" | "newestExportReady" | "newestExportDownload";

/**
 * Defaults that have since been replaced, and are no longer worth keeping.
 *
 * Saving settings used to write every selector to the database, defaults
 * included — so a stored value could be an old default nobody chose, and it
 * would then outrank a better one shipped later. A person's deliberate
 * override should survive an upgrade; a snapshot of last week's guess should
 * not. Anything matching one of these is dropped on read.
 */
export const SUPERSEDED_SELECTORS: Record<string, string[]> = {
  loginEmail: ['input[type="email"], input[name="email"]'],
  loginPassword: ['input[type="password"], input[name="password"]'],
  loginSubmit: ['button[type="submit"]'],
};

export const DEFAULT_SELECTORS: Selectors = {
  // Emburse signs in through account.emburse.app, whose box is often a plain
  // text input rather than type=email.
  loginEmail: 'input[type="email"], input[name="username"], input[name="email"], input[placeholder*="@"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")',
  loggedIn: 'text=Transactions',

  // The device-verification screen. Its code box is usually one field, but some
  // tenants split it into six single-character boxes — the selector matches
  // either, and the code is typed rather than pasted so both fill correctly.
  mfaCode: 'input[name*="code" i], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"]',
  mfaSubmit: 'button[type="submit"], button:has-text("Verify"), button:has-text("Continue"), button:has-text("Submit")',
  // Ticking this is the entire point of passing the challenge: unticked, the
  // next run is a stranger again and somebody is reading codes every morning.
  mfaRemember: 'input[type="checkbox"]',

  adminTab: 'text=ADMIN',
  // Not just <table>: most data grids of this vintage are divs that announce
  // themselves through ARIA instead. Emburse's is one of them.
  grid: 'table, [role="grid"], [role="table"], [role="rowgroup"]',
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
  // Either state of the control: untouched it says "Select a format"; once a
  // format has been chosen it says that format instead, and the old selector
  // then matched nothing at all.
  // The dialog's wording is "Choose a template" / "Select a template" for its
  // sibling control, so the format one is likely phrased the same way. Only
  // used when the control is not a native <select>, which is handled directly.
  // Deliberately no bare text match: the words "Select a format" belong to a
  // floating label that cannot be clicked. Only used if neither the native
  // dropdown nor the accessible-name lookup found the control.
  formatSelect: '[role="combobox"], [aria-haspopup="listbox"], button:has-text("format")',
  formatOption: 'text="PDF"',
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
  "sign in": ["loginEmail", "loginPassword", "loginSubmit", "loggedIn",
              "mfaCode", "mfaSubmit", "mfaRemember"],
  "switch to ADMIN": ["adminTab"],
  "open the filtered grid": ["gridPath", "grid"],
  "read the item count": ["itemCount"],
  "open the export dialog": ["exportButton", "dialog"],
  "set the sections": ["dialogRoot", "dialog"],
  "choose PDF": ["formatSelect", "formatOption"],
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
  mfaCode: "The box for the verification code, on the \u201cverify this device\u201d screen.",
  mfaSubmit: "The button that submits that code.",
  mfaRemember: "The \u201cremember this device\u201d tick box. Ticking it is what stops the code being asked for every run.",
  adminTab: "The ADMIN tab, top left. PERSONAL would export one person's expenses.",
  grid: "The transactions table itself — used to tell the page has loaded. The item-count line is accepted instead, so this missing is not fatal.",
  itemCount: "The \u201cN items, $X\u201d line above the grid.",
  gridPath: "Path to the transactions grid. Filters are added as query parameters.",
  exportButton: "The EXPORT button above the grid, not the one in the dialog.",
  dialog: "Text that proves the Export Expenses dialog is open.",
  dialogRoot: "The dialog element itself; section chips are looked for inside it.",
  dialogScope: "The line saying whether all expenses or a selection will be exported.",
  formatSelect: "The format dropdown in the dialog — the thing you click to open the list.",
  formatOption: "The PDF entry inside that list, once it is open.",
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

/**
 * A browser whose cookies outlive the run.
 *
 * Every run used to launch a fresh browser, so Emburse saw an unknown device
 * each time — which makes its "remember this device for 30 days" offer
 * worthless, because there is nothing for it to remember. A persistent profile
 * on disk means a device trusted once stays trusted, and the verification
 * becomes a rare event rather than a permanent wall.
 *
 * It also keeps the session, so most runs skip sign-in entirely.
 */
export async function openBrowser(): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const chromium = await loadPlaywright();
  const executablePath = (await systemChromium()) ?? undefined;
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];

  const dir = env.emburseLogin.profileDir;
  if (dir) {
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const context = await chromium.launchPersistentContext(dir, {
      ...(executablePath ? { executablePath } : {}),
      args,
      viewport: { width: 1600, height: 1000 },
      acceptDownloads: true,
    });
    // The profile directory carries trust between runs; the database carries
    // it between deployments, which rebuild that directory and would otherwise
    // lose the device every time the app ships.
    await restoreCookies(context);
    return { context, close: () => context.close() };
  }

  // No profile directory configured: behave as before rather than refusing.
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 },
  });
  await restoreCookies(context);
  return { context, close: () => browser.close() };
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
  opts: {
    dryRun?: boolean;
    onChallenge?: ChallengeHook;
    /**
     * Called as each step finishes, so progress can be seen while it happens.
     *
     * A run can legitimately take twenty minutes — most of it spent waiting
     * for Emburse to build the file — and the steps used to be written only at
     * the end. So the one question worth asking, "is it stuck?", had no answer
     * anywhere in the app.
     */
    onStep?: (steps: StepResult[]) => void;
    /** Checked between steps, so a run can be called off without a restart. */
    shouldStop?: () => boolean;
  } = {},
): Promise<ExportRun> {
  const steps: StepResult[] = [];
  let close: (() => Promise<void>) | null = null;
  let page: Page | null = null;
  let pdf: Buffer | null = null;
  let itemLine: string | null = null;
  let credentialFault = false;

  /** Run one step, timing it and recording what happened either way. */
  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    const started = Date.now();
    if (opts.shouldStop?.()) {
      steps.push({ name, ok: false, detail: "stopped — the run was called off", ms: 0 });
      opts.onStep?.(steps);
      return false;
    }
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail, ms: Date.now() - started });
      opts.onStep?.(steps);
      return true;
    } catch (err) {
      if (err instanceof SignInFailed && err.credentialFault) credentialFault = true;
      steps.push({
        name,
        ok: false,
        detail: err instanceof Error ? err.message.split("\n")[0]! : String(err),
        ms: Date.now() - started,
      });
      opts.onStep?.(steps);
      return false;
    }
  };

  // Queued, because a decision batch drives the same profile and Chromium
  // locks it. Waiting is right; colliding is a crash that blames the wrong
  // thing.
  return withBrowser(opts.dryRun ? "a test export" : "the export", async () => {
  try {
    const opened = await openBrowser();
    close = opened.close;
    page = await opened.context.newPage();
    page.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);

    const ok = await runSteps(
      page, settings, selectors, login, step, opts,
      (v) => (itemLine = v), (b) => (pdf = b), () => pdf !== null,
    );

    // Whatever Emburse issued for getting this far — including for passing a
    // device check — is kept, so the next run does not start as a stranger.
    // After the steps rather than after sign-in, because the cookies that
    // matter are only set once the app has actually loaded.
    if (steps.find((st) => st.name === "sign in")?.ok) {
      await rememberCookies(opened.context);
    }

    const screenshot = ok ? null : (await page.screenshot({ fullPage: false })).toString("base64");
    return { ok, signInFailed: signInBroke(steps), credentialFault, steps, screenshot, pdf, itemLine };
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
    return { ok: false, signInFailed: signInBroke(steps), credentialFault, steps, screenshot, pdf, itemLine };
  } finally {
    await close?.().catch(() => {});
  }
  });
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
/**
 * Read a download to a Buffer, insisting it really is a PDF.
 *
 * Shared by both routes to a file — the one Emburse hands back on the spot and
 * the one it queues — because "did we get a PDF" must not be answered two
 * slightly different ways.
 */
async function readDownload(download: { createReadStream: () => Promise<NodeJS.ReadableStream> }): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  if (buf.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new Error(`downloaded ${buf.length} bytes but it is not a PDF`);
  }
  return buf;
}

/**
 * What the app's navigation offers, for when a link cannot be found.
 *
 * The useful half of "I could not find Exports" is what there was instead.
 */
async function navText(page: Page): Promise<string> {
  for (const sel of ["nav", '[role="navigation"]', "aside"]) {
    const nav = await firstVisible(page, sel, 0);
    const text = nav ? (await nav.innerText().catch(() => "")).replace(/\s+/g, " ").trim() : "";
    if (text) return text;
  }
  return pageText(page);
}

/** The export dialog's words, for a failure that has to be readable. */
async function dialogText(page: Page, sel: Selectors): Promise<string> {
  const root = await firstVisible(page, sel.dialogRoot, 2000);
  const text = root ? await root.innerText().catch(() => "") : "";
  // A dropdown's menu is often portalled outside the dialog, so fall back to
  // the page rather than reporting an empty string.
  return (text || (await pageText(page))).replace(/\s+/g, " ").trim();
}

/**
 * Set the format with a native `<select>`, if that is what this is.
 *
 * Looks for a dropdown that actually offers PDF rather than trusting a
 * selector to have found the right one — a dialog has several dropdowns, and
 * the one that lists PDF is by definition the format control whatever it is
 * labelled. Returns null when there is no such select, so the click path can
 * take over.
 */
async function chooseFormatFromSelect(page: Page, sel: Selectors): Promise<string | null> {
  // Inside the dialog if we can find it, otherwise anywhere — a dialog that
  // does not match `dialogRoot` is a selector problem for another step, not a
  // reason to skip a control that is plainly on the page.
  const root = (await firstVisible(page, sel.dialogRoot, 1000)) ?? page.locator("body");
  const selects = root.locator("select");

  const n = await selects.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const one = selects.nth(i);
    if (!(await one.isVisible().catch(() => false))) continue;

    const options = await one.locator("option").allTextContents().catch(() => []);
    const pdf = options.find((t) => /\bpdf\b/i.test(t));
    if (!pdf) continue;

    await one.selectOption({ label: pdf });
    return `format set to PDF — chose "${pdf.trim()}" in a dropdown`;
  }
  return null;
}

/**
 * Set the format through the accessibility tree.
 *
 * The dialog puts "Select a format" in a floating label above a control that
 * reads "CSV". A text selector finds the label — and that label carries
 * `pointer-events: none`, so clicking it waits for something that can never
 * receive a click and times out at exactly the step timeout. The words are
 * right there on screen and still unclickable, which is a miserable thing to
 * debug from a selector box.
 *
 * Asking for the control *named* "format" sidesteps it: the label is what
 * gives the control its accessible name, so the name matches while the thing
 * returned is the control. It also cleanly avoids the template dropdown
 * sitting right above it, whose value ("Default CSV export") contains the word
 * CSV and would fool anything matching on displayed text.
 */
async function chooseFormatByRole(page: Page): Promise<string | null> {
  for (const role of ["combobox", "button"] as const) {
    const control = page.getByRole(role, { name: /format/i }).first();
    if (!(await control.isVisible().catch(() => false))) continue;

    const before = ((await control.innerText().catch(() => "")) || "").trim();
    if (/^pdf$/i.test(before)) return "format was already PDF";

    await control.click();
    const option = page.getByRole("option", { name: /^\s*PDF\s*$/i }).first();
    await option.waitFor({ state: "visible" }).catch(() => {});
    if (!(await option.isVisible().catch(() => false))) continue;
    await option.click();

    // Verify rather than assume. A dropdown that opened and closed without
    // taking looks identical to one that worked.
    const after = ((await control.innerText().catch(() => "")) || "").trim();
    if (!/pdf/i.test(after)) {
      throw new Error(
        `chose PDF in the format dropdown but it still reads "${after || "nothing"}".`,
      );
    }
    return `format set to PDF${before ? ` (was ${before})` : ""}`;
  }
  return null;
}

/**
 * Has the transactions grid loaded? Say how we know, or null.
 *
 * Both signals are given the full budget rather than being tried in sequence,
 * since either arriving is the answer.
 */
async function gridLoaded(page: Page, sel: Selectors): Promise<string | null> {
  const ms = env.emburseLogin.stepTimeoutMs;
  const [grid, count] = await Promise.all([
    firstVisible(page, sel.grid, ms).then((l) => (l ? "the grid is on screen" : null)),
    firstVisible(page, sel.itemCount, ms).then((l) => (l ? "the item count is on screen" : null)),
  ]);
  return grid ?? count;
}

export async function signIn(
  page: Page,
  sel: Selectors,
  login: Login,
  /** The app's own address, used to tell "back in the app" from "still at the identity host". */
  appUrl: string,
  challenge?: ChallengeHook,
): Promise<string> {
  const loggedIn = page.locator(sel.loggedIn).first();
  const emailBox = page.locator(sel.loginEmail).first();

  // Wait, do not peek. account.emburse.app draws its form with JavaScript, so
  // asking whether the box is visible the instant domcontentloaded fires
  // reliably says no — and then a correct selector looks like a wrong one.
  // Race the two outcomes instead: whichever appears, that is where we are.
  await Promise.race([
    emailBox.waitFor({ state: "visible" }),
    loggedIn.waitFor({ state: "visible" }),
  ]).catch(() => {});

  if (!(await emailBox.isVisible().catch(() => false))) {
    if (await loggedIn.isVisible().catch(() => false)) return "already signed in";
    throw new Error(
      `no sign-in form and the app is not loaded after waiting — at ${safeUrl(page.url())}. ` +
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

  const landed = await waitForApp(page, sel, appUrl);

  if (landed === "app") return `signed in as ${login.email}`;
  if (landed === "app-unmatched") {
    // Signed in, but `loggedIn` did not match. Worth proceeding — the origin
    // and a rendered page are real evidence — and worth saying out loud, so a
    // selector that has quietly stopped matching gets fixed rather than
    // carried indefinitely.
    return (
      `signed in as ${login.email} — the app is loaded at ${safeUrl(page.url())}, but the ` +
      "loggedIn selector did not match anything on it. Worth correcting."
    );
  }

  // A verification code is the one failure a person can actually clear, so
  // offer it to them instead of reporting a dead end — but only when somebody
  // is there to ask. An unattended 6am run has nobody to answer, and parking a
  // browser until it times out would just delay the same failure while holding
  // the profile lock.
  if (challenge) {
    const how = await passChallenge(page, sel, challenge);
    if (how) return `signed in as ${login.email} — ${how}`;
  }
  throw new SignInFailed(
    `signed in as ${login.email} but the app did not appear — ${await whyStuck(page)}`,
    isCredentialFault(await pageText(page), page.url()),
  );
}

/**
 * Wait for the sign-in to land somewhere, and say where.
 *
 * Written as a poll rather than a race of `waitFor`s because the question is
 * not "did one selector appear" but "which of several situations are we in",
 * and the answer changes as the page loads.
 *
 * The reason it is patient: a real run signed in successfully, spent thirty
 * seconds looking at a dashboard that had not painted yet, and reported that
 * the app never appeared — the screenshot taken a second later showed the app
 * fully rendered. Handing back the identity session and cold-rendering the
 * dashboard is the slowest thing in the run, and it happens exactly once, on
 * the run somebody is watching.
 */
async function waitForApp(
  page: Page,
  sel: Selectors,
  appUrl: string,
): Promise<"app" | "app-unmatched" | "challenge" | "stuck"> {
  const deadline = Date.now() + env.emburseLogin.signInWaitMs;
  const loggedIn = page.locator(sel.loggedIn).first();
  const codeBox = page.locator(sel.mfaCode).first();

  while (Date.now() < deadline) {
    if (await loggedIn.isVisible().catch(() => false)) return "app";

    const url = page.url();
    const text = await pageText(page);
    if (challengeKind(text, url) !== null) return "challenge";
    if (await codeBox.isVisible().catch(() => false)) return "challenge";

    // The fallback signal, and a sturdier one than any selector: sign-in
    // happens on the identity host, the app lives on its own. Being back on
    // the app's origin, off its sign-in paths, with something actually
    // rendered, is what "signed in" means — regardless of what any given
    // element is called this month.
    if (text.length > 0 && inApp(url, appUrl)) return "app-unmatched";

    await page.waitForTimeout(500);
  }
  return "stuck";
}

/** On the app's own origin, and not on one of its sign-in pages. */
export function inApp(current: string, appUrl: string): boolean {
  try {
    const now = new URL(current);
    if (now.origin !== new URL(appUrl).origin) return false;
    return !/^\/(logged-out|login|sign-?in|sso|auth|code-authentication)\b/i.test(now.pathname);
  } catch {
    return false;
  }
}

/**
 * A sign-in that failed, and whether the password is what needs changing.
 *
 * The distinction is the whole point. Every sign-in failure used to flag the
 * stored credential for re-entry, so a device check told its owner their
 * password was rejected. They re-type a perfectly good password, it fails the
 * same way, and the next time the app says a credential is bad they do not
 * believe it.
 */
export class SignInFailed extends Error {
  constructor(message: string, readonly credentialFault: boolean) {
    super(message);
  }
}

/**
 * Asked for a verification code while a sign-in is parked, and given one back.
 *
 * Whatever is on the other end of this — a web page, a test — the contract is
 * the same: it blocks until a person answers, and it throws if they never do.
 */
export type ChallengeHook = (ctx: {
  /** What the page says, so the person knows which code is wanted. */
  prompt: string;
  screenshot: string | null;
  attempt: number;
  /** Why the previous code was refused, on a retry. */
  lastError: string | null;
}) => Promise<string>;

/** Attempts before giving up. Emburse's own limit is lower, so this is a floor. */
const CHALLENGE_ATTEMPTS = 3;

/**
 * Walk a person through the device check, and make it the last one.
 *
 * The verification itself is the easy half. The half that matters is the tick
 * box: an unticked "remember this device" means the code was for nothing, the
 * next run is a stranger again, and somebody is reading texts every morning
 * forever. So it is ticked before the code is submitted, and its state is
 * reported either way — if Emburse ever stops offering it, that shows up as a
 * sentence in the step detail rather than as a mystery a month later.
 *
 * Returns how it was passed, or null when this is not a code prompt at all —
 * in which case the caller falls through to its usual diagnosis.
 */
async function passChallenge(page: Page, sel: Selectors, ask: ChallengeHook): Promise<string | null> {
  // Is this a challenge at all? The address answers first and most reliably —
  // Emburse's own path says /code-authentication — with the page's words as a
  // fallback for tenants whose URL says nothing.
  if (challengeKind(await pageText(page), page.url()) === null) return null;

  // Wait for the box, do not peek at it. This page is drawn by JavaScript like
  // the identity page before it, so asking the instant we arrive reliably says
  // "no code box" and turns a challenge we could have cleared into a dead end.
  const box = page.locator(sel.mfaCode).first();
  await box.waitFor({ state: "visible" }).catch(() => {});
  if (!(await box.isVisible().catch(() => false))) {
    throw new Error(
      `Emburse is asking for a verification code at ${safeUrl(page.url())}, but no box to type it ` +
        "into was found. Check the mfaCode selector against that page.",
    );
  }

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= CHALLENGE_ATTEMPTS; attempt++) {
    const prompt = snippet(await pageText(page));
    const screenshot = await page
      .screenshot({ fullPage: false })
      .then((b) => b.toString("base64"))
      .catch(() => null);

    const code = await ask({ prompt, screenshot, attempt, lastError });

    const remembered = await tickRemember(page, sel);
    await typeCode(page, sel, code);
    await page.locator(sel.mfaSubmit).first().click().catch(() => {});

    const loggedIn = page.locator(sel.loggedIn).first();
    await loggedIn.waitFor({ state: "visible" }).catch(() => {});
    if (await loggedIn.isVisible().catch(() => false)) {
      return remembered
        ? `verified with a code, and this device is now remembered, so future runs should not be asked again`
        : `verified with a code. Emburse did not offer to remember this device, so the next run may be asked again — ` +
            `check the mfaRemember selector against that screen`;
    }

    const text = await pageText(page);
    lastError = challengeKind(text, page.url())
      ? `Emburse did not accept that code. It says: "${snippet(text)}"`
      : `The code was submitted but the app still did not appear. The page reads: "${snippet(text)}"`;

    // Off the challenge screen but not into the app: another code will not
    // help, so stop rather than spending the remaining attempts on it.
    if (!challengeKind(text, page.url())) break;
  }

  throw new Error(lastError ?? "The verification code was not accepted.");
}

/**
 * Tick "remember this device", if it is there.
 *
 * Scoped to an unticked box only: `check()` on an already-ticked one is a
 * no-op, but reporting it as "we ticked it" when the tenant ticks it by
 * default would be a small lie in the one place this feature is judged.
 */
async function tickRemember(page: Page, sel: Selectors): Promise<boolean> {
  const box = page.locator(sel.mfaRemember).first();
  if (!(await box.isVisible().catch(() => false))) return false;
  if (await box.isChecked().catch(() => false)) return true;
  await box.check().catch(() => {});
  return box.isChecked().catch(() => false);
}

/**
 * Put the code in, whichever shape the box takes.
 *
 * Some tenants use one field; others use six single-character boxes that
 * advance focus as you type. Filling `.first()` with the whole code works for
 * the first and silently loses five characters on the second — so when the
 * count of boxes matches the length of the code, they are filled one by one.
 */
async function typeCode(page: Page, sel: Selectors, code: string): Promise<void> {
  const boxes = page.locator(sel.mfaCode);
  const n = await boxes.count().catch(() => 1);

  if (n > 1 && n === code.length) {
    for (let i = 0; i < n; i++) await boxes.nth(i).fill(code[i]!);
    return;
  }
  const first = boxes.first();
  await first.fill("");
  // Typed rather than pasted: a split field that advances focus on keypress
  // ignores a value set wholesale.
  await first.pressSequentially(code, { delay: 20 });
}

/**
 * The first element matching `selector` that is actually visible.
 *
 * `locator(sel).first()` is the trap: it picks element number one and waits
 * for *that* to become visible. Data grids routinely render hidden siblings —
 * a measuring table, a virtualised header, an empty template — so the first
 * match can be a ghost that will never be visible, and the wait times out
 * beside a grid that has been on screen the whole time.
 *
 * Waiting for "any of these is visible" is the question actually being asked.
 */
export async function firstVisible(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  const all = page.locator(selector);
  do {
    const n = await all.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const one = all.nth(i);
      if (await one.isVisible().catch(() => false)) return one;
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return null;
}

/**
 * Click the first visible match, or say precisely why nothing was clicked.
 *
 * `locator.click()` on a selector that matches nothing reports
 * "locator.click: Timeout 30000ms exceeded", which names neither the thing it
 * wanted nor what was actually on screen. Every one of these selectors is a
 * guess about somebody else's markup, so the failure has to carry enough for
 * the person reading it to write a better guess — the selector tried, and the
 * words that were really there.
 */
async function clickVisible(
  page: Page,
  selector: string,
  what: string,
  context?: () => Promise<string>,
): Promise<void> {
  const target = await firstVisible(page, selector, env.emburseLogin.stepTimeoutMs);
  if (!target) {
    const seen = snippet((await context?.()) ?? (await pageText(page)));
    throw new Error(
      `could not find ${what} — nothing visible matched ${selector}. It reads: "${seen}"`,
    );
  }
  await target.click();
}

/** The page's words, flattened — what both the diagnosis and the prompt read. */
const pageText = async (page: Page): Promise<string> =>
  ((await page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();

/**
 * Which wall this is, if it is one.
 *
 * Two different screens, and the order matters. A page asking for a code is a
 * second factor; a page only offering to remember the device is a device check.
 * They overlap in wording — "Verify it is you" heads both — so the code request
 * is tested first, or every MFA prompt gets reported as a device check and
 * sends people to look at a device nobody asked about.
 *
 * Shared, because the code-entry step and the failure message must agree on
 * what a challenge is. Two copies of this rule would drift, and the drift would
 * show up as a run that refuses to offer the box on the very page that needs it.
 */
export function challengeKind(text: string, url = ""): "code" | "device" | null {
  // The address is the most reliable evidence there is, and it was being
  // ignored. Emburse parks a half-finished sign-in on a page whose path says
  // exactly what it wants — /code-authentication — while the page's own words
  // may not have rendered yet, or may not contain any of the phrases below.
  // Reading only the text meant sitting on the verification page and reporting
  // a wrong password.
  if (/\/(code-authentication|mfa|two-factor|2fa|otp|verify-device|challenge)/i.test(path(url))) {
    return "code";
  }
  if (
    /verification code|authentication code|two-factor|2fa|one-time|authenticator|security code|passcode|check your (phone|email)|enter the code/i.test(
      text,
    )
  ) return "code";
  if (offersToRemember(text)) return "device";
  return null;
}

const offersToRemember = (text: string) =>
  /remember (this|my) device|trust (this|my) device|verify this device/i.test(text);

/** Just the path, for matching. A malformed URL is not worth throwing over. */
const path = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/**
 * A URL safe to show a person, write to the database, or put in a screenshot.
 *
 * Emburse carries a `session_token` in the query string of its verification
 * pages — a bearer credential for a half-authenticated session. That was being
 * printed in the failure message, stored on the credential row as `last_error`,
 * and rendered in the UI, which is three copies of a live secret in places
 * nobody would think to look for one. The path is the part that carries the
 * meaning; the query string is the part that carries the risk.
 */
export const safeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return u.search || u.hash ? `${u.origin}${u.pathname} (…)` : `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
};

/**
 * Why sign-in ended somewhere that is not the app.
 *
 * Listing the three things it might be is not much better than saying it
 * failed. The page itself knows — a rejected password says so, a second factor
 * asks for a code — so read it and report that instead of a shortlist. Falls
 * back to the page's own words when nothing matches a known pattern, because
 * unfamiliar wording is still evidence.
 */
async function whyStuck(page: Page): Promise<string> {
  const url = page.url();
  const text = await pageText(page);

  // Challenges are tested before credential rejection, not after. "Try again"
  // appears on a code screen too ("Didn't get a code? Try again"), so a loose
  // rejection test run first will claim the password is wrong while the
  // browser sits on the verification page — which is exactly what happened.
  const kind = challengeKind(text, url);
  if (kind === "code") {
    return (
      "Emburse is asking for a verification code. Start a test run and it will stop here and ask " +
      "you for it, rather than failing. " +
      (offersToRemember(text)
        ? "It offers to remember this device, so passing it once should be the last time. "
        : "") +
      `It says: "${snippet(text)}"`
    );
  }
  if (kind === "device") {
    return (
      "Emburse is asking to verify this device, which no automation can answer on its own. " +
      "It offers to remember the device, so this only has to be passed once per browser profile — " +
      `but the confirmation has to come from a person. It says: "${snippet(text)}"`
    );
  }
  if (credentialsRejected(text)) {
    return `Emburse rejected the credentials. It says: "${snippet(text)}"`;
  }
  if (/microsoft|sign in with|single sign|saml|okta/i.test(text)) {
    return `Emburse handed sign-in to another identity provider. It says: "${snippet(text)}"`;
  }
  if (!text) {
    return `the page at ${safeUrl(url)} has no readable text yet — it may still be loading, or be a redirect.`;
  }
  // Signed in fine, but nothing matched loggedIn: the likeliest remaining case.
  return (
    `at ${safeUrl(url)}, and the page reads: "${snippet(text)}". If that looks like Emburse, ` +
    "the loggedIn selector is what needs correcting."
  );
}

/**
 * Did Emburse actually say the password was wrong?
 *
 * Deliberately narrow. Sending somebody to re-type a password that is perfectly
 * good is worse than saying nothing: they do it, it fails again, and after the
 * second time they stop believing the message. "Try again" on its own is not
 * evidence — half the error screens on the internet end with it.
 */
export function isCredentialFault(text: string, url = ""): boolean {
  // A challenge always wins. Sitting on the verification page is not evidence
  // about the password, and treating it as such is what sent somebody to
  // re-type a working one.
  if (challengeKind(text, url) !== null) return false;
  return credentialsRejected(text);
}

export function credentialsRejected(text: string): boolean {
  return /wrong email or password|incorrect password|invalid (email|password|credentials)|password (is|was) (incorrect|wrong)|could not (sign|log) you in/i.test(
    text,
  );
}

const snippet = (t: string) => (t.length > 220 ? `${t.slice(0, 220)}…` : t);

const signInBroke = (steps: StepResult[]) => steps.some((s) => s.name === "sign in" && !s.ok);

async function runSteps(
  page: Page,
  settings: ExportSettings,
  sel: Selectors,
  login: Login,
  step: (name: string, fn: () => Promise<string>) => Promise<boolean>,
  opts: { dryRun?: boolean; onChallenge?: ChallengeHook; shouldStop?: () => boolean },
  setItemLine: (v: string) => void,
  setPdf: (b: Buffer) => void,
  gotPdf: () => boolean,
): Promise<boolean> {
  // From settings, so a wrong host can be corrected without a redeploy.
  const url = settings.emburseUrl || env.emburseLogin.url;

  if (!(await step("open Emburse", async () => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // Redacted: Emburse's sign-in redirect carries a session_token and the
    // whole OAuth query string, and this detail is stored and displayed.
    return `loaded ${safeUrl(page.url())}`;
  }))) return false;

  if (!(await step("sign in", async () => signIn(page, sel, login, url, opts.onChallenge)))) return false;

  if (!(await step("switch to ADMIN", async () => {
    // Emburse reopens on whichever of ADMIN / PERSONAL was last used, and
    // PERSONAL holds only this account's own expenses.
    const tab = page.locator(sel.adminTab).first();
    // Same reasoning as sign-in: the app renders after load, so give the tab a
    // chance to exist before concluding it does not.
    await tab.waitFor({ state: "visible" }).catch(() => {});
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

  if (!(await step("open the filtered grid", async () => {
    // One navigation, not two. There used to be an "open Transactions" step
    // that clicked a nav link first — which was pure risk, because this step
    // then navigates to an absolute URL regardless of where that click landed.
    // Its only achievement was a thirty-second timeout whenever Emburse
    // renamed or moved the link, on the way to a page we were about to load
    // directly anyway.
    //
    // The filters live in the query string, so there is also no ADVANCED
    // FILTERS dialog and no toggle whose state could be misread and inverted.
    const target = gridUrl(url, { receiptsOnly: settings.receiptsOnly, path: sel.gridPath });
    await page.goto(target, { waitUntil: "domcontentloaded" });

    // Two independent ways to know the grid arrived, because one selector for
    // it is one guess. The count line is the sturdier of the two — "34 items,
    // $42,249.94" is Emburse's own words about its own grid, and it cannot be
    // there unless the rows are.
    const how = await gridLoaded(page, sel);
    if (!how) {
      throw new Error(
        `the grid did not appear at ${safeUrl(page.url())}. Tried the grid selector ` +
          `(${sel.grid}) and the item-count line (${sel.itemCount}); neither matched anything ` +
          `visible. The page reads: "${snippet(await pageText(page))}"`,
      );
    }
    const scope = settings.receiptsOnly ? "receipts only, via the URL" : "unfiltered, via the URL";
    return `${scope} — ${how}`;
  }))) return false;

  await step("read the item count", async () => {
    // Not fatal: the count is a cross-check, not a precondition. A run that
    // cannot find it should still produce the export.
    const line = (await page.locator(sel.itemCount).first().innerText()).trim();
    setItemLine(line);
    return line;
  });

  if (!(await step("open the export dialog", async () => {
    await clickVisible(page, sel.exportButton, "the EXPORT button above the grid");
    if (!(await firstVisible(page, sel.dialog, env.emburseLogin.stepTimeoutMs))) {
      throw new Error(
        `the export dialog did not open — nothing visible matched ${sel.dialog} at ` +
          `${safeUrl(page.url())}.`,
      );
    }
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

    // Re-found at the top of every pass, never cached across one — and waited
    // for, never peeked at. Both halves were wrong at different times.
    //
    // Peeking: the dialog's title renders before its body, so asking whether a
    // chip is visible the instant the dialog opens reliably says no. That came
    // back in 0.0s having concluded the chips were missing, on a dialog whose
    // whole text was still "Export Expenses".
    //
    // Caching: clicking a chip re-renders the dialog, so a root taken before
    // the click points at a page that no longer exists. The pass after a click
    // then read an empty document, found no chips, and reported that they
    // would not take — having in fact just set one correctly.
    let scoped = true;
    for (let pass = 0; pass <= ALL_CHIPS.length; pass++) {
      const here = await findChipRoot(page, sel, [...want]);
      if (!here) {
        // Before anything was touched this is a selector problem, and the one
        // this step exists to catch: a chip that cannot be read used to be
        // skipped in silence, so a dialog where none matched produced "already
        // correct" and an export of whatever Emburse had selected. That is
        // invisible downstream — the PDF is valid, parses, and reconciles
        // against its own total. Only the sections are wrong.
        const names = [...want].join(", ");
        throw new Error(
          pass === 0
            ? `could not find the section chip${want.size === 1 ? "" : "s"} for ${names} in the ` +
              `export dialog, so the export would have covered the wrong sections. Looked inside ` +
              `${sel.dialogRoot} and across the whole page. It reads: ` +
              `"${snippet(await dialogText(page, sel))}"`
            : `the section chips did not come back after ${changed.join(" ")}. The dialog reads: ` +
              `"${snippet(await dialogText(page, sel))}"`,
        );
      }
      scoped = here.scoped;

      let clicked = false;
      for (const name of ALL_CHIPS) {
        const chip = chipLocator(here.root, name);
        if (!(await chip.isVisible().catch(() => false))) continue;

        const on = await isChipOn(chip);
        if (on === null) {
          // Never click a chip whose state could not be read. Doing so turned
          // one on, then off, then on again — six times — because every read
          // came back the same and every pass decided it still needed
          // changing. A chip toggled an unknown number of times is worse than
          // a run that stopped.
          throw new Error(
            `cannot tell whether the "${name}" chip is selected, so it was left alone rather ` +
              `than toggled blindly. It looks like ${await describeChip(chip)}.`,
          );
        }
        if (on === want.has(name)) continue;

        await chip.click();
        clicked = true;
        changed.push(`${want.has(name) ? "+" : "-"}${name}`);

        // Verify this one click before making another. Without this, a chip
        // whose state reads wrong is clicked once per pass until the passes
        // run out, leaving it wherever the parity landed.
        const after = await findChipRoot(page, sel, [...want]);
        const state = after ? await isChipOn(chipLocator(after.root, name)) : null;
        if (state !== want.has(name)) {
          // Put it back. Two clicks return a toggle to where it started, which
          // is the one thing that can be said for certain here.
          if (after) await chipLocator(after.root, name).click().catch(() => {});
          throw new Error(
            `clicking "${name}" did not turn it ${want.has(name) ? "on" : "off"} — it now reads ` +
              `${state === null ? "unreadable" : state ? "on" : "off"}. It was clicked back to ` +
              `where it started. The dialog reads: "${snippet(await dialogText(page, sel))}"`,
          );
        }
        break;
      }
      // One change per pass. The next pass waits for the dialog to come back
      // before reading anything, which is what makes the click observable.
      if (clicked) continue;

      // Settled. Say what is actually on, rather than that nothing needed
      // doing — "already correct" was a claim made without reading a chip.
      const on: string[] = [];
      for (const name of ALL_CHIPS) {
        const chip = chipLocator(here.root, name);
        if (!(await chip.isVisible().catch(() => false))) continue;
        if ((await isChipOn(chip)) === true) on.push(name);
      }
      const wrong = [...want].filter((w) => !on.includes(w)).concat(on.filter((o) => !want.has(o)));
      if (wrong.length) {
        throw new Error(
          `the section chips would not take: wanted ${[...want].join(", ") || "none"}, ` +
            `ended up with ${on.join(", ") || "none"}.`,
        );
      }
      // Saying when the chips were only reachable outside the dialog turns a
      // silent near-miss into a one-line selector fix.
      const note = scoped ? "" : ` (found outside ${sel.dialogRoot} — worth correcting)`;
      return `${changed.length ? `${changed.join(" ")} — ` : ""}on: ${on.join(", ") || "none"}${note}`;
    }
    // A chip that never takes means the state could not be read, and exporting
    // the wrong sections looks exactly like exporting the right ones.
    throw new Error(`section chips would not settle after ${changed.join(" ")}`);
  }))) return false;

  if (!(await step("choose PDF", async () => {
    // Choosing PDF also greys out the template selector, so nothing else needed.
    //
    // This used to be two blind clicks — `.first()` on the control and
    // `.last()` on a hard-coded "PDF" — and when the control was not where it
    // expected, all it could say was that a click timed out. Both halves are
    // now named, both are configurable, and a failure quotes the dialog so the
    // right words can be read straight off it.
    const inDialog = () => dialogText(page, sel);

    // A native <select> first, because it is the one shape where clicking is
    // simply wrong: its <option>s are not clickable elements, so a click on
    // one waits for something that will never become actionable and times out
    // at exactly the step timeout — which is the failure that was seen. The
    // dialog's sibling control ("Choose a template" → "Default CSV export")
    // is a native select, so its format control very likely is too.
    const viaSelect = await chooseFormatFromSelect(page, sel);
    if (viaSelect) return viaSelect;

    const viaRole = await chooseFormatByRole(page);
    if (viaRole) return viaRole;

    await clickVisible(page, sel.formatSelect, "the format dropdown", inDialog);
    await clickVisible(page, sel.formatOption, "PDF in the format list", inDialog);
    return "format set to PDF";
  }))) return false;

  if (!(await step("confirm the scope is everything", async () => {
    // With rows ticked the dialog says "1 expense(s)" and exports only those —
    // a valid PDF of almost nothing, which every later check would accept.
    //
    // Waited for, not sampled. This line lives in the dialog's body, which is
    // drawn after its title, and reading it too early finds a dialog that says
    // only "Export Expenses" — which does not match "all expenses" and so
    // reads as a row selection. Refusing to export because the page had not
    // finished rendering is a bad way to lose a morning.
    const deadline = Date.now() + env.emburseLogin.stepTimeoutMs;
    let body = "";
    do {
      // The dialog first, then the page — same reason the chips need it: a
      // dialogRoot that matches only the header leaves this line outside it,
      // and an inconclusive read is not a reason to refuse.
      for (const read of [() => dialogText(page, sel), () => pageText(page)]) {
        body = await read();
        if (/all\s+expense/i.test(body)) return "exporting all expenses";
        // A definite answer: it named a count, so the scope really is a
        // selection, and no amount of waiting will change that.
        if (/\d+\s+expense\(s\)/i.test(body)) {
          throw new Error(`dialog is scoped to a row selection, not all expenses: ${snippet(body)}`);
        }
      }
      await page.waitForTimeout(250);
    } while (Date.now() < deadline);

    // Never found either phrasing. Refusing is the safe direction: this is the
    // check that stops a valid PDF of almost nothing being exported and
    // accepted by every test downstream.
    throw new Error(
      `could not tell whether the dialog is exporting everything or a row selection — ` +
        `nothing matched "all expense(s)" or "N expense(s)". It reads: ${snippet(body)}`,
    );
  }))) return false;

  if (opts.dryRun) {
    await step("dry run", async () => "stopped before clicking Export");
    return true;
  }

  if (!(await step("start the export", async () => {
    // Scoped to the dialog: the grid behind it has an EXPORT button of its own,
    // and clicking that one reopens the dialog instead of submitting it.
    const root = await firstVisible(page, sel.dialogRoot, env.emburseLogin.stepTimeoutMs);
    if (!root) {
      throw new Error(
        `the export dialog is no longer on screen — nothing visible matched ${sel.dialogRoot}.`,
      );
    }
    const button = root.locator(sel.dialogExport).last();
    if (!(await button.isVisible().catch(() => false))) {
      throw new Error(
        `could not find the EXPORT button inside the dialog — nothing matched ` +
          `${sel.dialogExport} there. The dialog reads: ` +
          `"${snippet((await root.innerText().catch(() => "")).replace(/\s+/g, " ").trim())}"`,
      );
    }
    // Some tenants hand the file straight back instead of queueing it. Listen
    // for that while clicking, rather than clicking and then going to look for
    // a queue entry that was never created.
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }).catch(() => null),
      button.click(),
    ]);
    if (download) {
      const buf = await readDownload(download);
      setPdf(buf);
      return `export downloaded directly, ${(buf.length / 1e6).toFixed(1)} MB`;
    }
    return "export requested";
  }))) return false;

  if (!(await step("wait for the export and download it", async () => {
    // Already in hand: Emburse gave the file back at the moment of export, so
    // there is no queue to watch.
    if (gotPdf()) return "already downloaded when the export was requested";

    // Getting to the list is the whole premise of this step, so its failure is
    // reported rather than swallowed. Clicking a link that is not there used
    // to be a caught-and-ignored error, after which the *transactions* page
    // was polled for a "Complete" row for fifteen minutes — a quarter of an
    // hour spent on a page that could never say it.
    const list = await firstVisible(page, sel.exportsNav, env.emburseLogin.stepTimeoutMs);
    if (!list) {
      throw new Error(
        `could not find the link to Emburse's finished exports — nothing visible matched ` +
          `${sel.exportsNav}. Open Emburse, find where a finished export appears, and put the ` +
          `words on that link into the exportsNav selector. The page offers: ` +
          `"${snippet(await navText(page))}"`,
      );
    }
    await list.click();

    const deadline = Date.now() + env.emburseLogin.exportWaitMs;
    while (Date.now() < deadline) {
      if (opts.shouldStop?.()) throw new Error("stopped — the run was called off while waiting");
      if (await firstVisible(page, sel.newestExportReady, 0)) {
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          clickVisible(page, sel.newestExportDownload, "the Download link on the finished export"),
        ]);
        const buf = await readDownload(download);
        setPdf(buf);
        return `downloaded ${(buf.length / 1e6).toFixed(1)} MB`;
      }
      await page.waitForTimeout(10_000);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    throw new Error(
      `no completed export appeared within ` +
        `${Math.round(env.emburseLogin.exportWaitMs / 60000)} min at ${safeUrl(page.url())}. ` +
        `Nothing there matched ${sel.newestExportReady}. The page reads: ` +
        `"${snippet(await pageText(page))}"`,
    );
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
function chipLocator(root: Locator, name: string) {
  const label = new RegExp(`^[\\s\u2713\u2714\u2705*]*${escapeRe(name)}[\\s]*$`, "i");
  return root
    .locator('a, button, [role="button"], [role="checkbox"], label, span, div')
    .filter({ hasText: label })
    .first();
}

/**
 * Find where the section chips live, waiting for them to be drawn.
 *
 * Two mistakes are avoided here, and the first one shipped.
 *
 * **Peeking.** The dialog's title appears before its body, so asking whether a
 * chip is visible the instant the dialog opens reliably says no — the step
 * came back in 0.0s having concluded the chips could not be found, on a dialog
 * whose text was still just "Export Expenses". The rule this file already
 * learned twice: wait for a condition, do not sample one.
 *
 * **Trusting the scope.** Chips are looked for inside `dialogRoot`, and if
 * that selector matches a header rather than the whole dialog, the chips are
 * real and on screen and still unreachable. So the page is tried as well, and
 * the answer says which worked — a run that only succeeds unscoped is a
 * dialogRoot worth correcting, not a mystery.
 */
async function findChipRoot(
  page: Page,
  sel: Selectors,
  want: string[],
): Promise<{ root: Locator; scoped: boolean } | null> {
  const has = async (root: Locator) => {
    for (const name of want) {
      if (!(await chipLocator(root, name).isVisible().catch(() => false))) return false;
    }
    return want.length > 0;
  };

  const deadline = Date.now() + env.emburseLogin.stepTimeoutMs;
  do {
    const dialog = await firstVisible(page, sel.dialogRoot, 0);
    if (dialog && (await has(dialog))) return { root: dialog, scoped: true };
    const body = page.locator("body");
    if (await has(body)) return { root: body, scoped: false };
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a section chip is switched on.
 *
 * Emburse marks the active chips with a tick and a filled background. Neither
 * is a reliable attribute, so this reads whatever signals the DOM offers and
 * falls back to the tick character in the label.
 */
async function isChipOn(chip: Locator): Promise<boolean | null> {
  // Anything the chip states outright, in the order it is worth trusting.
  for (const attr of ["aria-pressed", "aria-checked", "aria-selected", "data-selected", "data-active"]) {
    const v = await chip.getAttribute(attr).catch(() => null);
    if (v !== null && v !== "") return v === "true";
  }

  const cls = (await chip.getAttribute("class").catch(() => "")) ?? "";
  if (/\b(is-)?(selected|active|checked)\b/i.test(cls)) return true;
  // Chip libraries of this vintage say it in the variant: filled is on,
  // outlined is off.
  if (/filled/i.test(cls)) return true;
  if (/outlined/i.test(cls)) return false;

  const text = (await chip.innerText().catch(() => "")) ?? "";
  if (/[\u2713\u2714\u2705]/.test(text)) return true;

  // The tick as an icon rather than a character — which is why reading the
  // text alone found no tick on a chip that plainly has one.
  if ((await chip.locator("svg").count().catch(() => 0)) > 0) return true;

  // Last resort, and the one a person actually uses: a selected chip is
  // filled, an unselected one is not.
  const bg = await chip
    .evaluate((el) => getComputedStyle(el as Element).backgroundColor)
    .catch(() => "");
  const rgba = /rgba?\(([^)]+)\)/.exec(bg);
  if (rgba) {
    const [r = 0, g = 0, b = 0, a = 1] = rgba[1]!.split(",").map((n) => Number(n.trim()));
    if (a === 0) return false;
    // Near-white is the page behind it showing through, not a filled chip.
    if (r > 235 && g > 235 && b > 235) return false;
    return true;
  }

  // Unknown. Deliberately not "off": treating unreadable as off is what made
  // a chip get clicked six times — on, off, on, off — because every read came
  // back the same and every pass decided it still needed turning on.
  return null;
}

/** What a chip looks like, for a failure somebody has to act on. */
async function describeChip(chip: Locator): Promise<string> {
  const cls = (await chip.getAttribute("class").catch(() => "")) ?? "";
  const tag = await chip.evaluate((el) => (el as Element).tagName.toLowerCase()).catch(() => "?");
  return `<${tag}${cls ? ` class="${cls.slice(0, 120)}"` : ""}>`;
}
