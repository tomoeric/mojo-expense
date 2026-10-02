/**
 * One login, two queues: whose login reads a queue is not whose queue it is.
 *
 *   pnpm exec tsx scripts/test-run-as.ts            (needs DATABASE_URL)
 *
 * "Would need to separate pulls, one schedule for Eric using Eric's scope
 * and another for Brian using Brian's scope, but import would use Eric for
 * both."
 *
 * Which is right, and it needs the two questions prised apart. A manager
 * can see the rows waiting on the people under them, so one login can pull
 * everybody's queues — each narrowed by that person's own filters and
 * stamped as theirs. The alternative is a second reviewer's login, which
 * means a second verification code from somebody who is not at the screen
 * every time Emburse stops trusting the browser.
 *
 * The hazard is equally plain: if the stamp follows the LOGIN instead of
 * the queue, an admin pulling for somebody else takes their expenses. That
 * is the line this test holds.
 */

process.env.SESSION_SECRET ||= "test-secret-run-as";

import { db, ensureSchema } from "../server/db.js";
import { deleteCredential, saveCredential } from "../server/emburse/credentials.js";
import { reviewerImports, setReviewerImport } from "../server/emburse/export-scheduler.js";
import { gridUrl, partsOfGridUrl } from "../server/emburse/auto-export.js";

const ERIC = "eric.s@test.invalid";
const BRIAN = "brian.c@test.invalid";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM reviewer_imports WHERE user_email IN ($1,$2)", [ERIC, BRIAN]);
  await deleteCredential(ERIC).catch(() => false);
  await deleteCredential(BRIAN).catch(() => false);
};

const mine = async (who: string) =>
  (await reviewerImports()).find((r) => r.userEmail.toLowerCase() === who);

await ensureSchema();

try {
  await clean();
  // Only Eric has a login. That is the whole point: Brian never signs in.
  await saveCredential(ERIC, ERIC, ERIC, "pw-eric");
  await saveCredential(BRIAN, BRIAN, BRIAN, "pw-brian");

  console.log("\n1. A reviewer runs as themselves unless told otherwise");
  check("Eric runs as himself", (await mine(ERIC))?.runAs === null);
  check("Brian too", (await mine(BRIAN))?.runAs === null);

  console.log("\n2. Brian's queue can be read with Eric's login");
  await setReviewerImport(BRIAN, { runAs: ERIC }, "test");
  {
    const b = await mine(BRIAN);
    check("it is recorded", b?.runAs === ERIC, String(b?.runAs));
    // The line this test exists for: the setting says whose LOGIN, and
    // must not quietly become whose QUEUE.
    check("…and the row is still Brian's", b?.userEmail.toLowerCase() === BRIAN);
    check("…while Eric is untouched", (await mine(ERIC))?.runAs === null);
  }

  console.log("\n3. Each keeps their own filters");
  await setReviewerImport(BRIAN, {
    gridPath: "/transactions/team", gridSection: "inbox",
    gridQuery: "filters[current_reviewer][]=brian-opaque-id",
  }, "test");
  await setReviewerImport(ERIC, {
    gridPath: "/transactions/team", gridSection: "inbox",
    gridQuery: "filters[current_reviewer][]=eric-opaque-id",
  }, "test");
  {
    check("Brian's filter is his", (await mine(BRIAN))?.gridQuery?.includes("brian-opaque-id") === true);
    check("Eric's is his", (await mine(ERIC))?.gridQuery?.includes("eric-opaque-id") === true);
    check("…and setting filters did not clear who reads them",
      (await mine(BRIAN))?.runAs === ERIC, String((await mine(BRIAN))?.runAs));
  }

  console.log("\n4. The filters reach the URL, and the defaults survive them");
  {
    const url = gridUrl("https://spend.emburse.test", {
      path: "/transactions/team", section: "inbox", receiptsOnly: true,
      extra: "filters[current_reviewer][]=brian-opaque-id",
    });
    const u = new URL(url);
    check("the reviewer filter is there",
      u.searchParams.get("filters[current_reviewer][]") === "brian-opaque-id");
    check("…the section is still set", u.searchParams.get("filters[section]") === "inbox");
    check("…and receipts-only was not lost", u.searchParams.get("filters[receipt]") === "true");
  }

  console.log("\n5. A URL copied out of Emburse gives up its parts");
  // Nobody should have to know which parameter the Current Reviewer
  // dropdown sets. Use it, copy the address bar, paste.
  {
    const pasted = "https://spend.emburse.com/transactions/team" +
      "?filters%5Bquery%5D=&filters%5Bsection%5D=pending_manager_review" +
      "&filters%5Bcurrent_reviewer%5D%5B%5D=abc123&filters%5Breceipt%5D=true";
    const parts = partsOfGridUrl(pasted);
    check("the path comes out", parts?.path === "/transactions/team", parts?.path);
    check("…the section comes out", parts?.section === "pending_manager_review", parts?.section);
    check("…the reviewer filter is kept",
      parts?.extra.includes("current_reviewer") === true, parts?.extra);
    // Dropped on purpose: a search box belongs to whoever typed in it, and
    // a pasted URL must not silently flip the app's own receipts setting.
    check("…the search box is dropped", parts?.extra.includes("filters%5Bquery") === false);
    check("…and receipts-only is not taken from the paste",
      parts?.extra.includes("receipt") === false, parts?.extra);
  }

  console.log("\n6. Rubbish in the box does not become a URL");
  check("it refuses", partsOfGridUrl("not a url") === null);
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
