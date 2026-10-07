import fs from "node:fs/promises";
import type { BrowserContext, Locator, Page } from "playwright";
import { env } from "../env.js";
import { forgetCookies, rememberCookies, restoreCookies } from "./browser-state.js";
import { nowDoing, watching } from "./live-view.js";
import { withBrowser } from "./browser-lock.js";
import type { ExportSettings } from "../import/settings.js";
import { clearCodeAsked, noteCodeAsked } from "./challenge-log.js";

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
  /**
   * The step failed because the thing looked for is simply not there, which
   * is not a fault. Carried on the step rather than inferred from its
   * wording, so the queue can treat it differently without anybody having to
   * keep a sentence stable.
   */
  absent?: boolean;
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
  | "accountMenu" | "signOutPath"
  | "mfaCode" | "mfaSubmit" | "mfaRemember"
  | "adminTab" | "grid" | "itemCount"
  | "gridPath"
  | "gridSection"
  | "gridQuery"
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
  // Emburse's deny dialog is "Return Transactions" with CANCEL and SEND
  // BACK; the word "Deny" is only on the menu item that opens it. Anyone
  // who saved the old default before it was corrected would keep it for
  // ever, because a stored value beats the compiled one.
  denyConfirm: ['button:has-text("Deny")'],
};

export const DEFAULT_SELECTORS: Selectors = {
  // Emburse signs in through account.emburse.app, whose box is often a plain
  // text input rather than type=email.
  loginEmail: 'input[type="email"], input[name="username"], input[name="email"], input[placeholder*="@"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")',
  loggedIn: 'text=Transactions',

  // WHERE the signed-in account is named. Emburse puts it top right, and it
  // prints the person's NAME — "Eric Schlicht" — never their email, which
  // is the whole reason the old check could not tell one reviewer from
  // another and waved a run through on somebody else's session.
  //
  // Scoped on purpose. The grid below is full of other people's names, so
  // searching the whole page for "brian" would find a cardholder and call
  // it a sign-in.
  accountMenu: 'header, [class*="header" i], [class*="navbar" i], [data-testid*="user" i], [aria-label*="account" i]',
  // Ends the Emburse SESSION without untrusting the browser: "remember this
  // device" is a separate long-lived cookie, which is why this is a sign-out
  // and not a cookie wipe. Wiping them is what lost Brian's device trust
  // last time, and nobody can read his code out on demand.
  signOutPath: "/users/sign_out",

  // The device-verification screen. Its code box is usually one field, but some
  // tenants split it into six single-character boxes — the selector matches
  // either, and the code is typed rather than pasted so both fill correctly.
  mfaCode: 'input[name*="code" i], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"]',
  mfaSubmit: 'button[type="submit"], button:has-text("Verify"), button:has-text("Continue"), button:has-text("Submit")',
  // Ticking this is the entire point of passing the challenge: unticked, the
  // next run is a stranger again and somebody is reading codes every morning.
  mfaRemember: 'input[type="checkbox"]',

  // ADMIN *or* MANAGER: Emburse names the team-wide tab per tenant, and this
  // one calls it MANAGER. Matching only ADMIN meant every run reported "no
  // ADMIN tab on this page" — harmless for the export, which reaches the grid
  // by URL anyway, but it had decisions telling people their account might
  // lack the team view when the tab was on screen the whole time, two
  // characters from what the selector was looking for.
  adminTab: 'text=/^\\s*(ADMIN|MANAGER)\\s*$/i',
  // Not just <table>: most data grids of this vintage are divs that announce
  // themselves through ARIA instead. Emburse's is one of them.
  grid: 'table, [role="grid"], [role="table"], [role="rowgroup"]',
  // The "34 items, $42,249.94" line above the grid.
  itemCount: 'text=/\\d[\\d,]* items?, \\$[\\d,]+\\.\\d{2}/',

  // A path, not a selector: the grid's filters live in the query string.
  gridPath: "/transactions/team",
  gridSection: "inbox",
  gridQuery: "",

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
  "Needs Review", "Pending Other's Review", "Pending Submission", "Denied", "Completed",
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
              "mfaCode", "mfaSubmit", "mfaRemember", "accountMenu", "signOutPath"],
  "confirm who is signed in": ["accountMenu"],
  "switch to the team view": ["adminTab"],
  "open the filtered grid": ["gridPath", "gridSection", "gridQuery", "grid"],
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
  accountMenu: "Where Emburse prints WHO is signed in \u2014 the account menu, top right. Scoped rather than the whole page, because the grid is full of other people's names.",
  signOutPath: "Path that ends the Emburse session, used when a session was found already open and could not be proved to be this account's. Device trust survives it; a cookie wipe would not.",
  mfaCode: "The box for the verification code, on the \u201cverify this device\u201d screen.",
  mfaSubmit: "The button that submits that code.",
  mfaRemember: "The \u201cremember this device\u201d tick box. Ticking it is what stops the code being asked for every run.",
  adminTab: "The team-wide tab, top left — ADMIN on some tenants, MANAGER on others. PERSONAL would export one person's own expenses.",
  grid: "The transactions table itself — used to tell the page has loaded. The item-count line is accepted instead, so this missing is not fatal.",
  itemCount: "The \u201cN items, $X\u201d line above the grid.",
  gridPath: "Path to the transactions grid. Filters are added as query parameters.",
  gridQuery: "Any other filters, copied from Emburse\'s address bar — above all Current Reviewer, which is what separates two approvers in a chain. Use the dropdown in Emburse, copy the URL, paste it into a reviewer\'s row.",
  gridSection: "The section filter the grid is opened with — Emburse's own value, \"inbox\" for Needs Review. With a two-stage approval chain this is one of the two things that says WHOSE stage is being read.",
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
  opts: {
    section?: string; receiptsOnly?: boolean; query?: string; path?: string;
    /**
     * One cardholder's own queue, by Emburse's internal user id.
     *
     * The parameter is `filters[user_id][]` and the value is an opaque
     * string — `uk4l0byvo7zzwgfzidt34awh2afoixiphkfka8fx`, not a name — so
     * it cannot be constructed, only learned by using the dropdown once and
     * reading the URL that comes back.
     *
     * Worth the trouble because it is a FILTER: it returns everything that
     * person has, including the rows Emburse's text search refuses to
     * return.
     */
    userId?: string;
    /**
     * Any other filters, verbatim, as a query string.
     *
     * The one that matters here is Emburse's **Current Reviewer** dropdown,
     * which is what finally separates two approvers: an expense in a chain
     * sits with exactly one reviewer at a time, and that filter is how the
     * grid says which. Its parameter name and values are a tenant's own —
     * opaque ids, not names — so they are not constructed here, they are
     * copied out of the address bar after using the dropdown once. Exactly
     * the same bargain as `filters[user_id][]` above, and worth it for the
     * same reason: a filter returns the truth where a guess cannot.
     *
     * Applied LAST so a learned filter beats the defaults, and parsed
     * rather than concatenated so a stray `?` or a duplicate key cannot
     * produce a URL that quietly means something else.
     */
    extra?: string;
  } = {},
): string {
  const url = new URL(opts.path ?? "/transactions/team", base);
  // Blank means NO section filter — the list's own default view. That is the
  // honest setting for a page whose sections this app does not know, and
  // Reimbursements is one: forcing Transactions' "inbox" onto it asks for a
  // section that may not exist there and comes back with nothing.
  const section = opts.section ?? "inbox";
  if (section) url.searchParams.set("filters[section]", section);
  if (opts.receiptsOnly) url.searchParams.set("filters[receipt]", "true");
  if (opts.userId) url.searchParams.append("filters[user_id][]", opts.userId);
  url.searchParams.set("filters[query]", opts.query ?? "");
  if (opts.extra) {
    for (const [k, v] of new URLSearchParams(opts.extra.replace(/^[?]/, ""))) {
      // Repeated keys are how Emburse expresses "any of these", so append
      // for the array-shaped ones and replace for the rest.
      if (k.endsWith("[]")) url.searchParams.append(k, v);
      else url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

/**
 * Pull the path and filters out of a URL copied from Emburse.
 *
 * The whole point is that nobody should have to know which parameter the
 * Current Reviewer dropdown sets. Use the dropdown, copy the address bar,
 * paste it in: the path, the section and everything else come out of it.
 *
 * `query` and `receipt` are dropped deliberately — the first is a search
 * box that belongs to whoever typed in it, the second is the app's own
 * setting and a pasted URL must not silently flip it.
 */
export function partsOfGridUrl(href: string): {
  path: string; section: string; extra: string;
} | null {
  try {
    const url = new URL(href.trim());
    const keep = new URLSearchParams();
    let section = "";
    for (const [k, v] of url.searchParams) {
      if (k === "filters[section]") { section = v; continue; }
      if (k === "filters[query]" || k === "filters[receipt]") continue;
      keep.append(k, v);
    }
    return { path: url.pathname, section, extra: keep.toString() };
  } catch {
    return null;
  }
}

/** The cardholder id Emburse put in a grid URL, if it is carrying one. */
export function userIdInUrl(href: string): string | null {
  try {
    return new URL(href).searchParams.get("filters[user_id][]");
  } catch {
    return null;
  }
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
/**
 * An email as a safe folder name — one directory per Emburse account.
 *
 * Lower-cased so the same account cannot end up with two profiles, and
 * everything outside a-z0-9 replaced so nothing in an address can reach
 * out of the directory it is supposed to name.
 */
export function cleanName(email: string): string {
  return email.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80) || "shared";
}

/**
 * Give the device Emburse already trusts to one account, keeping it.
 *
 * The per-account profiles are right and they have one cost nobody can
 * pay: the trust lives in the OLD shared directory, and moving to
 * per-account directories abandons it, so everybody signs in again. "I
 * won't be able to enter the code for Brian — we entered in code already.
 * That needs to stay." Quite so. A second reviewer is somebody else's
 * working day, and a design that needs them at a screen to be re-verified
 * is a design that does not ship.
 *
 * So the old profile is not discarded, it is handed to whichever account
 * it actually belongs to — a question the app cannot answer and a person
 * can. Everything comes across: cookies, localStorage, IndexedDB, which is
 * why this copies the directory rather than only the cookie jar.
 *
 * Copies rather than moves, so a wrong choice can be corrected by choosing
 * again rather than by somebody finding a verification code.
 */
export async function adoptLegacyProfile(userEmail: string): Promise<number> {
  const base = env.emburseLogin.profileDir;
  if (!base || !userEmail.trim()) return 0;
  const target = `${base}/${cleanName(userEmail)}`;

  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  // The old profile is whatever sits directly in the base directory. The
  // per-account ones are subdirectories we made, and Chromium's lock files
  // belong to the process that left them, not to anybody's session.
  const LOCKS = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket"]);
  const mine = new Set(entries.filter((e) => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name))
    .map((e) => e.name));
  const carry = entries.filter((e) => !LOCKS.has(e.name) && !mine.has(e.name));
  if (carry.length === 0) return 0;

  await fs.mkdir(target, { recursive: true }).catch(() => {});
  let copied = 0;
  for (const e of carry) {
    await fs.cp(`${base}/${e.name}`, `${target}/${e.name}`, { recursive: true, force: true })
      .then(() => { copied++; })
      .catch(() => {});
  }
  return copied;
}

export async function openBrowser(
  /**
   * Whose saved session to put in the browser, if any.
   *
   * Required in spirit: a run with no name gets a clean context and signs
   * in the long way. That is the safe end of the trade, because sign-in
   * returns early on "already signed in" — so an unnamed run handed the
   * last session anybody saved would skip the password step and read that
   * person's Needs Review while reporting its own name.
   */
  asUser = "",
): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const chromium = await loadPlaywright();
  const executablePath = (await systemChromium()) ?? undefined;
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];

  /*
   * A profile DIRECTORY PER ACCOUNT, not one for the app.
   *
   * The database jar was keyed per account and that was not enough. The
   * persistent Chromium profile holds cookies, localStorage and IndexedDB
   * of its own, it survives between runs, and it was one directory for
   * everybody — so the next run opened with the previous account's session
   * already live, whatever the jar put in.
   *
   * What that produced, exactly: a run started from Brian's view, labelled
   * brian.c@mojocarwash.com, reported "sign in — already signed in" in
   * 1.6 seconds and then read 157 items, $29,287.03. That is Eric's queue.
   * The run never signed in as Brian at all, imported Eric's Needs Review,
   * and stamped it as Brian's, and every step was green.
   *
   * One directory each ends it: a session can only ever be found by the
   * account it belongs to. `cleanName` keeps it a plain folder name rather
   * than trusting an email in a path.
   */
  const base = env.emburseLogin.profileDir;
  const dir = base
    ? (asUser ? `${base}/${cleanName(asUser)}` : `${base}/shared`)
    : base;
  if (dir) {
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const launch = (): Promise<BrowserContext> => chromium.launchPersistentContext(dir, {
      ...(executablePath ? { executablePath } : {}),
      args,
      viewport: { width: 1600, height: 1000 },
      acceptDownloads: true,
    });

    /**
     * A lock left behind by a Chromium that died is permanent until removed.
     *
     * Chromium takes an exclusive lock on its profile directory and drops it
     * on a clean exit. A process killed instead — OOM, a container reclaimed,
     * a restart in the middle of a run — leaves the lock files sitting there,
     * and every launch afterwards fails with "Failed to create a
     * ProcessSingleton for your profile directory". On a container that
     * rebuilt its filesystem each deploy that was self-clearing. On a VM the
     * directory persists, so it is forever: every import, every approval,
     * every sign-in, until somebody deletes a file nobody knows about.
     *
     * Safe to clear because `withBrowser` already serialises every run in
     * this process, and the profile is not shared with anything else — so
     * reaching here means no browser of ours is using it. If some other
     * Chromium genuinely holds it, the retry fails the same way and the
     * error is reported as before.
     */
    let context: BrowserContext;
    try {
      context = await launch();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (!/ProcessSingleton|already in use|SingletonLock/i.test(why)) throw err;
      console.warn("browser: clearing a profile lock left by a Chromium that did not exit");
      for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        await fs.rm(`${dir}/${name}`, { force: true, recursive: true }).catch(() => {});
      }
      context = await launch();
    }
    /*
     * NOT cleared. The directory is this account's and nobody else's, so
     * the cookies in it are theirs — including the one Emburse issues for
     * "remember this device for 30 days", which is the entire point of
     * keeping a profile at all.
     *
     * Clearing them was a belt-and-braces reflex and it quietly destroyed
     * the feature: every run would start as a stranger and ask for a
     * verification code, which for a second reviewer means asking somebody
     * else to drop what they are doing. Isolation is what makes a session
     * safe to reuse; emptying the profile on the way in is not isolation,
     * it is just forgetting.
     */
    // The profile directory carries trust between runs; the database carries
    // it between deployments, which rebuild that directory and would otherwise
    // lose the device every time the app ships.
    await restoreCookies(context, asUser);
    return { context, close: () => context.close() };
  }

  // No profile directory configured: behave as before rather than refusing.
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 },
  });
  await restoreCookies(context, asUser);
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
        // `NotInQueue` is thrown when Emburse has nothing matching in Needs
        // Review. Named by constructor rather than by instanceof, so this
        // module does not have to import from the one that throws it.
        ...(err instanceof Error && err.constructor.name === "NotInQueue" ? { absent: true } : {}),
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
     * Every other Emburse login this app knows about.
     *
     * Only ever used to catch being signed in as the wrong one. Seeing one
     * of these on the page while our own is absent is the proof that a run
     * reporting the right name all the way down is reading somebody else's
     * queue — which is otherwise invisible until the numbers look odd.
     */
    otherLogins?: string[];
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
    /**
     * The browser, the moment it exists, so a stop can shut it.
     *
     * Between-steps is not good enough and the stuck run proved it. "Open
     * Emburse" retries a 90-second navigation three times, so a run can sit
     * inside ONE step for six minutes with the flag set and nothing reading
     * it — Stop this run returned cheerfully and did nothing at all. Closing
     * the context makes the in-flight goto reject at once, the step fails,
     * and the run ends and is recorded like any other failure.
     */
    onOpen?: (close: () => Promise<void>) => void;
  } = {},
): Promise<ExportRun> {
  const steps: StepResult[] = [];
  let close: (() => Promise<void>) | null = null;
  let page: Page | null = null;
  let stopWatching: (() => void) | null = null;
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
      // So anybody watching sees a caption that matches the picture.
      nowDoing(name);
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
    const opened = await openBrowser(login.email);
    close = opened.close;
    opts.onOpen?.(opened.close);
    page = await opened.context.newPage();
    page.setDefaultTimeout(env.emburseLogin.stepTimeoutMs);

    // Watchable while it runs. Costs nothing unless somebody is looking:
    // frames are taken on request, not on a timer.
    stopWatching = watching(page, "starting", login.email);
    const ok = await runSteps(
      page, settings, selectors, login, step, opts,
      (v) => (itemLine = v), (b) => (pdf = b), () => pdf !== null,
    );

    // Whatever Emburse issued for getting this far — including for passing a
    // device check — is kept, so the next run does not start as a stranger.
    // After the steps rather than after sign-in, because the cookies that
    // matter are only set once the app has actually loaded.
    if (steps.find((st) => st.name === "sign in")?.ok) {
      await rememberCookies(opened.context, login.email);
    }

    // Short leash, and never fatal. A page that has already timed out times
    // its screenshot out too, and an exception here would throw the whole run
    // into the catch below — turning a diagnosed step failure into an
    // undiagnosed one at the very moment the diagnosis matters.
    const screenshot = ok
      ? null
      : await page
          .screenshot({ fullPage: false, timeout: 5_000 })
          .then((b) => b.toString("base64"))
          .catch(() => null);
    return { ok, signInFailed: signInBroke(steps), credentialFault, steps, screenshot, pdf, itemLine };
  } catch (err) {
    // Only call this "start browser" when the browser is genuinely what
    // failed. Everything thrown out of runSteps landed here under that name,
    // so a run whose first navigation timed out was headlined "Stopped at
    // start browser" — and the browser had started perfectly. The steps
    // already recorded the real failure; this line must not overwrite the
    // story it tells.
    const started = steps.length > 0;
    steps.push({
      name: started ? "the run stopped" : "start browser",
      ok: false,
      detail: explainLaunch(err),
      ms: 0,
    });
    let screenshot: string | null = null;
    try {
      // Short leash. A page that has already timed out times the screenshot
      // out too, which used to add another 30s and a second red step saying
      // "page.screenshot: Timeout" — noise on top of the real cause.
      if (page) screenshot = (await page.screenshot({ timeout: 5_000 })).toString("base64");
    } catch {
      /* A dead page cannot be photographed; the step detail is what matters. */
    }
    return { ok: false, signInFailed: signInBroke(steps), credentialFault, steps, screenshot, pdf, itemLine };
  } finally {
    // The last frame outlives the run on purpose — the interesting moment
    // is usually the one just before it ended.
    stopWatching?.();
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
/**
 * A URL that is part of the sign-in journey rather than a destination.
 *
 * The assertion hop is the one that matters: a document whose only job is
 * to be replaced by JavaScript the moment it loads. Deciding anything on
 * that page is deciding about a page that is leaving.
 */
const MID_SIGN_IN = /\/(?:login|oidc|assertion|authorize|callback|sso)\b/i;

/**
 * How a grid says it has nothing in it.
 *
 * Emburse writes "No rows". That wording was in neither of the two places
 * that test for an empty result, so a search returning nothing produced the
 * one diagnosis it could not be — see `gridLoaded`.
 */
export const EMPTY_GRID =
  /no rows|no results|no expenses|no transactions|nothing to show|no data|0 results/i;

export async function gridLoaded(page: Page, sel: Selectors): Promise<string | null> {
  const ms = env.emburseLogin.stepTimeoutMs;
  const [grid, count] = await Promise.all([
    firstVisible(page, sel.grid, ms).then((l) => (l ? "the grid is on screen" : null)),
    firstVisible(page, sel.itemCount, ms).then((l) => (l ? "the item count is on screen" : null)),
  ]);
  if (grid ?? count) return grid ?? count;

  // An EMPTY grid is still a loaded grid, and it used to be indistinguishable
  // from a page that never arrived. Both of the signals above are absent when
  // a search matches nothing: the shipped grid selector is "table" and this
  // tenant builds its grid from divs, while the item-count line — "4 items,
  // $118.33" — is not rendered at all when the count is zero.
  //
  // So every approval whose expense had left Needs Review failed with "no
  // grid … Set the grid and row selectors in Settings to match", against a
  // screenshot showing the grid, the filters, and the words "No rows". That
  // sends somebody to fix configuration that is working, for an expense that
  // is simply not there any more — usually because it has already been
  // approved.
  const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  if (EMPTY_GRID.test(body)) return "the grid is on screen and empty";
  // A standard ARIA grid, as a last resort. Not a substitute for the
  // configured selector — the row selector still has to match before
  // anything is clicked — but enough to say the page arrived.
  //
  // Given the SAME budget as the configured selector, not one second. A
  // failure report showed "no grid … Nothing matched the grid selector
  // 'table'. What IS on the page: [role='grid'] ×1, [role='row'] ×2 — so
  // the page loaded and one of those is the grid." The fallback that would
  // have answered it had already been given a second and lost, after the
  // configured selector spent the whole step budget failing. A last resort
  // that is only tried when there is no time left is not a last resort.
  const aria = await firstVisible(page, '[role="grid"], [role="table"]', ms);
  if (aria) return "the grid is on screen";

  /**
   * One more look when the page says it is still working.
   *
   * A real failure reported "Nothing table-like is on the page at all, so
   * either it had not finished rendering or /transactions/team is not where
   * this tenant keeps its transactions" — and the page text it quoted began
   * "Eric Schlicht Mammoth Holdings Loading...". It had not finished
   * rendering. The first half of that sentence was right and the message
   * sent somebody to check the second half, which is configuration that was
   * working.
   *
   * So a page still saying "Loading" is given one more full budget rather
   * than being reported as a selector problem. It costs nothing on a page
   * that is merely empty — EMPTY_GRID has already answered that above — and
   * on a slow link it is the difference between an approval and a wrong
   * diagnosis.
   */
  /*
   * An unreadable body counts as still loading too.
   *
   * A failure reported "[role=\"grid\"] ×1, [role=\"rowgroup\"] ×4,
   * [role=\"row\"] ×6, … so the page loaded and one of those is the grid"
   * and then "The page says: (nothing readable)". The elements were in the
   * DOM and nothing was painted, so every visibility check failed and the
   * word "Loading" was not there to be found either. A page with no
   * readable text at all has not arrived, whatever its markup says.
   */
  if (!/\bloading\b/i.test(body) && body.trim() !== "") return null;
  const late = await Promise.all([
    firstVisible(page, sel.grid, ms),
    firstVisible(page, '[role="grid"], [role="table"]', ms),
  ]);
  return late.some(Boolean) ? "the grid is on screen, after a slow render" : null;
}


/**
 * The words that stand for one login's owner on an Emburse page.
 *
 * Emburse's account menu prints a NAME — "Eric Schlicht" — and never the
 * email, so the check that looked for an email address could never confirm
 * or deny anything and said "could not confirm" on every single run. A
 * login's local part is the one piece of their name we hold:
 * `brian.c@mojocarwash.com` gives "brian", `eric.s@…` gives "eric", and
 * that is enough to tell those two apart.
 *
 * Initials and other one- or two-letter fragments are dropped — "c" would
 * match almost any page.
 */
export function nameTokens(email: string): string[] {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  return [...new Set(local.split(/[^a-z]+/).filter((t) => t.length >= 3))];
}

/**
 * Who the page says is signed in: us, somebody else we know, or no answer.
 *
 * Pure, so the three outcomes can be tested without a browser. Takes the
 * text of the ACCOUNT MENU rather than the whole page — the grid is full of
 * cardholders' names, and "Brian" appearing in somebody's expense list is
 * not a sign-in.
 */
export function readsAs(
  text: string,
  mine: string,
  others: string[],
): { mine: boolean; other: string | null; how: string } {
  const hay = text.toLowerCase();
  const me = mine.trim().toLowerCase();
  const peers = others.map((e) => e.trim().toLowerCase()).filter((e) => e && e !== me);

  if (hay.includes(me)) return { mine: true, other: null, how: "their address is on the page" };

  const theirs = peers.find((e) => hay.includes(e))
    ?? peers.find((e) => nameTokens(e).some((t) => hay.includes(t)));
  const ours = nameTokens(me).some((t) => hay.includes(t));

  // Ours AND somebody else's is not a confirmation. It means the text picked
  // up more than the account menu, and the honest answer is "cannot tell".
  if (ours && !theirs) return { mine: true, other: null, how: "their name is in the account menu" };
  if (theirs && !ours) return { mine: false, other: theirs, how: `${theirs} is in the account menu` };
  return { mine: false, other: null, how: "the account menu names nobody we know" };
}

/** The account menu's text, falling back to the page when it is not found. */
async function accountText(page: Page, sel: Selectors): Promise<string> {
  const menu = page.locator(sel.accountMenu).first();
  const scoped = await menu.innerText({ timeout: 2_000 }).catch(() => "");
  if (scoped.trim()) return scoped;
  return page.locator("body").innerText().catch(() => "");
}


/**
 * End the Emburse session without untrusting the browser.
 *
 * Device trust is a separate, long-lived cookie, so a sign-out keeps it and
 * a cookie wipe does not. That distinction is the whole reason this exists
 * as a navigation rather than `context.clearCookies()`: clearing them is
 * what lost Brian's remembered device before, and nobody can read his
 * verification code out on demand.
 *
 * Never throws. The caller decides what an unsuccessful sign-out means,
 * and it can tell by looking for the form afterwards.
 */
async function signOutOf(page: Page, sel: Selectors, appUrl: string): Promise<string> {
  const base = (() => {
    try { return new URL(page.url()).origin; } catch { return appUrl; }
  })();
  const emailBox = page.locator(sel.loginEmail).first();
  /** Did that work? The sign-in form appearing is the only proof. */
  const out = async (): Promise<boolean> => {
    await page.goto(appUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await emailBox.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
    return emailBox.isVisible().catch(() => false);
  };

  // The configured path first, then the handful this kind of app uses. One
  // guess would have made Brian's import depend on a URL nobody has
  // verified; a wrong guess here costs one navigation.
  const paths = [...new Set([
    sel.signOutPath?.trim() || "/users/sign_out",
    "/users/sign_out", "/logout", "/sign_out", "/users/logout", "/session/destroy",
  ].filter(Boolean))];

  for (const path of paths) {
    await page.goto(new URL(path, base).toString(), { waitUntil: "domcontentloaded" })
      .catch(() => {});
    if (await out()) return `signed out via ${path}`;
  }

  // Failing that, do it the way a person would: open the account menu and
  // click the item that says so. Tenant-correct by construction, which the
  // paths above are not.
  const menu = page.locator(sel.accountMenu).first();
  await menu.click({ timeout: 3_000 }).catch(() => {});
  const link = page.locator('a:has-text("Sign out"), a:has-text("Log out"), '
    + 'button:has-text("Sign out"), button:has-text("Log out")').first();
  await link.click({ timeout: 3_000 }).catch(() => {});
  if (await out()) return "signed out from the account menu";

  return "could not sign out";
}

/**
 * Sign in, and keep the lockout record honest on the way through.
 *
 * A thin wrapper so "a sign-in worked" clears the record in ONE place.
 * `signInHere` has four ways of succeeding — already signed in, signed in,
 * verified with a code, landed after a retry — and clearing at each of them
 * is how one gets missed and the app tells somebody to go and sign in long
 * after they did.
 */
export async function signIn(
  page: Page,
  sel: Selectors,
  login: Login,
  appUrl: string,
  challenge?: ChallengeHook,
  others: string[] = [],
  /**
   * What is running, for the record written when Emburse asks for a code
   * and there is nobody to ask. Only ever read on that path.
   */
  during = "an unattended run",
): Promise<string> {
  try {
    const how = await signInHere(page, sel, login, appUrl, challenge, others, during);
    await clearCodeAsked(login.email, how);
    return how;
  } catch (err) {
    if (!(err instanceof StrandedAtIdentity)) throw err;

    /*
     * Drop the saved session and try once more, from nothing.
     *
     * Emburse signs in through an OIDC redirect chain, and an OIDC flow is
     * stateful: its `state` nonce is tied to a cookie set at the START of
     * the flow. We restore a saved cookie jar into a fresh browser before
     * every run, so a jar carrying a dead session or a half-finished flow
     * gives the identity host something it cannot reconcile, and it answers
     * with an error page that has no form on it.
     *
     * Left alone that state is PERMANENT, which is the actual defect: the
     * jar that caused it is the jar restored next time. One reviewer sat
     * stuck for a full day across eight scheduled runs while the other
     * healed on his own, for no reason but which jar happened to be stale.
     *
     * Safe because the jar is a cache and never a credential — the password
     * is sealed in its own table and is what signs in from here. The cost of
     * being wrong is one password sign-in, and possibly one verification
     * code, which is strictly better than a reviewer being locked out until
     * somebody notices.
     *
     * Once. A second strand is a real failure and must be reported as one.
     */
    console.log(
      `emburse: ${login.email} was stranded at the identity host — ` +
      "clearing the saved session and signing in from scratch");
    await forgetCookies(login.email).catch(() => {});
    await page.context().clearCookies().catch(() => {});
    await openEmburse(page, appUrl).catch(() => "");

    const how = await signInHere(page, sel, login, appUrl, challenge, others, during);
    await clearCodeAsked(login.email, how);
    return `${how} — after clearing a stale saved session`;
  }
}

async function signInHere(
  page: Page,
  sel: Selectors,
  login: Login,
  /** The app's own address, used to tell "back in the app" from "still at the identity host". */
  appUrl: string,
  challenge?: ChallengeHook,
  /** Every other Emburse login we hold, so a session can be recognised as not ours. */
  others: string[] = [],
  during = "an unattended run",
): Promise<string> {
  const loggedIn = page.locator(sel.loggedIn).first();
  const emailBox = page.locator(sel.loginEmail).first();

  // Wait, do not peek. account.emburse.app draws its form with JavaScript, so
  // asking whether the box is visible the instant domcontentloaded fires
  // reliably says no — and then a correct selector looks like a wrong one.
  // Race the outcomes instead: whichever appears, that is where we are.
  //
  // THE CODE BOX IS ONE OF THEM. With a session already remembered, Emburse
  // skips email and password entirely and opens straight on
  // /code-authentication — so neither the form nor the app ever appears, the
  // race times out, and the run used to die claiming the loginEmail selector
  // was wrong while a code box sat on screen waiting to be filled in.
  const codeBoxEarly = page.locator(sel.mfaCode).first();
  const settle = async (): Promise<void> => {
    await Promise.race([
      emailBox.waitFor({ state: "visible" }),
      loggedIn.waitFor({ state: "visible" }),
      codeBoxEarly.waitFor({ state: "visible" }),
    ]).catch(() => {});
  };
  await settle();

  // A second look, if we are still standing in the middle of the sign-in
  // chain. Emburse's OAuth ends on an auto-submitting assertion page, and
  // a race that begins there can be cut short by the navigation it is
  // waiting through — leaving "no sign-in form and the app is not loaded"
  // about a page that was on its way somewhere. Belt to the load state's
  // braces: it costs nothing when we are already where we are going.
  if (MID_SIGN_IN.test(page.url())
      && !(await emailBox.isVisible().catch(() => false))
      && !(await loggedIn.isVisible().catch(() => false))) {
    await page.waitForURL((u) => !MID_SIGN_IN.test(u.toString()), { timeout: 20_000 }).catch(() => {});
    await settle();
  }

  if (!(await emailBox.isVisible().catch(() => false))) {
    if (await loggedIn.isVisible().catch(() => false)) {
      /*
       * A session was already open. WHOSE is a question, not an assumption.
       *
       * It used to be an assumption, written down as one: "the browser
       * profile and the cookie jar are both this account's, so a live
       * session here can only be theirs". That is false the moment anything
       * copies a profile between accounts — which adopting the legacy
       * device does, by design, to carry device trust forward. Brian's
       * folder ended up holding Eric's session, this branch returned
       * "already signed in as brian.c@…" in 1.7 seconds without typing a
       * password, and the run exported 95 rows of which 91 were Eric's.
       * Every step was green.
       *
       * So: prove it, or do not use it. An unproven session is signed out
       * of and replaced with a real sign-in, which costs about a minute and
       * makes the account certain. Signing out does not untrust the
       * browser — "remember this device" is a separate long-lived cookie —
       * which is why this is a sign-out and not the cookie wipe that lost
       * Brian's trust last time.
       */
      const seen = readsAs(await accountText(page, sel), login.email, others);
      if (seen.mine) {
        return `already signed in as ${login.email} — ${seen.how}`;
      }

      const whose = seen.other
        ? `the open session is ${seen.other}'s, not ${login.email}'s`
        : `the open session could not be proved to be ${login.email}'s`;
      const how = await signOutOf(page, sel, appUrl);
      await settle();

      if (!(await emailBox.isVisible().catch(() => false))) {
        throw new SignInFailed(
          `${whose}, and ${how} — no sign-in form appeared, still at ` +
            `${safeUrl(page.url())}. Nothing was exported, deliberately: using that session ` +
            `would have imported somebody else's expenses under ${login.email}'s name. ` +
            `Check the signOutPath selector against this tenant.`,
          false,
        );
      }
      // The form is up. Fall through to it — it types the password, so
      // whatever happens next, the account is this one.
    } else if (challengeKind(await pageText(page), page.url()) !== null) {
      // Straight to a verification code, before any form. Clearable by a
      // person, so ask — and if nobody is there to ask, say THAT rather
      // than blaming a selector for a page it was never meant to match.
      //
      // An `else if`, not a second `if`. It used to be one, and the
      // sign-out-and-retry path above walked straight through it into the
      // "no sign-in form" throw below — reporting a broken loginEmail
      // selector about a page that was showing the sign-in form.
      if (challenge) {
        const how = await passChallenge(page, sel, challenge);
        if (how) {
          const landed = await waitForApp(page, sel, appUrl);
          if (landed === "app" || landed === "app-unmatched") {
            return `signed in as ${login.email} — ${how}`;
          }
        }
        throw new SignInFailed(
          `Emburse asked to verify this device and the app did not appear afterwards — ${await whyStuck(page)}`,
          false,
        );
      }
      // Recorded, not just thrown. Thrown, this reaches a run log nobody
      // reads at 5am; the only thing that ever surfaced was Emburse's own
      // email to the reviewer, and the app itself said nothing at all.
      await noteCodeAsked({
        loginEmail: login.email, during, prompt: snippet(await pageText(page)),
      });
      throw new SignInFailed(
        "Emburse is asking for a verification code before it will sign in, and this run had nobody " +
          "to ask. Start it yourself so the code can be entered — once answered, this device stays " +
          "trusted and later runs go straight through.",
        false,
      );
    } else {
      // Emburse's own error page, which is NOT a sign-in page and has no
      // form on it to match. Saying "check the loginEmail selector" about
      // it cost a day of looking for an account lockout that did not
      // exist, while the page itself read "the url has been assembled
      // incorrectly".
      const text = await pageText(page);
      throw new StrandedAtIdentity(
        BROKEN_PAGE.test(text)
          ? `Emburse answered with its own error page at ${safeUrl(page.url())} — it says the page ` +
            `is missing or the URL was assembled wrongly. That is not a sign-in screen and there is ` +
            `no form on it: the sign-in is an OIDC redirect chain and it landed somewhere dead, ` +
            `which a stale saved session can cause.`
          : `no sign-in form and the app is not loaded after waiting — at ${safeUrl(page.url())}.`,
      );
    }
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
  } else if (challengeKind(await pageText(page), page.url()) !== null) {
    // The password went in and Emburse answered with the verification
    // screen. Same lockout as the one above, reached by the other road.
    await noteCodeAsked({
      loginEmail: login.email, during, prompt: snippet(await pageText(page)),
    });
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
 * The sign-in went nowhere: neither a form nor the app, on a page that is
 * neither.
 *
 * Its own type because the RECOVERY is specific and automatic — see
 * `signIn`. Matching on the wording would break the first time somebody
 * improved the sentence, which this file has said once already.
 */
export class StrandedAtIdentity extends Error {}

/** Emburse's "Oops! Something went wrong" page, in its own words. */
const BROKEN_PAGE =
  /page is missing|assembled incorrectly|something went wrong/i;

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
      // Loud, because the whole promise made to the person who just read
      // their email is that this is the last time. On a successful run the
      // step detail is only stored when the trace flag is on, so without
      // this the one thing worth knowing would be invisible exactly when
      // everything appears to have worked.
      console.log(remembered
        ? "emburse: verified with a code and the device is now remembered"
        : "emburse: VERIFIED BUT NOT REMEMBERED — Emburse did not offer a " +
          '"remember this device" box, or the mfaRemember selector no longer matches it, ' +
          "so a code will be asked for again");
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

/**
 * Can this container reach the host at all, without a browser?
 *
 * Asked only when Chromium has failed to load a page three times. It is the
 * one question that splits the two very different causes of that: a
 * container with no route out, versus a browser that cannot use the route
 * it has. They look identical from inside Playwright and have nothing in
 * common as fixes, and until this existed the message guessed at the first
 * one every time.
 */
/**
 * Above this, a "successful" probe is evidence AGAINST the browser being
 * the problem rather than for it. A healthy container answers this HEAD in
 * well under a second; the reports that prompted this were 11–17 seconds.
 */
const SLOW_REACH_MS = 3_000;

async function reachable(url: string): Promise<string> {
  const started = Date.now();
  try {
    const stop = AbortSignal.timeout(15_000);
    const res = await fetch(new URL("/", url).toString(), {
      method: "HEAD", redirect: "manual", signal: stop,
    });
    const ms = Date.now() - started;
    // SLOW is its own answer, and leaving it out was a misdiagnosis with a
    // cost. One redirect taking fourteen seconds is not "the network is
    // fine" — it is a link on which a full single-page app, dozens of
    // requests deep, cannot finish inside ninety seconds no matter how
    // healthy Chromium is. Twenty-five decisions in one report were filed
    // under "look at Chromium: a corrupt profile, a leftover process, or
    // memory on this VM" off a 13.9-second HEAD, which sends somebody to
    // rebuild a browser that was working.
    if (ms > SLOW_REACH_MS) {
      return `A plain request from the container did reach it, but took ${(ms / 1000).toFixed(1)}s ` +
        `for a single redirect (HTTP ${res.status}). That is the container's egress being very ` +
        `slow, not the browser: a page that fetches dozens of things cannot finish in ` +
        `${Math.round(env.emburseLogin.openTimeoutMs / 1000)}s over a link like that. Nothing here ` +
        `needs fixing — try again when the network is better, or raise EMBURSE_OPEN_TIMEOUT_MS.`;
    }
    return `A plain request from the container reached it in ${ms}ms (HTTP ${res.status}), so the ` +
      `network is fine and the BROWSER is what could not load the page — look at Chromium: a ` +
      `corrupt profile, a leftover process, or memory on this VM.`;
  } catch (err) {
    const ms = Date.now() - started;
    return `A plain request from the container also failed after ${ms}ms ` +
      `(${err instanceof Error ? err.message : String(err)}), so this container has no route to ` +
      `Emburse right now — it is the network or DNS, not anything in this app.`;
  }
}

/**
 * Open Emburse, with its own budget and two real retries.
 *
 * This is the first thing the container does after sitting idle — cold TLS,
 * then Emburse's OAuth redirect chain — and on the shared 30s step budget
 * the 6am export timed out every morning while manual runs (warm, 15s)
 * looked perfectly healthy.
 *
 * Shared with the DECISION path, which is how it should have started. The
 * decisions had a bare `page.goto(url)` on the 30s step budget, so on a slow
 * morning every queued approval failed at the first step with
 * "page.goto: Timeout 30000ms exceeded" and a screenshot of a sign-in page
 * that had plainly rendered. The export had already learned this lesson and
 * the decisions did not inherit it — the same divergence that had the export
 * accepting the item-count line as proof of a grid while decisions demanded
 * the grid selector.
 *
 * Returns the step detail, so both callers say the same thing.
 */
export async function openEmburse(page: Page, url: string): Promise<string> {
  // How long each attempt cost, so a retry that SUCCEEDS still leaves a
  // record. Without this the only evidence a navigation is chronically slow
  // was a total failure — a first attempt that timed out and a second that
  // got through looked exactly like a page that loaded first time, and the
  // next timeout is diagnosed by guessing all over again.
  const spent: string[] = [];
  const open = async (): Promise<void> => {
    const from = Date.now();
    try {
      // "domcontentloaded", and NOT "commit". I tried commit — it returns as
      // soon as the navigation is accepted, before a single byte of script
      // has run — on the reasoning that every caller waits for something
      // real afterwards. That reasoning was wrong in one specific way, and
      // it cost fourteen sign-ins.
      //
      // Emburse signs in through an OAuth chain that ends in an
      // auto-submitting assertion page: a document whose whole job is to be
      // replaced by JavaScript the moment it loads. Committing returns ON
      // that page, so the sign-in check started racing for a form and an
      // app on a hop that was about to navigate away — and reported "no
      // sign-in form and the app is not loaded" at
      // /login/oidc/assertion, and at /home before the shell had drawn.
      //
      // domcontentloaded does not wait for subresources either, so it was
      // never the thing making a slow link slow; the redirects and the TLS
      // were. It only waits for the document to parse, which is the point
      // at which the page is a page.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: env.emburseLogin.openTimeoutMs });
      spent.push(`${((Date.now() - from) / 1000).toFixed(1)}s`);
    } catch (err) {
      spent.push(`timed out after ${((Date.now() - from) / 1000).toFixed(1)}s`);
      throw err;
    }
  };

  try {
    await open();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await page.goto("about:blank").catch(() => {});
    try {
      await open();
    } catch {
      // Two tries 110 seconds apart is really one try. Whatever stops a page
      // loading for ninety seconds — a container whose network is not up yet
      // after a restart, a DNS resolver still starting — is not over in the
      // twenty seconds the old retry allowed, so the last attempt waits
      // properly first. A minute on the one morning it is needed, nothing on
      // the others.
      await page.waitForTimeout(30_000);
      await open().catch(async () => {
        // The decisive question, and it had never been asked: can THIS
        // CONTAINER reach Emburse at all? A plain fetch needs no browser, no
        // profile and no rendering. If it works, the network is fine and
        // Chromium is the problem — a corrupt profile, a leftover process,
        // memory. If it fails too, the container genuinely has no route out,
        // and no amount of selector work will help.
        const reach = await reachable(url);
        throw new Error(
          `${safeUrl(url)} did not load within ` +
            `${Math.round(env.emburseLogin.openTimeoutMs / 1000)}s, three times over about two ` +
            `minutes (${spent.join(", ")}). First attempt: ${why.split("\n")[0]}. ${reach}`,
        );
      });
    }
  }
  // Redacted: Emburse's sign-in redirect carries a session_token and the
  // whole OAuth query string, and this detail is stored and displayed.
  //
  // The attempts are named when there was more than one. A step that reads
  // "loaded … (timed out after 90.0s, then 11.4s)" is the difference between
  // a one-off and a host that is always on the edge of the budget.
  return `loaded ${safeUrl(page.url())}${spent.length > 1 ? ` (${spent.join(", then ")})` : ""}`;
}

/** Exposed for the test that pins which of the two causes it names. */
export const reachableForTest = reachable;

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
  opts: {
    dryRun?: boolean; onChallenge?: ChallengeHook; shouldStop?: () => boolean;
    /** The other logins this app knows, to catch being signed in as one. */
    otherLogins?: string[];
  },
  setItemLine: (v: string) => void,
  setPdf: (b: Buffer) => void,
  gotPdf: () => boolean,
): Promise<boolean> {
  // From settings, so a wrong host can be corrected without a redeploy.
  const url = settings.emburseUrl || env.emburseLogin.url;

  if (!(await step("open Emburse", () => openEmburse(page, url)))) return false;

  if (!(await step("sign in",
    async () => signIn(page, sel, login, url, opts.onChallenge, opts.otherLogins ?? [],
      // No hook means the scheduler withheld one, which it does for exactly
      // one trigger. Naming it here is what turns "a run was locked out"
      // into "the morning import is locked out".
      "the scheduled import"))))
    return false;

  /*
   * WHO is actually signed in — asked of the page, not of our intentions.
   *
   * Every step until now reports the account we MEANT to use. Nothing
   * checked, and "sign in" returns early on "already signed in" without
   * looking, so a run could be signed in as somebody else and say the
   * right name at every stage. Days went into deciding whether a 300-row
   * pull meant the list was too wide or the session was the wrong
   * person's, and the run itself could have answered that in a second.
   *
   * No selector, deliberately: Emburse's account menu is markup we cannot
   * know, and a wrong guess at it would be another thing to maintain. The
   * page's own text is enough for the question that matters — is ANOTHER
   * known login visible here? Finding one is proof of the wrong account.
   *
   * Three outcomes, and only one is fatal:
   *   - another reviewer's login on the page → stop, before a single row
   *     of theirs is imported as somebody else's;
   *   - our own login on the page → confirmed, and say so;
   *   - neither → cannot tell, which is honest and not a reason to refuse.
   */
  if (!(await step("confirm who is signed in", async () => {
    const seen = readsAs(await accountText(page, sel), login.email, opts.otherLogins ?? []);
    if (seen.other) {
      throw new Error(
        `this run is signed in as ${seen.other}, not ${login.email} — ${seen.how}. Nothing was ` +
        `exported. Sign-in should have replaced that session; check the signOutPath and ` +
        `accountMenu selectors against this tenant.`);
    }
    if (seen.mine) return `confirmed as ${login.email} — ${seen.how}`;
    // Not fatal here. The sign-in step above already refuses to USE a
    // session it could not prove, so by this point either the password was
    // typed this run or the run has stopped. This is the backstop, and a
    // backstop that cannot read the account menu should say so rather than
    // refuse a run that is in fact correct.
    return `the account menu named nobody we know, so this could not be confirmed from the page; ` +
      `the password was typed this run, so the account is ${login.email}`;
  }))) return false;

  if (!(await step("switch to the team view", async () => {
    // Not when this run is pointed somewhere else. A reviewer reading their
    // own approval stage is deliberately NOT on the team-wide tab, and
    // clicking it first would land on the wrong list before the URL below
    // corrects it — or leave Emburse remembering the wrong tab for the
    // next run.
    if (sel.gridPath && !/\/team\b/.test(sel.gridPath)) {
      return `skipped — this run reads ${sel.gridPath}, which is not the team-wide list`;
    }
    // Emburse reopens on whichever of the team tab / PERSONAL was last used,
    // and PERSONAL holds only this account's own expenses. The tab is called
    // ADMIN on some tenants and MANAGER on others.
    const tab = page.locator(sel.adminTab).first();
    // Same reasoning as sign-in: the app renders after load, so give the tab a
    // chance to exist before concluding it does not.
    await tab.waitFor({ state: "visible" }).catch(() => {});
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      return "clicked the team-wide tab";
    }
    // Absence is only acceptable if this is the app at all. Treating a missing
    // element as "fine" is how a failed sign-in got reported as three green
    // steps and then a thirty-second timeout on the one that could not skip.
    // Tolerated here because the grid is reached by URL a step later, so the
    // export does not depend on the click — which is also why this said "no
    // ADMIN tab" on every run of a MANAGER tenant for weeks without anyone
    // noticing the selector was simply wrong.
    if (await page.locator(sel.loggedIn).first().isVisible().catch(() => false)) {
      return `no tab matched ${sel.adminTab}, but the app is loaded — the grid is opened by URL next, ` +
        `so this only matters if that comes back empty`;
    }
    throw new Error(`no team-wide tab and the app is not loaded — at ${page.url()}`);
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
    const target = gridUrl(url, {
      receiptsOnly: settings.receiptsOnly, path: sel.gridPath, section: sel.gridSection,
      extra: sel.gridQuery,
    });
    await page.goto(target, { waitUntil: "domcontentloaded" });

    // Two independent ways to know the grid arrived, because one selector for
    // it is one guess. The count line is the sturdier of the two — "34 items,
    // $42,249.94" is Emburse's own words about its own grid, and it cannot be
    // there unless the rows are.
    let how = await gridLoaded(page, sel);

    /*
     * The configured path is not where this tenant keeps that list.
     *
     * /reimbursements is a 404 here — "404 Not found" with the nav beside
     * it listing "Reimbursements 8" as a link. Both reviewers' reimbursement
     * imports failed that way, on a path that was a guess written into
     * DEFAULT_SOURCES and never checked against the real tenant.
     *
     * The answer is on the page. The nav links to the list by name, so
     * rather than make somebody read a 404 and go hunting, follow the link
     * whose name matches the path we were told to open, and SAY what it
     * turned out to be so the setting can be corrected once.
     *
     * Only after the configured path has failed, and only to a link on
     * Emburse's own nav — this widens nothing about which queue is read,
     * it finds the page the setting was pointing at.
     */
    let viaNav: string | null = null;
    if (!how && sel.gridPath) {
      const name = (sel.gridPath.split("/").filter(Boolean).pop() ?? "").replace(/[-_]/g, " ");
      /** Where the nav says that list lives, by href or by going there. */
      const askTheNav = async (): Promise<string | null> => {
        if (!name) return null;
        // An anchor if there is one — cheap, and it needs no navigation.
        // Emburse's nav is a single-page app, though, so the item may be a
        // button or a div with a click handler and no href at all. Then the
        // only way to learn the path is to press it, which is what a person
        // does.
        for (const how2 of ["a", '[role="link"]', "button", '[role="button"]', "li"]) {
          const item = page.locator(`${how2}:has-text("${name}")`).first();
          if (!(await item.isVisible().catch(() => false))) continue;
          const href = await item.getAttribute("href").catch(() => null);
          if (href && !href.startsWith("#")) return new URL(href, page.url()).pathname;
          const before = page.url();
          await item.click({ timeout: 5_000 }).catch(() => {});
          await page.waitForURL((u) => u.toString() !== before, { timeout: 8_000 }).catch(() => {});
          if (page.url() !== before) return new URL(page.url()).pathname;
        }
        return null;
      };

      /*
       * The tenant's own naming scheme, before asking the nav.
       *
       * Transactions lives at /transactions/team on the MANAGER tab and at
       * /transactions on PERSONAL — so a list's team-wide view is
       * "<list>/team" here. The nav beside the 404 reads "MANAGER …
       * Transactions … Reimbursements", which makes /reimbursements/team
       * the obvious candidate for the same tab, and it costs one
       * navigation to find out.
       *
       * Tried before the nav because it is cheaper and more precise: the
       * nav link may well point at the PERSONAL view, which is a different
       * queue from the one a reviewer approves out of.
       */
      const sameScheme = /\/team\b/.test(sel.gridPath)
        ? null
        : `${sel.gridPath.replace(/\/$/, "")}/team`;
      let found: string | null = null;
      if (sameScheme) {
        await page.goto(gridUrl(url, {
          receiptsOnly: settings.receiptsOnly, path: sameScheme,
          section: sel.gridSection, extra: sel.gridQuery,
        }), { waitUntil: "domcontentloaded" }).catch(() => {});
        if (await gridLoaded(page, sel)) found = sameScheme;
      }
      found ??= await askTheNav();
      // Back through gridUrl, so the list is opened with this reviewer's
      // filters rather than whatever the nav's own default view is.
      if (found && found !== sel.gridPath) {
        await page.goto(gridUrl(url, {
          receiptsOnly: settings.receiptsOnly, path: found,
          section: sel.gridSection, extra: sel.gridQuery,
        }), { waitUntil: "domcontentloaded" }).catch(() => {});
        how = await gridLoaded(page, sel);
        if (how) viaNav = found;
      }
    }

    if (!how) {
      // A 404 is not a selector problem, and reporting it as one sends
      // somebody to fix the thing that is right. /reimbursements was a
      // guessed path that this tenant does not have; the page says so in
      // as many words, and the fix is one setting, not a selector.
      const text = await pageText(page);
      const missing = /\b404\b|not found/i.test(text);
      throw new Error(
        missing
          ? `${safeUrl(page.url())} does not exist on this tenant — the page says 404. This is ` +
            `the wrong path for that list, not a selector problem. Open the list in Emburse, ` +
            `copy the address, and put its path into that list under Export settings. ` +
            `The page reads: "${snippet(text)}"`
          : `the grid did not appear at ${safeUrl(page.url())}. Tried the grid selector ` +
            `(${sel.grid}) and the item-count line (${sel.itemCount}); neither matched anything ` +
            `visible. The page reads: "${snippet(text)}"`,
      );
    }
    const scope = settings.receiptsOnly ? "receipts only, via the URL" : "unfiltered, via the URL";
    return `${scope} — ${how}` +
      (viaNav
        ? ` — NOTE: ${sel.gridPath} did not load, so this followed the nav link to ${viaNav}. ` +
          `Set this list's path to ${viaNav} under Export settings so it goes straight there.`
        : "");
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
        // Which chips ARE there. A name from another tenant's vocabulary reads
        // as perfectly plausible in Export settings, and "Needs Manager
        // Review" — a chip this tenant does not have — stopped the export
        // every morning while the message sent people hunting for a selector.
        const offered = pass === 0 ? await offeredChips(page, sel) : [];
        throw new Error(
          pass === 0
            ? `could not find the section chip${want.size === 1 ? "" : "s"} for ${names} in the ` +
              `export dialog, so the export would have covered the wrong sections. ` +
              (offered.length > 0
                ? `The sections this dialog offers are: ${offered.join(", ")} — tick those in Export ` +
                  `settings instead. `
                : `No section chip could be read at all, inside ${sel.dialogRoot} or across the page. `) +
              `It reads: "${snippet(await dialogText(page, sel))}"`
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
 * confuse "Needs Review" with "Pending Other's Review"; the anchoring also
 * rules out ancestors, whose text contains the label plus everything around it.
 *
 * Apostrophes are matched either way round. "Pending Other's Review" is the
 * one chip whose name contains one, and whether Emburse renders it straight or
 * curly is a rendering detail nobody should have to discover from a failed
 * export at 6am.
 */
function chipLocator(root: Locator, name: string) {
  const label = new RegExp(
    `^[\\s\u2713\u2714\u2705*]*${escapeRe(name).replace(/['\u2018\u2019]/g, "['\u2018\u2019]")}[\\s]*$`,
    "i",
  );
  return root
    .locator('a, button, [role="button"], [role="checkbox"], label, span, div')
    .filter({ hasText: label })
    .first();
}

/**
 * The section chips this dialog actually offers.
 *
 * A run that stops on a chip it cannot find is almost always a chip that is
 * not there \u2014 Emburse names its sections per tenant, and a name typed into
 * Export settings from another tenant's vocabulary looks perfectly plausible.
 * Saying "these are the ones on screen" turns that from a selector hunt into
 * a tick box. Best effort: nothing here may throw on the way to an error.
 */
async function offeredChips(page: Page, sel: Selectors): Promise<string[]> {
  const roots = [await firstVisible(page, sel.dialogRoot, 0), page.locator("body")];
  const found: string[] = [];
  for (const name of ALL_CHIPS) {
    for (const root of roots) {
      if (!root) continue;
      if (await chipLocator(root, name).isVisible().catch(() => false)) {
        found.push(name);
        break;
      }
    }
  }
  return found;
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
