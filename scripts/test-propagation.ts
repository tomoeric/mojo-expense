/**
 * A correction reaches a page somebody has customised.
 *
 *   pnpm exec tsx scripts/test-propagation.ts
 *
 * The rule the brief states and the code used to break: saving a
 * complete page is not a reason for later shared corrections to stop
 * reaching it. An account's arrangement is still its own — nothing
 * here overwrites one — but the account must be TOLD, and taking the
 * correction must be one click rather than a rebuild.
 *
 * So the cases are the ways that could go wrong:
 *
 *   An account following the base is never "behind": it has every
 *   correction by reading them. Telling it otherwise would train
 *   everybody to dismiss the notice.
 *
 *   An account with its own layout IS told, and the notice says what
 *   changed rather than that something did.
 *
 *   Taking one bucket of a correction keeps the rest of the page.
 *
 *   Keeping ours clears the notice — and the NEXT correction raises
 *   it again, because a permanent opt-out is the silence this
 *   whole mechanism exists to end.
 */
import {
  acknowledgeDrift, adoptFromBase, baseLayout, baseRev, forgetLayouts, layoutDrift,
  layoutFor, resetLayout, saveBaseLayout, saveLayout,
} from "../server/dutch-miller/blocks.js";
import { createAccount } from "../server/dutch-miller/accounts.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const PAGE = "member-signups-review" as const;
const BY = "eric.s@mojocarwash.com";
const MADE: string[] = [];
let BASE_WAS: { blockId: string; position: number; width: number; height: string }[] = [];

try {
  BASE_WAS = (await baseLayout(PAGE)).map((b) => ({
    blockId: b.id, position: b.position, width: b.width, height: b.height,
  }));

  const follower = await createAccount({ name: "Drift Follower Motors" }, BY);
  const custom = await createAccount({ name: "Drift Custom Motors" }, BY);
  if (!follower.ok || !custom.ok) throw new Error("could not make the scratch accounts");
  MADE.push(follower.account.id, custom.account.id);
  const F = follower.account.id;
  const C = custom.account.id;

  console.log("1. An account that follows the base is never behind");
  const startRev = await baseRev(PAGE);
  check("it has no arrangement of its own", (await layoutDrift(F, PAGE)).own === false);
  check("…and is not reported as behind", (await layoutDrift(F, PAGE)).behind === false);

  console.log("\n2. An account arranges its page");
  const mine = await layoutFor(C, PAGE);
  const kept = mine.slice(0, 2).map((b, i) => ({
    blockId: b.id, position: (i + 1) * 10, width: 4 as const, height: "auto",
  }));
  const saved = await saveLayout(C, PAGE, kept, BY);
  check("the save is accepted", saved.ok === true,
    saved.ok ? "" : saved.problem);
  const after = await layoutDrift(C, PAGE);
  check("it now has its own arrangement", after.own === true);
  check("…and is NOT behind, because nothing has changed since",
    after.behind === false, `theirs ${after.theirs} of ${after.rev}`);

  console.log("\n3. A correction is made to the shared layout");
  const base = await baseLayout(PAGE);
  const moved = [base[base.length - 1]!, ...base.slice(0, -1)].map((b, i) => ({
    blockId: b.id, position: (i + 1) * 10,
    width: (b.id === base[base.length - 1]!.id ? 3 : b.width),
    height: b.height,
  }));
  await saveBaseLayout(PAGE, moved, BY, "a correction");
  check("the revision moved on", (await baseRev(PAGE)) === startRev + 1,
    `${startRev} → ${await baseRev(PAGE)}`);

  const fd = await layoutDrift(F, PAGE);
  check("THE FOLLOWER IS STILL NOT BEHIND — it already has it", fd.behind === false);
  check("…and its page shows the correction",
    (await layoutFor(F, PAGE))[0]?.id === base[base.length - 1]!.id);

  const cd = await layoutDrift(C, PAGE);
  check("THE CUSTOMISED ACCOUNT IS TOLD", cd.behind === true,
    `theirs ${cd.theirs} of ${cd.rev}`);
  check("…and its page is UNCHANGED, as it arranged it",
    (await layoutFor(C, PAGE)).map((b) => b.id).join(",")
      === kept.map((k) => k.blockId).join(","));
  check("…the notice names what it has not got",
    cd.added.length > 0 || cd.differs.length > 0,
    `${cd.added.length} added, ${cd.differs.length} placed differently`);
  check("…and says why it changed", cd.why === "a correction", cd.why);

  console.log("\n4. Taking ONE bucket of it, keeping the rest of the page");
  const wanted = cd.added[0] ?? cd.differs[0];
  check("there is something to take", Boolean(wanted));
  const took = await adoptFromBase({
    accountId: C, page: PAGE, blockIds: [wanted!.id], by: BY,
  });
  check("it is accepted", took.ok === true, took.ok ? "" : took.problem);
  const now = await layoutFor(C, PAGE);
  check("the bucket is on the page", now.some((b) => b.id === wanted!.id));
  check("…and the buckets it kept are still there",
    kept.every((k) => now.some((b) => b.id === k.blockId)),
    now.map((b) => b.name).join(", "));
  check("…and the notice has cleared", (await layoutDrift(C, PAGE)).behind === false);
  check("…while the page is still the account's own",
    (await layoutDrift(C, PAGE)).own === true);

  console.log("\n5. Keeping ours — and the next correction still arrives");
  await saveBaseLayout(PAGE, moved.map((m, i) => ({ ...m, position: (i + 1) * 10 + 1 })),
    BY, "a second correction");
  check("the account is told again", (await layoutDrift(C, PAGE)).behind === true);
  await acknowledgeDrift(C, PAGE);
  const ack = await layoutDrift(C, PAGE);
  check("acknowledging clears it", ack.behind === false);
  check("…without changing the page",
    (await layoutFor(C, PAGE)).map((b) => b.id).join(",") === now.map((b) => b.id).join(","));
  await saveBaseLayout(PAGE, moved.map((m, i) => ({ ...m, position: (i + 1) * 10 + 2 })),
    BY, "a third correction");
  check("AND THE NEXT ONE RAISES IT AGAIN — not a permanent opt-out",
    (await layoutDrift(C, PAGE)).behind === true);

  console.log("\n6. Going back to the shared layout");
  await resetLayout(C, PAGE);
  const reset = await layoutDrift(C, PAGE);
  check("it follows the base again", reset.own === false);
  check("…and is not behind", reset.behind === false);

} finally {
  console.log("\nCleaning up");
  if (BASE_WAS.length > 0) {
    await saveBaseLayout(PAGE, BASE_WAS, "test-cleanup", "restored").catch(() => undefined);
  }
  for (const id of MADE) {
    await forgetLayouts(id).catch(() => undefined);
    await db().query("DELETE FROM dm_accounts WHERE id = $1", [id]).catch(() => undefined);
  }
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
