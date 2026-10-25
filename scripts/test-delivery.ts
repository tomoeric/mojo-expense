/**
 * Sending one message, once, with a bounded number of tries.
 *
 *   pnpm exec tsx scripts/test-delivery.ts
 *
 * Three failures that are invisible until somebody complains:
 *
 *   A duplicate. A retry whose first attempt succeeded but whose reply
 *   was lost sends twice, and the reviewer gets two emails about one
 *   member with no way to tell which is real.
 *
 *   An unbounded retry. One permanently bad address becomes a loop.
 *
 *   A silent give-up. The step stays grey and nobody can say why.
 *
 * Graph is replaced here by a fake, because the point is the
 * surrounding behaviour and a test that sends real mail is a test
 * nobody runs.
 */
import { db } from "../server/db.js";

/**
 * A fake Graph.
 *
 * Passed in rather than monkey-patched: an ES module namespace object
 * is frozen, so there is no way to replace `sendMail` after the fact.
 * `sendOnce` takes the transport as an option for exactly this.
 */
const calls: { to: string; subject: string }[] = [];
let behaviour: "ok" | "transient" | "permanent" = "ok";
let failuresLeft = 0;

const transport = async (to: string, subject: string): Promise<void> => {
  calls.push({ to, subject });
  if (behaviour === "permanent") throw new Error("550 mailbox unavailable");
  if (behaviour === "transient" && failuresLeft > 0) {
    failuresLeft -= 1;
    throw new Error("503 service unavailable");
  }
};

const { RETRY, deliveriesFor, sendOnce } = await import("../server/dutch-miller/delivery.js");

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const RES = "test-resource-0001";
const msg = (email: string) => ({
  resource: RES, kind: "signup", email, audience: "reviewer",
  subject: "A new member", html: "<p>hello</p>",
  transport, configured: () => true,
});

try {
  await db().query("DELETE FROM dm_mail_sends WHERE resource = $1", [RES]).catch(() => {});

  console.log("1. One message, one send");
  const first = await sendOnce(msg("reviewer@example.invalid"));
  check("it sends", first.state === "sent");
  check("…on the first attempt", first.attempts === 1);
  check("…and really called out once", calls.length === 1);

  console.log("\n2. Asking again does NOT send again");
  const again = await sendOnce(msg("reviewer@example.invalid"));
  check("it reports the earlier send", again.state === "sent");
  check("…as a duplicate", again.duplicate === true);
  check("…and nothing left the building", calls.length === 1, String(calls.length));

  console.log("\n3. A blip is retried, within a bound");
  calls.length = 0;
  behaviour = "transient";
  failuresLeft = 1;
  const flaky = await sendOnce(msg("flaky@example.invalid"));
  check("it eventually sends", flaky.state === "sent");
  check("…after two attempts", flaky.attempts === 2, String(flaky.attempts));
  check("…which is what actually happened", calls.length === 2);

  console.log("\n4. Retrying STOPS");
  calls.length = 0;
  failuresLeft = 99;
  const doomed = await sendOnce(msg("doomed@example.invalid"));
  check("it gives up", doomed.state === "failed");
  check(`…after exactly ${RETRY.maxAttempts}`, doomed.attempts === RETRY.maxAttempts,
    String(doomed.attempts));
  check("…and tried no more than that", calls.length === RETRY.maxAttempts,
    String(calls.length));
  check("…saying why", doomed.error.includes("503"), doomed.error);

  console.log("\n5. A refused address is not retried at all");
  calls.length = 0;
  behaviour = "permanent";
  const bad = await sendOnce(msg("nobody@example.invalid"));
  check("it fails", bad.state === "failed");
  // Retrying a dead mailbox three times only delays the honest answer.
  check("…on the first attempt", bad.attempts === 1, String(bad.attempts));
  check("…without three goes at it", calls.length === 1, String(calls.length));

  console.log("\n6. The final state is visible, not just logged");
  const rows = await deliveriesFor(RES);
  check("every attempt is recorded", rows.length === 4, String(rows.length));
  const failedRows = rows.filter((r) => r.state === "failed");
  check("the failures are marked failed", failedRows.length === 2);
  check("…with the attempt count", failedRows.some((r) => r.attempts === RETRY.maxAttempts));
  check("…and a reason", failedRows.every((r) => r.error.length > 0));
  check("one bad address did not stop the good one",
    rows.some((r) => r.email === "reviewer@example.invalid" && r.state === "sent"));

  console.log("\n7. A failed message CAN be sent again deliberately");
  behaviour = "ok";
  calls.length = 0;
  const retried = await sendOnce(msg("doomed@example.invalid"));
  check("it sends this time", retried.state === "sent");
  check("…reusing the same record rather than making a second",
    (await deliveriesFor(RES)).length === 4);
} finally {
  await db().query("DELETE FROM dm_mail_sends WHERE resource = $1", [RES]).catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
