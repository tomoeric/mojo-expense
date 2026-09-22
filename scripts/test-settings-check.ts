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
  sections: ["Needs Review", "Needs Manager Review"],
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

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
