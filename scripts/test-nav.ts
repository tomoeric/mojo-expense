/**
 * Which pages an account's rail holds, and who may change it.
 *
 *   pnpm exec tsx scripts/test-nav.ts
 *
 * One rule carries the whole feature: a page appears AT MOST ONCE in
 * an account's navigation. A picker that only offers unused pages is
 * not that rule — it is a convenience that a second tab, a stale page
 * and a retried request all walk straight past. So the cases below
 * are the ways somebody actually gets two copies of one page: adding
 * it twice, adding it under a different parent, adding it with a
 * different name, and two requests landing together.
 *
 * Also checked: that the base rail is shared and followed rather than
 * copied, that an account's additions are its own, and that a page
 * nobody has shipped cannot be conjured from an account editor.
 */
import { DUTCH_MILLER, createAccount } from "../server/dutch-miller/accounts.js";
import {
  NAV_PAGES, addNav, forgetNav, navFor, navKeys, navOptions, removeNav,
} from "../server/dutch-miller/nav.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

const BY = "eric.s@mojocarwash.com";
let second = "";

try {
  console.log("1. The base rail is what every account starts on");
  const rail = await navFor(DUTCH_MILLER);
  const top = rail.map((i) => i.key);
  check("Member Signups is a heading", rail.find((i) => i.key === "member-signups")?.group
    === true);
  check("…with its two halves under it",
    rail.find((i) => i.key === "member-signups")?.children.length === 2);
  check("Account Registration is a main button", top.includes("account-registration"),
    top.join(", "));
  check("…and so are the two RFID pages",
    top.includes("rfid-instructions") && top.includes("rfid-review"));
  // The whole point of the change. Vendors keeps its page, its route
  // and its records, and leaves the everyday rail.
  check("VENDORS IS NOT ON THE RAIL", !(await navKeys(DUTCH_MILLER)).includes("vendors"));
  check("…but is still in the catalogue", NAV_PAGES.some((p) => p.key === "vendors"));
  check("…and is therefore offered as something to add",
    (await navOptions(DUTCH_MILLER)).pages.some((p) => p.key === "vendors"));
  check("nothing on the base reads as this account's own",
    rail.every((i) => !i.added && i.children.every((c) => !c.added)));

  console.log("\n2. Routes have not moved");
  // Every one of these is in somebody's bookmarks and in sent email.
  const routes = new Map(NAV_PAGES.map((p) => [p.key, p.route]));
  check("Review Existing is still member-signups/review",
    routes.get("member-signups-review") === "member-signups/review");
  check("Add New is still member-signups/add",
    routes.get("member-signups-add") === "member-signups/add");
  check("RFID Inventory is still rfid-review", routes.get("rfid-review") === "rfid-review");
  check("Vendors is still vendors", routes.get("vendors") === "vendors");

  console.log("\n3. Adding a page, as a main button");
  const made = await createAccount({ name: "Nav Motors" }, BY);
  if (!made.ok) throw new Error(made.problem);
  second = made.account.id;

  const asMain = await addNav({
    accountId: second, pageKey: "vendors", parentKey: null, by: BY,
  });
  check("it is added", asMain.ok === true, asMain.ok ? "" : asMain.problem);
  const navA = await navFor(second);
  check("…at the top of the rail", navA.some((i) => i.key === "vendors" && !i.group));
  check("…marked as this account's own",
    navA.find((i) => i.key === "vendors")?.added === true);
  // The one that matters: one account's navigation is its own.
  check("DUTCH MILLER'S RAIL IS UNTOUCHED",
    !(await navKeys(DUTCH_MILLER)).includes("vendors"));

  console.log("\n4. One instance per account, however it is asked for");
  const twice = await addNav({
    accountId: second, pageKey: "vendors", parentKey: null, by: BY,
  });
  check("adding the same page again is refused", twice.ok === false,
    twice.ok ? "" : twice.problem);
  // The two ways somebody gets round a naive check.
  const elsewhere = await addNav({
    accountId: second, pageKey: "vendors", parentKey: "rfid-review", by: BY,
  });
  check("…and under a different parent, refused", elsewhere.ok === false);
  const renamed = await addNav({
    accountId: second, pageKey: "vendors", parentKey: null, label: "Suppliers", by: BY,
  });
  check("…and under a different name, refused", renamed.ok === false,
    renamed.ok ? "" : renamed.problem);
  check("…and it is still there exactly once",
    (await navKeys(second)).filter((k) => k === "vendors").length === 1);

  // A page already on the SHARED base is refused the same way, which
  // is the case somebody hits first: the base is navigation too.
  const fromBase = await addNav({
    accountId: second, pageKey: "rfid-review", parentKey: null, by: BY,
  });
  check("a page already on the shared base is refused too", fromBase.ok === false,
    fromBase.ok ? "" : fromBase.problem);

  console.log("\n5. Two requests landing together");
  /*
   * The reason the duplicate check is a primary key and not a
   * picker. Both of these pass the read that says the page is
   * unused, because both read before either wrote.
   */
  await removeNav(second, "vendors");
  const [a, b] = await Promise.all([
    addNav({ accountId: second, pageKey: "vendors", parentKey: null, by: BY }),
    addNav({ accountId: second, pageKey: "vendors", parentKey: null, by: BY }),
  ]);
  check("exactly one wins", [a.ok, b.ok].filter(Boolean).length === 1,
    `${a.ok} / ${b.ok}`);
  const loser = a.ok ? b : a;
  check("…the loser is told, not silently ignored",
    loser.ok === false && loser.problem.length > 0);
  check("…and the page is on the rail once",
    (await navKeys(second)).filter((k) => k === "vendors").length === 1);

  console.log("\n6. A sub button needs a real parent in the same account");
  await removeNav(second, "vendors");
  const nowhere = await addNav({
    accountId: second, pageKey: "vendors", parentKey: "not-a-button", by: BY,
  });
  check("an invented parent is refused", nowhere.ok === false,
    nowhere.ok ? "" : nowhere.problem);
  check("…saying to pick one that exists",
    !nowhere.ok && nowhere.problem.toLowerCase().includes("main button"),
    nowhere.ok ? "" : nowhere.problem);
  const sub = await addNav({
    accountId: second, pageKey: "vendors", parentKey: "rfid-review",
    label: "Suppliers", by: BY,
  });
  check("an existing main button works", sub.ok === true, sub.ok ? "" : sub.problem);
  const navB = await navFor(second);
  const parent = navB.find((i) => i.key === "rfid-review");
  check("…and the page sits under it",
    parent?.children.some((c) => c.key === "vendors") === true);
  check("…with the name this account gave it",
    parent?.children.find((c) => c.key === "vendors")?.label === "Suppliers");
  // A label is a display name. The KEY is what decides duplicates,
  // and the ROUTE is where the page actually lives.
  check("…while its route is unchanged",
    parent?.children.find((c) => c.key === "vendors")?.route === "vendors");
  check("…and it is still only there once",
    (await navKeys(second)).filter((k) => k === "vendors").length === 1);

  console.log("\n6b. A page nobody shipped cannot be added");
  const ghost = await addNav({
    accountId: second, pageKey: "invoices", parentKey: null, by: BY,
  });
  check("refused", ghost.ok === false, ghost.ok ? "" : ghost.problem);
  check("…saying the template is where a page comes from",
    !ghost.ok && ghost.problem.toLowerCase().includes("template"),
    ghost.ok ? "" : ghost.problem);

  console.log("\n7. The picker offers only what is unused");
  const opts = await navOptions(second);
  const used = new Set(await navKeys(second));
  check("nothing already on the rail is offered",
    opts.pages.every((p) => !used.has(p.key)));
  check("…and every offer is a real page",
    opts.pages.every((p) => NAV_PAGES.some((n) => n.key === p.key)));
  check("the parents offered are all on this account's rail",
    opts.parents.every((p) => navB.some((i) => i.key === p.key)));
  // Every page in the catalogue is now placed. The picker has to say
  // so rather than offering to invent one.
  check("with everything placed, there is nothing left to offer",
    opts.pages.length === 0, opts.pages.map((p) => p.key).join(", "));

  console.log("\n8. Taking one back off");
  const gone = await removeNav(second, "vendors");
  check("an added page can be removed", gone.ok === true, gone.ok ? "" : gone.problem);
  check("…and is offered again",
    (await navOptions(second)).pages.some((p) => p.key === "vendors"));
  // The base is the shared rail. An account emptying it would be an
  // outage with no way back from inside the app.
  const base = await removeNav(second, "rfid-review");
  check("a page from the shared base cannot be removed", base.ok === false,
    base.ok ? "" : base.problem);
  check("…and is still there", (await navKeys(second)).includes("rfid-review"));

} finally {
  if (second) {
    await forgetNav(second).catch(() => undefined);
    await db().query("DELETE FROM dm_accounts WHERE id = $1", [second])
      .catch(() => undefined);
  }
  await db().query("DELETE FROM dm_account_nav WHERE account_id = $1", [DUTCH_MILLER])
    .catch(() => undefined);
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
