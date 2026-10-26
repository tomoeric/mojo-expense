/**
 * One partner must not be able to reach another. Over HTTP.
 *
 *   pnpm exec tsx scripts/test-isolation.ts
 *
 * Every other suite here calls the modules directly, which is the
 * right level for "does this rule hold". It is the wrong level for
 * this one. Account isolation is enforced by MIDDLEWARE, on a header
 * a browser sends, mounted in an order that a type checker cannot
 * see — the first version of it was defeated by a route collision
 * that compiled perfectly. So this one speaks to a real server over
 * a real socket, with a real session cookie.
 *
 * What it proves, and nothing less is enough:
 *
 *   A scoped administrator naming another partner — in the header,
 *   in the query string, however they ask — is refused, not quietly
 *   given their own data back and not given the other partner's.
 *
 *   They cannot create a partner account, and cannot give themselves
 *   one. Scope is a grant, so widening it is the account
 *   administrator's alone.
 *
 *   A deactivated account refuses a saved link ON THE SERVER, and
 *   says what happened rather than pretending the account is not
 *   theirs.
 *
 * The app is assembled here rather than imported from index.ts, which
 * would start the export scheduler, the decision worker and three
 * timers. The stack below is the same one, in the same order — if
 * index.ts ever gains a layer ahead of the Dutch Miller mount, it
 * belongs here too.
 */
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

process.env.SESSION_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.DM_SUPER_ADMINS = "owner@mojocarwash.com";
process.env.DUTCH_MILLER_ALLOWED = "owner@mojocarwash.com, scoped@mojocarwash.com";
process.env.AUTH_ALLOWED ||= "mojocarwash.com";

const { authMiddleware, requireApp } = await import("../server/auth/index.js");
const { viewAsMiddleware } = await import("../server/auth/view-as.js");
const { dutchMillerRouter } = await import("../server/dutch-miller/routes.js");
const { db } = await import("../server/db.js");

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const OWNER = "owner@mojocarwash.com";
const SCOPED = "scoped@mojocarwash.com";

/** A session cookie, signed the way `session.ts` signs one. */
const cookie = (email: string): string => {
  const u = { id: email, email, name: email, exp: Date.now() + 3_600_000, via: "microsoft" };
  const payload = Buffer.from(JSON.stringify(u)).toString("base64url");
  const mac = crypto.createHmac("sha256", process.env.SESSION_SECRET!)
    .update(payload).digest("base64url");
  return `mojo_sid=${payload}.${mac}`;
};

const app = express();
app.use((req, res, next) => (req.path === "/api/dutch-miller/rfid/upload"
  || req.path === "/api/dutch-miller/signups/bulk/check"
  ? next()
  : express.json({ limit: "1mb" })(req, res, next)));
app.use(cookieParser());
app.use(authMiddleware);
app.use(viewAsMiddleware);
app.use("/api/dutch-miller", requireApp("dutch-miller"), dutchMillerRouter);

const server = app.listen(0);
await new Promise<void>((done) => server.once("listening", () => done()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Answer = { status: number; body: Record<string, unknown> };
const call = async (
  method: "GET" | "POST", path: string, email: string,
  opts: { slug?: string; body?: unknown } = {},
): Promise<Answer> => {
  const headers: Record<string, string> = { cookie: cookie(email) };
  if (opts.slug) headers["x-partner-account"] = opts.slug;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, {
    method, headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* not json */ }
  return { status: res.status, body };
};

let probeId = "";
let probeSlug = "";

try {
  console.log("1. The shell's first read resolves a partner");
  const me = await call("GET", "/api/dutch-miller/me", OWNER);
  check("the owner is let in", me.status === 200, String(me.status));
  check("…the platform is named", me.body.platform === "MOJO Partners");
  const account = me.body.account as { slug?: string; line?: string } | null;
  check("…a partner is resolved", account?.slug === "dutchmiller", JSON.stringify(account));
  check("…reading as the live header does",
    account?.line === "Dutch Miller — SUDS Car Wash", account?.line);
  check("…and they are the account administrator", me.body.isAccountAdmin === true);

  /*
   * The route collision that compiled. GET /events is the live
   * stream; an earlier version of the event log was added at the
   * same path and silently shadowed it, which nothing but a real
   * request could have shown.
   */
  const stream = await fetch(`${base}/api/dutch-miller/events`,
    { headers: { cookie: cookie(OWNER) } });
  check("GET /events is still the live stream",
    (stream.headers.get("content-type") ?? "").includes("event-stream"),
    stream.headers.get("content-type") ?? String(stream.status));
  await stream.body?.cancel();

  console.log("\n2. Provisioning is the account administrator's");
  const made = await call("POST", "/api/dutch-miller/accounts", OWNER,
    { body: { name: "Isolation Motors", affiliation: "SUDS Car Wash" } });
  check("a partner is created", made.status === 200 && made.body.created === true,
    JSON.stringify(made.body).slice(0, 140));
  const acct = made.body.account as { id: string; slug: string };
  probeId = acct?.id ?? "";
  probeSlug = acct?.slug ?? "";
  const twice = await call("POST", "/api/dutch-miller/accounts", OWNER,
    { body: { name: "Isolation Motors", affiliation: "SUDS Car Wash" } });
  check("…and a retried request does not make a second",
    twice.body.created === false
    && (twice.body.account as { id: string }).id === probeId);
  const reserved = await call("POST", "/api/dutch-miller/accounts", OWNER,
    { body: { name: "Api", slug: "api" } });
  check("a path the application needs is refused", reserved.status === 400);

  console.log("\n3. A header naming an account you do not hold");
  const nowhere = await call("GET", "/api/dutch-miller/me", OWNER, { slug: "no-such-partner" });
  check("an account that does not exist is refused", nowhere.status === 403);

  console.log("\n4. A scoped administrator stays in their own partner");
  const role = await call("POST", "/api/dutch-miller/users", OWNER,
    { body: { email: SCOPED, roleKey: "administrator" } });
  check("they are given an administrator role", role.status === 200,
    JSON.stringify(role.body).slice(0, 120));
  const scope = await call("POST",
    `/api/dutch-miller/users/${encodeURIComponent(SCOPED)}/accounts`, OWNER,
    { body: { accounts: [probeId], allAccounts: false } });
  check("…and exactly one partner", scope.status === 200, JSON.stringify(scope.body));

  const theirs = await call("GET", "/api/dutch-miller/me", SCOPED);
  check("they land in it without asking",
    (theirs.body.account as { slug?: string } | null)?.slug === probeSlug);
  check("…and are offered no other", (theirs.body.accounts as unknown[]).length === 1);
  check("…and are not an account administrator", theirs.body.isAccountAdmin === false);

  // The three ways somebody would actually try it.
  const byHeader = await call("GET", "/api/dutch-miller/signups", SCOPED,
    { slug: "dutchmiller" });
  check("naming another partner in the header is refused", byHeader.status === 403,
    String(byHeader.status));
  const byQuery = await call("GET", "/api/dutch-miller/signups?account=dutchmiller", SCOPED);
  check("…in the query string, refused", byQuery.status === 403, String(byQuery.status));
  const byId = await call("GET", `/api/dutch-miller/signups?account=${"acct_dutchmiller"}`,
    SCOPED);
  check("…by the account's id, refused", byId.status === 403, String(byId.status));

  // Refused, not quietly answered from their own account. The
  // difference matters: a silent fallback reads as success and
  // teaches somebody that the parameter works.
  const own = await call("GET", "/api/dutch-miller/signups", SCOPED, { slug: probeSlug });
  check("their own list answers, and is their own", own.status === 200
    && (own.body.counts as { total: number }).total === 0,
  JSON.stringify(own.body.counts));

  console.log("\n5. An administrator cannot widen their own reach");
  const mint = await call("POST", "/api/dutch-miller/accounts", SCOPED,
    { body: { name: "Sneaky Ford" } });
  check("they cannot create a partner", mint.status === 403, String(mint.status));
  const grab = await call("POST",
    `/api/dutch-miller/users/${encodeURIComponent(SCOPED)}/accounts`, SCOPED,
    { body: { accounts: [], allAccounts: true } });
  check("…nor give themselves every partner", grab.status === 403, String(grab.status));
  const kill = await call("POST", `/api/dutch-miller/accounts/${probeId}/status`, SCOPED,
    { body: { active: false, reason: "because I can" } });
  check("…nor deactivate one", kill.status === 403, String(kill.status));

  console.log("\n6. Deactivation is refused on the server, not hidden in the UI");
  const off = await call("POST", `/api/dutch-miller/accounts/${probeId}/status`, OWNER,
    { body: { active: false, reason: "Isolation run finished." } });
  check("it switches off", off.status === 200, JSON.stringify(off.body).slice(0, 120));
  const deep = await call("GET", "/api/dutch-miller/signups", SCOPED, { slug: probeSlug });
  check("a saved link into it is refused", deep.status === 403, String(deep.status));
  // Told what happened, rather than that the account is not theirs.
  // It IS theirs; it is shut, and the reason is the thing they need.
  check("…and says it was deactivated", deep.body.accountOff === true);
  check("…with the reason on it",
    String(deep.body.error ?? "").includes("Isolation run finished"),
    String(deep.body.error ?? ""));
  const kept = await call("GET", "/api/dutch-miller/accounts", OWNER);
  check("an account administrator still sees it, to bring it back",
    (kept.body.accounts as { id: string }[]).some((a) => a.id === probeId));
  console.log("\n7. Layouts are per account, and the template is not an admin's to change");
  // Back on, so the scoped admin can work in it again.
  await call("POST", `/api/dutch-miller/accounts/${probeId}/status`, OWNER,
    { body: { active: true, reason: "" } });

  const page = "member-signups-review";
  const mine = await call("GET", `/api/dutch-miller/blocks/${page}`, SCOPED,
    { slug: probeSlug });
  check("a page's layout answers", mine.status === 200, String(mine.status));
  check("…for their own account",
    (mine.body.account as { id: string }).id === probeId);
  check("…and they may arrange it", mine.body.canArrange === true);

  const arranged = await call("POST", `/api/dutch-miller/blocks/${page}/layout`, SCOPED,
    {
      slug: probeSlug,
      body: {
        layout: [
          { blockId: "blk_review_customer", position: 10, width: 4, height: "auto" },
          { blockId: "blk_review_auto", position: 20, width: 2, height: "auto" },
        ],
      },
    });
  check("they can arrange their own page", arranged.status === 200,
    JSON.stringify(arranged.body).slice(0, 140));

  // The one that matters over HTTP: arranging one account's page must
  // not reach another's, and the header is the only thing naming it.
  const dmLayout = await call("GET", `/api/dutch-miller/blocks/${page}`, OWNER,
    { slug: "dutchmiller" });
  const first = (dmLayout.body.layout as { id: string }[])[0];
  check("DUTCH MILLER'S PAGE IS UNTOUCHED", first?.id === "blk_review_auto", first?.id);

  const hidden = await call("POST", `/api/dutch-miller/blocks/${page}/layout`, SCOPED,
    {
      slug: probeSlug,
      body: {
        layout: [{
          blockId: "blk_review_customer", position: 10, width: 6, height: "auto",
          hidden: true,
        }],
      },
    });
  check("hiding a bucket the workflow depends on is refused", hidden.status === 400,
    String(hidden.status));
  check("…saying which item", String(hidden.body.error ?? "").includes("RFID"),
    String(hidden.body.error ?? ""));

  const forge = await call("POST", "/api/dutch-miller/template/blocks", SCOPED,
    { slug: probeSlug, body: { page, name: "Sneaky", items: ["firstName"] } });
  check("an admin cannot change the shared template", forge.status === 403,
    String(forge.status));
  const forgeBase = await call("POST", `/api/dutch-miller/template/layout/${page}`, SCOPED,
    { slug: probeSlug, body: { layout: [] } });
  check("…nor the base layout every partner starts on", forgeBase.status === 403,
    String(forgeBase.status));

  console.log("\n8. Navigation and registration are the account's own");
  const nav = await call("GET", "/api/dutch-miller/nav/options", SCOPED,
    { slug: probeSlug });
  check("the picker answers for their account", nav.status === 200, String(nav.status));
  check("…naming it",
    (nav.body.account as { id: string }).id === probeId);

  const added = await call("POST", "/api/dutch-miller/nav", SCOPED,
    { slug: probeSlug, body: { pageKey: "vendors", parentKey: null } });
  check("they can add a page to their own rail", added.status === 200,
    JSON.stringify(added.body).slice(0, 140));
  const navTwice = await call("POST", "/api/dutch-miller/nav", SCOPED,
    { slug: probeSlug, body: { pageKey: "vendors", parentKey: "rfid-review" } });
  check("…but not a second time, even under another parent", navTwice.status === 400,
    String(navTwice.status));
  const ghost = await call("POST", "/api/dutch-miller/nav", SCOPED,
    { slug: probeSlug, body: { pageKey: "invoices", parentKey: null } });
  check("…and not a page nobody shipped", ghost.status === 400, String(ghost.status));

  // The one that matters: one account's rail is its own.
  const dmNav = await call("GET", "/api/dutch-miller/me", OWNER, { slug: "dutchmiller" });
  const dmKeys = (dmNav.body.rail as { key: string; children: { key: string }[] }[])
    .flatMap((i) => [i.key, ...i.children.map((c) => c.key)]);
  check("DUTCH MILLER'S RAIL IS UNTOUCHED", !dmKeys.includes("vendors"), dmKeys.join(","));
  check("…and still carries Account Registration",
    dmKeys.includes("account-registration"), dmKeys.join(","));

  const theirBiz = await call("GET", "/api/dutch-miller/business", SCOPED,
    { slug: probeSlug });
  check("their registration answers", theirBiz.status === 200, String(theirBiz.status));
  check("…as an empty draft, not another partner's record",
    (theirBiz.body.record as { status: string; fields: Record<string, string> }).status
      === "draft"
    && (theirBiz.body.record as { fields: Record<string, string> }).fields.legalName === "");
  const reachBiz = await call("GET", "/api/dutch-miller/business", SCOPED,
    { slug: "dutchmiller" });
  check("reaching the other partner's registration is refused", reachBiz.status === 403,
    String(reachBiz.status));

} finally {
  if (probeId) {
    await db().query("DELETE FROM dm_account_layout WHERE account_id = $1", [probeId])
      .catch(() => undefined);
    await db().query("DELETE FROM dm_account_nav WHERE account_id = $1", [probeId])
      .catch(() => undefined);
    await db().query("DELETE FROM dm_business WHERE account_id = $1", [probeId])
      .catch(() => undefined);
  }
  if (probeId) {
    await db().query("DELETE FROM dm_settings WHERE account_id = $1", [probeId])
      .catch(() => undefined);
    await db().query("DELETE FROM dm_accounts WHERE id = $1", [probeId])
      .catch(() => undefined);
  }
  await db().query("DELETE FROM dm_account_access WHERE email = $1", [SCOPED])
    .catch(() => undefined);
  await db().query("DELETE FROM dm_users WHERE email = $1", [SCOPED])
    .catch(() => undefined);
  server.close();
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
