/**
 * Job titles, and the two ways this could go quietly wrong.
 *
 *   pnpm exec tsx scripts/test-titles.ts   (needs DATABASE_URL)
 *
 * "If we identify a corporate receipt from job titles (rule) then they
 * get auto denied." So a title feeds an unattended DENIAL, which makes
 * two things matter more than the feature itself.
 *
 * THE JOIN. The export carries a name and no email — "scott pashley"
 * where the directory says "Scott Pashley" — so the key is a normalised
 * name, computed in TypeScript when stored and in SQL when read. Two
 * implementations of one key is how a title gets stored under one and
 * looked up under another, so they are pinned to each other here.
 *
 * THE UNKNOWN. A name we could not match has no title, and a rule like
 * "title is not Store Manager → deny" must SKIP those people rather than
 * deny them. Failing open is the only acceptable direction for a denial
 * nobody is watching.
 */

export {};

process.env.SESSION_SECRET ||= "test-secret-titles";

const { db, ensureSchema } = await import("../server/db.js");
const { nameKey, setTitles, titleCoverage, KEY_SQL } = await import("../server/people/titles.js");
const store = await import("../server/rules/store.js");
const { evaluate } = await import("../server/rules/engine.js");
const type = await import("../server/rules/engine.js");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const clean = async (): Promise<void> => {
  await db().query("DELETE FROM expenses WHERE dedupe_key LIKE 'ti-%'");
  await db().query("DELETE FROM employee_titles WHERE source = 'test'");
};

await ensureSchema();
await store.ensureRules();

try {
  await clean();

  console.log("\n1. One name, written the ways people write it");
  check("case does not matter", nameKey("scott pashley") === nameKey("Scott Pashley"));
  check("…nor does the order", nameKey("Pashley, Scott") === nameKey("Scott Pashley"));
  check("…nor a middle initial",
    nameKey("Craig W Demoranville") === nameKey("Craig Demoranville"));
  check("but two different people stay different",
    nameKey("Josh Yankiver") !== nameKey("Jonathan Roath"));

  console.log("\n2. The SQL key agrees with the TypeScript one");
  // Two implementations of one key is how a title gets stored under one
  // and looked up under another — and the symptom is simply no titles,
  // with nothing anywhere saying why.
  {
    const names = [
      "scott pashley", "Scott Pashley", "Pashley, Scott", "Craig W Demoranville",
      "Craig Demoranville", "Jonathan Roath", "Alejandro Guerrero", "O'Brien, Sean",
      "Mary-Jane Watson", "JOSH  YANKIVER",
    ];
    const { rows } = await db().query<{ n: string; k: string }>(
      `SELECT n, ${KEY_SQL("n")} AS k FROM unnest($1::text[]) AS n`, [names]);
    const off = rows.filter((r) => r.k !== nameKey(r.n));
    check("every spelling keys the same in both",
      off.length === 0,
      off.map((r) => `${r.n}: sql “${r.k}” vs ts “${nameKey(r.n)}”`).join(" | "));
  }

  console.log("\n3. A title reaches the rule engine");
  await db().query(
    `INSERT INTO expenses (dedupe_key, reviewer, employee, merchant, amount_cents,
                           expense_date, category, note)
     VALUES ('ti-1','e@t.invalid','scott pashley','Uber',6397,'2026-09-13',
             'Travel - Mileage & Ground Transportation','Uber to airport'),
            ('ti-2','e@t.invalid','Nobody Indirectory','Uber',1000,'2026-09-13',
             'Travel - Mileage & Ground Transportation','Uber')`);
  // The directory spells him properly; the export does not.
  check("titles stored", await setTitles([{ name: "Scott Pashley", title: "Marketing Director" }],
    "test") === 1);

  const subs = await store.subjects(db(), ["ti-1", "ti-2"]);
  const scott = subs.find((x) => x.dedupeKey === "ti-1");
  const nobody = subs.find((x) => x.dedupeKey === "ti-2");
  check("the title is on the subject despite the casing",
    scott?.title === "Marketing Director", scott?.title);
  check("…and an unmatched person has none", nobody?.title === "", `“${nobody?.title}”`);

  console.log("\n4. An unknown title DENIES NOBODY");
  {
    const denyRule = {
      id: 1, name: "Corporate", enabled: true, match: "all" as const,
      when: [{ field: "title" as const, op: "contains" as const, value: "Director" }],
      must: null, action: "deny" as const, message: "Corporate card, corporate review",
      createdBy: null, createdAt: "", updatedBy: null, updatedAt: "", lastRunAt: null,
    };
    check("it catches the person it knows about",
      evaluate(scott!, denyRule) === "fail", evaluate(scott!, denyRule));
    check("…and does not apply to the one it does not",
      evaluate(nobody!, denyRule) === "not-applicable", evaluate(nobody!, denyRule));

    // The dangerous inverse: "anyone who is NOT a store manager".
    const inverse = {
      ...denyRule,
      when: [{ field: "title" as const, op: "is_not" as const, value: "Store Manager" }],
    };
    check("an inverse rule still skips the unknown — it does not deny them",
      evaluate(nobody!, inverse) === "not-applicable", evaluate(nobody!, inverse));
    check("…while still catching the known one", evaluate(scott!, inverse) === "fail");
  }

  console.log("\n5. Coverage says who is missing, by name");
  {
    const cover = await titleCoverage();
    check("the matched one is listed",
      cover.matched.some((m) => m.employee === "scott pashley"));
    check("…and the unmatched one is named",
      cover.unmatched.includes("Nobody Indirectory"), JSON.stringify(cover.unmatched));
  }

  console.log("\n6. A person with no title in the directory is not stored blank");
  // "" would mean "they have no job", which behaves differently in a rule
  // from "we do not know".
  check("a blank title is skipped",
    await setTitles([{ name: "Someone Else", title: "   " }], "test") === 0);
} finally {
  await clean();
  await db().end();
}

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
