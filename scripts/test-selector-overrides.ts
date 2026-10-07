/**
 * A selector you correct in Export settings actually reaches the run.
 *
 *   pnpm exec tsx scripts/test-selector-overrides.ts
 *
 * Export settings offers every selector the decision steps use — the ⋮ menu,
 * the reason box, the button that commits a denial — and `liveOverrides`
 * kept only keys present in DEFAULT_SELECTORS, which is the EXPORT half
 * alone. So a corrected `denyConfirm` typed into that dialog was stored,
 * silently dropped on the way back out, and the run carried on using the
 * compiled default. Twice in one week somebody was told "change it in
 * settings, no deploy needed" about a field that could not work.
 *
 * The other half: when a shipped default is corrected, a stored copy of the
 * OLD one outranks it for ever, because a stored value beats the compiled
 * one by design. SUPERSEDED_SELECTORS is how a replaced default is retired,
 * and the deny fix shipped without an entry in it.
 */
import { readSettings, writeSettings } from "../server/import/settings.js";
import { DECISION_SELECTORS } from "../server/emburse/decide.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const base = await readSettings();
const put = (selectors: Record<string, string>) =>
  writeSettings(base.sections, base.receiptsOnly, base.schedule, selectors,
    base.emburseUrl, "test@example.invalid", base.sources);

try {
  console.log("1. A corrected decision selector survives the round trip");
  const MINE = 'button:has-text("Send it back")';
  await put({ ...base.selectors, denyConfirm: MINE });
  let back = await readSettings();
  check("the dialog's value is what comes back", back.selectors.denyConfirm === MINE,
    `got ${JSON.stringify(back.selectors.denyConfirm)}`);
  // The run merges DECISION_SELECTORS under the stored ones, so surviving
  // the round trip is exactly what decides which one is clicked.
  const used = { ...DECISION_SELECTORS, ...back.selectors } as Record<string, string>;
  check("…and it is the one the run would use", used.denyConfirm === MINE);

  console.log("\n2. A stored copy of a REPLACED default is retired, not obeyed");
  // Emburse's deny dialog is "Return Transactions" with SEND BACK; the old
  // default said Deny and matched nothing. Anyone holding the old value
  // would keep it for ever without this.
  await put({ ...base.selectors, denyConfirm: 'button:has-text("Deny")' });
  back = await readSettings();
  const now = { ...DECISION_SELECTORS, ...back.selectors } as Record<string, string>;
  check("the retired value does not come back",
    back.selectors.denyConfirm !== 'button:has-text("Deny")');
  check("…so the run uses the corrected default",
    now.denyConfirm === DECISION_SELECTORS.denyConfirm, now.denyConfirm);
  check("…which is the SEND BACK one", /send back/i.test(now.denyConfirm ?? ""));

  console.log("\n3. Export selectors still behave as they did");
  await put({ ...base.selectors, loggedIn: "text=Something else" });
  back = await readSettings();
  check("an export override survives too", back.selectors.loggedIn === "text=Something else");
  await put({ ...base.selectors, loggedIn: base.selectors.loggedIn! });
  back = await readSettings();
  check("…and a value equal to the default is not stored as an override",
    back.selectors.loggedIn === base.selectors.loggedIn);
} finally {
  await put(base.selectors).catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
