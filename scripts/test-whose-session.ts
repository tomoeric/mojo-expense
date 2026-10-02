/**
 * Whose session is actually open in the browser.
 *
 *   pnpm exec tsx scripts/test-whose-session.ts
 *
 * The run that forced this: a manual import labelled brian.c@mojocarwash.com
 * reported "sign in — already signed in as brian.c@… — their session was
 * still open" in 1.7 seconds, then "confirm who is signed in — could not
 * confirm from the page, which shows no login address; proceeding", then
 * exported 95 items of which 91 were already in eric.s@mojocarwash.com's
 * queue. The browser was showing "Eric Schlicht" the whole time.
 *
 * Two faults, one in each step. The confirm step looked for an EMAIL and
 * Emburse's account menu prints a NAME, so it could never confirm or deny
 * anything. And the sign-in step treated an open session as proof of whose
 * it was — an assumption that a legacy-profile adoption breaks on purpose,
 * since carrying device trust forward means copying one account's profile
 * into another's folder.
 */

import { nameTokens, readsAs } from "../server/emburse/auto-export.js";

const ERIC = "eric.s@mojocarwash.com";
const BRIAN = "brian.c@mojocarwash.com";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

console.log("\n1. A login's name tokens");
check("the first name survives", nameTokens(BRIAN).includes("brian"));
check("…and the initial does not — it would match anything",
  !nameTokens(BRIAN).includes("c"), nameTokens(BRIAN).join(","));
check("Eric's too", JSON.stringify(nameTokens(ERIC)) === JSON.stringify(["eric"]),
  nameTokens(ERIC).join(","));

console.log("\n2. The exact page that got through");
{
  // What the account menu showed while the run called itself Brian's.
  const seen = readsAs("Eric Schlicht\nMammoth Holdings", BRIAN, [ERIC]);
  check("it is not Brian's", seen.mine === false);
  check("…and it is named as Eric's", seen.other === ERIC, String(seen.other));
}

console.log("\n3. The honest cases");
{
  const his = readsAs("Brian Carroll\nMammoth Holdings", BRIAN, [ERIC]);
  check("Brian's own menu confirms him", his.mine === true && his.other === null);

  const byEmail = readsAs(`signed in as ${BRIAN}`, BRIAN, [ERIC]);
  check("an email confirms him too", byEmail.mine === true);

  const nobody = readsAs("Transactions\nDashboard\nCards", BRIAN, [ERIC]);
  check("a menu naming nobody is not a confirmation", nobody.mine === false);
  check("…and does not accuse anybody either", nobody.other === null);
}

console.log("\n4. Ambiguity is never a confirmation");
{
  // Both names in the text means the scope was wider than the account menu
  // — a grid full of cardholders, say. "Cannot tell" is the honest answer,
  // and the sign-in step turns that into a real sign-in rather than a guess.
  const both = readsAs("Eric Schlicht approved Brian Carroll's expense", BRIAN, [ERIC]);
  check("ours AND theirs confirms nothing", both.mine === false);
  check("…and accuses nobody", both.other === null);
}

console.log("\n5. A reviewer we hold no login for is not evidence");
{
  const stranger = readsAs("Michael Vance", BRIAN, [ERIC]);
  check("an unknown name is not Eric", stranger.other === null);
  check("…and not a confirmation of Brian", stranger.mine === false);
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
