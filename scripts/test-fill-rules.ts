/**
 * Vendor rules: what an expense from this merchant should say.
 *
 *   pnpm exec tsx scripts/test-fill-rules.ts
 *
 * The owner's ask: mark a vendor as a category, and have that
 * applied when a receipt is matched. What matters, in order:
 *
 *   A RULE PROPOSES AND NEVER SENDS. Its fields arrive in the
 *   same list as the receipt and wait for the same press. A rule
 *   that could queue a write to Emburse would be the standing
 *   "always ask" instruction defeated by a configuration screen.
 *
 *   IT MATCHES THE VENDOR AND NOTHING NEAR IT. A loose match
 *   here is not a card somebody rejects, it is a category
 *   silently written onto the wrong expense.
 *
 *   MOST SPECIFIC WINS, by a stated rule rather than by whatever
 *   the database returned first.
 *
 *   A FIELD THAT IS ALREADY RIGHT IS NOT PROPOSED, because a
 *   list of no-ops is how somebody stops reading the list.
 *
 *   AND THE SUGGESTIONS COME FROM REAL HISTORY, with counts.
 */
import { db, ensureSchema } from "../server/db.js";
import {
  deleteRule, ensureFillRules, pick, rulesFor, saveRule, setsOf, suggestions,
  vendorMatches, type FillRule,
} from "../server/emburse/fill-rules.js";
import { proposeWrites, writesFor } from "../server/emburse/receipt-writeback.js";
import { recordCandidates, decideMatch } from "../server/emburse/receipt-mail.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const ERIC = "eric.s@mojocarwash.com";
const LANE = "personal-mojo";
const OTHER = "personal-mammoth";

const rule = (over: Partial<FillRule> = {}): FillRule => ({
  id: 1, owner: ERIC, lane: "", vendor: "REPLIT", category: "Software",
  purpose: "", location: "", department: "", comment: "", enabled: true,
  updatedAt: "", updatedBy: "", ...over,
});

const expense = (key: string, over: {
  merchant?: string; category?: string; location?: string; department?: string;
  lane?: string;
} = {}) => db().query(
  `INSERT INTO expenses (dedupe_key, employee, expense_date, merchant, amount_cents,
                         category, department, location, note, method, in_inbox,
                         reviewer, source, lane)
   VALUES ($1,'Eric S','2026-10-24',$2,10660,$3,$4,$5,'Card spend','Card',true,$6,'',$7)
   ON CONFLICT (dedupe_key) DO UPDATE
     SET merchant = excluded.merchant, category = excluded.category,
         department = excluded.department, location = excluded.location`,
  [key, over.merchant ?? "REPLIT", over.category ?? "", over.department ?? "",
    over.location ?? "", ERIC, over.lane ?? LANE]);

const clean = async () => {
  await db().query("DELETE FROM expense_fill_rules WHERE lower(owner) = lower($1)", [ERIC]);
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'zz-fr-%'");
};

await ensureSchema();
await ensureFillRules();

try {
  await clean();

  console.log("1. A vendor name covers how a statement actually spells it");
  check("exactly", vendorMatches("REPLIT", "REPLIT"));
  check("case and punctuation blind", vendorMatches("replit", "REPLIT.COM"));
  check("…and a store number on the end", vendorMatches("Starbucks", "STARBUCKS #4417"));
  check("A DIFFERENT VENDOR DOES NOT MATCH", !vendorMatches("REPLIT", "GITHUB"));
  check("…and neither does a word they happen to share",
    !vendorMatches("Amazon Web Services", "GITHUB"));
  check("nothing matches nothing", !vendorMatches("", "REPLIT"));

  console.log("\n2. Most specific wins, by a stated rule");
  const all = rule({ id: 1, lane: "", vendor: "REPLIT", category: "Software" });
  const mine = rule({ id: 2, lane: LANE, vendor: "REPLIT", category: "Tools" });
  const longer = rule({ id: 3, lane: "", vendor: "REPLIT PRO", category: "Pro" });
  check("a rule naming this tab beats one covering every tab",
    pick([all, mine], "REPLIT", LANE)?.category === "Tools",
    pick([all, mine], "REPLIT", LANE)?.category);
  check("…and the other tab still gets the general one",
    pick([all, mine], "REPLIT", OTHER)?.category === "Software");
  check("the longer vendor string wins between equals",
    pick([all, longer], "REPLIT PRO", LANE)?.category === "Pro");
  check("a disabled rule is not picked",
    pick([rule({ enabled: false })], "REPLIT", LANE) === null);
  check("and no rule is no rule", pick([all], "ADOBE", LANE) === null);

  console.log("\n3. Only the fields a rule actually sets");
  check("an empty field says nothing about that box",
    JSON.stringify(setsOf(rule({ category: "Software", purpose: "  " })))
      === JSON.stringify({ category: "Software" }),
    JSON.stringify(setsOf(rule({ category: "Software", purpose: "  " }))));

  console.log("\n4. Saving, editing and deleting one");
  const saved = await saveRule({
    owner: ERIC, vendor: "REPLIT", category: "Technology/Software, Licenses",
    purpose: "AI Development and Use", location: "Corporate-Pure Magic",
    department: "IT & Compliance", by: ERIC,
  });
  check("it comes back with an id", saved.id > 0);
  const again = await saveRule({
    owner: ERIC, vendor: "replit", category: "Changed", by: ERIC,
  });
  check("THE SAME VENDOR TWICE IS AN EDIT, not a second rule",
    (await rulesFor(ERIC)).length === 1, String((await rulesFor(ERIC)).length));
  check("…and the edit took", again.category === "Changed", again.category);
  check("somebody else's rule cannot be deleted",
    (await deleteRule("brian.c@mojocarwash.com", saved.id)) === false);

  console.log("\n4b. EDITING ONE, field by field, Comment included");
  /*
   * Five boxes on Emburse's edit form, and a rule has to be able
   * to set every one of them and then be changed. Comment was the
   * fifth and was missing — it is a free-text box at the foot of
   * the form with no column in the export, so nothing here knew
   * about it until the owner pointed at it.
   */
  const five = await saveRule({
    owner: ERIC, vendor: "FIVEFIELD", category: "C1", purpose: "P1",
    location: "L1", department: "D1", comment: "M1", by: ERIC,
  });
  check("all five are stored",
    [five.category, five.purpose, five.location, five.department, five.comment]
      .join("|") === "C1|P1|L1|D1|M1",
    [five.category, five.purpose, five.location, five.department, five.comment].join("|"));
  const edited = await saveRule({
    id: five.id, owner: ERIC, vendor: "FIVEFIELD", category: "C2", purpose: "P2",
    location: "L2", department: "D2", comment: "M2", by: ERIC,
  });
  check("EDITING CHANGES EVERY ONE, and keeps the same rule",
    edited.id === five.id
    && [edited.category, edited.purpose, edited.location, edited.department, edited.comment]
      .join("|") === "C2|P2|L2|D2|M2",
    `${edited.id} vs ${five.id}: `
    + [edited.category, edited.purpose, edited.location, edited.department, edited.comment]
      .join("|"));
  const cleared = await saveRule({
    id: five.id, owner: ERIC, vendor: "FIVEFIELD", category: "C2", by: ERIC,
  });
  check("…and emptying a field means the rule stops touching that box",
    cleared.comment === "" && cleared.purpose === "",
    JSON.stringify(setsOf(cleared)));
  check("…which setsOf reports as the fields it still sets",
    JSON.stringify(setsOf(cleared)) === JSON.stringify({ category: "C2" }),
    JSON.stringify(setsOf(cleared)));
  await deleteRule(ERIC, five.id);

  console.log("\n5. A MATCHED RECEIPT CARRIES THE RULE'S FIELDS — and sends nothing");
  await saveRule({
    owner: ERIC, vendor: "REPLIT",
    category: "Technology/Software, Licenses, and Subscriptions",
    purpose: "AI Development and Use", location: "Corporate-Pure Magic",
    department: "IT & Compliance", comment: "Monthly AI subscription", by: ERIC,
  });
  // An expense that already has the department right: the rule
  // must not propose a change to something already correct.
  await expense("zz-fr-1", { merchant: "REPLIT", department: "IT & Compliance" });
  await recordCandidates([{
    dedupeKey: "zz-fr-1", lane: LANE, messageId: "fr-msg-1",
    confidence: "strong", score: 80, reasons: ["Same date."],
    evidence: {
      messageId: "fr-msg-1", subject: "Your Replit receipt",
      from: "invoice@mail.replit.com", receivedAt: "2026-10-24T12:00:00Z",
      folder: "Receipts", merchant: "Replit", date: "2026-10-24", totalCents: 10660,
      currency: "USD", reference: "", hasAttachment: false, attachments: [],
      excerpt: "Amount due $106.60",
    },
  }]);
  await decideMatch({ dedupeKey: "zz-fr-1", messageId: "fr-msg-1", choose: true, by: ERIC });
  await proposeWrites({ dedupeKey: "zz-fr-1", messageId: "fr-msg-1", by: ERIC });

  const writes = await writesFor("zz-fr-1");
  const kinds = writes.map((w) => w.kind).sort();
  check("the category is proposed", kinds.includes("category"), kinds.join(", "));
  check("…and the business purpose", kinds.includes("purpose"));
  check("…and the location", kinds.includes("location"));
  check("…and the comment", kinds.includes("comment"), kinds.join(", "));
  check("A FIELD ALREADY RIGHT IS NOT PROPOSED", !kinds.includes("department"),
    kinds.join(", "));
  check("the receipt is still in there too", kinds.includes("receipt"));
  check("NOTHING IS QUEUED OR APPLIED BY A RULE",
    writes.every((w) => w.state === "proposed"),
    writes.map((w) => `${w.kind}:${w.state}`).join(", "));
  const cat = writes.find((w) => w.kind === "category");
  check("…and it proposes what the rule says",
    cat?.proposed === "Technology/Software, Licenses, and Subscriptions", cat?.proposed);

  console.log("\n6. A vendor with no rule is untouched");
  await expense("zz-fr-2", { merchant: "ADOBE" });
  await recordCandidates([{
    dedupeKey: "zz-fr-2", lane: LANE, messageId: "fr-msg-2",
    confidence: "strong", score: 80, reasons: ["Same date."],
    evidence: {
      messageId: "fr-msg-2", subject: "Your Adobe receipt", from: "mail@adobe.com",
      receivedAt: "2026-10-24T12:00:00Z", folder: "Receipts", merchant: "Adobe",
      date: "2026-10-24", totalCents: 10660, currency: "USD", reference: "",
      hasAttachment: false, attachments: [], excerpt: "Total $106.60",
    },
  }]);
  await decideMatch({ dedupeKey: "zz-fr-2", messageId: "fr-msg-2", choose: true, by: ERIC });
  await proposeWrites({ dedupeKey: "zz-fr-2", messageId: "fr-msg-2", by: ERIC });
  const adobe = (await writesFor("zz-fr-2")).map((w) => w.kind);
  check("no field writes at all", !adobe.some(
    (k) => ["category", "purpose", "location", "department"].includes(k)),
  adobe.join(", "));

  console.log("\n7. The suggestions come from this person's own history");
  await db().query("DELETE FROM expense_fill_rules WHERE lower(owner) = lower($1)", [ERIC]);
  for (const n of [3, 4, 5]) {
    await expense(`zz-fr-${n}`, {
      merchant: "GITHUB", category: "Software", department: "IT & Compliance",
    });
  }
  await expense("zz-fr-6", { merchant: "GITHUB", category: "Other", department: "IT & Compliance" });
  const found = (await suggestions(ERIC, null)).find((s) => s.vendor === "GITHUB");
  check("the vendor is suggested", Boolean(found), JSON.stringify(found ?? {}));
  check("…with the commonest category, not the last one",
    found?.category.value === "Software", found?.category.value);
  check("…and the count that makes it checkable",
    found?.category.of === 3 && found?.seen === 4,
    `${found?.category.of} of ${found?.seen}`);
  await saveRule({ owner: ERIC, vendor: "GITHUB", category: "Software", by: ERIC });
  check("A VENDOR THAT ALREADY HAS A RULE IS NOT SUGGESTED AGAIN",
    !(await suggestions(ERIC, null)).some((s) => s.vendor === "GITHUB"));
} finally {
  await clean().catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
}
