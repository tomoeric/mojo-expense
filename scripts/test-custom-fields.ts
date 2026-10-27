/**
 * A field defined in the template, with each account's data its own.
 *
 *   pnpm exec tsx scripts/test-custom-fields.ts
 *
 * The buckets arrange what the application registered, and that
 * vocabulary is fixed on purpose — but a partner asking for "Deal
 * Jacket #" cannot be told to wait for a deploy. So a field can be
 * DEFINED in the template, shared like everything else there, with
 * the DATA kept per account.
 *
 * That split is the risk, so these are the cases:
 *
 *   The definition is shared — every account can place it, and a
 *   rename reaches them all.
 *
 *   The data is NOT. One partner's answer must not be readable by
 *   another even when they ask for the same subject id.
 *
 *   A key nobody defined is refused rather than stored, and a
 *   retired field keeps every answer written against it.
 *
 *   A custom field is never essential, because no workflow written
 *   before it existed can depend on it.
 */
import {
  archiveField, fieldUsage, listFields, saveField, saveValues, valuesFor, valuesForMany,
} from "../server/dutch-miller/fields.js";
import {
  essentialOn, forgetLayouts, itemsFor, layoutFor, listBlocks, saveBlock, saveLayout,
} from "../server/dutch-miller/blocks.js";
import { DUTCH_MILLER, createAccount } from "../server/dutch-miller/accounts.js";
import { db } from "../server/db.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};
const refused = async (fn: () => Promise<{ ok: boolean; problem?: string }>) => {
  const out = await fn();
  return out.ok ? "" : (out.problem ?? "refused");
};

const PAGE = "member-signups-review" as const;
const BY = "eric.s@mojocarwash.com";
const MADE: string[] = [];
const FIELDS: string[] = [];
let second = "";
let bucketWas: string[] = [];

try {
  const made = await createAccount({ name: "Jacket Motors" }, BY);
  if (!made.ok) throw new Error(made.problem);
  second = made.account.id;
  MADE.push(second);

  console.log("1. Defining a field");
  const out = await saveField({
    page: PAGE, label: "Deal Jacket #", input: "text",
    note: "The paper file this deal lives in.",
  }, BY);
  check("it is created", out.ok === true, out.ok ? "" : out.problem);
  if (!out.ok) throw new Error(out.problem);
  const key = out.field.key;
  FIELDS.push(key);
  check("…with a key that cannot shadow a code one", key.startsWith("cf_"), key);
  check("…flagged as new without being asked", out.field.newUntil !== null);

  const vocab = await itemsFor(PAGE);
  check("it joins the page's vocabulary", vocab.some((i) => i.key === key));
  check("…marked as the template's rather than code's",
    vocab.find((i) => i.key === key)?.custom === true);
  check("…AND IS NOT ESSENTIAL", !essentialOn(PAGE).includes(key));

  console.log("\n2. Putting it in a shared bucket");
  const bucket = (await listBlocks(PAGE)).find((b) => b.id === "blk_review_dealer")!;
  bucketWas = bucket.items;
  const put = await saveBlock({
    id: bucket.id, page: PAGE, name: bucket.name,
    items: [...bucket.items, key], columns: bucket.columns,
  }, BY);
  check("the bucket accepts it", put.ok === true, put.ok ? "" : put.problem);
  const dm = (await layoutFor(DUTCH_MILLER, PAGE)).find((b) => b.id === bucket.id);
  check("it renders in Dutch Miller's page", dm?.items.includes(key) === true);
  const other = (await layoutFor(second, PAGE)).find((b) => b.id === bucket.id);
  check("…and in the other partner's too — ONE definition",
    other?.items.includes(key) === true);

  console.log("\n3. The data is each account's");
  const wrote = await saveValues({
    accountId: DUTCH_MILLER, page: PAGE, subject: "member-1",
    values: { [key]: "DJ-4417" }, by: BY,
  });
  check("Dutch Miller's answer is stored", wrote.ok === true,
    wrote.ok ? "" : wrote.problem);
  check("…and reads back", (await valuesFor(DUTCH_MILLER, PAGE, "member-1"))[key] === "DJ-4417");
  const theirs = await valuesFor(second, PAGE, "member-1");
  check("THE OTHER PARTNER SEES NOTHING, for the same subject id",
    theirs[key] === undefined, JSON.stringify(theirs));

  await saveValues({
    accountId: second, page: PAGE, subject: "member-1",
    values: { [key]: "JACKET-9" }, by: BY,
  });
  check("it writes its own answer", (await valuesFor(second, PAGE, "member-1"))[key] === "JACKET-9");
  check("…without touching the first",
    (await valuesFor(DUTCH_MILLER, PAGE, "member-1"))[key] === "DJ-4417");
  const many = await valuesForMany(DUTCH_MILLER, PAGE, ["member-1", "member-2"]);
  check("a table's worth reads in one query, still scoped",
    many.get("member-1")?.[key] === "DJ-4417" && many.has("member-2") === false);

  console.log("\n4. What is refused");
  const unknown = await refused(() => saveValues({
    accountId: DUTCH_MILLER, page: PAGE, subject: "member-1",
    values: { notAField: "x" }, by: BY,
  }));
  check("a key nobody defined is refused", unknown.includes("not a field"), unknown);
  const listed = await saveField({
    page: PAGE, label: "Jacket state", input: "select", options: ["Open", "Filed"],
  }, BY);
  if (!listed.ok) throw new Error(listed.problem);
  FIELDS.push(listed.field.key);
  const offList = await refused(() => saveValues({
    accountId: DUTCH_MILLER, page: PAGE, subject: "member-1",
    values: { [listed.field.key]: "Shredded" }, by: BY,
  }));
  check("a choice that is not on the list is refused",
    offList.includes("choices"), offList);
  const noOptions = await saveField({ page: PAGE, label: "Empty list", input: "select" }, BY);
  check("a list field with no choices is refused", noOptions.ok === false,
    noOptions.ok ? "" : noOptions.problem);

  console.log("\n5. Renaming reaches everybody; retiring loses nothing");
  const renamed = await saveField({ key, page: PAGE, label: "Jacket #", input: "text" }, BY);
  check("the label changes", renamed.ok === true && renamed.field.label === "Jacket #");
  check("…and the key did not", renamed.ok === true && renamed.field.key === key);
  check("…so both accounts' answers still resolve",
    (await valuesFor(DUTCH_MILLER, PAGE, "member-1"))[key] === "DJ-4417"
    && (await valuesFor(second, PAGE, "member-1"))[key] === "JACKET-9");
  check("the new label reaches both",
    (await itemsFor(PAGE)).find((i) => i.key === key)?.label === "Jacket #");

  check("it holds answers", (await fieldUsage(key)) === 2, String(await fieldUsage(key)));
  await archiveField(key, true);
  check("retired, it leaves the vocabulary",
    !(await itemsFor(PAGE)).some((i) => i.key === key));
  check("…and stops rendering, without being taken out of the bucket",
    (await layoutFor(DUTCH_MILLER, PAGE)).find((b) => b.id === bucket.id)
      ?.items.includes(key) === false);
  check("…while every answer is kept", (await fieldUsage(key)) === 2);
  await archiveField(key, false);
  check("bringing it back brings the answers with it",
    (await valuesFor(DUTCH_MILLER, PAGE, "member-1"))[key] === "DJ-4417"
    && (await layoutFor(DUTCH_MILLER, PAGE)).find((b) => b.id === bucket.id)
      ?.items.includes(key) === true);

  console.log("\n6. An account that has picked its own fields is offered it, not given it");
  const picked = await saveLayout(second, PAGE, [{
    blockId: bucket.id, position: 10, width: 6, height: "auto",
    items: bucketWas,
  }], BY);
  check("it picks the bucket's original fields", picked.ok === true,
    picked.ok ? "" : picked.problem);
  const third = await saveField({ page: PAGE, label: "Jacket note", input: "textarea" }, BY);
  if (!third.ok) throw new Error(third.problem);
  FIELDS.push(third.field.key);
  await saveBlock({
    id: bucket.id, page: PAGE, name: bucket.name,
    items: [...bucketWas, key, third.field.key], columns: bucket.columns,
  }, BY);
  check("Dutch Miller, which had not picked, gets it",
    (await layoutFor(DUTCH_MILLER, PAGE)).find((b) => b.id === bucket.id)
      ?.items.includes(third.field.key) === true);
  check("the one that HAD picked does not",
    (await layoutFor(second, PAGE)).find((b) => b.id === bucket.id)
      ?.items.includes(third.field.key) === false);
  check("…and it is in that bucket's available inventory",
    (await listBlocks(PAGE)).find((b) => b.id === bucket.id)!.items
      .includes(third.field.key));

} finally {
  console.log("\nCleaning up");
  if (bucketWas.length > 0) {
    await saveBlock({
      id: "blk_review_dealer", page: PAGE, name: "Dealer",
      items: bucketWas, columns: 3,
    }, "test-cleanup").catch(() => undefined);
  }
  for (const k of FIELDS) {
    await db().query("DELETE FROM dm_custom_values WHERE field_key = $1", [k])
      .catch(() => undefined);
    await db().query("DELETE FROM dm_template_fields WHERE key = $1", [k])
      .catch(() => undefined);
  }
  await forgetLayouts(DUTCH_MILLER).catch(() => undefined);
  for (const id of MADE) {
    await forgetLayouts(id).catch(() => undefined);
    await db().query("DELETE FROM dm_custom_values WHERE account_id = $1", [id])
      .catch(() => undefined);
    await db().query("DELETE FROM dm_accounts WHERE id = $1", [id]).catch(() => undefined);
  }
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
