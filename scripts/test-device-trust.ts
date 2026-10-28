/**
 * A remembered device belongs to ONE EMBURSE ACCOUNT, and the page can say so.
 *
 *   pnpm run build
 *   pnpm exec tsx scripts/test-device-trust.ts
 *
 * Emburse trusts a browser per account: that is how the cookie jar and the
 * Chromium profile are both keyed, because that is what Emburse issues the
 * trust against. Three things had not caught up, and together they made
 * per-tab trust unusable:
 *
 *   THE READOUT WAS THE PRIMARY CONNECTION'S, on every tab. It asked
 *   `cookiesSavedAt(ownLoginEmail(user))`, which resolves to the person's
 *   first stored credential — so a personal tab could read "Emburse trusts
 *   this browser" about an account that had never been trusted, and then a
 *   run stopped to ask for a code the page had just said was unnecessary.
 *
 *   ADOPTION WAS OFFERED BY APP ADDRESS. The jar is read by LOGIN address,
 *   so the old shared trust landed under a key no run looks at, reported
 *   success, and the account was asked for a code anyway. For
 *   eric.s@mojocarwash.com the two strings coincide and it appeared to
 *   work; for eric.s@mammothholdings.com there was no way to say it at all.
 *
 *   FORGETTING ONE ACCOUNT DESTROYED THE SHARED ROW, which is the trust
 *   every other account was still waiting to adopt.
 *
 * Over HTTP rather than against the functions, because the bug was in what
 * the route ANSWERS — the functions underneath were right and are covered
 * by test-cookie-jars.
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";

process.env.SESSION_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.AUTH_ALLOWED ||= "mojocarwash.com";
process.env.AUTH_ADMINS ||= "eric.s@mojocarwash.com";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const APP = "eric.s@mojocarwash.com";
const MAMMOTH = "eric.s@mammothholdings.com";
const ID = "device-trust-user";
const PORT = 5617;

const sid = (() => {
  const payload = Buffer.from(JSON.stringify({
    id: ID, email: APP, name: APP, exp: Date.now() + 3_600_000, via: "microsoft",
  })).toString("base64url");
  const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
    .update(payload).digest("base64url");
  return `mojo_sid=${payload}.${mac}`;
})();

const { db } = await import("../server/db.js");
const { saveCredential, deleteCredential } = await import("../server/emburse/credentials.js");
const { addConnection } = await import("../server/emburse/connections.js");
const { forgetCookies, rememberCookies, legacyDevice, cookiesSavedAt } =
  await import("../server/emburse/browser-state.js");

const server = spawn("node", ["dist/server.js"], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => undefined);
server.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));

const up = async (): Promise<boolean> => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/me`);
      if (res.status < 500) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

type Device = { loginEmail: string; label: string; linked: boolean; rememberedAt: string | null };
type Choice = { loginEmail: string; userEmail: string; label: string; rememberedAt: string | null };

const runs = async (lane: string): Promise<{ device: Device; deviceChoices: Choice[];
  legacyDeviceAt: string | null }> => {
  const res = await fetch(
    `http://127.0.0.1:${PORT}/api/export-runs?reviewer=${encodeURIComponent(APP)}&lane=${lane}`,
    { headers: { cookie: sid } });
  return await res.json() as never;
};

/** Just enough of a Playwright context for the jar to write. */
const ctxWith = (name: string) => ({
  storageState: async () => ({ cookies: [{
    name, value: "x", domain: "spend.emburse.com", path: "/",
    expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const,
  }] }),
  addCookies: async () => undefined,
} as never);

try {
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID]);
  await db().query("DELETE FROM reviewer_imports WHERE user_email = $1", [APP]);
  await forgetCookies();
  // The two accounts as they really are: the primary signs in as Mammoth,
  // the second as MOJO. Note that the MOJO Emburse address equals the app
  // address and the Mammoth one does not — which is exactly why keying the
  // jar by the app address appeared to work for one tab and could never
  // work for the other.
  await saveCredential(ID, APP, MAMMOTH, "mammoth-password");
  const second = await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "mojo-password", label: "MOJO",
  });
  if (!second.ok) throw new Error(second.problem);

  check("the server comes up", await up());

  console.log("\n1. The readout is about the tab's own Emburse account");
  const mgr = await runs("manager");
  check("the manager tab names the primary connection",
    mgr.device.loginEmail === MAMMOTH, mgr.device.loginEmail);
  check("…and says which tab it is about", mgr.device.label === "Manager tab",
    mgr.device.label);
  const mojo = await runs("personal-mojo");
  check("the MOJO tab names ITS OWN account",
    mojo.device.loginEmail === APP, mojo.device.loginEmail);
  const mam = await runs("personal-mammoth");
  check("the Mammoth tab names the Mammoth account",
    mam.device.loginEmail === MAMMOTH, mam.device.loginEmail);
  check("nothing is remembered yet, on any tab",
    [mgr, mojo, mam].every((r) => r.device.rememberedAt === null));

  console.log("\n2. Trusting one account does not make the others look trusted");
  // The whole fault in one assertion: the Mammoth login is the primary, so
  // the old readout reported ITS trust on the MOJO tab too.
  await rememberCookies(ctxWith("mammoth-session"), MAMMOTH);
  const after = { mgr: await runs("manager"), mojo: await runs("personal-mojo") };
  check("the Mammoth account is remembered", after.mgr.device.rememberedAt !== null);
  check("THE MOJO TAB STILL SAYS NOT REMEMBERED",
    after.mojo.device.rememberedAt === null, String(after.mojo.device.rememberedAt));

  console.log("\n3. A tab with no account linked is not 'untrusted', it is unconfigured");
  await db().query(
    "DELETE FROM emburse_credentials WHERE user_id = $1 AND account_key = $2",
    [ID, second.connection.accountKey]);
  const unlinked = await runs("personal-mojo");
  check("it says so", unlinked.device.linked === false);
  check("…and names no account", unlinked.device.loginEmail === "");
  const back = await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "mojo-password", label: "MOJO",
  });
  if (!back.ok) throw new Error(back.problem);

  console.log("\n4. The shared device is offered BY EMBURSE LOGIN");
  // The pre-keying row, as a deployment that has been running a while has it.
  await db().query(
    `INSERT INTO emburse_browser_state (id, state, updated_at) VALUES (true, $1, now())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [(await db().query<{ state: Buffer }>(
      "SELECT state FROM emburse_browser_jars WHERE user_email = $1", [MAMMOTH])).rows[0]!.state]);
  const offered = await runs("personal-mojo");
  check("there is a shared device to assign", offered.legacyDeviceAt !== null);
  const keys = offered.deviceChoices.map((c) => c.loginEmail).sort();
  check("both EMBURSE addresses are offered",
    keys.join(",") === [APP, MAMMOTH].sort().join(","), keys.join(","));
  check("…named by the tab they serve, not by an address alone",
    offered.deviceChoices.every((c) => /tab/i.test(c.label)),
    offered.deviceChoices.map((c) => c.label).join(" | "));
  check("…and the one already trusted says so, so it is not overwritten",
    offered.deviceChoices.find((c) => c.loginEmail === MAMMOTH)?.rememberedAt !== null);

  console.log("\n5. Adopting it reaches the key a run actually reads");
  const adopt = await fetch(`http://127.0.0.1:${PORT}/api/export-device/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sid },
    body: JSON.stringify({ loginEmail: APP }),
  });
  const adopted = await adopt.json() as { ok?: boolean; carried?: boolean; loginEmail?: string };
  check("it is accepted", adopt.ok === true && adopted.ok === true, JSON.stringify(adopted));
  check("…and says something was carried", adopted.carried === true);
  check("THE JAR IS NOW UNDER THE EMBURSE ADDRESS",
    (await cookiesSavedAt(APP)) !== null);
  check("…which is what the MOJO tab reads back",
    (await runs("personal-mojo")).device.rememberedAt !== null);

  console.log("\n6. An address nobody signs in as is refused, not written");
  const bogus = await fetch(`http://127.0.0.1:${PORT}/api/export-device/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sid },
    body: JSON.stringify({ loginEmail: "nobody@example.invalid" }),
  });
  check("it is a 400", bogus.status === 400, String(bogus.status));
  check("…with a sentence naming the fix",
    /Your Emburse login/i.test((await bogus.json() as { error?: string }).error ?? ""));
  check("…and no jar was written under it",
    (await cookiesSavedAt("nobody@example.invalid")) === null);

  console.log("\n7. Forgetting one tab's device costs only that tab a code");
  const forget = await fetch(
    `http://127.0.0.1:${PORT}/api/export-device?loginEmail=${encodeURIComponent(APP)}`,
    { method: "DELETE", headers: { cookie: sid } });
  check("it is accepted", forget.ok === true);
  check("the MOJO tab is no longer remembered", (await cookiesSavedAt(APP)) === null);
  check("…AND THE MAMMOTH ONE STILL IS", (await cookiesSavedAt(MAMMOTH)) !== null);
  check("…and the shared device survived, so the others can still adopt it",
    (await legacyDevice()) !== null);

  console.log("\n8. The shared device can be dropped without losing anybody's trust");
  const drop = await fetch(`http://127.0.0.1:${PORT}/api/export-device/legacy`,
    { method: "DELETE", headers: { cookie: sid } });
  check("it is accepted", drop.ok === true);
  check("the shared row is gone", (await legacyDevice()) === null);
  check("…and the Mammoth account kept its own", (await cookiesSavedAt(MAMMOTH)) !== null);

  console.log("\n9. Another account's Emburse addresses are not handed to a non-admin");
  // The buttons were gated in the page, which is presentation. The list is
  // other people's Emburse logins, so the gate is on the route too.
  const plain = Buffer.from(JSON.stringify({
    id: "someone-else", email: "nobody.else@mojocarwash.com", name: "N",
    exp: Date.now() + 3_600_000, via: "microsoft",
  })).toString("base64url");
  const pmac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
    .update(plain).digest("base64url");
  const asPlain = await fetch(`http://127.0.0.1:${PORT}/api/export-runs`, {
    headers: { cookie: `mojo_sid=${plain}.${pmac}` },
  });
  const body = await asPlain.json() as { deviceChoices?: Choice[] };
  check("the request is allowed", asPlain.ok === true, String(asPlain.status));
  check("…and the account list is empty for them",
    (body.deviceChoices ?? []).length === 0, JSON.stringify(body.deviceChoices));
} finally {
  await forgetCookies().catch(() => undefined);
  await deleteCredential(ID).catch(() => undefined);
  await db().query("DELETE FROM emburse_credentials WHERE user_id = $1", [ID])
    .catch(() => undefined);
  await db().query("DELETE FROM reviewer_imports WHERE user_email = $1", [APP])
    .catch(() => undefined);
  server.kill();
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
