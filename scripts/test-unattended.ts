/**
 * A batch nobody is watching must not wait for a person.
 *
 * "Seems to be a hang up, not getting any approved." The queue sat on
 * "Applying 10 of 12 queued — 1080s so far" with nothing landed and no
 * failure to show for it either.
 *
 * Emburse asks an unrecognised browser for a verification code, and the
 * decision worker offered that prompt to the reviewer — on the reasoning
 * that "the decider clicked Approve moments ago, so there is somebody to
 * ask". True of a click. Not true of an automatic approval, which the sweep
 * queued on a timer a quarter of an hour earlier with nobody at the screen.
 * The run parked for the full ten-minute wait holding the browser, the
 * profile lock and the rest of the batch, then abandoned the sign-in anyway.
 *
 * No browser and no database: the rule is a predicate, and this is what it
 * has to say.
 */

import { anybodyToAsk } from "../server/emburse/decision-worker.js";
import type { BatchItem } from "../server/emburse/decide.js";

let failures = 0;
const check = (label: string, ok: boolean): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

const item = (automatic?: boolean): BatchItem => ({
  id: 1, decision: "approve", reason: "",
  target: { employee: "A", merchant: "B", amount: 1, date: "2026-09-24" },
  ...(automatic === undefined ? {} : { automatic }),
});

console.log("\nWho is present");
check("a batch of automatic approvals has nobody to ask",
  anybodyToAsk([item(true), item(true), item(true)]) === false);
check("a person's click means somebody is there",
  anybodyToAsk([item(false)]) === true);
// The browser signs in ONCE for the whole batch, so one person present
// clears the device check for everything travelling with them.
check("one click among many automatic ones is still somebody",
  anybodyToAsk([item(true), item(false), item(true)]) === true);
// Absent rather than false: everything that is not explicitly the machine's
// came from a person, and defaulting the other way would silently stop
// offering the prompt to the reviewer who is standing right there.
check("an item that does not say is treated as a person's",
  anybodyToAsk([item()]) === true);
check("an empty batch asks nobody", anybodyToAsk([]) === false);

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
