/**
 * Whose Needs Review the import reads.
 *
 * "Brian needs a separate import timeline as his import will pull from his
 * Emburse login, correct?" — and the question exposed something worse than
 * a missing feature. Emburse's Needs Review is relative to whoever signed
 * in, so the account the import uses IS the queue this whole app shows.
 * The rule was "the credential most recently proven to work, else the most
 * recently saved": the moment a second person stores a login and it
 * succeeds once, the entire queue silently becomes THEIR Needs Review.
 * Nobody is told, and expenses appear or vanish for everyone.
 *
 * Needs DATABASE_URL. Cleans up after itself.
 */

process.env.SESSION_SECRET ||= "test-secret-for-credentials";

import { db } from "../server/db.js";
import { credentialForExport, saveCredential, deleteCredential } from "../server/emburse/credentials.js";
import { setFlagOwner } from "../server/flags.js";

const ERIC = "eric.s@test.invalid";
const BRIAN = "brian.c@test.invalid";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const clean = async (): Promise<void> => {
  await deleteCredential(ERIC).catch(() => false);
  await deleteCredential(BRIAN).catch(() => false);
  await db().query("DELETE FROM app_flags WHERE key = 'importAs'").catch(() => undefined);
};

try {
  await clean();

  console.log("\nWith nobody chosen, it falls back and says so");
  await saveCredential(ERIC, ERIC, ERIC, "pw-eric");
  {
    const c = await credentialForExport();
    check("it uses the only login there is", c?.userEmail === ERIC, c?.userEmail);
    // The fallback has to announce itself, because its danger is invisible.
    check("…and warns that nobody chose", /by default/.test(c?.chosen ?? ""), c?.chosen);
    check("…naming what happens when a second login appears",
      /the queue moves/.test(c?.chosen ?? ""), c?.chosen);
  }

  console.log("\nA second login must not quietly take the queue over");
  await saveCredential(BRIAN, BRIAN, BRIAN, "pw-brian");
  // Brian's is the most recently saved, so the old rule would hand him the
  // whole app's queue here, without a word.
  await setFlagOwner("importAs", ERIC);
  {
    const c = await credentialForExport();
    check("the chosen person keeps it", c?.userEmail === ERIC, c?.userEmail);
    check("…and the run says it was chosen, not guessed",
      /chosen: the import is set to run as/.test(c?.chosen ?? ""), c?.chosen);
  }

  console.log("\nChoosing somebody is how it moves");
  await setFlagOwner("importAs", BRIAN);
  check("it reads Brian's queue now", (await credentialForExport())?.userEmail === BRIAN);

  console.log("\nChoosing somebody with no login refuses, rather than substituting");
  // The one thing it must never do: fall back to another account's Needs
  // Review, because that is a different queue and nothing would say so.
  await deleteCredential(BRIAN);
  {
    let said = "";
    try {
      await credentialForExport();
    } catch (e) {
      said = (e as Error).message;
    }
    check("it refuses", said !== "", said.slice(0, 120));
    check("…saying whose login is missing", said.includes(BRIAN), said.slice(0, 160));
    check("…and why substituting would be wrong",
      /different queue/.test(said), said.slice(0, 200));
  }
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
