/**
 * Match results show up in the review queue.
 *
 *   pnpm exec tsx scripts/test-match-tab.ts
 *
 * The brief asks the personal queues to display match results (§4) and
 * names the states (§3): queued, uploaded, failed, already attached,
 * needs review. The queue showed Emburse's own Receipt column instead —
 * "none" — which is true about Emburse and silent about every receipt
 * this app had found, pulled in and was holding. An expense matched,
 * previewed and queued read exactly like one nobody had touched.
 *
 * `matchState` is the one place that decides the word, so it is the one
 * place worth testing: the write-back is further along than the match
 * and wins where both exist, and nothing reads as a success while the
 * other half is asking for a person.
 */
import { matchState } from "../server/emburse/neon.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

console.log("1. The send, once there is one, is what the queue reports");
check("applied reads as sent", matchState("applied", "chosen") === "sent");
check("already attached says so", matchState("already", "chosen") === "already");
check("queued reads as queued", matchState("queued", "chosen") === "queued");
check("proposed is queued too — it is on its way",
  matchState("proposed", "chosen") === "queued");
check("a failed send needs review", matchState("failed", "chosen") === "failed");
// Stale is a conflict: Emburse moved under us. It wants a person, and
// calling it anything softer would hide the one row that needs looking at.
check("…and so does a stale one", matchState("stale", "chosen") === "failed");

console.log("\n2. With no send yet, the match itself is the answer");
check("chosen and unsent reads as matched", matchState(null, "chosen") === "matched");
check("a bare candidate is NOT a match", matchState(null, "candidate") === "candidate");
check("attached without a write-back row still reads as sent",
  matchState(null, "attached") === "sent");
check("a failed match needs review", matchState(null, "failed") === "failed");
check("rejected is nothing at all", matchState(null, "rejected") === null);
check("and no receipt was ever matched", matchState(null, null) === null);

console.log("\n3. The write-back wins over the match, not the other way round");
// Both exist on every sent receipt, because choosing records a match and
// sending records a write-back. Reading the match would report "matched"
// for ever on an expense that was sent days ago.
check("sent beats chosen", matchState("applied", "chosen") === "sent");
check("…and a failure is not hidden by a chosen match",
  matchState("failed", "chosen") === "failed");

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
