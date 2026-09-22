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
  format: "CSV",
  requestedAt: null,
};

/** How long the fake export takes to become downloadable. */
const EXPORT_MS = 2000;

const page = (body: string) => `<!doctype html><html><body style="font-family:sans-serif">${body}</body></html>`;

app.get("/", (_req, res) => {
  if (!state.signedIn) {
    res.send(page(`
      <form method="post" action="/login">
        <input type="email" name="email" placeholder="Email">
        <input type="password" name="password" placeholder="Password">
        <button type="submit">Sign in</button>
      </form>`));
    return;
  }
  res.send(page(`
    <a href="/admin">ADMIN</a> <a href="/personal">PERSONAL</a>
    <a href="/transactions">Transactions</a>`));
});

app.post("/login", (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(401).send(page("<p>Bad credentials</p>"));
    return;
  }
  state.signedIn = true;
  res.redirect("/");
});

app.get("/admin", (_req, res) => {
  state.admin = true;
  res.redirect("/transactions");
});

app.get("/transactions", (_req, res) => {
  const count = state.receiptsFilter ? 193 : 275;
  const total = state.receiptsFilter ? "39,706.03" : "52,110.44";
  res.send(page(`
    <a href="/admin">ADMIN</a> <a href="/transactions">Transactions</a>
    <p>${count} items, $${total}</p>
    <a href="/filters">ADVANCED FILTERS</a>
    <form method="post" action="/tick"><button type="submit">Tick a row</button></form>
    <p>rows ticked: ${state.rowsTicked}</p>
    <a href="/dialog"><button>EXPORT</button></a>
    <table><tr><th>Date</th></tr><tr><td>Sep 13</td></tr></table>`));
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
app.post("/__reset", (_req, res) => {
  reset();
  res.json({ ok: true });
});

const reset = () =>
  Object.assign(state, {
    signedIn: false, admin: false, receiptsFilter: false, rowsTicked: 0,
    format: "CSV", requestedAt: null,
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
