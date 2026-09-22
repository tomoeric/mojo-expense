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

/** The one code the mock's verification screen accepts. */
export const GOOD_CODE = "482913";

export type MockHandle = { url: string; state: () => State; reset: () => void; close: () => Promise<void> };

type State = {
  signedIn: boolean;
  admin: boolean;
  receiptsFilter: boolean;
  sections: Record<string, boolean>;
  rowsTicked: number;
  pendingUser: string;
  loginOutcome: "ok" | "rejected" | "mfa" | "device" | "code";
  /**
   * Milliseconds the signed-in app spends blank before it paints.
   *
   * Emburse's dashboard cold-renders after the identity hand-off, and a real
   * run gave up on it at thirty seconds — reporting that sign-in failed while
   * the screenshot taken a second later showed the app fully loaded.
   */
  appPaintMs: number;
  /** When false, the signed-in app contains nothing the loggedIn selector matches. */
  showNavLabel: boolean;
  /**
   * How the transactions grid is drawn.
   *
   *   "table"  — a plain <table>.
   *   "ghost"  — a hidden measuring <table> first, then the real one. This is
   *              what data grids actually emit, and what defeats a wait on
   *              `.first()`: element number one never becomes visible.
   *   "divs"   — no <table> at all, ARIA roles only, like Emburse's own.
   */
  gridShape: "table" | "ghost" | "divs";
  /**
   * How the export dialog offers a format.
   *
   *   "links"  — a link that opens a page of choices.
   *   "select" — a native <select>, alongside a template one that also has to
   *              be ignored. Clicking an <option> is not a thing you can do,
   *              so a runner that clicks its way through times out here.
   */
  formatControl: "links" | "select" | "mui";
  /** When true the chips render as something the chip selector cannot match. */
  chipsUnmatchable: boolean;
  /** Milliseconds the dialog shows only its title before drawing its body. */
  dialogBodyMs: number;
  /** When true role="dialog" wraps only the title, not the chips. */
  dialogRootIsHeaderOnly: boolean;
  /** Codes submitted to the verification screen, right or wrong. */
  codeAttempts: number;
  /** Whether the last accepted code arrived with "remember this device" ticked. */
  rememberedDevice: boolean;
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
  codeAttempts: 0,
  rememberedDevice: false,
  appPaintMs: 0,
  showNavLabel: true,
  gridShape: "table",
  formatControl: "links",
  chipsUnmatchable: false,
  dialogBodyMs: 0,
  dialogRootIsHeaderOnly: false,
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
  const cells = (r: (typeof ROWS)[number]) =>
    `${r.date}</td><td>${r.merchant}</td><td>${r.who}</td><td>$${r.amount}</td>
     <td><button>APPROVE</button> <button aria-label="more">&#8942;</button>`;

  const realTable = `<table><thead><tr><th>Date</th><th>Merchant</th><th>Employee</th><th>Amount</th><th></th></tr></thead>
    <tbody>${shown.map((r) => `<tr><td>${cells(r)}</td></tr>`).join("")}</tbody></table>`;

  if (state.gridShape === "ghost") {
    // The measuring table a data grid renders to size its columns. It is a
    // <table>, it comes first, and it is never visible — so a wait on the
    // first match sits on it until it times out, next to a grid that loaded
    // immediately.
    return `<table style="display:none"><tbody><tr><td>sizing</td></tr></tbody></table>${realTable}`;
  }
  if (state.gridShape === "divs") {
    return `<div role="grid">
      <div role="rowgroup">${shown
        .map((r) => `<div role="row"><div role="cell">${cells(r).replace(/<\/?td>/g, "")}</div></div>`)
        .join("")}</div>
    </div>`;
  }
  return realTable;
};

const page = (body: string) => `<!doctype html><html><body style="font-family:sans-serif">${body}</body></html>`;

app.get("/", (_req, res) => {
  if (!state.signedIn) {
    // Email first, password on the next screen — the shape account.emburse.app
    // actually uses, and the one that defeats filling both at once.
    res.redirect("/identity");
    return;
  }
  const nav = `<a href="/admin">ADMIN</a> <a href="/personal">PERSONAL</a>` +
    (state.showNavLabel ? ` <a href="/transactions">Transactions</a>` : ` <a href="/transactions">Spend</a>`);

  if (state.appPaintMs > 0) {
    // Blank first, then the app — the shape that broke a real run. A check
    // that reads the page once, early, sees nothing here and concludes the
    // sign-in failed.
    res.send(page(`
      <div id="app"></div>
      <script>
        setTimeout(function () {
          document.getElementById("app").innerHTML = ${JSON.stringify(nav)};
        }, ${state.appPaintMs});
      </script>`));
    return;
  }
  res.send(page(nav));
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
  // A verification code, unless this browser has already been trusted. This is
  // the screen a person can actually clear, so unlike the others it has a way
  // through — and the "remember this device" box is wired to the cookie rather
  // than being decoration. An automation that submits the code without ticking
  // it gets in today and is a stranger again tomorrow, which is exactly the
  // silent failure worth catching here.
  if (state.loginOutcome === "code" && !/trusted=1/.test(req.headers.cookie ?? "")) {
    res.send(codePage(null));
    return;
  }
  // Device verification, unless this browser has been here before. The cookie
  // is the whole point: without a persistent profile it never comes back, and
  // "remember this device" can never be satisfied.
  if (state.loginOutcome === "device" && !/trusted=1/.test(req.headers.cookie ?? "")) {
    res.setHeader("set-cookie", "trusted=1; Path=/; Max-Age=2592000");
    res.send(page("<h1>Verify</h1><p>Remember this device for 30 days. Back to login</p>"));
    return;
  }
  state.signedIn = true;
  res.redirect("/");
});

const codePage = (error: string | null) =>
  page(`
    <h1>Verify it is you</h1>
    <p>Enter the verification code we sent to your phone.</p>
    ${error ? `<p>${error}</p>` : ""}
    <form method="post" action="/verify">
      <input type="text" name="code" placeholder="000000">
      <label><input type="checkbox" name="remember"> Remember this device for 30 days</label>
      <button type="submit">Verify</button>
    </form>`);

app.post("/verify", (req, res) => {
  const { code, remember } = req.body as { code?: string; remember?: string };
  state.codeAttempts++;
  if (code !== GOOD_CODE) {
    res.send(codePage("That code is incorrect. Please try again."));
    return;
  }
  state.rememberedDevice = Boolean(remember);
  if (remember) res.setHeader("set-cookie", "trusted=1; Path=/; Max-Age=2592000");
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
      state.chipsUnmatchable
        // Same words on screen, wrapped so the chip selector cannot reach them:
        // the text lives in a nested element the filter does not look at. This
        // is what a markup change looks like from outside, and what used to be
        // reported as "already correct".
        ? `<section data-chip><svg><title>${on ? "on" : "off"}</title></svg></section>`
        : `<a role="button" aria-pressed="${on}" href="/chip?name=${encodeURIComponent(name)}"
            style="border:1px solid #888;padding:2px 6px;margin:2px">${on ? "✓ " : ""}${name}</a>`)
    .join("");
  const body = `
      <p>You will be exporting ${scope} that are tagged with</p>
      <div>${chips}</div>
      <p>Filter(s): ${state.receiptsFilter ? "Receipts: true" : "none"}</p>
      ${formatControl()}
      <form method="post" action="/start"><button type="submit">EXPORT</button></form>`;

  // role="dialog" around the title only. The chips are on screen and real, and
  // anything scoping its search to the dialog cannot reach them — which reads
  // exactly like chips that do not exist.
  if (state.dialogRootIsHeaderOnly) {
    res.send(page(`<div role="dialog"><h2>Export Expenses</h2></div><div>${body}</div>`));
    return;
  }

  // The title first, the body a beat later. Checking the instant the dialog
  // opens finds a dialog whose whole text is "Export Expenses" and concludes
  // the chips are missing — in 0.0s, which is the tell.
  if (state.dialogBodyMs > 0) {
    res.send(page(`
      <div role="dialog">
        <h2>Export Expenses</h2>
        <div id="body"></div>
      </div>
      <script>
        setTimeout(function () {
          document.getElementById("body").innerHTML = ${JSON.stringify(body)};
        }, ${state.dialogBodyMs});
      </script>`));
    return;
  }

  res.send(page(`
    <div role="dialog">
      <h2>Export Expenses</h2>
      ${body}
    </div>`));
});

const formatControl = () => {
  if (state.formatControl === "mui") {
    // The shape the real dialog uses: a floating label that owns the control's
    // accessible name and cannot be clicked, over a div that can. A runner
    // that goes by the visible words finds the label and waits forever.
    return `
      <label id="tpl-label">Select a template</label>
      <div role="combobox" aria-labelledby="tpl-label" tabindex="0">Default CSV export</div>
      <p>Which format do you want to export in?</p>
      <label id="fmt-label" style="pointer-events:none">Select a format</label>
      <div role="combobox" aria-labelledby="fmt-label" tabindex="0"
           onclick="document.getElementById('fmt-menu').style.display='block'">${state.format}</div>
      <ul id="fmt-menu" role="listbox" style="display:none">
        <li role="option" onclick="location.href='/format/CSV'">CSV</li>
        <li role="option" onclick="location.href='/format/PDF'">PDF</li>
      </ul>`;
  }
  if (state.formatControl === "select") {
    // A template dropdown first, exactly as the real dialog has it — a runner
    // that grabs the first <select> it sees picks this one and never sets the
    // format at all.
    return `
      <label>Choose a template</label>
      <select name="template">
        <option>Default CSV export</option>
        <option>Detailed export</option>
      </select>
      <label>Choose a format</label>
      <form method="post" action="/format-select">
        <select name="format" onchange="this.form.submit()">
          <option ${state.format === "CSV" ? "selected" : ""}>CSV</option>
          <option ${state.format === "PDF" ? "selected" : ""}>PDF</option>
        </select>
      </form>`;
  }
  return `<a href="/format">Select a format</a> <b>${state.format}</b>`;
};

app.post("/format-select", (req, res) => {
  state.format = String((req.body as { format?: string }).format ?? "CSV");
  res.redirect("/dialog");
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
app.post("/__app", (req, res) => {
  const q = req.query as Record<string, string>;
  if ("paintMs" in q) state.appPaintMs = Number(q["paintMs"]) || 0;
  if ("nav" in q) state.showNavLabel = q["nav"] !== "false";
  if ("grid" in q) state.gridShape = q["grid"] as State["gridShape"];
  if ("format" in q) state.formatControl = q["format"] as State["formatControl"];
  if ("chips" in q) state.chipsUnmatchable = q["chips"] === "unmatchable";
  if ("bodyMs" in q) state.dialogBodyMs = Number(q["bodyMs"]) || 0;
  if ("dialogRoot" in q) state.dialogRootIsHeaderOnly = q["dialogRoot"] === "header";
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
