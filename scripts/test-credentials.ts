/**
 * Check that a stored Emburse password stays unreadable.
 *
 *   NEON_DATABASE_URL=... SESSION_SECRET=... pnpm exec tsx scripts/test-credentials.ts
 *
 * The claim being tested is narrow and worth stating exactly: no code path in
 * this app hands the password back — not to an administrator, not to the person
 * who typed it — and the stored bytes are not legible to someone reading the
 * database. It is NOT a claim of secrecy from whoever controls the deployment,
 * who holds the key by necessity, because the scheduler has to sign in unaided.
 */

import { db, ensureSchema } from "../server/db.js";
import {
  saveCredential, credentialStatus, listCredentials, credentialForExport,
  deleteCredential, noteResult,
} from "../server/emburse/credentials.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await ensureSchema();

const BRIAN = { id: "oid-brian", email: "brian@mojocarwash.com" };
const SECRET = "Brian!s-Emburse-Pa55word";

await db().query("DELETE FROM emburse_credentials WHERE user_id LIKE 'oid-%'").catch(() => {});

console.log("\n1. Brian saves his login once");
await saveCredential(BRIAN.id, BRIAN.email, "brian@mojocarwash.com", SECRET);
const mine = await credentialStatus(BRIAN.id);
check("his own status comes back", mine !== null);
check("it names the Emburse account", mine?.loginEmail === "brian@mojocarwash.com", mine?.loginEmail);
check("the status carries no password field", !JSON.stringify(mine).includes(SECRET), JSON.stringify(mine));

console.log("\n2. Nothing an admin can call returns it");
const listed = await listCredentials();
check("the admin list shows the credential exists", listed.length === 1);
check("the admin list names whose it is", listed[0]?.userEmail === BRIAN.email, listed[0]?.userEmail);
check("the admin list has no password in it", !JSON.stringify(listed).includes(SECRET));

console.log("\n3. Somebody else's id returns nothing");
check("a different user sees no credential", (await credentialStatus("oid-eric")) === null);

console.log("\n4. The stored bytes are not legible");
const { rows } = await db().query<{ secret: Buffer }>(
  "SELECT secret FROM emburse_credentials WHERE user_id = $1", [BRIAN.id]);
const raw = rows[0]!.secret;
check("the column is not the plaintext", !raw.toString("utf8").includes(SECRET));
check("nor the plaintext in base64", !raw.toString("base64").includes(Buffer.from(SECRET).toString("base64")));
// GCM is a stream cipher, so the ciphertext is exactly as long as the
// plaintext; the 28 extra bytes are the 12-byte iv and the 16-byte tag.
check("it is the iv, the tag and the ciphertext and nothing else",
  raw.length === SECRET.length + 28, `${raw.length} bytes for a ${SECRET.length}-char password`);

console.log("\n5. Only the export runner can open it");
const forExport = await credentialForExport();
check("the runner gets the real password", forExport?.password === SECRET);
check("and knows whose it is, to report back", forExport?.userId === BRIAN.id);

console.log("\n6. Re-asking happens only after a sign-in failure");
check("a fresh credential is not flagged", (await credentialStatus(BRIAN.id))?.needsReentry === false);
await noteResult(BRIAN.id, false, "sign in: password rejected");
check("flagged once sign-in fails", (await credentialStatus(BRIAN.id))?.needsReentry === true);
await noteResult(BRIAN.id, true, null);
check("cleared once it works again", (await credentialStatus(BRIAN.id))?.needsReentry === false);

console.log("\n7. Replacing it forgets what the old one proved");
await saveCredential(BRIAN.id, BRIAN.email, "brian@mojocarwash.com", "a-different-password");
const after = await credentialStatus(BRIAN.id);
check("the success mark is cleared", after?.lastOkAt === null, String(after?.lastOkAt));
check("the new password is the one handed out", (await credentialForExport())?.password === "a-different-password");

console.log("\n8. He can remove it");
check("delete reports success", (await deleteCredential(BRIAN.id)) === true);
check("and it is gone", (await credentialStatus(BRIAN.id)) === null);
check("deleting again is not an error", (await deleteCredential(BRIAN.id)) === false);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
