/**
 * Who gets which app.
 *
 *   pnpm exec tsx scripts/test-app-access.ts
 *
 * One deployment, two products. Emburse is the expense reviewer this app
 * began as and has people using it today; Dutch Miller is new and has two.
 * Getting this wrong in either direction is bad in a different way: too
 * narrow and a reviewer is locked out of the tool they use every morning,
 * too wide and somebody sees a product that is not theirs.
 *
 * The asymmetry in the defaults is the thing to hold on to. Emburse's list
 * being unset must mean "carry on as before", because a list that starts
 * empty would lock out every existing reviewer on the deploy that
 * introduced it. Dutch Miller's being unset must mean "the two named
 * people and nobody else", because it has no users to preserve.
 */
import { appFor, appsFor, hasDutchMiller, hasEmburse } from "../server/auth/apps.js";

const ERIC = "eric.s@mojocarwash.com";
const PAUL = "paul.d@mojocarwash.com";
const BRIAN = "brian.c@mojocarwash.com";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};
const env = (vars: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

try {
  console.log("1. Out of the box, with no secrets set");
  env({ DUTCH_MILLER_ALLOWED: undefined, EMBURSE_ALLOWED: undefined, AUTH_ALLOWED: undefined });
  check("Eric has both", appsFor(ERIC).join(",") === "emburse,dutch-miller", appsFor(ERIC).join(","));
  check("Paul has Dutch Miller only", appsFor(PAUL).join(",") === "dutch-miller", appsFor(PAUL).join(","));
  // The one that would have hurt. Brian reviews expenses every morning and
  // is on neither list; a default of "Emburse is opt-in too" locks him out
  // the moment this ships.
  check("an existing reviewer keeps Emburse", appsFor(BRIAN).join(",") === "emburse",
    appsFor(BRIAN).join(","));
  check("…and does not gain Dutch Miller", !hasDutchMiller(BRIAN));

  console.log("\n2. The Dutch Miller secret REPLACES the default, never adds to it");
  // A default nobody can remove is a backdoor.
  env({ DUTCH_MILLER_ALLOWED: "paul.d@mojocarwash.com" });
  check("the listed person has it", hasDutchMiller(PAUL));
  check("Eric is no longer on it", !hasDutchMiller(ERIC));
  // And having lost Dutch Miller he falls back into the open Emburse list,
  // rather than out of everything.
  check("…and keeps Emburse", appsFor(ERIC).join(",") === "emburse");

  console.log("\n3. Forgiving about how the secret is typed");
  env({ DUTCH_MILLER_ALLOWED: '  "PAUL.D@mojocarwash.com" \n eric.s@mojocarwash.com,  ' });
  check("quotes, case, newlines and a trailing comma all survive",
    hasDutchMiller(PAUL) && hasDutchMiller(ERIC));
  env({ DUTCH_MILLER_ALLOWED: "@dutchmiller.com" });
  check("a bare domain works", hasDutchMiller("anyone@dutchmiller.com"));
  check("…and does not spill into another domain", !hasDutchMiller("anyone@mojocarwash.com"));

  console.log("\n4. Setting EMBURSE_ALLOWED makes Emburse opt-in too");
  env({ DUTCH_MILLER_ALLOWED: undefined, EMBURSE_ALLOWED: "brian.c@mojocarwash.com" });
  check("the listed person has it", hasEmburse(BRIAN));
  check("…and nobody else does", !hasEmburse("someone.else@mojocarwash.com"));
  check("…not even Eric, who is only a default", !hasEmburse(ERIC));

  console.log("\n5. Somebody who may not sign in holds nothing");
  env({ EMBURSE_ALLOWED: undefined, AUTH_ALLOWED: "mojocarwash.com" });
  check("an outsider gets no Emburse", !hasEmburse("stranger@example.com"));
  check("…and no app at all", appsFor("stranger@example.com").length === 0);
  check("…so the shell has nothing to show them", appFor("stranger@example.com", undefined) === null);

  console.log("\n6. The app cookie is a preference, never a grant");
  env({ AUTH_ALLOWED: undefined });
  // The one value in all of this a browser can set for itself.
  check("asking for an app you hold is honoured", appFor(ERIC, "dutch-miller") === "dutch-miller");
  check("asking for one you do NOT hold is ignored", appFor(BRIAN, "dutch-miller") === "emburse");
  check("…and so is nonsense", appFor(ERIC, "../admin") === "emburse");
  check("no preference falls back to the first held", appFor(PAUL, undefined) === "dutch-miller");

  console.log("\n7. The FRONT DOOR asks about every app, not just Emburse");
  /*
   * The bug this pins, exactly as it happened.
   *
   * AUTH_ALLOWED is the Emburse list and was the only one when the
   * sign-in gate was written. Paul is assigned to Dutch Miller and
   * is not on it, so he authenticated in the tenant and was then
   * refused at the front door of the app he had been given — and
   * told to ask an administrator about a list that was never going
   * to mention him.
   */
  env({
    AUTH_ALLOWED: "eric.s@mojocarwash.com, brian.c@mojocarwash.com",
    DUTCH_MILLER_ALLOWED: undefined,
    EMBURSE_ALLOWED: undefined,
  });
  check("Paul is NOT on the Emburse list", !hasEmburse(PAUL));
  check("…but he does hold Dutch Miller", hasDutchMiller(PAUL));
  // The gate the callback uses. Anything other than zero gets in.
  check("…so the door lets him in", appsFor(PAUL).length > 0,
    appsFor(PAUL).join(","));
  check("…and lands him in the partner app", appFor(PAUL, undefined) === "dutch-miller");
  // And it must still shut on somebody with nothing.
  check("a tenant account on neither list is still refused",
    appsFor("nobody@mojocarwash.com").length === 0);
  check("…and an outsider is too", appsFor("stranger@example.com").length === 0);
  // Paul holds ONE app, so the other one stays shut behind its guard.
  check("holding Dutch Miller does not hand him Emburse",
    !appsFor(PAUL).includes("emburse"));
} finally {
  // Nothing persistent to clean up — this only ever read env vars.
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
