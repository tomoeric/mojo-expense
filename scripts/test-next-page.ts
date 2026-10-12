/**
 * The grid has more than one page, and the run has to see all of it.
 *
 *   pnpm exec tsx scripts/test-next-page.ts
 *
 * Emburse paginates at ten rows. The cardholder filter is the right way to
 * find an expense — it returns everything that person has, including rows
 * the text search refuses to return — but "everything" arrives ten at a
 * time, and the run read the first page and concluded.
 *
 * Taylor Langley's queue reads "1-10 of 18". Five of her rows were
 * permanently invisible, and seven recurring Facebook charges failed over
 * and over with "none of the 13 rows matched" about rows on page two. The
 * message was false and it sent the reader to check whether the expense
 * still existed.
 *
 * This covers the one thing that is a guess about the tenant: whether the
 * shipped selector finds the arrow, and — the half that matters more —
 * whether it refuses the arrow at the END of the list, since a run that
 * keeps clicking a dead control pages for ever holding the browser lock.
 */
import { chromium } from "playwright";
import { DECISION_SELECTORS } from "../server/emburse/decide.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
});
const page = await browser.newPage();
const sel = DECISION_SELECTORS.nextPage;

const live = async () => {
  const one = page.locator(sel).first();
  return (await one.isVisible().catch(() => false))
    && !(await one.isDisabled().catch(() => false));
};

try {
  console.log("1. The arrow as a paginated grid draws it");
  await page.setContent(`<body><div>1-10 of 18</div>
    <button aria-label="Previous page"></button>
    <button aria-label="Next page"></button></body>`);
  check("the next arrow is found", await live());
  check("…and it is the NEXT one, not Previous",
    /next/i.test(await page.locator(sel).first().getAttribute("aria-label") ?? ""));

  console.log("\n2. The last page must stop the loop");
  // The arrow stays on the page at the end of the list. A run that cannot
  // tell pages for ever, holding the one browser every other job queues on.
  await page.setContent(`<body><div>11-18 of 18</div>
    <button aria-label="Previous page"></button>
    <button aria-label="Next page" disabled></button></body>`);
  check("a disabled arrow is not followed", !(await live()));
  await page.setContent(`<body><div>11-18 of 18</div>
    <div role="button" aria-label="Next page" aria-disabled="true"></div></body>`);
  check("…nor an aria-disabled one", !(await live()));

  console.log("\n3. A grid that does not paginate at all");
  await page.setContent(`<body><table><tr><td>Aug 02, 2026</td></tr></table></body>`);
  check("no arrow, no paging", !(await live()));

  console.log("\n4. Shapes a tenant might use instead");
  await page.setContent(
    `<body><nav aria-label="pagination"><button>1</button><button>2</button></nav></body>`);
  check("a pagination nav's last control is found", await live());
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
