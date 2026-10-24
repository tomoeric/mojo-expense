/**
 * No backticks inside a SQL template literal.
 *
 * `const SCHEMA = ` opens a template literal, so a backtick in a
 * comment inside it CLOSES the string and the rest of the file parses
 * as code. The error lands dozens of lines away and says "',' expected",
 * which points at nothing useful. It has happened three times.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
});

let bad = 0;
for (const file of walk("server")) {
  const text = readFileSync(file, "utf8");
  // Every `const X = \`` ... \`;` block whose body looks like SQL.
  const re = /const\s+\w+\s*(?::\s*string\s*)?=\s*`([\s\S]*?)`;/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    if (!/\b(CREATE|ALTER|INSERT|UPDATE|SELECT)\b/i.test(body)) continue;
    if (!body.includes("`")) continue;
    const line = text.slice(0, m.index).split("\n").length;
    console.error(`${file}:${line} — backtick inside a SQL template literal.`);
    bad++;
  }
}
if (bad > 0) {
  console.error("\nUse plain words in comments inside SQL templates.");
  process.exit(1);
}
console.log("SQL templates clean.");
