/**
 * Account Registration: one record per partner, and a review nobody
 * can skip.
 *
 *   pnpm exec tsx scripts/test-registration.ts
 *
 * What would go wrong quietly, which is what the cases below are:
 *
 *   A registration approved on the strength of a check nobody did.
 *   The verification belongs to the ADDRESS that was proved, so
 *   editing the email afterwards has to take the proof with it —
 *   otherwise somebody types a new address, submits, and the record
 *   says verified.
 *
 *   One partner reading another's business licence. Every read takes
 *   an account id, and a document id from the wrong account has to
 *   answer exactly as an id that never existed.
 *
 *   A submission that fails and takes the draft with it. Everything
 *   typed has to survive a refusal, or somebody stops trying.
 *
 *   A verification link that works twice, or that a mail scanner
 *   spends on delivery. Single-use, and spent by a POST.
 */
import { DUTCH_MILLER, createAccount } from "../server/dutch-miller/accounts.js";
import {
  AGREEMENT, BLANK_BUSINESS, acceptAgreement, blockers, completeVerification,
  currentDocument, decideBusiness, decideDocument, documentBytes, forgetBusiness,
  getBusiness, requestDocument, saveBusiness, startVerification, submitBusiness,
  uploadDocument, validateBusiness,
} from "../server/dutch-miller/business.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const BY = "desk@dutchmiller.example";
const MOJO = "eric.s@mojocarwash.com";
let second = "";

const GOOD = {
  legalName: "Dutch Miller Chevrolet LLC",
  dba: "Dutch Miller",
  businessType: "LLC",
  website: "dutchmiller.example",
  address1: "14 Mill Road",
  city: "Huntington",
  state: "wv",
  postalCode: "25701",
  businessPhone: "3045550133",
  businessEmail: "Office@DutchMiller.example",
  contactName: "Dana Reyes",
  contactTitle: "General Manager",
  contactEmail: "dana@dutchmiller.example",
  contactPhone: "3045550144",
};

try {
  console.log("1. Opening the page writes nothing and invents nothing");
  const fresh = await getBusiness("acct_nobody_at_all");
  check("an account with no record gets an empty draft", fresh.status === "draft");
  check("…with blank fields, not example ones",
    JSON.stringify(fresh.fields) === JSON.stringify(BLANK_BUSINESS));
  check("…and no row was written",
    Number((await db().query<{ n: string }>(
      "SELECT count(*) AS n FROM dm_business WHERE account_id = $1",
      ["acct_nobody_at_all"])).rows[0]?.n ?? 0) === 0);

  console.log("\n2. A draft saves without being complete");
  const part = await saveBusiness(DUTCH_MILLER, { legalName: "Half Filled" }, BY);
  check("a half-filled draft saves", part.ok === true);
  check("…and is still a draft", part.ok && part.record.status === "draft");
  check("…and says what is still missing", blockers(part.ok ? part.record : fresh).length > 0);
  // Malformed is wrong either way. Catching it at the keyboard beats
  // finding out when the verification link bounces.
  const bad = await saveBusiness(DUTCH_MILLER, { ...GOOD, businessEmail: "nope" }, BY);
  check("a malformed address is refused even in a draft", bad.ok === false);
  check("…naming the field", !bad.ok && Boolean(bad.errors.businessEmail));
  const badZip = validateBusiness({ ...BLANK_BUSINESS, postalCode: "257" }, false);
  check("a short ZIP is refused", Boolean(badZip.postalCode));

  const saved = await saveBusiness(DUTCH_MILLER, GOOD, BY);
  check("a complete draft saves", saved.ok === true, saved.ok ? "" : JSON.stringify(saved.errors));
  if (!saved.ok) throw new Error("could not save the draft");
  check("…the phone is formatted once, here",
    saved.record.fields.businessPhone === "(304) 555-0133",
    saved.record.fields.businessPhone);
  check("…the email lower-cased", saved.record.fields.businessEmail
    === "office@dutchmiller.example");
  check("…and the state lifted", saved.record.fields.state === "WV");

  console.log("\n3. Submitting is refused until the checks are done");
  const early = await submitBusiness(DUTCH_MILLER, BY);
  check("refused", early.ok === false);
  check("…for the email", !early.ok
    && early.blockers.some((b) => b.includes("has not been verified")));
  check("…and the agreement", !early.ok
    && early.blockers.some((b) => b.includes(AGREEMENT.title)));
  // The draft is the whole point of the refusal being survivable.
  check("THE DRAFT IS UNTOUCHED",
    (await getBusiness(DUTCH_MILLER)).fields.legalName === GOOD.legalName);

  console.log("\n4. Verifying the business email");
  const start = await startVerification(DUTCH_MILLER, BY);
  check("a link is minted", start.ok === true, start.ok ? "" : start.problem);
  if (!start.ok) throw new Error("no token");
  check("…for the address on the form", start.email === "office@dutchmiller.example");
  // Nothing in the clear, like every other token here.
  const stored = await db().query<{ token_hash: string }>(
    "SELECT token_hash FROM dm_business_verify WHERE account_id = $1", [DUTCH_MILLER]);
  check("…and the token is stored hashed, never in the clear",
    stored.rows[0]?.token_hash !== start.token
    && (stored.rows[0]?.token_hash ?? "").length === 64);

  const wrong = await completeVerification("not-a-real-token");
  check("a made-up link is refused", wrong.ok === false);
  const done = await completeVerification(start.token);
  check("the real one works", done.ok === true, done.ok ? "" : done.problem);
  // Single use. A mail provider that scans the message, and a second
  // click, must not both count.
  const again = await completeVerification(start.token);
  check("…and works exactly once", again.ok === false,
    again.ok ? "" : again.problem.slice(0, 40));
  const verified = await getBusiness(DUTCH_MILLER);
  check("the record carries the verified address",
    verified.verifiedEmail === "office@dutchmiller.example");
  check("…and the email is no longer a blocker",
    !blockers(verified).some((b) => b.includes("has not been verified")));

  console.log("\n5. Changing the address takes the proof with it");
  /*
   * The quiet failure this prevents: type a new address, submit,
   * and the record says verified on the strength of a check that
   * was done on a different mailbox.
   */
  const moved = await saveBusiness(
    DUTCH_MILLER, { ...GOOD, businessEmail: "new@dutchmiller.example" }, BY);
  check("the new address saves", moved.ok === true);
  check("…the OLD one is still recorded as the proved one",
    moved.ok && moved.record.verifiedEmail === "office@dutchmiller.example");
  check("…and the mismatch blocks a submission",
    blockers(moved.ok ? moved.record : verified)
      .some((b) => b.includes("new@dutchmiller.example")));
  // Put it back; the proof for that address still stands.
  const back = await saveBusiness(DUTCH_MILLER, GOOD, BY);
  check("going back to the verified address clears it again",
    back.ok && !blockers(back.record).some((b) => b.includes("has not been verified")));

  console.log("\n6. The agreement, by version");
  const old = await acceptAgreement(DUTCH_MILLER, BY, "1999-01-01");
  check("accepting a version that is not the current one is refused", old.ok === false);
  const agreed = await acceptAgreement(DUTCH_MILLER, BY, AGREEMENT.version);
  check("the current one is accepted", agreed.ok === true);
  check("…recording who", agreed.ok && agreed.record.agreementAcceptedBy === BY);
  check("…and exactly which version",
    agreed.ok && agreed.record.agreementVersion === AGREEMENT.version);

  console.log("\n7. Submitting, and the review");
  const sent = await submitBusiness(DUTCH_MILLER, BY);
  check("it submits", sent.ok === true,
    sent.ok ? "" : `${sent.blockers.join(" / ")} ${JSON.stringify(sent.errors)}`);
  check("…and is with MOJO", sent.ok && sent.record.status === "submitted");
  const noNote = await decideBusiness({
    accountId: DUTCH_MILLER, approve: false, note: "", by: MOJO,
  });
  check("sending it back with no reason is refused", noNote.ok === false);
  const backToThem = await decideBusiness({
    accountId: DUTCH_MILLER, approve: false,
    note: "The ZIP does not match the address on the licence.", by: MOJO,
  });
  check("sending it back works", backToThem.ok === true);
  check("…the state says so",
    backToThem.ok && backToThem.record.status === "changes-requested");
  check("…and the reason is on the record, where the partner reads it",
    backToThem.ok && backToThem.record.decisionNote.includes("ZIP"));
  // Still editable, and the reason stays on screen while it is fixed.
  const fixed = await saveBusiness(DUTCH_MILLER, { ...GOOD, postalCode: "25702" }, BY);
  check("a returned registration is still editable", fixed.ok === true);
  check("…and stays returned until it is sent again",
    fixed.ok && fixed.record.status === "changes-requested");
  const noDecision = await decideBusiness({
    accountId: DUTCH_MILLER, approve: true, note: "", by: MOJO,
  });
  check("there is nothing to decide until it is resubmitted", noDecision.ok === false);

  const resent = await submitBusiness(DUTCH_MILLER, BY);
  check("it resubmits", resent.ok === true);
  const ok = await decideBusiness({
    accountId: DUTCH_MILLER, approve: true, note: "", by: MOJO,
  });
  check("and is approved", ok.ok === true && ok.record.status === "approved");

  console.log("\n8. Proof of business, only when it is asked for");
  const unasked = await uploadDocument({
    accountId: DUTCH_MILLER, filename: "licence.pdf",
    contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4 test"), by: BY,
  });
  check("an upload nobody asked for is refused", unasked.ok === false,
    unasked.ok ? "" : unasked.problem);
  await requestDocument(DUTCH_MILLER, true, "Send the state registration.", MOJO);
  check("once asked, it is a blocker",
    blockers(await getBusiness(DUTCH_MILLER)).some((b) => b.includes("Proof of business")));
  const big = await uploadDocument({
    accountId: DUTCH_MILLER, filename: "huge.pdf", contentType: "application/pdf",
    bytes: Buffer.alloc(9 * 1024 * 1024), by: BY,
  });
  check("an oversized file is refused", big.ok === false);
  const wrongType = await uploadDocument({
    accountId: DUTCH_MILLER, filename: "notes.exe",
    contentType: "application/x-msdownload", bytes: Buffer.from("x"), by: BY,
  });
  check("a file type we do not accept is refused", wrongType.ok === false);
  const up = await uploadDocument({
    accountId: DUTCH_MILLER, filename: "licence.pdf", contentType: "application/pdf",
    bytes: Buffer.from("%PDF-1.4 licence"), by: BY,
  });
  check("a PDF is accepted", up.ok === true, up.ok ? "" : up.problem);
  const doc = await currentDocument(DUTCH_MILLER);
  check("…and is the current document", doc?.filename === "licence.pdf");
  // One live document. "Which of these four is the current licence"
  // is a question nobody should have to answer.
  await uploadDocument({
    accountId: DUTCH_MILLER, filename: "licence-v2.pdf", contentType: "application/pdf",
    bytes: Buffer.from("%PDF-1.4 newer"), by: BY,
  });
  const doc2 = await currentDocument(DUTCH_MILLER);
  check("a replacement supersedes rather than piling up",
    doc2?.filename === "licence-v2.pdf");
  await decideDocument(DUTCH_MILLER, "approved", "", MOJO);
  check("an approved document is no longer a blocker",
    !blockers(await getBusiness(DUTCH_MILLER)).some((b) => b.includes("Proof of business")));

  console.log("\n9. One partner cannot read another's");
  const made = await createAccount({ name: "Registration Motors" }, MOJO);
  if (!made.ok) throw new Error(made.problem);
  second = made.account.id;
  const theirs = await getBusiness(second);
  check("a new account starts with an empty draft", theirs.fields.legalName === "");
  check("…and none of the other partner's details",
    theirs.verifiedEmail === "" && theirs.agreementVersion === "");
  // The one that matters most here: the file is somebody's licence.
  check("THE DOCUMENT IS NOT READABLE FROM ANOTHER ACCOUNT",
    (await documentBytes(second, doc2!.id)) === null);
  check("…and reads exactly like an id that never existed",
    (await documentBytes(second, "999999")) === null);
  check("the real owner can still read it",
    (await documentBytes(DUTCH_MILLER, doc2!.id))?.filename === "licence-v2.pdf");
  check("one partner's registration is not the other's",
    (await currentDocument(second)) === null);

  console.log("\n10. Approval is a judgement, not a grant");
  // Nothing here touches pages, roles or account scope. Said as a
  // test because "approved" is exactly the word somebody would read
  // as "and now they can do more".
  const after = await getBusiness(DUTCH_MILLER);
  check("the record carries a status and nothing else",
    after.status === "approved"
    && !Object.keys(after).some((k) => k.toLowerCase().includes("grant")
      || k.toLowerCase().includes("role")));

} finally {
  await forgetBusiness(DUTCH_MILLER).catch(() => undefined);
  if (second) {
    await forgetBusiness(second).catch(() => undefined);
    await db().query("DELETE FROM dm_accounts WHERE id = $1", [second])
      .catch(() => undefined);
  }
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
