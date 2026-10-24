/**
 * Who gets told about a new signup, and what the message says.
 *
 *   pnpm exec tsx scripts/test-notify.ts
 *
 * Two kinds of mistake matter here and neither announces itself. Sending
 * to nobody looks exactly like a quiet week — so the gates that produce
 * an empty list are tested one at a time. And sending to the wrong person
 * cannot be taken back, so a pasted list is parsed strictly, with
 * anything unrecognised reported rather than dropped.
 *
 * The message body is checked for the fields somebody actually needs off
 * it — the tag, the contract, the name — because a notification missing
 * the RFID means walking back to the app to find out what it was.
 */
import {
  getSignupNotify, parseRecipients, recipientsFor, setSignupNotify,
} from "../server/dutch-miller/settings.js";
import { signupEmail } from "../server/dutch-miller/notify.js";
import type { SignupRow } from "../server/dutch-miller/signups.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const ME = "submitter@dutchmiller.example";
const ROW: SignupRow = {
  guid: "11111111-2222-4333-8444-555555555555",
  createdAt: "2026-10-24T14:18:44.000Z",
  displayTimezone: "America/Chicago",
  dealer: { dlwContractId: "0041", dealNumber: "00712", customerId: "C-9" },
  customer: {
    firstName: "Dana", lastName: "Reyes", plateDlw: "ABC 1234",
    vehicleMake: "Ford", vehicleModel: "Bronco", vehicleYear: "2024",
    vehicleColor: "Blue", rfid: "12345+678901",
  },
  submittedAt: "2026-10-24T14:20:00.000Z",
  submittedBy: ME,
  completedAt: null,
  completedBy: null,
};

try {
  console.log("1. Parsing what somebody pastes");
  check("one per line",
    parseRecipients("a@x.com\nb@x.com").ok.join(",") === "a@x.com,b@x.com");
  check("commas and semicolons",
    parseRecipients("a@x.com, b@x.com; c@x.com").ok.length === 3);
  check("an address book entry",
    parseRecipients("Dana Reyes <dana@x.com>").ok[0] === "dana@x.com");
  check("case is flattened", parseRecipients("A@X.COM").ok[0] === "a@x.com");
  check("the same address twice is once",
    parseRecipients("a@x.com, A@x.com").ok.length === 1);
  check("blank lines are not an error", parseRecipients("a@x.com\n\n\n").rejected.length === 0);
  const bad = parseRecipients("a@x.com, notanemail, b@x.com");
  check("a bad entry is REPORTED, not dropped", bad.rejected.join(",") === "notanemail",
    bad.rejected.join(","));
  check("…while the good ones still parse", bad.ok.length === 2);
  check("nothing at all is nothing", parseRecipients("").ok.length === 0);

  console.log("\n2. Nobody is told until somebody is listed");
  check("an unset setting sends to nobody", (await recipientsFor(ME)).length === 0);
  check("…and reads as empty rather than undefined",
    (await getSignupNotify()).recipients.length === 0);

  console.log("\n3. Once it is set");
  await setSignupNotify(
    { recipients: ["ops@mojocarwash.com", "memberships@mojocarwash.com"],
      enabled: true, copySubmitter: false },
    "tester@mojocarwash.com");
  const to = await recipientsFor(ME);
  check("both are told", to.length === 2, to.join(","));
  check("…and the submitter is NOT, unless asked for", !to.includes(ME));
  check("who changed it is kept",
    (await getSignupNotify()).updatedBy === "tester@mojocarwash.com");

  console.log("\n4. Copying the submitter");
  await setSignupNotify(
    { recipients: ["ops@mojocarwash.com"], enabled: true, copySubmitter: true },
    "tester@mojocarwash.com");
  check("they are added", (await recipientsFor(ME)).includes(ME));
  // Otherwise somebody on the list who submits a signup gets two copies of
  // the same email and assumes it fired twice.
  check("…but never twice if they are already on the list",
    (await recipientsFor("ops@mojocarwash.com")).length === 1);
  check("…and a submitter with no address is skipped",
    (await recipientsFor("")).length === 1);

  console.log("\n5. Switched off means off");
  await setSignupNotify(
    { recipients: ["ops@mojocarwash.com"], enabled: false, copySubmitter: true },
    "tester@mojocarwash.com");
  check("nobody is told", (await recipientsFor(ME)).length === 0);
  check("…not even the submitter copy", !(await recipientsFor(ME)).includes(ME));
  check("…and the list is kept for when it comes back on",
    (await getSignupNotify()).recipients.length === 1);

  console.log("\n6. An empty list beats being switched on");
  await setSignupNotify(
    { recipients: [], enabled: true, copySubmitter: true },
    "tester@mojocarwash.com");
  check("still nobody", (await recipientsFor(ME)).length === 0);

  console.log("\n7. What the message says");
  const { subject, html } = signupEmail(ROW);
  check("the subject names the member", subject.includes("Dana Reyes"), subject);
  check("…and the tag, so it can be searched for later",
    subject.includes("12345+678901"));
  for (const [what, value] of [
    ["the tag", "12345+678901"], ["the contract", "0041"], ["the deal", "00712"],
    ["the customer ID", "C-9"], ["the plate", "ABC 1234"], ["the vehicle", "Bronco"],
    ["who submitted it", ME], ["the reference", ROW.guid],
  ] as const) {
    check(`the body carries ${what}`, html.includes(value));
  }
  // The stored timestamp is UTC; everybody reading reads Chicago.
  check("times are shown in the configured zone, not UTC",
    html.includes("CDT") || html.includes("CST"), "no timezone in body");
  check("a sample says so, loudly",
    signupEmail(ROW, { sample: true }).html.includes("No member was created"));
  check("…and its subject cannot be mistaken for a real one",
    signupEmail(ROW, { sample: true }).subject.startsWith("Sample"));

  console.log("\n8. A name with markup in it");
  const nasty = { ...ROW, customer: { ...ROW.customer, lastName: '<script>x</script>' } };
  check("is escaped, not injected", !signupEmail(nasty).html.includes("<script>"));
} finally {
  await db().query("DELETE FROM dm_settings WHERE key = 'signup_notify'").catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
