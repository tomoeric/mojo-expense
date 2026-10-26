/**
 * A view must show the VIEWED person's scope, not the viewer's.
 *
 *   pnpm exec tsx scripts/test-view-scope.ts
 *
 * Two rules that pull in opposite directions, and both have to hold:
 *
 *   What is SHOWN follows the viewed person. A view exists to answer
 *   "what can they see?", and a super administrator's Delete sitting
 *   under a dealer's name is the view lying about the one thing it is
 *   for. This is what went wrong: the buttons were judged on whoever
 *   was really at the keyboard.
 *
 *   What is DONE follows the real person, and during a view nothing
 *   can be done at all. Loosening the display must never loosen that
 *   — the whole design rests on it.
 */
import { actionsFor } from "../server/dutch-miller/actions.js";
import { ADMIN_ROLE, CSC_ROLE, saveRole } from "../server/dutch-miller/roles.js";
import { dmAccessFor, saveDmUser } from "../server/dutch-miller/users.js";
import { viewAsMiddleware, VIEW_AS_COOKIE, formatViewAs } from "../server/auth/view-as.js";
import { db } from "../server/db.js";
import type { Request, Response, NextFunction } from "express";

process.env.AZURE_TENANT_ID ||= "t";
process.env.AZURE_CLIENT_ID ||= "c";
process.env.AZURE_CLIENT_SECRET ||= "s";
process.env.AUTH_ALLOWED ||= "mojocarwash.com";
process.env.DM_SUPER_ADMINS = "owner@mojocarwash.com";

const OWNER = "owner@mojocarwash.com";
const ADMIN = "admin@mojocarwash.com";
const MINE = [ADMIN];
const MADE: string[] = [];

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

/** Run the middleware with a cookie, and report what it decided. */
function run(method: string, cookie: string | undefined, path = "/api/dutch-miller/rfid") {
  let nexted = false;
  let status: number | null = null;
  const req = {
    method, path, cookies: cookie ? { [VIEW_AS_COOKIE]: cookie } : {},
    user: { id: "1", email: OWNER, name: "Owner", exp: Date.now() + 1e6, via: "microsoft" },
  } as unknown as Request;
  const res = {
    status(c: number) { status = c; return this; },
    json() { return this; },
    clearCookie() { return this; },
  } as unknown as Response;
  viewAsMiddleware(req, res, (() => { nexted = true; }) as NextFunction);
  return { nexted, status, req };
}

try {
  // An ordinary administrator: every page, no deleting.
  await saveDmUser({ email: ADMIN, roleKey: ADMIN_ROLE, by: OWNER, byRole: "super" });

  console.log("1. The owner holds what an administrator does not");
  const owner = await dmAccessFor(OWNER);
  const admin = await dmAccessFor(ADMIN);
  check("the owner can delete members", owner.deletesSignups);
  check("…and RFIDs", owner.deletesRfid);
  check("…and approve", owner.approves);
  check("an administrator can do none of those",
    !admin.deletesSignups && !admin.deletesRfid && !admin.approves);

  console.log("\n2. Inside a view, req.user IS the viewed person");
  /*
   * The whole fix rests on this. The display flags are computed from
   * `req.user`, so if the middleware did not swap it the buttons would
   * still be the viewer's.
   */
  const viewing = run("GET", formatViewAs(ADMIN, "abc123def456"));
  check("the request goes through", viewing.nexted);
  check("…as the viewed person", viewing.req.user?.email === ADMIN,
    viewing.req.user?.email);
  check("…with the real one kept beside it",
    viewing.req.viewingAs?.real.email === OWNER);
  check("…and the session id, for pairing the log",
    viewing.req.viewingAs?.sid === "abc123def456");

  // So the flags, which read req.user, are the ADMIN's.
  const shown = await dmAccessFor(viewing.req.user?.email ?? "");
  check("so what is SHOWN is theirs: no delete", shown.deletesSignups === false);
  check("…no RFID delete", shown.deletesRfid === false);
  check("…no approve", shown.approves === false);
  check("…and not super", shown.role !== "super");

  console.log("\n3. And none of it becomes an action");
  // The rule the display change must not weaken.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const w = run(method, formatViewAs(ADMIN, "abc123def456"));
    check(`${method} is refused while viewing`, !w.nexted && w.status === 403);
  }
  check("GET is allowed", run("GET", formatViewAs(ADMIN, "abc123def456")).nexted);
  // The one POST that must work, or there is no way out of a view.
  const exit = run("POST", formatViewAs(ADMIN, "abc123def456"), "/api/auth/view-as");
  check("…except the exit", exit.nexted);

  console.log("\n4. Outside a view, nothing changed");
  const normal = run("GET", undefined);
  check("the owner is themselves", normal.req.user?.email === OWNER);
  check("…with no view on it", normal.req.viewingAs === undefined);
  const mine = await dmAccessFor(normal.req.user?.email ?? "");
  check("…and holds everything again", mine.deletesSignups && mine.deletesRfid);

  console.log("\n5. A role's grants show through a view");
  // Granting it must change what the view shows, or the view is not
  // telling you about the role at all.
  const remover = await saveRole({
    name: "Test Scope Remover", pages: ["rfid-review"], administers: false,
    deletesRfid: true, by: OWNER,
  });
  MADE.push(remover.key);
  await saveDmUser({ email: ADMIN, roleKey: remover.key, by: OWNER, byRole: "super" });
  const now = await dmAccessFor(ADMIN);
  check("the viewed person's RFID delete appears", now.deletesRfid);
  check("…and their member delete still does not", now.deletesSignups === false);
  const asActions = actionsFor({
    pages: now.pages, administers: now.role === "admin", approves: now.approves,
    deletesSignups: now.deletesSignups, deletesRfid: now.deletesRfid,
  });
  check("…which the action list agrees with",
    asActions["rfid.delete"] && !asActions["member.delete"]);

  console.log("\n6. Approving follows the viewed role too");
  await saveDmUser({ email: ADMIN, roleKey: CSC_ROLE, by: OWNER, byRole: "super" });
  check("a CSC being viewed shows as able to approve",
    (await dmAccessFor(ADMIN)).approves);
} finally {
  await db().query("DELETE FROM dm_users WHERE email = ANY($1::text[])", [MINE])
    .catch(() => {});
  await db().query("DELETE FROM dm_roles WHERE key = ANY($1::text[])", [MADE])
    .catch(() => {});
  await db().end().catch(() => {});
}

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
