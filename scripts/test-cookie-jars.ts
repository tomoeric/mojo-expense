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
import { cookiesSavedAt, forgetCookies, rememberCookies, restoreCookies }
  from "../server/emburse/browser-state.js";

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

  console.log("\nAnd forgetting everything still works");
  await forgetCookies();
  check("nothing is remembered", (await cookiesSavedAt()) === null);
  check("…for anybody", (await cookiesSavedAt(BRIAN)) === null);
} finally {
  await forgetCookies();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
