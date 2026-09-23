/**
 * Who may write rules.
 *
 *   pnpm exec tsx scripts/test-rule-editors.ts     (needs DATABASE_URL)
 *
 * The list is an allow-list, and allow-lists have one classic failure: an
 * empty one that means "nobody" locks out the person who has to populate it.
 * So empty means "any admin", the pre-existing behaviour, and restriction
 * begins the moment somebody is named. That switch is what this pins.
 *
 * It also pins the limit honestly: the list is only as strong as AUTH_ADMINS,
 * because a non-admin is refused before the list is ever consulted and — with
 * AUTH_ADMINS unset — everyone is an admin.
 */

// Only dynamic imports below, so that the environment above is set before the
// modules that snapshot it load. `export {}` keeps this a module regardless.
export {};

process.env.SESSION_SECRET ||= "test-secret-for-sealing-credentials";
// Sign-in must look configured, or every permission check short-circuits to
// "allowed" the way it does on a machine with no Entra app.
process.env.AZURE_TENANT_ID ||= "test-tenant";
process.env.AZURE_CLIENT_ID ||= "test-client";
process.env.AZURE_CLIENT_SECRET ||= "test-secret";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const { db, ensureSchema } = await import("../server/db.js");
const { canWriteRules, isRestricted, listEditors, setEditor } =
  await import("../server/rules/editors.js");

await ensureSchema();

const ERIC = `zz-eric-${Date.now()}@example.invalid`;
const BRIAN = `zz-brian-${Date.now()}@example.invalid`;

// Start from a clean list, and put it back afterwards — this suite is meant to
// be runnable against a database that already has real editors in it.
const before = await listEditors();
await db().query("DELETE FROM rule_editors");

try {
  console.log("\nAn empty list does not lock anybody out");
  check("nothing is restricted yet", !(await isRestricted()));
  check("an admin may write", await canWriteRules(ERIC));

  console.log("\nNaming somebody starts the restriction");
  await setEditor(ERIC, true, ERIC);
  check("the list is now enforced", await isRestricted());
  check("the named person may write", await canWriteRules(ERIC));
  check("everybody else may not", !(await canWriteRules(BRIAN)));

  console.log("\nThe toggle");
  await setEditor(BRIAN, true, ERIC);
  check("switching Brian on lets him write", await canWriteRules(BRIAN));
  check("…and does not remove Eric", await canWriteRules(ERIC));
  await setEditor(BRIAN, false, ERIC);
  check("switching him off again takes it back", !(await canWriteRules(BRIAN)));
  check("Eric is still there", await canWriteRules(ERIC));

  console.log("\nDetails that bite later");
  await setEditor(ERIC.toUpperCase(), true, ERIC);
  check("an address is the same address whatever its case",
    (await listEditors()).filter((e) => e.email === ERIC.toLowerCase()).length === 1,
    JSON.stringify((await listEditors()).map((e) => e.email)));
  check("…and matching ignores case too", await canWriteRules(ERIC.toUpperCase()));

  await setEditor(`  ${BRIAN}  `, true, ERIC);
  check("surrounding whitespace is not part of the address", await canWriteRules(BRIAN));
  await setEditor(BRIAN, false, ERIC);

  let rejected = false;
  try {
    await setEditor("not-an-address", true, ERIC);
  } catch {
    rejected = true;
  }
  check("something that is not an email is refused", rejected);

  check("nobody signed in cannot write", !(await canWriteRules(undefined)));
  check("an empty address cannot write", !(await canWriteRules("")));

  // The middleware, not just the predicate underneath it. This is the thing
  // actually standing in front of every write route, and a wrapper that let
  // everything through would pass every test above.
  console.log("\nThe gate in front of the write routes");
  const { requireRuleEditor } = await import("../server/rules/editors.js");
  const gate = async (email: string | undefined) => {
    let status = 0;
    let body: { error?: string } = {};
    let passed = false;
    const res = {
      status(code: number) { status = code; return this; },
      json(payload: { error?: string }) { body = payload; return this; },
    };
    await requireRuleEditor(
      { user: email ? { email } : undefined } as never,
      res as never,
      (() => { passed = true; }) as never,
    );
    return { passed, status, error: body.error ?? "" };
  };

  const ericIn = await gate(ERIC);
  check("a named person is let through", ericIn.passed && ericIn.status === 0,
    `status=${ericIn.status}`);
  const brianOut = await gate(BRIAN);
  check("everybody else gets a 403, not a pass",
    !brianOut.passed && brianOut.status === 403, `status=${brianOut.status} passed=${brianOut.passed}`);
  check("…and is told how to be added",
    /administrator can add you/.test(brianOut.error), brianOut.error);
  const anon = await gate(undefined);
  check("nobody signed in is refused", !anon.passed && anon.status === 403);

  // Removing the last person must restore the open state rather than lock the
  // app — the one transition that would be unrecoverable if it went wrong.
  await setEditor(ERIC, false, ERIC);
  check("emptying the list opens it back up, rather than locking everyone out",
    !(await isRestricted()) && (await canWriteRules(BRIAN)));
} finally {
  await db().query("DELETE FROM rule_editors");
  for (const e of before) await setEditor(e.email, true, e.addedBy ?? "restore");
  await db().end();
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
