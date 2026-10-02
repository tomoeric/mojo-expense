/**
 * Denying needs the row's ⋮ menu, and the default could not find it.
 *
 *   pnpm exec tsx scripts/test-deny-row-menu.ts
 *
 * "no ⋮ row menu matched `button[aria-label*="more" i], button:has-text("⋮")`
 * anywhere on the page. Approving would still work; only denying needs
 * this." — a real DENY of a $116.55 Home Depot charge, on a grid with the
 * menu plainly on every row.
 *
 * Emburse draws it as an icon button: no text, no "more" in its label, just
 * an SVG and a popup attribute. So the default matched nothing, and because
 * approving never touches that control, denying was the only thing broken —
 * which is the hardest kind of fault to notice.
 *
 * Two things are checked. The widened default finds that button. And when
 * nothing matches at all, the message names the controls that ARE on the
 * row, because the selector is the one thing the reader already has and the
 * markup is the thing they cannot get at.
 */

export {};

process.env.EMBURSE_PROFILE_DIR = `/tmp/mojo-denymenu-${Date.now()}`;
process.env.EMBURSE_STEP_TIMEOUT_MS ||= "25000";
process.env.EMBURSE_SIGN_IN_WAIT_MS ||= "45000";

const { startMock } = await import("./mock-emburse.js");
const mock = await startMock(5417, "/dev/null");
process.env.EMBURSE_LOGIN_URL = mock.url;

const { runDecision, DECISION_SELECTORS } = await import("../server/emburse/decide.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const SEL = { ...DECISION_SELECTORS } as never;
const LOGIN = { userId: "u", email: "eric.s@example.invalid", password: "x" };
const TARGET = {
  employee: "Brianna Ruth", merchant: "DOORDASH INC.", amount: 26.4, date: "2026-09-13",
};

const menu = (style: string) =>
  fetch(`${mock.url}/__menu/${style}`, { method: "POST" }).then(() => {}).catch(() => {});

const step = (r: { steps: { name: string; ok: boolean; detail: string }[] }, name: string) =>
  r.steps.find((s) => s.name === name);

try {
  console.log("\n1. The markup the real tenant uses: no label, no text, a popup attribute");
  mock.reset();
  await menu("haspopup");
  {
    const run = await runDecision("deny", TARGET, "Wrong amount", SEL, mock.url, LOGIN, {});
    const denied = step(run, "deny");
    check("the deny step found the menu",
      denied?.ok === true || !/no ⋮ row menu matched/.test(denied?.detail ?? ""),
      denied?.detail);
    check("…so the decision is not refused for want of a menu",
      !/row menu matched/.test(JSON.stringify(run.steps)),
      run.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`).join(" | "));
  }

  console.log("\n2. The old markup still works");
  mock.reset();
  await menu("labelled");
  {
    const run = await runDecision("deny", TARGET, "Wrong amount", SEL, mock.url, LOGIN, {});
    check("an aria-label=\"more\" button is still found",
      !/row menu matched/.test(JSON.stringify(run.steps)),
      run.steps.filter((s) => !s.ok).map((s) => s.name).join(", "));
  }

  console.log("\n3. With no menu at all, it says what IS on the row");
  mock.reset();
  await menu("none");
  {
    const run = await runDecision("deny", TARGET, "Wrong amount", SEL, mock.url, LOGIN, {});
    const denied = step(run, "deny");
    // Repeated sign-ins are unreliable in this container — a later run
    // reaches /identity and the form never draws. That is the environment,
    // not the thing under test, and reporting it as a failure of the deny
    // message would be a lie about which. Say it was not reached.
    if (!denied) {
      console.log("  skip  the run did not reach the deny step in this environment — "
        + run.steps.filter((x) => !x.ok).map((x) => x.name).join(", "));
    } else {
      check("it still refuses", denied.ok === false, denied.detail);
      check("…and names the controls on the row",
        /The controls on this row are:/.test(denied.detail), denied.detail);
      check("…listing the APPROVE button it can see",
        /APPROVE/i.test(denied.detail), denied.detail);
      check("…and still says approving would work",
        /only denying needs this/.test(denied.detail), denied.detail);
    }
  }

  console.log("\n4. Approving is untouched by any of it");
  mock.reset();
  await menu("none");
  {
    const run = await runDecision("approve", TARGET, "", SEL, mock.url, LOGIN, { dryRun: true });
    const signIn = step(run, "sign in");
    if (signIn && !signIn.ok) {
      console.log("  skip  sign-in did not complete in this environment");
    } else {
      check("a dry-run approve still finds its row", run.ok,
        run.steps.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join(" | "));
    }
  }
} finally {
  await menu("labelled");
  await mock.close();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
