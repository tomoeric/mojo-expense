/**
 * A verification code nobody was there to answer still reaches the app.
 *
 *   pnpm exec tsx scripts/test-code-asked.ts
 *
 * The live challenge parks a browser while somebody types, and it is only
 * ever wired up when somebody is watching — a scheduled run is deliberately
 * given no prompt hook. So the unattended case left no trace anywhere in
 * the app: a 5am import hit Emburse's verification screen, Emburse mailed a
 * code to the reviewer, the run stopped, and the only signal was that email.
 * The import simply looked as though it had not happened.
 *
 * No browser: this is about what survives the run, which is exactly the part
 * a browser test cannot show.
 */
import { clearCodeAsked, noteCodeAsked, openCodeRequests } from "../server/emburse/challenge-log.js";
import { db } from "../server/db.js";

const ERIC = `codetest-eric-${Date.now()}@example.invalid`;
const BRIAN = `codetest-brian-${Date.now()}@example.invalid`;

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};
const mine = async () =>
  (await openCodeRequests()).filter((r) => r.loginEmail === ERIC || r.loginEmail === BRIAN);

try {
  console.log("1. A locked-out scheduled run says so");
  await noteCodeAsked({ loginEmail: ERIC, during: "the scheduled import", prompt: "Enter the code we sent you" });
  let open = await mine();
  check("one row is open", open.length === 1);
  check("…naming the job that was turned away", open[0]?.during === "the scheduled import");
  check("…and the inbox the code went to", open[0]?.loginEmail === ERIC);
  check("…with the page's own words", /code we sent you/.test(open[0]?.prompt ?? ""));
  check("…counted once so far", open[0]?.times === 1);

  console.log("\n2. Every morning after that is the SAME lockout");
  // A run locked out on Monday is locked out on Tuesday. Fourteen identical
  // rows say no more than one saying "asked 14 times", and they would bury
  // a second login if there ever were one.
  await noteCodeAsked({ loginEmail: ERIC, during: "the scheduled import" });
  await noteCodeAsked({ loginEmail: ERIC, during: "automatic approvals" });
  open = await mine();
  check("still one row, not three", open.length === 1);
  check("…counted up instead", open[0]?.times === 3, `times = ${open[0]?.times}`);
  check("…and it names the job that asked LAST", open[0]?.during === "automatic approvals");
  check("…keeping when it started", open[0]!.firstAskedAt <= open[0]!.lastAskedAt);

  console.log("\n3. A second reviewer is a second lockout");
  await noteCodeAsked({ loginEmail: BRIAN, during: "the scheduled import" });
  check("both are listed", (await mine()).length === 2);

  console.log("\n4. Signing in puts it away");
  // Clearing is keyed to the login, so one reviewer getting in must not
  // speak for the other — their profiles and device trust are separate.
  await clearCodeAsked(ERIC, "signed in as eric");
  open = await mine();
  check("the one who signed in is gone", !open.some((r) => r.loginEmail === ERIC));
  check("…and the other is untouched", open.some((r) => r.loginEmail === BRIAN));

  console.log("\n5. And it can come back");
  // Cleared is not deleted: the old row stays as the record, and a fresh
  // lockout has to be able to open a new one past the unique index.
  await noteCodeAsked({ loginEmail: ERIC, during: "the scheduled import" });
  open = await mine();
  check("a new lockout opens cleanly", open.some((r) => r.loginEmail === ERIC));
  check("…starting its count again", open.find((r) => r.loginEmail === ERIC)?.times === 1);

  console.log("\n6. Clearing something that was never locked out");
  await clearCodeAsked("nobody@example.invalid", "signed in");
  check("does nothing and says nothing", true);
} finally {
  await db().query(
    "DELETE FROM emburse_code_requests WHERE login_email = ANY($1)", [[ERIC, BRIAN]]).catch(() => {});
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
