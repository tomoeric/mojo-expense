/**
 * Viewing as somebody must never become acting as them.
 *
 * An admin needs to see what another reviewer sees — their imports, their
 * failures, whether their Emburse login is stored — and the only honest way
 * to do that is to swap the identity the whole app reads. Every write in
 * this app is stamped with that identity: decidedBy on a decision, who saved
 * a rule, who flipped a flag. And an approval reaches Emburse under the
 * decider's own login and carries their name in the finance system
 * permanently.
 *
 * So the rule is not "be careful which writes we allow", it is "allow none".
 * An allow-list of safe methods, so a write route added next month is
 * refused by default rather than discovered later.
 *
 * No browser, no database: the middleware is the whole rule.
 */

import { viewAsMiddleware, VIEW_AS_COOKIE } from "../server/auth/view-as.js";
import { isAuthConfigured } from "../server/auth/index.js";
import type { Request, Response, NextFunction } from "express";

// Sign-in has to look configured, or isAdmin is vacuously true for
// everybody — which is the right behaviour for a deployment with no
// sign-in, and would make the admin half of this file prove nothing.
process.env.AZURE_TENANT_ID ||= "tenant-for-the-test";
process.env.AZURE_CLIENT_ID ||= "client-for-the-test";
process.env.AZURE_CLIENT_SECRET ||= "secret-for-the-test";
process.env.AUTH_ALLOWED ||= "mammothholdings.com";
process.env.AUTH_ADMINS ||= "eric.s@mammothholdings.com";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

type Ran = { nexted: boolean; status: number | null; body: unknown; req: Request };

function run(opts: {
  method: string; path: string; cookie?: string; email?: string | null;
}): Ran {
  const cleared: string[] = [];
  const out: Ran = { nexted: false, status: null, body: null, req: null as never };
  const req = {
    method: opts.method,
    path: opts.path,
    cookies: opts.cookie ? { [VIEW_AS_COOKIE]: opts.cookie } : {},
    ...(opts.email === null
      ? {}
      : { user: { id: "1", email: opts.email ?? "eric.s@mammothholdings.com", name: "Eric" } }),
  } as unknown as Request;
  const res = {
    clearCookie: (n: string) => { cleared.push(n); return res; },
    status: (c: number) => { out.status = c; return res; },
    json: (b: unknown) => { out.body = b; return res; },
  } as unknown as Response;
  viewAsMiddleware(req, res, (() => { out.nexted = true; }) as NextFunction);
  out.req = req;
  return out;
}

const BRIAN = "brian.c@mammothholdings.com";

console.log("\nWith no cookie, nothing changes");
{
  const r = run({ method: "POST", path: "/api/decisions" });
  check("the request goes through", r.nexted);
  check("…as the real person", r.req.user?.email === "eric.s@mammothholdings.com");
  check("…and nothing is being viewed", r.req.viewingAs === undefined);
}

console.log("\nAn admin viewing as somebody else");
{
  const read = run({ method: "GET", path: "/api/reports", cookie: BRIAN });
  check("a read goes through", read.nexted);
  check("…as them", read.req.user?.email === BRIAN, read.req.user?.email);
  check("…and the real person is still known",
    read.req.viewingAs?.real.email === "eric.s@mammothholdings.com");

  // The rule. Not a list of dangerous routes — every method that could
  // change anything, including ones that do not exist yet.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const w = run({ method, path: "/api/decisions", cookie: BRIAN });
    check(`${method} is refused`, !w.nexted && w.status === 403, `status ${w.status}`);
  }
  const refused = run({ method: "POST", path: "/api/decisions", cookie: BRIAN });
  check("…and says why, naming them",
    /viewing the app as/.test(String((refused.body as { error?: string })?.error ?? "")) &&
    String((refused.body as { error?: string })?.error ?? "").includes(BRIAN));

  // The way out has to work from inside the mode, or there is no way out.
  const exit = run({ method: "POST", path: "/api/auth/view-as", cookie: BRIAN });
  check("the control that ends it still works", exit.nexted);
  check("…and it knows who really pressed it",
    exit.req.viewingAs?.real.email === "eric.s@mammothholdings.com");
}

console.log("\nWho may do it at all");
{
  check("sign-in looks configured, or this section proves nothing",
    isAuthConfigured());
  // Checked on every request against the REAL user, so losing admin rights
  // takes effect on the next request rather than at the next sign-in.
  const notAdmin = run({ method: "GET", path: "/api/reports", cookie: BRIAN, email: "katie@mammothholdings.com" });
  check("a non-admin's cookie is ignored", notAdmin.nexted);
  check("…and they stay themselves", notAdmin.req.user?.email === "katie@mammothholdings.com");
  check("…with nothing being viewed", notAdmin.req.viewingAs === undefined);

  const anon = run({ method: "GET", path: "/api/reports", cookie: BRIAN, email: null });
  check("a signed-out caller's cookie is ignored", anon.nexted);
  check("…and gives them no identity", anon.req.user === undefined);

  // Viewing as yourself is not a mode, it is a no-op, and leaving it as one
  // would put a banner on screen that nothing could dismiss.
  const self = run({ method: "POST", path: "/api/decisions", cookie: "eric.s@mammothholdings.com" });
  check("viewing as yourself is simply not viewing", self.nexted && self.req.viewingAs === undefined);
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
