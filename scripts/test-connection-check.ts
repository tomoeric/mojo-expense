/**
 * "Test connection" — signing in and reaching the grid, without deciding.
 *
 *   pnpm exec tsx scripts/test-connection-check.ts     (needs a browser)
 *
 * Approving a real expense used to be the only way to find out whether
 * somebody's Emburse login worked, so the first thing a new reviewer learned
 * was that a real expense "did not go through" — with the cause three screens
 * away in the export log. This is that same path minus the click.
 *
 * It goes as far as the grid on purpose: the failures people actually hit are
 * the device check (at sign-in) and the grid not appearing (after it), and a
 * test that stopped at "signed in" would have declared the second one fine.
 */

export {};

process.env.EMBURSE_PROFILE_DIR = `/tmp/mojo-conn-${Date.now()}`;
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "10000";
process.env.EMBURSE_SIGN_IN_WAIT_MS ||= "20000";

const { startMock, GOOD_CODE } = await import("./mock-emburse.js");
const mock = await startMock(5409, "/dev/null");
process.env.EMBURSE_LOGIN_URL = mock.url;

const { testConnection, DECISION_SELECTORS } = await import("../server/emburse/decide.js");
const { DEFAULT_SELECTORS } = await import("../server/emburse/auto-export.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const login = { userId: "brian@example.invalid", email: "brian@example.invalid", password: "x" };
const sel = { ...DEFAULT_SELECTORS, ...DECISION_SELECTORS } as Record<string, string>;
const set = (path: string) => fetch(`${mock.url}${path}`, { method: "POST" }).catch(() => {});
const names = (r: { steps: { name: string }[] }) => r.steps.map((s) => s.name).join(" → ");

try {
  console.log("\nA working login");
  await set("/__reset");
  const good = await testConnection(sel, mock.url, login);
  check("it connects", good.ok, names(good));
  check("…and goes past signing in, to the grid",
    good.steps.some((s) => /grid/i.test(s.name) && s.ok), names(good));
  check("…saying what it found there",
    /row\(s\)/.test(good.steps.find((s) => /grid/i.test(s.name))?.detail ?? ""),
    good.steps.find((s) => /grid/i.test(s.name))?.detail);
  check("and it decides nothing", good.matchedRow === null);

  console.log("\nA login that needs the device verifying");
  await set("/__reset");
  await set("/__outcome/code-first");
  let asked = 0;
  const coded = await testConnection(sel, mock.url, login, {
    onChallenge: async () => {
      asked++;
      return GOOD_CODE;
    },
  });
  check("the code is asked for here, so it can be cleared without approving anything",
    asked === 1, `asked ${asked} time(s)`);
  check("and the connection then works", coded.ok, names(coded));

  // Eric can export; Brian cannot approve. Same selectors, different account —
  // so the difference is Emburse permissions, and the ADMIN tab is the tell.
  // Only the EXPORT used to save the cookie jar. So somebody who cleared a
  // device check while approving had the trust cookie written into the browser
  // profile and nowhere else — and Replit rebuilds that directory on every
  // deploy, so they were asked for a code again on the next ship.
  if (process.env.DATABASE_URL) {
    console.log("\nKeeping the device trusted");
    const { cookiesSavedAt } = await import("../server/emburse/browser-state.js");
    const { db } = await import("../server/db.js");
    await db().query("DELETE FROM emburse_browser_state").catch(() => {});
    check("nothing is remembered to begin with", (await cookiesSavedAt()) === null);
    await set("/__reset");
    const kept = await testConnection(sel, mock.url, login);
    check("the connection test signs in", kept.ok, names(kept));
    check("…and saves the jar, so the next deploy does not start as a stranger",
      (await cookiesSavedAt()) !== null);
    await db().query("DELETE FROM emburse_browser_state").catch(() => {});
    // The pool stays open: the blocks below still sign in, and every sign-in
    // now saves the jar. Closing it here made those log a pool error.
  } else {
    console.log("\nDATABASE_URL not set — skipping the remembered-device check.");
  }

  console.log("\nAn account with no team-wide tab");
  await set("/__reset");
  const noAdmin = await testConnection({ ...sel, adminTab: "a.no-such-admin-tab" }, mock.url, login);
  const adminStep = noAdmin.steps.find((s) => /team view/i.test(s.name));
  check("a missing team tab is called out, not passed over silently",
    /no team-wide tab matched/.test(adminStep?.detail ?? ""), adminStep?.detail);
  check("…and it says what that means for deciding",
    /team view/i.test(adminStep?.detail ?? ""), adminStep?.detail);
  // Emburse names this tab ADMIN on some tenants and MANAGER on others, and
  // while the selector matched only ADMIN this step told a MANAGER tenant
  // their account might lack a view that was on screen the whole time. So the
  // message has to name the selector it tried, not only blame the account.
  check("…and names the selector, since a wrong one looks exactly like this",
    (adminStep?.detail ?? "").includes("a.no-such-admin-tab"), adminStep?.detail);

  console.log("\nA tenant whose tab is MANAGER rather than ADMIN");
  await set("/__reset");
  const shipped = await testConnection(sel, mock.url, login);
  const shippedStep = shipped.steps.find((s) => /team view/i.test(s.name));
  check("the shipped selector matches whichever name this tenant uses",
    !/no team-wide tab matched/.test(shippedStep?.detail ?? ""), shippedStep?.detail);

  console.log("\nA grid that does not appear");
  await set("/__reset");
  // The exact failure a reviewer just hit: signed in fine, no grid after it.
  const blind = await testConnection({ ...sel, grid: "table.nothing-matches-this" }, mock.url, login);
  check("it fails at the grid, not at sign-in",
    !blind.ok && blind.steps.some((s) => /sign in/i.test(s.name) && s.ok), names(blind));
  const why = blind.steps.find((s) => !s.ok)?.detail ?? "";
  check("…and says which selector found nothing, rather than just “did not appear”",
    /nothing-matches-this/.test(why), why.slice(0, 160));
  check("…and quotes what the page actually said", /The page says/.test(why), why.slice(0, 200));
  check("…and names the account as a likely cause when the export works but this does not",
    /this account is the difference/.test(why), why.slice(0, 120));
  check("…with a screenshot of where it stopped", Boolean(blind.screenshot));
} finally {
  await mock.close();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
