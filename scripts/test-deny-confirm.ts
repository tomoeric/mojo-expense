/**
 * The button that commits a denial is SEND BACK, not Deny.
 *
 *   pnpm exec tsx scripts/test-deny-confirm.ts
 *
 * Clicking Deny in the ⋮ menu opens a dialog Emburse titles "Return
 * Transactions", whose buttons are CANCEL and SEND BACK. The word "Deny"
 * appears nowhere on it. The shipped default was `button:has-text("Deny")`,
 * so it matched nothing and every manual denial died on the final click —
 * nine of them over seven weeks, including $8,255.78, each with the reason
 * already typed into the box and read back, each still sitting in Needs
 * Review and returning on every import, with the employee never told.
 *
 * Every deny test was green the whole time, because the mock had put a Deny
 * button on that dialog. A mock built to agree with our assumption tests the
 * assumption and not the tenant, so this file asserts the selector against
 * the markup Emburse actually serves.
 *
 * No sign-in and no mock server: the question is only whether a selector
 * matches a piece of DOM, and the browser-driven suite cannot complete
 * repeated sign-ins in this container. A check this cheap should never be
 * the one that cannot run.
 */
import { chromium } from "playwright";
import { DECISION_SELECTORS } from "../server/emburse/decide.js";

/** The dialog as spend.emburse.com builds it. */
const DIALOG = `<h2>Return Transactions</h2>
  <textarea placeholder="Reason"></textarea>
  <button class="cx" type="button">CANCEL</button>
  <button class="dc">SEND BACK</button>`;

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
});
const page = await browser.newPage();

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};
const count = async (sel: string) => page.locator(sel).count();

try {
  const confirm = DECISION_SELECTORS.denyConfirm;

  console.log("1. The dialog Emburse actually shows");
  await page.setContent(`<body>${DIALOG}</body>`);
  check("the old default matched nothing, which is the bug",
    (await count('button:has-text("Deny")')) === 0);
  check("the shipped default finds exactly one button", (await count(confirm)) === 1);
  const text = (await page.locator(confirm).first().innerText()).trim();
  check("…and it is SEND BACK, not CANCEL", /send back/i.test(text), `it reads “${text}”`);

  console.log("\n2. Ways the same button can be written");
  // The label is uppercased by CSS on some pages and in the DOM on others;
  // `:has-text` reads textContent, which a text-transform does not change.
  await page.setContent(
    `<body><button class="dc" style="text-transform:uppercase">Send back</button></body>`);
  check("lowercase markup under a text-transform still matches", (await count(confirm)) === 1);
  // The ⋮ menu was missed once by assuming a control is a real <button>.
  // A dialog footer need not be one either.
  await page.setContent(`<body><div role="button">SEND BACK</div></body>`);
  check("a div[role=button] footer still matches", (await count(confirm)) === 1);

  console.log("\n3. What it must NOT hit");
  // The menu item that OPENS the dialog says Deny. Matching it would reopen
  // the menu instead of committing, and look like a hang.
  await page.setContent(`<body><button class="dn">Deny</button></body>`);
  check("the Deny menu item is not mistaken for the confirm", (await count(confirm)) === 0);
  await page.setContent(`<body><h2>Return Transactions</h2><button>CANCEL</button></body>`);
  check("CANCEL is never a match", (await count(confirm)) === 0);
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
