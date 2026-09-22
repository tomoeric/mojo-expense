/**
 * Refusing an export older than one already imported.
 *
 *   pnpm exec tsx scripts/test-stale-import.ts
 *
 * The damage this prevents is quiet and hard to undo. Every row in an imported
 * file is marked back into the inbox and everything absent from it is marked
 * as having left — so yesterday's file resurrects expenses that have since
 * been approved and evicts the ones actually waiting. Once approvals start
 * releasing receipts it is worse: a resurrected expense returns with no
 * receipt, and that image cannot be fetched again.
 */

import { staleExportReason } from "../server/import/ingest.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** The newest expense in the file, and the newest already stored. */
const verdict = (file: string[], stored: string | null) =>
  staleExportReason(file.filter(Boolean).sort().at(-1) ?? null, stored);

console.log("\n1. An older export is refused");
check("yesterday's file is stale against today's data",
  verdict(["2026-09-18", "2026-09-21"], "2026-09-22") !== null);
check("…and says what it would have done",
  /back in the review queue/.test(verdict(["2026-09-21"], "2026-09-22") ?? ""),
  verdict(["2026-09-21"], "2026-09-22")?.slice(0, 90) ?? "accepted");

console.log("\n2. Today's export is fine");
// A quiet day produces an export whose newest row is the same as yesterday's.
// Blocking that would block the ordinary case.
check("the same newest date is not stale", verdict(["2026-09-19", "2026-09-22"], "2026-09-22") === null);
check("a newer one certainly is not", verdict(["2026-09-23"], "2026-09-22") === null);

console.log("\n3. Edge cases that must not block a real import");
check("a file with no dates is allowed through", verdict([], "2026-09-22") === null);
check("the very first import is allowed", verdict(["2026-01-05"], null) === null);
check("…and an old file into an empty database is too", verdict(["2020-01-01"], null) === null);
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
