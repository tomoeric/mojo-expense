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
import { approvedEmail, signupEmail } from "../server/dutch-miller/notify.js";
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
    firstName: "Dana", lastName: "Reyes", plateDlw: "ABC 1234", plateState: "WV",
    vehicleMake: "Ford", vehicleModel: "Bronco", vehicleYear: "2024",
    vehicleColor: "Blue", rfid: "12345+678901",
  },
  submittedAt: "2026-10-24T14:20:00.000Z",
  submittedBy: ME,
  notifiedAt: null,
  openedAt: null,
  openedBy: null,
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

  console.log("\n2. Nobody is told until there is a reviewer");
  check("an unset setting sends to nobody", (await recipientsFor(ME)).length === 0);
  check("…and reads as having no reviewer", (await getSignupNotify()).reviewer === "");

  console.log("\n3. The reviewer is one person");
  await setSignupNotify({
    reviewer: "csc@mojocarwash.com",
    notifiers: ["ops@mojocarwash.com", "memberships@mojocarwash.com"],
    enabled: true, copySubmitter: false,
  }, "tester@mojocarwash.com");
  const to = await recipientsFor(ME);
  check("everybody is told", to.length === 3, JSON.stringify(to));
  check("…exactly one of them as the reviewer",
    to.filter((r) => r.as === "reviewer").length === 1);
  check("…and the reviewer is first, since the message is theirs",
    to[0]?.as === "reviewer" && to[0]?.email === "csc@mojocarwash.com");
  check("the rest are notifiers", to.slice(1).every((r) => r.as === "notifier"));
  // One address in two roles would get two messages disagreeing about
  // whose job it is.
  await setSignupNotify({
    reviewer: "csc@mojocarwash.com",
    notifiers: ["csc@mojocarwash.com", "ops@mojocarwash.com"],
    enabled: true, copySubmitter: false,
  }, "tester@mojocarwash.com");
  const once = await recipientsFor(ME);
  check("somebody cannot be both", once.length === 2, JSON.stringify(once));

  console.log("\n4. Notifications need a reviewer to be on at all");
  let refused = "";
  try {
    await setSignupNotify({
      reviewer: "", notifiers: ["ops@mojocarwash.com"], enabled: true, copySubmitter: false,
    }, "tester@mojocarwash.com");
  } catch (e) { refused = (e as Error).message; }
  check("switching on without one is refused", /CSC Reviewer/.test(refused), refused);
  check("…because a crowd told it is not their job is nobody told",
    (await getSignupNotify()).reviewer === "csc@mojocarwash.com");
  let badOne = "";
  try {
    await setSignupNotify({
      reviewer: "not an address", notifiers: [], enabled: true, copySubmitter: false,
    }, "t");
  } catch (e) { badOne = (e as Error).message; }
  check("a reviewer that is not an address is refused", badOne !== "");

  console.log("\n5. Copying the submitter");
  await setSignupNotify({
    reviewer: "csc@mojocarwash.com", notifiers: ["ops@mojocarwash.com"],
    enabled: true, copySubmitter: true,
  }, "tester@mojocarwash.com");
  const withMe = await recipientsFor(ME);
  check("they are added", withMe.some((r) => r.email === ME && r.as === "submitter"));
  check("…but never twice if already listed",
    (await recipientsFor("ops@mojocarwash.com")).filter(
      (r) => r.email === "ops@mojocarwash.com").length === 1);

  console.log("\n6. Switched off means off");
  await setSignupNotify({
    reviewer: "csc@mojocarwash.com", notifiers: ["ops@mojocarwash.com"],
    enabled: false, copySubmitter: true,
  }, "tester@mojocarwash.com");
  check("nobody is told", (await recipientsFor(ME)).length === 0);
  check("…and both lists are kept for when it comes back on",
    (await getSignupNotify()).reviewer === "csc@mojocarwash.com"
      && (await getSignupNotify()).notifiers.length === 1);

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
  // The whole point of the button: somebody reads the email and marks
  // the signup complete without first going to find it.
  const linked = signupEmail(ROW, { origin: "https://example.invalid", as: "reviewer" });
  check("the reviewer gets a link to the record",
    linked.html.includes(`https://example.invalid/#/member-signups/review?open=${ROW.guid}`),
    "no link");
  check("…and their subject says it is theirs", linked.subject.startsWith("To review"),
    linked.subject);
  // A half-built URL in an email is worse than no button at all.
  check("no origin means no button rather than a broken one",
    !/href/.test(signupEmail(ROW, { origin: "", as: "reviewer" }).html));

  // A working button on a message that is only for information invites
  // four people to open a record one of them owns, and "opened" stops
  // meaning anything.
  const fyi = signupEmail(ROW, { origin: "https://example.invalid", as: "notifier" });
  check("a notifier gets NO link", !fyi.html.includes("/member-signups/review?open="),
    "link present");
  check("…but the same details", fyi.html.includes(ROW.customer.rfid)
    && fyi.html.includes(ROW.dealer.dlwContractId));
  check("…with the button greyed out rather than missing",
    fyi.html.includes("Open in MOJO") && !/<a[^>]*Open in MOJO/.test(fyi.html));
  check("…and told the review is not theirs",
    /review is not yours/i.test(fyi.html), "no explanation");
  check("…and told where to look instead", /Sign in to the portal/i.test(fyi.html));
  check("their subject marks it as information", fyi.subject.startsWith("FYI"),
    fyi.subject);
  const mine = signupEmail(ROW, { origin: "https://example.invalid", as: "submitter" });
  check("the submitter is told why they have it",
    /because you submitted it/i.test(mine.html));

  check("a sample says so, loudly",
    signupEmail(ROW, { sample: true }).html.includes("No member was created"));
  check("…and its subject cannot be mistaken for a real one",
    signupEmail(ROW, { sample: true }).subject.startsWith("Sample"));

  console.log("\n7b. The approval, to whoever submitted it");
  const done = { ...ROW, completedAt: "2026-10-25T15:00:00.000Z",
    completedBy: "csc@mojocarwash.com", openedAt: "2026-10-24T22:00:00.000Z" };
  const appr = approvedEmail(done, { origin: "https://example.invalid" });
  // The dealer has been waiting on one fact since they pressed submit.
  // It leads with that, in those words, not with a status name.
  check("it says the member can wash", /can now wash their vehicle/i.test(appr.html));
  check("…in the subject too", /can wash/i.test(appr.subject), appr.subject);
  check("…and names them", appr.subject.includes("Dana Reyes"));
  check("the tag is on it, since that is what they hand over",
    appr.html.includes(ROW.customer.rfid));
  check("their own references are on it", appr.html.includes("0041")
    && appr.html.includes("00712"));
  check("the vehicle and plate are on it",
    appr.html.includes("2024 Ford Bronco") && appr.html.includes("ABC 1234"));
  check("when it was approved", /Approved/.test(appr.html));
  // Submitting again would take a second tag off a member who has one.
  check("…and they are told not to submit again",
    /rather than submitting them again/i.test(appr.html));

  console.log("\n8. A name with markup in it");
  const nasty = { ...ROW, customer: { ...ROW.customer, lastName: '<script>x</script>' } };
  check("is escaped, not injected", !signupEmail(nasty).html.includes("<script>"));
} finally {
  await db().query("DELETE FROM dm_settings WHERE key = 'signup_notify'").catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
