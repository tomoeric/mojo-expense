/**
 * The denial note has to actually be in the box.
 *
 *   pnpm exec tsx scripts/test-deny-note.ts
 *
 * "How do I verify the deny note is pushed to Emburse and accepted?"
 * The run checked that a reason box EXISTS, and afterwards that the row
 * left Needs Review. Neither says the TEXT landed — and a fill that went
 * nowhere looks exactly like one that worked: read-only fields,
 * rich-text components that ignore a plain fill, boxes that clear on
 * blur, a selector that matched a different field. In all of them the
 * denial goes through, the explanation does not, and the employee is
 * told only that their expense was refused.
 *
 * No browser: the rule is "ask the box what it now says", and a stub
 * answers that better than a mock Emburse does. The browser-driven suite
 * cannot complete repeated sign-ins in this container, and this check is
 * too important to be the one that depends on it.
 */

export {};

const { putReasonIn } = await import("../server/emburse/decide.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

/** A box that behaves however the tenant's does. */
const boxThat = (how: "keeps" | "ignores" | "clears" | "truncates" | "throws") => {
  let held = "";
  return {
    async fill(v: string) {
      if (how === "keeps") held = v;
      if (how === "truncates") held = v.slice(0, 8);
      if (how === "clears" || how === "ignores") held = "";
    },
    async inputValue() {
      if (how === "throws") throw new Error("detached");
      return held;
    },
    get held() { return held; },
  };
};

const tried = async (box: Parameters<typeof putReasonIn>[0], reason: string) => {
  try { await putReasonIn(box, reason); return null; } catch (e) { return (e as Error).message; }
};

const REASON = "Receipt amount doesn't match";

console.log("\n1. A box that keeps what it is given");
{
  const box = boxThat("keeps");
  check("it goes through", (await tried(box, REASON)) === null);
  check("…with the reason in the box", box.held === REASON, box.held);
}

console.log("\n2. Every way a box can swallow it");
for (const how of ["ignores", "clears"] as const) {
  const why = await tried(boxThat(how), REASON);
  check(`a box that ${how} what is typed refuses`, why !== null);
  check("…saying the reason did not go in", /did not go into the box/.test(why ?? ""), why ?? "");
  check("…and that nothing was confirmed", /Nothing was confirmed/.test(why ?? ""), why ?? "");
  check("…naming what it reads instead", /\(empty\)/.test(why ?? ""), why ?? "");
}

console.log("\n3. A box that takes only part of it");
// Worse than taking none: a half-sentence reads as a complete thought.
// "Receipt " is not an explanation, and the employee cannot tell.
{
  const why = await tried(boxThat("truncates"), REASON);
  check("a truncated reason refuses too", why !== null);
  check("…and quotes both, so the truncation is visible",
    (why ?? "").includes(REASON) && (why ?? "").includes("Receipt "), why ?? "");
}

console.log("\n4. A box that cannot be read is not a box that took it");
{
  const why = await tried(boxThat("throws"), REASON);
  check("an unreadable box refuses rather than assuming", why !== null, why ?? "");
}

console.log("\n5. An approval carries no reason, and must not be blocked by this");
{
  // runDecision passes "" for an approve. An empty reason has nothing to
  // verify, and demanding it come back would stop every approval.
  check("an empty reason is fine", (await tried(boxThat("ignores"), "")) === null);
  check("…and so is whitespace", (await tried(boxThat("clears"), "   ")) === null);
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
