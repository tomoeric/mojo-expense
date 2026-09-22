/**
 * Find a Chromium the host already provides.
 *
 * Playwright downloads its own build, which is the right default nearly
 * everywhere and the wrong one on a Nix host: the binary arrives fine and then
 * refuses to start, because the shared libraries it was linked against are not
 * there. A browser the host installed does not have that problem — it was built
 * for this machine.
 *
 * Plain .mjs with no dependencies on purpose. This runs from `postinstall`,
 * where the only thing guaranteed to exist is Node.
 */

import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/** Names a distribution might install, most preferred first. */
const NAMES = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];

/**
 * Nix store paths carry a content hash, so they cannot be written down — the
 * path changes whenever the package does. Looking for the newest matching
 * directory is the only stable way to name one.
 */
function fromNixStore() {
  const store = "/nix/store";
  if (!existsSync(store)) return null;

  let best = null;
  let bestTime = 0;
  for (const entry of readdirSync(store)) {
    if (!/-chromium-/.test(entry)) continue;
    for (const name of ["chromium", "chrome"]) {
      const candidate = path.join(store, entry, "bin", name);
      if (!existsSync(candidate)) continue;
      // Later store paths sort after earlier ones for the same package, and
      // the hash prefix makes lexical order meaningless — so prefer the one
      // whose version string is highest, falling back to insertion order.
      const version = Number((/-chromium-(\d+)/.exec(entry) ?? [])[1] ?? 0);
      if (version >= bestTime) {
        bestTime = version;
        best = candidate;
      }
    }
  }
  return best;
}

function fromPath() {
  for (const name of NAMES) {
    try {
      const found = execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (found && existsSync(found)) return found;
    } catch {
      /* `which` exits non-zero when the name is not on PATH. */
    }
  }
  return null;
}

/** A host-provided Chromium, or null to mean "use Playwright's own". */
export function findSystemChromium() {
  // An explicit setting always wins: it is how somebody overrides a bad guess.
  const configured = (process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "").trim();
  if (configured) return existsSync(configured) ? configured : null;

  return fromPath() ?? fromNixStore();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = findSystemChromium();
  console.log(found ?? "");
}
