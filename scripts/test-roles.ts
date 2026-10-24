/**
 * Named roles, and what they can be edited into.
 *
 *   pnpm exec tsx scripts/test-roles.ts
 *
 * A role IS a grant of access, so the rules that keep one from becoming
 * a back door are tested here rather than read:
 *
 *   The two built-in roles always exist, and cannot be renamed, removed,
 *   or have their administering changed. Other things are written against
 *   them — the seeded default a new person lands on, and the admin role
 *   the guards ask about.
 *
 *   A role cannot be deleted while somebody holds it. Reassigning them
 *   automatically would be a silent change to what several people can
 *   see, decided by whoever happened to press delete.
 *
 *   Renaming keeps the holders, because the key is the identity and the
 *   name is a label. Get that backwards and a rename quietly revokes
 *   everybody.
 */
import {
  ADMIN_ROLE, CSC_ROLE, DEFAULT_ROLE, getRole, listRoles, removeRole, saveRole, slug,
} from "../server/dutch-miller/roles.js";
import { DM_PAGE_KEYS } from "../server/dutch-miller/pages.js";
import { dmAccessFor, saveDmUser } from "../server/dutch-miller/users.js";
import { db } from "../server/db.js";

process.env.DM_SUPER_ADMINS = "owner@example.invalid";
const OWNER = "owner@example.invalid";
const HOLDER = "holder@example.invalid";
const PAGE = DM_PAGE_KEYS[0]!;

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};
const refused = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return ""; } catch (e) { return (e as Error).message; }
};

const MADE: string[] = [];

try {
  console.log("1. The built-ins are always there");
  const seeded = await listRoles();
  const admin = seeded.find((r) => r.key === ADMIN_ROLE);
  const general = seeded.find((r) => r.key === DEFAULT_ROLE);
  check("an administrator role exists", Boolean(admin));
  check("…and it administers", admin?.administers === true);
  check("…with every page", admin?.pages.length === DM_PAGE_KEYS.length);
  check("a general user role exists", Boolean(general));
  // The default anybody lands on has to grant nothing, or assigning a
  // role becomes a way to hand out everything by accident.
  check("…and it grants NOTHING by default", general?.pages.length === 0);
  check("…and does not administer", general?.administers === false);
  check("both are marked built in", admin?.builtin === true && general?.builtin === true);

  console.log("\n1b. Approving belongs to CSC and nothing else");
  const csc = seeded.find((r) => r.key === CSC_ROLE);
  check("the CSC role exists", Boolean(csc));
  check("…and it approves", csc?.approves === true);
  check("…and it is built in", csc?.builtin === true);
  // Approving is a job, not a level. An administrator manages who can
  // use the app, which is a different thing from deciding a member
  // may wash.
  check("an ADMINISTRATOR does not approve", admin?.approves === false);
  check("a general user does not approve", general?.approves === false);
  check("exactly one role approves",
    seeded.filter((r) => r.approves).length === 1,
    String(seeded.filter((r) => r.approves).length));

  // Not a tick-box anywhere, so a new role cannot be given it.
  const sneaky = await saveRole({
    name: "Not CSC", pages: [], administers: false, by: OWNER,
  });
  MADE.push(sneaky.key);
  check("a role made here cannot approve", sneaky.approves === false);
  check("…even after an edit",
    (await saveRole({
      key: sneaky.key, name: "Not CSC", pages: [PAGE], administers: false, by: OWNER,
    })).approves === false);
  check("…and CSC still does", (await getRole(CSC_ROLE))?.approves === true);
  check("CSC cannot be removed", (await removeRole(CSC_ROLE)).ok === false);

  console.log("\n2. A built-in cannot be redefined");
  check("…not renamed", (await refused(() => saveRole({
    key: ADMIN_ROLE, name: "Boss", pages: [], administers: true, by: OWNER,
  }))).includes("renamed"));
  check("…not stripped of administering", (await refused(() => saveRole({
    key: ADMIN_ROLE, name: "Administrator", pages: [], administers: false, by: OWNER,
  }))).includes("administrator rights"));
  check("…not removed", (await removeRole(ADMIN_ROLE)).ok === false);
  // Its PAGES can change, which is the one thing worth being able to do
  // to it without inventing a parallel role.
  const narrowed = await saveRole({
    key: DEFAULT_ROLE, name: "General user", pages: [PAGE], administers: false, by: OWNER,
  });
  check("but its pages can", narrowed.pages.join(",") === PAGE);
  await saveRole({
    key: DEFAULT_ROLE, name: "General user", pages: [], administers: false, by: OWNER,
  });

  console.log("\n3. Making one");
  const writer = await saveRole({
    name: "Service Writer", pages: [PAGE], administers: false, by: OWNER,
  });
  MADE.push(writer.key);
  check("the key comes from the name", writer.key === "service-writer", writer.key);
  check("…and the slug is stable", slug("Service  WRITER!") === "service-writer");
  check("it is not built in", writer.builtin === false);
  check("a name already taken is refused", (await refused(() => saveRole({
    name: "service writer", pages: [], administers: false, by: OWNER,
  }))).includes("already a role"));
  check("a nameless role is refused",
    (await refused(() => saveRole({ name: "   ", pages: [], administers: false, by: OWNER })))
      .includes("needs a name"));
  check("a name with nothing usable in it is refused",
    (await refused(() => saveRole({ name: "!!!", pages: [], administers: false, by: OWNER })))
      .includes("letters or numbers"));

  console.log("\n4. Editing one keeps its holders");
  await saveDmUser({ email: HOLDER, roleKey: writer.key, by: OWNER, byRole: "super" });
  check("the holder has the role's page", (await dmAccessFor(HOLDER)).pages.includes(PAGE));
  const renamed = await saveRole({
    key: writer.key, name: "Service Advisor", pages: [PAGE], administers: false, by: OWNER,
  });
  check("renaming keeps the same key", renamed.key === writer.key, renamed.key);
  check("…so the holder keeps it", (await dmAccessFor(HOLDER)).roleKey === writer.key);
  check("…and sees the new name", (await dmAccessFor(HOLDER)).roleName === "Service Advisor");
  const counted = (await listRoles()).find((r) => r.key === writer.key);
  check("holders are counted", counted?.holders === 1, String(counted?.holders));

  console.log("\n5. A role in use cannot be deleted");
  const held = await removeRole(writer.key);
  check("it is refused", held.ok === false);
  check("…saying how many hold it", /1 person holds/.test(held.reason ?? ""), held.reason ?? "");
  check("…and it is still there", Boolean(await getRole(writer.key)));

  console.log("\n6. Once nobody holds it");
  await saveDmUser({ email: HOLDER, roleKey: DEFAULT_ROLE, by: OWNER, byRole: "super" });
  check("it can be removed", (await removeRole(writer.key)).ok === true);
  check("…and is gone", (await getRole(writer.key)) === null);
  check("removing one that never existed is not an error",
    (await removeRole("no-such-role")).ok === true);
  check("editing one that never existed IS",
    (await refused(() => saveRole({
      key: "no-such-role", name: "X", pages: [], administers: false, by: OWNER,
    }))).includes("No such role"));

  console.log("\n7. An administering role");
  const boss = await saveRole({
    name: "Branch Manager", pages: [], administers: true, by: OWNER,
  });
  MADE.push(boss.key);
  await saveDmUser({ email: HOLDER, roleKey: boss.key, by: OWNER, byRole: "super" });
  const access = await dmAccessFor(HOLDER);
  check("it reads as an admin", access.role === "admin", access.role);
  // Administering means every page regardless of the tick-boxes, so a
  // role that administers cannot be a narrow one by accident.
  check("…with every page, whatever was ticked",
    access.pages.length === DM_PAGE_KEYS.length, String(access.pages.length));
} finally {
  await db().query("DELETE FROM dm_users WHERE email = $1", [HOLDER]).catch(() => {});
  await db().query("DELETE FROM dm_roles WHERE key = ANY($1::text[])", [MADE]).catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
