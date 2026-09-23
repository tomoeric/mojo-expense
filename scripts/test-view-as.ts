/**
 * Viewing the app as somebody else.
 *
 *   pnpm exec tsx scripts/test-view-as.ts      (no database or browser needed)
 *
 * The whole safety of this feature is one property: it changes what is SHOWN
 * and nothing else. A decision carries the decider's name into Emburse, so an
 * admin clicking Approve while wearing somebody else's face would put that
 * person's name on a financial approval they never made.
 *
 * The cookie carries a name, never authority — whether it is honoured is
 * re-decided from the real session on every request, so setting it by hand as
 * a non-admin has to achieve nothing.
 */

export {};

process.env.AZURE_TENANT_ID ||= "t";
process.env.AZURE_CLIENT_ID ||= "c";
process.env.AZURE_CLIENT_SECRET ||= "s";
process.env.AUTH_ADMINS = "boss@example.invalid";

const { viewAsMiddleware, refuseWritesWhileViewingAs, VIEW_AS_COOKIE } =
  await import("../server/auth/view-as.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

type Req = {
  user?: { id: string; email: string; name: string; exp: number };
  viewingAs?: { real: string; as: string };
  cookies: Record<string, string>;
  method: string;
  path: string;
};

function run(req: Req) {
  const cleared: string[] = [];
  let status = 0;
  let body: { error?: string } = {};
  const res = {
    cookie: () => res,
    clearCookie: (name: string) => cleared.push(name),
    status(code: number) { status = code; return this; },
    json(payload: { error?: string }) { body = payload; return this; },
  };
  let passedView = false;
  viewAsMiddleware(req as never, res as never, (() => { passedView = true; }) as never);
  let passedWrite = false;
  if (passedView) {
    refuseWritesWhileViewingAs(req as never, res as never, (() => { passedWrite = true; }) as never);
  }
  return { req, cleared, status, error: body.error ?? "", passedWrite };
}

const admin = { id: "1", email: "boss@example.invalid", name: "Boss", exp: Date.now() + 1e6 };
const plain = { id: "2", email: "brian@example.invalid", name: "Brian", exp: Date.now() + 1e6 };
const as = (user: Req["user"], method: string, path: string, cookie = "brian@example.invalid") =>
  run({ user, cookies: { [VIEW_AS_COOKIE]: cookie }, method, path });

console.log("\nWho may do it at all");
const asAdmin = as(admin, "GET", "/api/reports");
check("an admin sees the app as the other person",
  asAdmin.req.user?.email === "brian@example.invalid", asAdmin.req.user?.email);
check("…and the request knows who is really there",
  asAdmin.req.viewingAs?.real === "boss@example.invalid", JSON.stringify(asAdmin.req.viewingAs));

// The cookie is a preference, not a credential. A non-admin setting it by hand
// must get nothing, and must not be left carrying it around.
const asPlain = as(plain, "GET", "/api/reports");
check("a non-admin setting the cookie by hand is ignored",
  asPlain.req.user?.email === "brian@example.invalid" && !asPlain.req.viewingAs,
  JSON.stringify(asPlain.req.viewingAs));
check("…and the cookie is cleared rather than left to confuse them",
  asPlain.cleared.includes(VIEW_AS_COOKIE));
const asSelf = as(admin, "GET", "/api/reports", "boss@example.invalid");
check("viewing as yourself is not a thing", !asSelf.req.viewingAs);

console.log("\nWhat it is allowed to do");
check("reads go through", as(admin, "GET", "/api/reports").passedWrite);

for (const [method, path] of [
  ["POST", "/api/decisions"],
  ["DELETE", "/api/decisions/12"],
  ["POST", "/api/decisions/apply"],
  ["POST", "/api/rules"],
  ["PUT", "/api/rules/3"],
  ["POST", "/api/import"],
] as const) {
  const r = as(admin, method, path);
  check(`${method} ${path} is refused`, !r.passedWrite && r.status === 403, `status ${r.status}`);
}

const decision = as(admin, "POST", "/api/decisions");
check("…and the refusal says why, and how to act for real",
  /read-only/.test(decision.error) && /Stop viewing as them/.test(decision.error), decision.error);

console.log("\nThe two exceptions, and why");
check("switching target is allowed, or you could not change who you are watching",
  as(admin, "POST", "/api/view-as").passedWrite);
check("switching back is allowed, or you could be stuck as them",
  as(admin, "DELETE", "/api/view-as").passedWrite);
check("the dry run is allowed — it decides nothing and is the point of the feature",
  as(admin, "POST", "/api/decisions/42/test").passedWrite);
// Testing the OTHER person's connection is the whole reason to be in their
// view: the first version always tested the admin's own login, which is
// precisely the one that already works.
check("the connection test is allowed, so it can be run as the person who is failing",
  as(admin, "POST", "/api/emburse-check").passedWrite);
check("…but only the dry run, not a decision that looks like one",
  !as(admin, "POST", "/api/decisions/42/testing").passedWrite);

console.log("\nWith nobody signed in");
check("no session means no impersonation", !as(undefined, "GET", "/api/reports").req.viewingAs);

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
