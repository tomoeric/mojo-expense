/**
 * The check that compares an export against what was asked for.
 *
 *   pnpm exec tsx scripts/test-settings-check.ts
 *
 * Its whole value is being believed. A section chip left in the wrong state
 * produces a valid PDF of the wrong rows that parses cleanly and reconciles
 * against its own printed total — this line on page 1 is the only thing that
 * can catch it after the fact.
 *
 * Which is exactly why it must not cry wolf. It warned on every successful
 * run, because Emburse prints the *grid* search there ("Section: Inbox") and
 * never names the export dialog's chips at all.
 */

import { checkAgainstSettings, type ExportSettings } from "../server/import/settings.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const want = {
  sections: ["Needs Review", "Pending Other's Review"],
  receiptsOnly: true,
} as ExportSettings;

const inbox = { sections: ["Inbox"], receiptFilter: "Receipts: True" };

console.log("\n1. A run that verified the chips itself");
let w = checkAgainstSettings(inbox, want, { sectionsVerified: true });
check("says nothing about sections", !w.some((s) => /section/i.test(s)), w.join(" | ") || "silent");
check("…and nothing at all, since the filter matched too", w.length === 0, w.join(" | "));

console.log("\n2. A file that arrived some other way");
w = checkAgainstSettings(inbox, want);
check("still warns that the scope cannot be confirmed",
  w.some((s) => /Section: Inbox/.test(s)), w.join(" | ") || "silent");

console.log("\n3. The receipts filter is checked either way");
w = checkAgainstSettings({ sections: ["Inbox"], receiptFilter: null }, want, { sectionsVerified: true });
check("a missing receipts filter is still reported",
  w.some((s) => /not filtered to Receipts/i.test(s)), w.join(" | ") || "silent");

console.log("\n4. A header that does name sections is still compared");
w = checkAgainstSettings(
  { sections: ["Needs Review", "Denied"], receiptFilter: "Receipts: True" }, want, { sectionsVerified: true });
check("a missing configured section is reported",
  w.some((s) => /missing configured section/i.test(s)), w.join(" | ") || "silent");
check("…and an unconfigured one is too",
  w.some((s) => /unconfigured section/i.test(s)), w.join(" | ") || "silent");

console.log("\n5. No header at all");
w = checkAgainstSettings(null, want, { sectionsVerified: true });
check("says the scope could not be read", w.length === 1, w.join(" | "));

// A stored section this Emburse does not have cannot match a chip, so it can
// only ever stop the run — and it stops EVERY run, for good, with no way to
// know from the failure that the cure is two clicks in Export settings.
// "Needs Manager Review" was exactly that: shipped in the defaults, stored in
// the database, absent from the tenant, and the 6am export dead every morning.
console.log("\n6. A stored section name this Emburse does not have");
if (process.env.DATABASE_URL) {
  const { readSettings, writeSettings, ALL_SECTIONS } =
    await import("../server/import/settings.js");
  const { db } = await import("../server/db.js");
  const before = await readSettings();
  try {
    // Straight into the row, because writeSettings correctly refuses to store
    // one — which is why only databases written before the rename carry it.
    await db().query(
      "UPDATE export_settings SET sections = $1 WHERE id",
      [["Needs Review", "Needs Manager Review"]],
    );
    const healed = await readSettings();
    check("the name that cannot exist is dropped",
      !healed.sections.includes("Needs Manager Review"), healed.sections.join(", "));
    check("…and the ones that can are kept",
      healed.sections.includes("Needs Review"), healed.sections.join(", "));

    await db().query("UPDATE export_settings SET sections = $1 WHERE id", [["Not A Section"]]);
    const empty = await readSettings();
    check("dropping every name falls back to the default rather than exporting nothing",
      empty.sections.length > 0 && empty.sections.every((s) => (ALL_SECTIONS as readonly string[]).includes(s)),
      empty.sections.join(", "));
  } finally {
    await writeSettings(before.sections, before.receiptsOnly, before.schedule,
      before.selectors, before.emburseUrl, "test-settings-check");
    await db().end();
  }
} else {
  console.log("  DATABASE_URL not set — skipping the stored-settings half.");
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
