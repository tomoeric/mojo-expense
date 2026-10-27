/**
 * One person, two Emburse accounts, and nothing mixed up between them.
 *
 *   pnpm exec tsx scripts/test-connections.ts
 *
 * Adding a second login is not a bigger version of storing one. The
 * ways it goes wrong are all silent, so these are the cases:
 *
 *   THE MANAGER QUEUE AND EVERY APPROVAL MUST NOT MOVE. They run on
 *   the PRIMARY connection. A second connection that is newer, or
 *   that has signed in more recently, must not become the one a
 *   decision is applied under — Emburse records an approval against
 *   whichever account signed in, in the finance system, for good.
 *
 *   A TAB IS LINKED BY COMPARING ADDRESSES, never by assuming the
 *   app user's own email says which tenant their saved password is
 *   for. The one already stored signs in as Mammoth while the
 *   person signs into this app as MOJO.
 *
 *   A LANE WITH NO MATCH SAYS SO, and links to nothing, rather than
 *   quietly using whatever else is on file.
 *
 *   NO ROUTE AND NO FUNCTION HERE RETURNS A PASSWORD.
 */
import {
  addConnection, credentialFor, credentialForLane, getConnection, labelConnection,
  lanesFor, linkedLanes, listConnections, removeConnection, setAwaitingCode,
} from "../server/emburse/connections.js";
import {
  PRIMARY, credentialForUser, deleteCredential, hasCredential, listCredentials,
  saveCredential,
} from "../server/emburse/credentials.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const ID = "test-user-two-accounts";
const APP = "eric.s@mojocarwash.com";
const MAMMOTH = "eric.s@mammothholdings.com";
const OTHER_ID = "test-user-someone-else";

try {
  await db().query("DELETE FROM emburse_credentials WHERE user_id = ANY($1::text[])",
    [[ID, OTHER_ID]]);

  console.log("1. The connection that is already there stays the primary one");
  /*
   * Saved the way the app has always saved one. It must come back
   * as `primary` with no migration step, because every existing
   * deployment has exactly this row and nothing about it may move.
   */
  await saveCredential(ID, APP, MAMMOTH, "mammoth-password");
  const first = await listConnections(ID);
  check("it is the only one", first.length === 1);
  check("…and it is the primary", first[0]?.isPrimary === true, first[0]?.accountKey);
  check("…signing in as the address it actually holds",
    first[0]?.loginEmail === MAMMOTH, first[0]?.loginEmail);
  check("…which is NOT the address the person uses for this app",
    first[0]?.userEmail !== first[0]?.loginEmail);

  console.log("\n2. Adding the second account");
  const added = await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "mojo-password",
    label: "MOJO",
  });
  check("it is accepted", added.ok === true, added.ok ? "" : added.problem);
  if (!added.ok) throw new Error(added.problem);
  check("…with a key of its own", added.connection.accountKey !== PRIMARY,
    added.connection.accountKey);
  check("…and it is NOT the primary", added.connection.isPrimary === false);
  check("both are stored", (await listConnections(ID)).length === 2);
  const dupe = await addConnection({
    userId: ID, userEmail: APP, loginEmail: MAMMOTH, password: "again",
  });
  check("the same Emburse login twice is refused", dupe.ok === false,
    dupe.ok ? "" : dupe.problem);

  console.log("\n3. THE MANAGER QUEUE AND DECISIONS DO NOT MOVE");
  const forDecision = await credentialForUser(APP);
  check("a decision still signs in as the primary connection",
    forDecision?.email === MAMMOTH, forDecision?.email);
  check("…and gets the primary's password", forDecision?.password === "mammoth-password");
  check("hasCredential still answers about the primary", await hasCredential(APP));
  // The old fault this codebase was bitten by: a newer, more
  // recently proven login quietly becoming the one in charge.
  await db().query(
    `UPDATE emburse_credentials SET last_ok_at = now(), updated_at = now()
      WHERE user_id = $1 AND account_key = $2`, [ID, added.connection.accountKey]);
  const afterSuccess = await credentialForUser(APP);
  check("A SECOND CONNECTION SIGNING IN DOES NOT TAKE OVER",
    afterSuccess?.email === MAMMOTH, afterSuccess?.email);

  console.log("\n4. A tab is linked by comparing addresses");
  const lanes = await lanesFor(APP);
  check("the three tabs are seeded", lanes.length === 3,
    lanes.map((l) => l.label).join(" · "));
  check("…with the exact names asked for",
    lanes.some((l) => l.label === "Personal Tab - MOJO")
    && lanes.some((l) => l.label === "Personal Tab - Mammoth"));
  const linked = await linkedLanes(ID, APP);
  const mojo = linked.find((l) => l.key === "personal-mojo")!;
  const mam = linked.find((l) => l.key === "personal-mammoth")!;
  const mgr = linked.find((l) => l.key === "manager")!;
  check("Personal Tab - MOJO is the MOJO login",
    mojo.connection?.loginEmail === APP, mojo.connection?.loginEmail);
  check("Personal Tab - Mammoth is the Mammoth login",
    mam.connection?.loginEmail === MAMMOTH, mam.connection?.loginEmail);
  check("…WHICH IS THE PRE-EXISTING CONNECTION, matched rather than assumed",
    mam.connection?.accountKey === PRIMARY);
  check("the Manager tab is the primary connection",
    mgr.connection?.accountKey === PRIMARY);

  console.log("\n5. A tab with nothing matching says so");
  await removeConnection(ID, added.connection.accountKey);
  const gone = (await linkedLanes(ID, APP)).find((l) => l.key === "personal-mojo")!;
  check("it is linked to nothing", gone.connection === null);
  check("…and the reason names the address it wanted",
    gone.problem.includes(APP), gone.problem);
  check("…and says what IS on file instead", gone.problem.includes(MAMMOTH), gone.problem);
  const refused = await credentialForLane(ID, APP, "personal-mojo");
  check("asking for that tab's login is REFUSED, not substituted",
    refused.ok === false, refused.ok ? "" : refused.problem);
  const mamLane = await credentialForLane(ID, APP, "personal-mammoth");
  check("…while the linked tab still works", mamLane.ok === true);
  check("…and returns ITS account's password",
    mamLane.ok && mamLane.password === "mammoth-password");

  console.log("\n6. A code challenge belongs to one connection");
  const back = await addConnection({
    userId: ID, userEmail: APP, loginEmail: APP, password: "mojo-password", label: "MOJO",
  });
  if (!back.ok) throw new Error(back.problem);
  await setAwaitingCode(APP, PRIMARY, true);
  const waiting = await listConnections(ID);
  check("the Mammoth connection is waiting",
    waiting.find((c) => c.accountKey === PRIMARY)?.awaitingCode === true);
  check("THE MOJO ONE IS NOT",
    waiting.find((c) => c.accountKey === back.connection.accountKey)?.awaitingCode === false);
  await setAwaitingCode(APP, PRIMARY, false);
  check("…and it clears", (await getConnection(ID, PRIMARY))?.awaitingCode === false);

  console.log("\n7. Nothing here hands back a password");
  const shapes = [
    ...(await listConnections(ID)) as unknown as Record<string, unknown>[],
    ...(await linkedLanes(ID, APP)) as unknown as Record<string, unknown>[],
    ...(await listCredentials()) as unknown as Record<string, unknown>[],
  ];
  const leaked = shapes.filter((o) => JSON.stringify(o).includes("password"));
  check("no listing contains one", leaked.length === 0, JSON.stringify(leaked[0] ?? {}));
  check("…and the sealed bytes are not in any of them",
    !JSON.stringify(shapes).includes("mojo-password"));

  console.log("\n8. One person's connections are not another's");
  await saveCredential(OTHER_ID, "brian@mojocarwash.com", "brian@mojocarwash.com", "brians");
  await addConnection({
    userId: OTHER_ID, userEmail: "brian@mojocarwash.com",
    loginEmail: "brian.second@example.com", password: "second", label: "Second",
  });
  check("they each see only their own",
    (await listConnections(ID)).every((c) => c.userEmail === APP)
    && (await listConnections(OTHER_ID)).every((c) => c.userEmail === "brian@mojocarwash.com"));
  // Their minted key, not 'primary' — every person has a row under
  // that name, so it proves nothing. What must not happen is one
  // person's own key resolving against somebody else's id.
  const theirs = (await listConnections(OTHER_ID)).find((c) => !c.isPrimary)!;
  const crossed = await getConnection(ID, theirs.accountKey);
  check("…and one cannot be fetched under the other's id", crossed === null,
    crossed ? `${crossed.userEmail} / ${crossed.loginEmail}` : "");
  check("…while the primary key, which everybody has, returns only your own",
    (await getConnection(ID, PRIMARY))?.userEmail === APP);
  check("…nor decrypted under the other's email",
    (await credentialFor("brian@mojocarwash.com", back.connection.accountKey)) === null);

  console.log("\n9. Labels decide nothing");
  await labelConnection(ID, PRIMARY, "Mammoth Holdings");
  const relabelled = await linkedLanes(ID, APP);
  check("the label changes", (await getConnection(ID, PRIMARY))?.label === "Mammoth Holdings");
  check("…and the Mammoth tab is still linked by its ADDRESS",
    relabelled.find((l) => l.key === "personal-mammoth")?.connection?.accountKey === PRIMARY);
  await labelConnection(ID, PRIMARY, "Personal Tab - MOJO");
  check("…even when the label claims to be the other tab",
    (await linkedLanes(ID, APP)).find((l) => l.key === "personal-mojo")
      ?.connection?.loginEmail === APP);

} finally {
  await deleteCredential(ID).catch(() => undefined);
  await db().query("DELETE FROM emburse_credentials WHERE user_id = ANY($1::text[])",
    [[ID, OTHER_ID]]).catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
