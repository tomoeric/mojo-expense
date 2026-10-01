/**
 * One browser profile per Emburse account.
 *
 *   pnpm exec tsx scripts/test-profile-isolation.ts
 *
 * Keying the database cookie jar per account was not enough. The
 * persistent Chromium profile has cookies, localStorage and IndexedDB of
 * its own, it survives between runs, and it was ONE DIRECTORY for
 * everybody — so the next run opened with the previous account's session
 * already live, whatever the jar put in.
 *
 * What that produced: a run started from Brian's view, labelled
 * brian.c@mojocarwash.com, reported "sign in — already signed in" in 1.6
 * seconds and read 157 items, $29,287.03 off the grid. That is Eric's
 * queue. The run never signed in as Brian, imported Eric's Needs Review,
 * stamped it as Brian's, and showed eleven green steps doing it.
 */

import fs from "node:fs/promises";
import os from "node:os";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const ERIC = "eric.s@mammothholdings.test";
const BRIAN = "brian.c@mammothholdings.test";

const base = await fs.mkdtemp(`${os.tmpdir()}/mojo-profiles-`);
process.env.EMBURSE_PROFILE_DIR = base;
process.env.PLAYWRIGHT_CHROMIUM_PATH ||= "/opt/pw-browsers/chromium";

// After the environment is set: `env` is read once at module load, so a
// static import here would capture the real profile directory and this
// would quietly test nothing.
const { openBrowser } = await import("../server/emburse/auto-export.js");

try {
  console.log("\nEach account gets a directory of its own");
  {
    const eric = await openBrowser(ERIC);
    await eric.close();
    const brian = await openBrowser(BRIAN);
    await brian.close();

    const dirs = (await fs.readdir(base)).sort();
    check("there are two profiles, not one", dirs.length === 2, dirs.join(", "));
    // The line this exists for: nothing either of them does can be found
    // by the other, session cookies included.
    check("…named for each account", dirs.some((d) => d.includes("eric")) &&
      dirs.some((d) => d.includes("brian")), dirs.join(", "));
    check("…and neither is the bare shared directory",
      !dirs.includes("shared"), dirs.join(", "));
  }

  console.log("\nAn unnamed run gets the shared one, not somebody's");
  {
    const anon = await openBrowser();
    await anon.close();
    const dirs = (await fs.readdir(base)).sort();
    check("it is its own directory", dirs.includes("shared"), dirs.join(", "));
    check("…so there are three", dirs.length === 3, dirs.join(", "));
  }

  console.log("\nThe same account reuses its own, rather than making another");
  {
    const again = await openBrowser(ERIC.toUpperCase());
    await again.close();
    const dirs = await fs.readdir(base);
    check("case does not make a second profile", dirs.length === 3, dirs.join(", "));
  }
} finally {
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
