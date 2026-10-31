/**
 * The browser step timeout is a setting, not a redeploy.
 *
 *   pnpm exec tsx scripts/test-step-timeout.ts
 *
 * Every wait in the automation is bounded by one number —
 * finding the row, opening the edit form, typing into a box,
 * pressing Save. It was `EMBURSE_STEP_TIMEOUT_MS` and nothing
 * else, so giving a slow tenant longer meant a secret and a
 * redeploy. The selectors and the Emburse URL are stored for
 * exactly that reason; this is the same argument.
 *
 * What must stay true:
 *
 *   THE ENV VAR IS STILL THE DEFAULT, so a deployment that never
 *   touches this behaves as it did.
 *
 *   A NONSENSE VALUE FALLS BACK rather than being clamped to a
 *   number nobody chose. Five seconds would fail every run and
 *   ten minutes is a browser nobody is watching holding a lock.
 *
 *   AND READING THE SETTINGS APPLIES IT. Every path that opens a
 *   browser reads them first, so that is the one place none of
 *   them can forget.
 */
import { db, ensureSchema } from "../server/db.js";
import { readSettings, writeSettings, MIN_STEP_TIMEOUT_MS, MAX_STEP_TIMEOUT_MS }
  from "../server/import/settings.js";
import { stepTimeoutMs, setStepTimeoutMs } from "../server/emburse/decide.js";
import { env } from "../server/env.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

await ensureSchema();
const before = await readSettings();

const save = (ms: number | undefined) => writeSettings(
  before.sections, before.receiptsOnly, before.schedule, before.selectors,
  before.emburseUrl, "test", before.sources, ms);

try {
  console.log("1. The env var is the default");
  await db().query("UPDATE export_settings SET step_timeout_ms = NULL WHERE id");
  const plain = await readSettings();
  check("with nothing stored, the setting IS the env var",
    plain.stepTimeoutMs === env.emburseLogin.stepTimeoutMs,
    `${plain.stepTimeoutMs} vs ${env.emburseLogin.stepTimeoutMs}`);
  check("…and that is what a step would wait",
    stepTimeoutMs() === env.emburseLogin.stepTimeoutMs, String(stepTimeoutMs()));

  console.log("\n2. A stored value overrides it");
  const saved = await save(90_000);
  check("it comes back on the settings", saved.stepTimeoutMs === 90_000,
    String(saved.stepTimeoutMs));
  check("READING THE SETTINGS APPLIES IT — no caller has to remember",
    stepTimeoutMs() === 90_000, String(stepTimeoutMs()));
  await readSettings();
  check("…and it survives a re-read", stepTimeoutMs() === 90_000, String(stepTimeoutMs()));

  console.log("\n3. Nonsense falls back rather than being clamped quietly");
  for (const [name, ms] of [
    ["one second", 1_000], ["an hour", 3_600_000], ["zero", 0], ["negative", -5],
  ] as const) {
    const out = await save(ms);
    check(`${name} is refused, and the default stands`,
      out.stepTimeoutMs === env.emburseLogin.stepTimeoutMs,
      String(out.stepTimeoutMs));
  }
  check("the bounds are the ones the page offers",
    MIN_STEP_TIMEOUT_MS === 5_000 && MAX_STEP_TIMEOUT_MS === 600_000,
    `${MIN_STEP_TIMEOUT_MS}–${MAX_STEP_TIMEOUT_MS}`);

  console.log("\n4. Both ends of the allowed range are accepted");
  check("five seconds", (await save(MIN_STEP_TIMEOUT_MS)).stepTimeoutMs === 5_000);
  check("ten minutes", (await save(MAX_STEP_TIMEOUT_MS)).stepTimeoutMs === 600_000);

  console.log("\n5. The override can be cleared");
  setStepTimeoutMs(null);
  check("back to the env default", stepTimeoutMs() === env.emburseLogin.stepTimeoutMs,
    String(stepTimeoutMs()));
} finally {
  await db().query("UPDATE export_settings SET step_timeout_ms = NULL WHERE id")
    .catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
}
