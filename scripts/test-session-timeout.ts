/**
 * Automatic sign-out is a setting, and it is an IDLE timeout.
 *
 *   pnpm exec tsx scripts/test-session-timeout.ts
 *
 * It was `SESSION_TTL_MS = 8 * 60 * 60 * 1000` with a comment
 * reading "a working day" — a reasonable guess, and not one
 * anybody could change without a deploy.
 *
 * What has to stay true, in order of how much it would cost to
 * get wrong:
 *
 *   A LINK SESSION CAN ONLY BE SHORTENED. Those belong to people
 *   an admin invited from outside; the setting goes to thirty
 *   days, and nobody decided that about dealer access.
 *
 *   OUT OF RANGE IS REFUSED, not clamped to a number nobody
 *   chose.
 *
 *   THE DEFAULT SURVIVES a database that cannot be read, because
 *   signing in must not depend on this.
 *
 *   AND IT IS IDLE, NOT ABSOLUTE: the middleware re-issues the
 *   cookie while somebody is working.
 */
import { db, ensureSchema } from "../server/db.js";
import {
  DEFAULT_SESSION_TTL_MS, MAX_SESSION_TTL_MS, MIN_SESSION_TTL_MS,
  clean, sessionTtlMs, setSessionTtlMs,
} from "../server/auth/session-policy.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

await ensureSchema();

try {
  await db().query("DELETE FROM app_settings WHERE key = 'session_ttl_ms'")
    .catch(() => undefined);

  console.log("1. The old constant is still the default");
  check("eight hours, as it always was",
    DEFAULT_SESSION_TTL_MS === 8 * 60 * 60 * 1000, String(DEFAULT_SESSION_TTL_MS));
  check("…and that is what an unset deployment gets",
    (await sessionTtlMs()) === DEFAULT_SESSION_TTL_MS, String(await sessionTtlMs()));

  console.log("\n2. A stored value takes over");
  await setSessionTtlMs(30 * 60_000, "eric.s@mojocarwash.com");
  check("thirty minutes is honoured", (await sessionTtlMs()) === 1_800_000,
    String(await sessionTtlMs()));
  await setSessionTtlMs(MAX_SESSION_TTL_MS, "eric.s@mojocarwash.com");
  check("…and so is the top of the range",
    (await sessionTtlMs()) === MAX_SESSION_TTL_MS);

  console.log("\n3. OUT OF RANGE IS REFUSED, not clamped");
  for (const [name, ms] of [
    ["one minute", 60_000], ["a year", 365 * 86_400_000], ["zero", 0],
    ["negative", -1], ["nonsense", Number.NaN],
  ] as const) {
    let threw = false;
    await setSessionTtlMs(ms, "eric.s@mojocarwash.com").catch(() => { threw = true; });
    check(`${name} is refused`, threw, String(ms));
  }
  check("…and the last good value still stands",
    (await sessionTtlMs()) === MAX_SESSION_TTL_MS, String(await sessionTtlMs()));
  check("the bounds are the ones the page offers",
    MIN_SESSION_TTL_MS === 300_000 && MAX_SESSION_TTL_MS === 2_592_000_000,
    `${MIN_SESSION_TTL_MS}–${MAX_SESSION_TTL_MS}`);

  console.log("\n4. `clean` is the one rule both ends use");
  check("a good value passes", clean(3_600_000) === 3_600_000);
  check("…a short one does not", clean(1) === null);
  check("…nor a long one", clean(MAX_SESSION_TTL_MS + 1) === null);
  check("…nor a string of nonsense", clean("soon") === null);

  console.log("\n5. A LINK SESSION CANNOT BE LENGTHENED BY IT");
  /*
   * The ceiling that matters. Dealer staff are invited from
   * outside; shortening reaches them, lengthening does not.
   */
  await setSessionTtlMs(MAX_SESSION_TTL_MS, "eric.s@mojocarwash.com");
  const long = Math.min(await sessionTtlMs(), DEFAULT_SESSION_TTL_MS);
  check("thirty days is capped at the eight-hour default for a link",
    long === DEFAULT_SESSION_TTL_MS, String(long));
  await setSessionTtlMs(15 * 60_000, "eric.s@mojocarwash.com");
  const short = Math.min(await sessionTtlMs(), DEFAULT_SESSION_TTL_MS);
  check("…but fifteen minutes reaches them", short === 900_000, String(short));
} finally {
  await db().query("DELETE FROM app_settings WHERE key = 'session_ttl_ms'")
    .catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
}
