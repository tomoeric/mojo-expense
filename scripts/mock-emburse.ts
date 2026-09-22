/**
 * A stand-in for Emburse, so the export runner can be tested without a tenant.
 *
 * It does not prove the real selectors are right — nothing outside Emburse can.
 * It proves the machinery around them: that sign-in is skipped when a session
 * exists, that section chips are read before being clicked rather than toggled
 * blind, that the run refuses to proceed when the dialog is scoped to a row
 * selection, that a queued export is polled rather than assumed ready, and that
 * the download arrives as a PDF and reaches the importer.
 *
 * Those are the parts that would otherwise only be exercised in production.
 *
 *   pnpm exec tsx scripts/mock-emburse.ts [port]
 *
 * `startMock` is exported so the test harness can run one in-process rather
 * than making the reader juggle two terminals.
 */

import express from "express";
import type { Server } from "node:http";
import fs from "node:fs";

export type MockHandle = { url: string; state: () => State; reset: () => void; close: () => Promise<void> };

type State = {
  signedIn: boolean;
  admin: boolean;
  receiptsFilter: boolean;
  sections: Record<string, boolean>;
  rowsTicked: number;
  pendingUser: string;
  loginOutcome: "ok" | "rejected" | "mfa";
  search: string;
  format: string;
  requestedAt: number | null;
};

export function startMock(port: number, pdfPath: string): Promise<MockHandle> {
const app = express();
app.use(express.urlencoded({ extended: false }));

const state: State = {
  signedIn: false,
  admin: false,
  receiptsFilter: false,
  // Deliberately wrong to begin with: Denied on, Needs Manager Review off. A
  // runner that clicks blindly will invert them instead of correcting them.
  sections: {
    "Needs Review": true, "Needs Manager Review": false,
    "Pending Submission": false, Denied: true, Completed: false,
  },
  rowsTicked: 0,
  pendingUser: "",
  loginOutcome: "ok",
  search: "",
  format: "CSV",
  requestedAt: null,
};

/** How long the fake export takes to become downloadable. */
const EXPORT_MS = 2000;

/** A handful of rows, deliberately including two that are nearly identical. */
const ROWS = [
  { date: "9/13/2026", merchant: "DOORDASH INC.", who: "Brianna Ruth", amount: "26.40" },
  { date: "9/13/2026", merchant: "DOORDASH INC.", who: "Kevin McBride", amount: "26.40" },
  { date: "9/12/2026", merchant: "DOORDASH INC.", who: "Brianna Ruth", amount: "126.40" },
  { date: "9/13/2026", merchant: "SHELL OIL", who: "Brianna Ruth", amount: "44.10" },
];

const grid = (search: string) => {
  const term = search.trim().toLowerCase();
  const shown = term ? ROWS.filter((r) => r.merchant.toLowerCase().includes(term)) : ROWS;
  return `<table><thead><tr><th>Date</th><th>Merchant</th><th>Employee</th><th>Amount</th><th></th></tr></thead>
    <tbody>${shown
      .map(
        (r) => `<tr><td>${r.date}</td><td>${r.merchant}</td><td>${r.who}</td><td>$${r.amount}</td>
        <td><button>APPROVE</button> <button aria-label="more">&#8942;</button></td></tr>`,
      )
      .join("")}</tbody></table>`;
};

const page = (body: string) => `<!doctype html><html><body style="font-family:sans-serif">${body}</body></html>`;

app.get("/", (_req, res) => {
  if (!state.signedIn) {
    // Email first, password on the next screen — the shape account.emburse.app
    // actually uses, and the one that defeats filling both at once.
    res.redirect("/identity");
    return;
  }
  res.send(page(`
    <a href="/admin">ADMIN</a> <a href="/personal">PERSONAL</a>
    <a href="/transactions">Transactions</a>`));
});

app.get("/identity", (_req, res) => {
  // Drawn by JavaScript after a beat, like account.emburse.app. A check that
  // runs the instant domcontentloaded fires sees an empty page here, which is
  // exactly how a correct selector came to look like a wrong one.
  res.send(page(`
    <div id="root"></div>
    <script>
      setTimeout(function () {
        document.getElementById("root").innerHTML =
          '<h1>Sign in</h1>' +
          '<form method="post" action="/identity">' +
          '<input type="text" name="username" placeholder="username@example.com">' +
          '<button type="submit">CONTINUE</button>' +
          '</form>';
      }, 1200);
    </script>`));
});

app.post("/identity", (req, res) => {
  state.pendingUser = String((req.body as { username?: string }).username ?? "");
  if (!state.pendingUser) {
    res.status(401).send(page("<p>Enter an email</p>"));
    return;
  }
  res.send(page(`
    <h1>Sign in</h1>
    <form method="post" action="/login">
      <input type="password" name="password" placeholder="Password">
      <button type="submit">Sign in</button>
    </form>`));
});

app.post("/login", (req, res) => {
  const { password } = req.body as { password?: string };
  if (!state.pendingUser || !password) {
    res.status(401).send(page("<p>Bad credentials</p>"));
    return;
  }
  // Forced outcomes, so the diagnosis of each can be tested.
  if (state.loginOutcome === "rejected") {
    res.send(page("<h1>Sign in</h1><p>Wrong email or password. Please try again.</p>"));
    return;
  }
  if (state.loginOutcome === "mfa") {
    res.send(page("<h1>Verify it is you</h1><p>Enter the verification code we sent to your phone.</p>"));
    return;
  }
  state.signedIn = true;
  res.redirect("/");
});

app.get("/admin", (_req, res) => {
  state.admin = true;
  res.redirect("/transactions");
});

app.get(["/transactions", "/transactions/team"], (req, res) => {
  // Filters arrive in the query string, as Emburse's own URLs do:
  //   /transactions/team?filters[section]=inbox&filters[receipt]=true
  const q = req.query as Record<string, string>;
  if ("filters[receipt]" in q) state.receiptsFilter = q["filters[receipt]"] === "true";
  state.search = q["filters[query]"] ?? "";

  const count = state.receiptsFilter ? 193 : 275;
  const total = state.receiptsFilter ? "39,706.03" : "52,110.44";
  res.send(page(`
    <a href="/admin">ADMIN</a> <a href="/transactions">Transactions</a>
    <p>${count} items, $${total}</p>
    <a href="/filters">ADVANCED FILTERS</a>
    <form method="post" action="/tick"><button type="submit">Tick a row</button></form>
    <p>rows ticked: ${state.rowsTicked}</p>
    <a href="/dialog"><button>EXPORT</button></a>
    ${grid(state.search)}`));
});

app.get("/filters", (_req, res) => {
  res.send(page(`
    <a href="/transactions">back</a>
    <form method="post" action="/apply">
      <label><input type="checkbox" name="receipts" ${state.receiptsFilter ? "checked" : ""}> Receipt</label>
      <button type="submit">Apply</button>
    </form>`));
});

app.post("/apply", (req, res) => {
  state.receiptsFilter = Boolean((req.body as { receipts?: string }).receipts);
  res.redirect("/transactions");
});

app.post("/tick", (_req, res) => {
  state.rowsTicked++;
  res.redirect("/transactions");
});

app.get("/dialog", (_req, res) => {
  const scope = state.rowsTicked > 0 ? `${state.rowsTicked} expense(s)` : "all expense(s)";
  const chips = Object.entries(state.sections)
    .map(([name, on]) =>
      `<a role="button" aria-pressed="${on}" href="/chip?name=${encodeURIComponent(name)}"
          style="border:1px solid #888;padding:2px 6px;margin:2px">${on ? "✓ " : ""}${name}</a>`)
    .join("");
  res.send(page(`
    <div role="dialog">
      <h2>Export Expenses</h2>
      <p>You will be exporting ${scope} that are tagged with</p>
      <div>${chips}</div>
      <p>Filter(s): ${state.receiptsFilter ? "Receipts: true" : "none"}</p>
      <a href="/format">Select a format</a> <b>${state.format}</b>
      <form method="post" action="/start"><button type="submit">EXPORT</button></form>
    </div>`));
});

app.get("/chip", (req, res) => {
  const name = String(req.query.name ?? "");
  if (name in state.sections) state.sections[name] = !state.sections[name];
  res.redirect("/dialog");
});

app.get("/format", (_req, res) => {
  res.send(page(`<a href="/format/CSV">CSV</a> <a href="/format/PDF">PDF</a>`));
});

app.get("/format/:f", (req, res) => {
  state.format = req.params.f ?? "CSV";
  res.redirect("/dialog");
});

app.post("/start", (_req, res) => {
  state.requestedAt = Date.now();
  res.send(page(`<p>Your export has started</p><a href="/exports">Exports</a>`));
});

app.get("/exports", (_req, res) => {
  const ready = state.requestedAt !== null && Date.now() - state.requestedAt > EXPORT_MS;
  res.send(page(`
    <a href="/exports">Exports</a>
    <table><tbody>
      <tr><td>expenses.pdf</td><td>${ready ? "Complete" : "Processing"}</td>
          <td>${ready ? '<a href="/download">Download</a>' : "—"}</td></tr>
    </tbody></table>`));
});

app.get("/download", (_req, res) => {
  const pdf = pdfPath;
  if (!pdf || !fs.existsSync(pdf)) {
    res.status(500).send("the mock needs a real export PDF to serve");
    return;
  }
  res.setHeader("content-type", "application/pdf");
  res.setHeader("content-disposition", 'attachment; filename="expenses.pdf"');
  res.send(fs.readFileSync(pdf));
});

/** Test hooks, so a harness can assert what the run actually did. */
app.get("/__state", (_req, res) => res.json(state));
app.post("/__outcome/:kind", (req, res) => {
  state.loginOutcome = (req.params.kind ?? "ok") as State["loginOutcome"];
  state.signedIn = false;
  state.pendingUser = "";
  res.json({ ok: true });
});
app.post("/__reset", (_req, res) => {
  reset();
  res.json({ ok: true });
});

const reset = () =>
  Object.assign(state, {
    signedIn: false, admin: false, receiptsFilter: false, rowsTicked: 0,
    pendingUser: "", loginOutcome: "ok", search: "", format: "CSV", requestedAt: null,
    sections: {
      "Needs Review": true, "Needs Manager Review": false,
      "Pending Submission": false, Denied: true, Completed: false,
    },
  });

return new Promise((resolve) => {
  const server: Server = app.listen(port, () =>
    resolve({
      url: `http://127.0.0.1:${port}`,
      state: () => ({ ...state }),
      reset: () => void reset(),
      close: () => new Promise<void>((done) => server.close(() => done())),
    }),
  );
});
}

// Run standalone when invoked directly, so the mock can also be poked by hand.
if (import.meta.url === `file://${process.argv[1]}`) {
  const h = await startMock(Number(process.argv[2] ?? 5299), process.env.MOCK_PDF ?? "");
  console.log(`mock Emburse on ${h.url}`);
}
