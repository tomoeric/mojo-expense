/**
 * Make sure some Chromium is available, downloading one only if it has to.
 *
 * Runs from `postinstall`. The download is ~80 MB and happens on every deploy
 * that rebuilds node_modules, so skipping it when the host already has a
 * browser is worth the few lines — and on a Nix host the host's own browser is
 * not merely cheaper, it is the one that actually starts.
 *
 * Never fails the install. A missing browser is something the app reports
 * clearly when a run is attempted; it is not a reason to break `pnpm install`
 * on a laptop that will never run an export.
 */

import { execFileSync } from "node:child_process";
import { findSystemChromium } from "./find-chromium.mjs";

const found = findSystemChromium();

if (found) {
  console.log(`[browser] using the host's Chromium at ${found} — skipping the download`);
} else {
  console.log("[browser] no host Chromium found; downloading Playwright's headless shell");
  try {
    execFileSync("playwright", ["install", "--only-shell", "chromium"], { stdio: "inherit" });
  } catch {
    console.log(
      "[browser] download failed. The app will say so if an export is attempted; " +
        "install a browser and set PLAYWRIGHT_CHROMIUM_PATH, or run " +
        "`pnpm exec playwright install --only-shell chromium`.",
    );
  }
}
