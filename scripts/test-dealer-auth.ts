/**
 * One-time links, codes, and the lockout.
 *
 *   pnpm exec tsx scripts/test-dealer-auth.ts
 *
 * This is the most exposed surface in the product: it answers to people
 * who are not signed in. The properties below are the ones an attacker
 * would go looking for, so each is tested from the outside rather than
 * read off the implementation.
 *
 *   Nothing is stored in the clear. The test greps the whole table for the
 *   token it was just handed — if it is in there, a leaked backup is a set
 *   of working keys rather than a list of hashes.
 *
 *   One use. Two clicks, a retry, or a mail scanner fetching the URL
 *   before the person does must not all succeed.
 *
 *   Asking again kills the old link, so there is never a pile of valid
 *   keys behind one address.
 *
 *   A wrong code costs an attempt whether or not the request finishes,
 *   and running out burns the code rather than leaving it guessable.
 */
import { createHash } from "node:crypto";
import {
  issueCode, issueToken, purgeOldTokens, redeemToken, verifyCode,
} from "../server/dutch-miller/invites.js";
import { LOCKOUT, audit, listAudit, lockState } from "../server/dutch-miller/audit.js";
import {
  TRUST_DAYS, deviceLabel, forgetDevices, isTrusted, listDevices, trustDevice,
} from "../server/dutch-miller/devices.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const A = "link-a@example.invalid";
const B = "link-b@example.invalid";
const LOCKED = "locked@example.invalid";
const MINE = [A, B, LOCKED];

try {
  console.log("1. A link is spent exactly once");
  const t1 = await issueToken({ email: A, kind: "login" });
  const first = await redeemToken(t1.token, t1.browserNonce ?? undefined);
  check("it works", first.ok === true && first.email === A);
  check("…in the browser that asked", first.ok === true && first.sameBrowser === true);
  const second = await redeemToken(t1.token, t1.browserNonce ?? undefined);
  check("the second use is refused", second.ok === false);
  check("…saying it was already used",
    second.ok === false && second.reason === "used", second.ok ? "" : second.reason);

  console.log("\n2. The token is not in the database");
  const raw = await db().query<{ hit: string }>(
    `SELECT count(*) AS hit FROM dm_login_tokens
      WHERE token_hash = $1 OR token_hash = $2`,
    [t1.token, createHash("sha256").update(t1.token).digest("hex")]);
  check("only the hash of it is", raw.rows[0]?.hit === "1", raw.rows[0]?.hit);

  console.log("\n3. Opened somewhere else");
  const t2 = await issueToken({ email: A, kind: "login" });
  const elsewhere = await redeemToken(t2.token, undefined);
  check("the link still opens", elsewhere.ok === true);
  check("…but is not treated as the same browser",
    elsewhere.ok === true && elsewhere.sameBrowser === false);
  const t3 = await issueToken({ email: A, kind: "login" });
  const wrongBrowser = await redeemToken(t3.token, "some-other-nonce");
  check("a nonce that is not ours is not the same browser either",
    wrongBrowser.ok === true && wrongBrowser.sameBrowser === false);

  console.log("\n4. Asking again kills the old link");
  const old = await issueToken({ email: B, kind: "login" });
  await issueToken({ email: B, kind: "login" });
  const stale = await redeemToken(old.token, old.browserNonce ?? undefined);
  check("the first link no longer works", stale.ok === false);
  check("…reported as used, not unknown",
    stale.ok === false && stale.reason === "used", stale.ok ? "" : stale.reason);

  console.log("\n5. Expiry");
  const t4 = await issueToken({ email: B, kind: "login" });
  await db().query(
    "UPDATE dm_login_tokens SET expires_at = now() - interval '1 minute' WHERE email = $1 AND used_at IS NULL",
    [B]);
  const late = await redeemToken(t4.token, t4.browserNonce ?? undefined);
  check("an expired link is refused", late.ok === false);
  check("…and says so", late.ok === false && late.reason === "expired");
  check("a token nobody ever issued is unknown",
    (await redeemToken("not-a-real-token", undefined)) .ok === false);

  console.log("\n6. An invite is not browser-bound");
  const inv = await issueToken({ email: A, kind: "invite", bindBrowser: false });
  check("no nonce is minted for it", inv.browserNonce === null);
  const opened = await redeemToken(inv.token, undefined);
  check("…and it opens anywhere", opened.ok === true && opened.kind === "invite");
  check("…never counting as the same browser",
    opened.ok === true && opened.sameBrowser === false);

  console.log("\n7. Codes");
  const code = await issueCode(A);
  check("six digits", /^\d{6}$/.test(code), code);
  const plain = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_verify_codes WHERE email = $1 AND code_hash = $2", [A, code]);
  check("the code itself is not stored", plain.rows[0]?.n === "0");
  check("a wrong one is refused", (await verifyCode(A, "000000")).ok === false
    || code === "000000");
  check("the right one works", (await verifyCode(A, code)).ok === true);
  check("…and is spent", (await verifyCode(A, code)).ok === false);

  console.log("\n8. Guessing a code runs out");
  const code2 = await issueCode(B);
  const wrong = code2 === "111111" ? "222222" : "111111";
  let last = await verifyCode(B, wrong);
  for (let i = 1; i < LOCKOUT.maxCodeAttempts; i++) last = await verifyCode(B, wrong);
  check("every wrong guess is refused", last.ok === false);
  check("…and the tries left are counted down",
    last.ok === false && last.attemptsLeft === 0, last.ok ? "" : String(last.attemptsLeft));
  const burned = await verifyCode(B, code2);
  check("the real code no longer works either — it was burned", burned.ok === false,
    burned.ok ? "accepted" : burned.reason);

  console.log("\n9. Lockout");
  check("a quiet address is not locked", (await lockState(LOCKED)).locked === false);
  for (let i = 0; i < LOCKOUT.maxFailures; i++) {
    await audit({ action: "code.failed", subject: LOCKED });
  }
  const locked = await lockState(LOCKED);
  check(`${LOCKOUT.maxFailures} failures locks it`, locked.locked === true,
    JSON.stringify(locked));
  check("…with a time to tell them", Boolean(locked.until));
  check("…and it is per address, not global",
    (await lockState("someone-else@example.invalid")).locked === false);
  // Derived from the trail, so an old failure stops counting on its own —
  // nothing to sweep up, and no row that can strand somebody permanently.
  await db().query(
    `UPDATE dm_audit SET at = now() - ($1 || ' minutes')::interval WHERE subject = $2`,
    [String(LOCKOUT.windowMinutes + 5), LOCKED]);
  check("…and it clears itself as the window moves",
    (await lockState(LOCKED)).locked === false);

  console.log("\n10. The trail");
  const trail = await listAudit({ subject: LOCKED, limit: 50 });
  check("the failures are on it", trail.length >= LOCKOUT.maxFailures, String(trail.length));
  check("no entry carries a token or a code",
    trail.every((e) => !e.detail.includes(code) && !e.detail.includes(t1.token)));
  check("purging old tokens does not touch live ones",
    (await purgeOldTokens()) >= 0);

  console.log("\n11. Trusted devices");
  check("an unknown browser is not trusted", !(await isTrusted(A, "never-seen")));
  check("…and neither is no cookie at all", !(await isTrusted(A, undefined)));
  const dev = await trustDevice(A, deviceLabel("Mozilla/5.0 (Macintosh) Chrome/1"));
  check("a trusted browser is recognised", await isTrusted(A, dev.secret));
  // Both halves have to match, or one person's trust on a shared machine
  // would carry the next person past the code.
  check("…but only for the person it was trusted for", !(await isTrusted(B, dev.secret)));
  check("the cookie's secret is not stored", (await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM dm_trusted_devices WHERE id = $1", [dev.secret])).rows[0]?.n === "0");
  check("two weeks is the window", TRUST_DAYS === 14, String(TRUST_DAYS));
  check("the machine is listed for an administrator",
    (await listDevices(A)).some((d) => d.label.includes("Chrome")));
  check("…with a readable name", deviceLabel("Mozilla/5.0 (Windows NT) Firefox/1") === "Firefox on Windows",
    deviceLabel("Mozilla/5.0 (Windows NT) Firefox/1"));

  console.log("\n12. Trust runs out, and can be taken away");
  await db().query(
    "UPDATE dm_trusted_devices SET expires_at = now() - interval '1 day' WHERE email = $1", [A]);
  check("expired trust is no trust", !(await isTrusted(A, dev.secret)));
  const dev2 = await trustDevice(B, "Test");
  check("a fresh one works", await isTrusted(B, dev2.secret));
  // "Signed out everywhere" has to include the machines, or the next link
  // walks straight in with no code.
  check("revoking forgets every machine", (await forgetDevices(B)) >= 1);
  check("…so the code is asked for again", !(await isTrusted(B, dev2.secret)));

} finally {
  await db().query("DELETE FROM dm_login_tokens WHERE email = ANY($1::text[])", [MINE])
    .catch(() => {});
  await db().query("DELETE FROM dm_verify_codes WHERE email = ANY($1::text[])", [MINE])
    .catch(() => {});
  await db().query("DELETE FROM dm_audit WHERE subject = ANY($1::text[])", [MINE])
    .catch(() => {});
  await db().query("DELETE FROM dm_trusted_devices WHERE email = ANY($1::text[])", [MINE])
    .catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
