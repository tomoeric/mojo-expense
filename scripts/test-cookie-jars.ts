/**
 * One cookie jar per Emburse account, not one for the app.
 *
 *   pnpm exec tsx scripts/test-cookie-jars.ts        (needs DATABASE_URL)
 *
 * `emburse_browser_state` held exactly one row by design, from when one
 * login was the whole app. With two reviewers that is a live Emburse
 * session belonging to whoever signed in last, handed to whoever runs next.
 *
 * And sign-in returns early on "already signed in" when it finds a live
 * session. So a run that restored the other person's cookies skips the
 * password step, reads THEIR Needs Review, and reports success under the
 * name it meant to use. Every other scope in this app can be perfect and a
 * run still comes back with the wrong person's expenses — intermittently,
 * depending only on who exported last.
 */

process.env.SESSION_SECRET ||= "test-secret-jars";

import { db, ensureSchema } from "../server/db.js";
import {
  adoptLegacyDevice, cookiesSavedAt, dropLegacyDevice, forgetCookies, legacyDevice,
  rememberCookies, restoreCookies, savedJars,
} from "../server/emburse/browser-state.js";

const ERIC = "eric.s@mammothholdings.test";
const BRIAN = "brian.c@mammothholdings.test";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

/** Just enough of a Playwright context for the jar to read and write. */
const fakeContext = (cookies: { name: string; value: string }[]) => {
  const added: { name: string; value: string }[] = [];
  return {
    added,
    ctx: {
      storageState: async () => ({ cookies }),
      addCookies: async (c: { name: string; value: string }[]) => { added.push(...c); },
    } as never,
  };
};

const jar = (who: string) => fakeContext([
  { name: "session", value: `${who}-session`, domain: "emburse.test", path: "/" } as never,
]);

await ensureSchema();

try {
  await forgetCookies();

  console.log("\nEach account's session is kept under its own name");
  await rememberCookies(jar(ERIC).ctx, ERIC);
  await rememberCookies(jar(BRIAN).ctx, BRIAN);
  {
    const { rows } = await db().query<{ n: string }>(
      "SELECT count(*) AS n FROM emburse_browser_jars");
    check("there are two jars, not one", Number(rows[0]!.n) === 2, rows[0]!.n);
  }

  console.log("\nA run only ever gets its own back");
  {
    const eric = fakeContext([]);
    await restoreCookies(eric.ctx, ERIC);
    check("Eric gets a session", eric.added.length === 1, String(eric.added.length));
    // The line this test exists for.
    check("…and it is HIS", eric.added[0]?.value === `${ERIC}-session`, eric.added[0]?.value);

    const brian = fakeContext([]);
    await restoreCookies(brian.ctx, BRIAN);
    check("Brian gets his own", brian.added[0]?.value === `${BRIAN}-session`, brian.added[0]?.value);
  }

  console.log("\nBrian signing in does not hand Eric his session");
  // The sequence from the report: Brian's export succeeds, so his is the
  // newest jar. Under one shared row, Eric's next run restored it.
  await rememberCookies(jar(BRIAN).ctx, BRIAN);
  {
    const eric = fakeContext([]);
    await restoreCookies(eric.ctx, ERIC);
    check("Eric still gets Eric's", eric.added[0]?.value === `${ERIC}-session`, eric.added[0]?.value);
  }

  console.log("\nAn unnamed run is given nothing at all");
  // Safer than it looks: it signs in the long way, which is slower and
  // always correct. Handing it the last session anybody saved is how a run
  // reads somebody else's queue under its own name.
  {
    const nobody = fakeContext([]);
    const n = await restoreCookies(nobody.ctx, "");
    check("no cookies are restored", n === 0 && nobody.added.length === 0);
    const saved = await rememberCookies(jar("nobody").ctx, "");
    check("…and an unnamed session is not saved either", saved === 0);
  }

  console.log("\nForgetting one device leaves the other remembered");
  await forgetCookies(ERIC);
  check("Eric's is gone", (await cookiesSavedAt(ERIC)) === null);
  check("…and Brian's is not", (await cookiesSavedAt(BRIAN)) !== null);

  console.log("\nEvery remembered device, in one answer");
  // The page shows a row per Emburse account; asking per account turned one
  // render into N round trips for a readout nobody acts on individually.
  const all = await savedJars();
  check("Brian's is listed", all.some((j) => j.loginEmail === BRIAN), JSON.stringify(all));
  check("…and Eric's, just forgotten, is not",
    !all.some((j) => j.loginEmail === ERIC));
  check("…with the time it was saved",
    all.every((j) => !Number.isNaN(Date.parse(j.savedAt))));

  /*
   * THE PRE-KEYING SHARED ROW SURVIVES FORGETTING ONE ACCOUNT.
   *
   * `forgetCookies(who)` used to delete it whatever was named, so clearing
   * one tab's stale jar threw away the trust every OTHER account was still
   * waiting to adopt — a verification code already given, destroyed by a
   * button that said it was about one account.
   */
  console.log("\nForgetting one account does not throw away the shared device");
  await db().query(
    `INSERT INTO emburse_browser_state (id, state, updated_at) VALUES (true, $1, now())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [(await db().query<{ state: Buffer }>(
      "SELECT state FROM emburse_browser_jars WHERE user_email = $1", [BRIAN])).rows[0]!.state]);
  check("there is a shared device to lose", (await legacyDevice()) !== null);
  await forgetCookies(BRIAN);
  check("the named account's jar is gone", (await cookiesSavedAt(BRIAN)) === null);
  check("…AND THE SHARED ONE IS STILL THERE", (await legacyDevice()) !== null);

  console.log("\nThe shared device is assigned by EMBURSE LOGIN, and copied");
  check("it can be given to an account", (await adoptLegacyDevice(ERIC)) === true);
  check("…which now has its own", (await cookiesSavedAt(ERIC)) !== null);
  // Copied, not moved: a wrong answer is corrected by choosing again
  // rather than by hunting for a code, and the other accounts can still
  // take it.
  check("…and the shared one is still available to the others",
    (await legacyDevice()) !== null);
  check("…so a second account can take it too",
    (await adoptLegacyDevice(BRIAN)) === true && (await cookiesSavedAt(BRIAN)) !== null);
  check("an unnamed adoption is refused", (await adoptLegacyDevice("")) === false);

  console.log("\nAnd it can be dropped once nothing is waiting for it");
  await dropLegacyDevice();
  check("the shared row is gone", (await legacyDevice()) === null);
  // The whole point of a separate call: it throws away no account's trust.
  check("…and neither account lost its own",
    (await cookiesSavedAt(ERIC)) !== null && (await cookiesSavedAt(BRIAN)) !== null);
  check("…and adopting now has nothing to carry",
    (await adoptLegacyDevice(ERIC)) === false);

  console.log("\nAnd forgetting everything still works");
  await forgetCookies();
  check("nothing is remembered", (await cookiesSavedAt()) === null);
  check("…for anybody", (await cookiesSavedAt(BRIAN)) === null);
  check("…and nothing is listed", (await savedJars()).length === 0);
} finally {
  await forgetCookies();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
