# Driving Emburse without an API

Emburse Spend's API is provisioning-only — members, team fields, receipt
upload — with no endpoint for expenses at any tier. So everything this app
does to Emburse it does through a real browser, signed in as a real person.
That is the single fact the rest of this document explains, and the source of
almost every failure worth knowing about.

Three things happen against Emburse:

| | What it does | Signs in as | Runs when |
|---|---|---|---|
| **Import** | Downloads a PDF export of the transactions grid | whichever stored login last worked | scheduled, or on demand |
| **Approve** | Clicks APPROVE on one row | **the person who approved** | ~20s after the click, or on Send now |
| **Deny** | ⋮ → Deny → reason → confirm, on one row | **the person who denied** | same |

Only one of them can run at a time. There is one browser.

---

## The browser

`openBrowser()` in `server/emburse/auto-export.ts`:

```js
chromium.launchPersistentContext(dir, {
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  viewport: { width: 1600, height: 1000 },
  acceptDownloads: true,
})
```

A genuine headless Chrome inside the Replit VM. Nothing forges HTTP requests
or hand-rolls cookies — which is why this inherits real-browser problems that
an API client would never have, like a button that exists in the DOM and can
never be clicked.

`--no-sandbox` because the container has no user namespaces. The viewport is
fixed and wide so the grid renders all its columns; a narrow one hides the
Action column and with it the APPROVE button.

### Where the session lives, and why in two places

The profile directory carries Emburse's "remember this device for 30 days"
between runs. But it lives in the application directory and **Replit rebuilds
that on every deploy** — so the device was forgotten every time the app
shipped, and whoever owns the export was asked for a fresh code. During
active development that is several codes a day, for a feature whose whole
promise is "once".

So after a successful sign-in the cookie jar is sealed and written to
Postgres (`emburse_browser_state`), and restored into the browser before the
next run. The profile dir carries trust *within* a deployment; the database
carries it *across* deployments.

Those cookies are a live Emburse session — the same sensitivity as the stored
password one table over, and sealed with the same key. Neither is ever
returned to any request.

### The device check

When Emburse asks to verify the device, the run pauses and the prompt is
surfaced **in the app, to the person whose login it is** (`waitForCode`).

This is why a decision can pass a device check and the 6am export cannot: the
reviewer clicked Approve a moment ago and is there to read a code. Nobody is
there at 6am. The `mfaRemember` checkbox is ticked deliberately — unticked,
the next run is a stranger again and somebody is reading codes every morning.

### One browser, one job

`withBrowser(label, fn)` serialises everything. The label is what the queue
strip shows: *"the export has the browser (69s so far)"*. Decisions queue
behind an export and vice versa. Twenty decisions each opening their own
session would be half an hour of browser time during which the export cannot
run at all.

---

## How the URL is built

`gridUrl()` in `server/emburse/auto-export.ts`. Filters live in the query
string, so the app **navigates straight to a filtered grid** rather than
clicking chips and typing into a search box:

```js
const url = new URL(opts.path ?? "/transactions/team", base);
url.searchParams.set("filters[section]", opts.section ?? "inbox");
if (opts.receiptsOnly) url.searchParams.set("filters[receipt]", "true");
url.searchParams.set("filters[query]", opts.query ?? "");
```

Producing, for example:

```
https://spend.emburse.com/transactions/team?filters[section]=inbox&filters[receipt]=true&filters[query]=
https://spend.emburse.com/transactions/team?filters[section]=inbox&filters[query]=DOORDASH+INC.
```

| Part | Where it comes from |
|---|---|
| base | `settings.emburseUrl`, falling back to `env.emburseLogin.url` |
| path | the `gridPath` selector — `/transactions/team`, the team-wide view |
| `filters[section]` | always `inbox` |
| `filters[receipt]` | `settings.receiptsOnly` — import only |
| `filters[query]` | empty for import; the merchant for a decision |

The base URL is a **setting, not a constant**, so a wrong host is corrected
without a redeploy. `gridPath` is stored among the selectors for the same
reason.

Navigating by URL means there is no filter chip to misread and no toggle
whose state could be inverted. It also means one less thing that can be
focused wrong, debounced, or left holding a previous search.

### Everything else is a selector, and selectors are configuration

Every element the app looks for — the grid, a row, the APPROVE button, the ⋮
menu, the export dialog — is a CSS selector **stored in Settings, not written
in code** (`DEFAULT_SELECTORS` is only the starting point). Emburse changes
its markup and differs between tenants; this is what makes that survivable
without a deploy.

Two defaults exist because a tenant proved them necessary:

- `adminTab` matches **ADMIN *or* MANAGER**. Emburse names the team-wide tab
  per tenant. Matching only ADMIN told people their account might lack a view
  that was on screen the whole time.
- `grid` and `resultRow` match **both a real `<table>` and an ARIA div grid**.
  `spend.emburse.com` builds its transactions grid from divs, so a
  table-only selector matched nothing and every decision failed on a page
  that was visibly full of rows.

### Two rules learned the hard way

**Wait for either of two signals, not one.** The grid is considered loaded
when the grid selector matches *or* Emburse's own item-count line
("34 items, $42,249.94") is visible. The count line cannot be on screen
unless the rows are. The export has always accepted both; the decision path
demanded the grid element, so on a tenant with a stale grid selector the
export worked and every decision failed — which looks exactly like a
permissions problem and is not.

**Click the first *visible* match, never the first match.** A virtualised
grid renders hidden copies of its rows to measure them, so the first APPROVE
button in the DOM is routinely one that will never be visible, and
`.first().click()` waits out the entire timeout for it. That is
`locator.click: Timeout 30000ms exceeded` — a message that names no cause.

---

## Import

```
scheduled tick  →  export run  →  PDF  →  parse  →  ingest  →  rules  →  receipts
```

### The export run

Twelve steps, each timed and recorded (`server/emburse/auto-export.ts`):

```
open Emburse
sign in
switch to the team view
open the filtered grid
read the item count
open the export dialog
set the sections
choose PDF
confirm the scope is everything
(dry run — stops here when testing)
start the export
wait for the export and download it
```

The file arrives through `page.waitForEvent("download")` — a real browser
download, not a fetched URL.

**Sections** (default `["Needs Review"]`) are ticked in the export dialog and
then **verified**, because an export of the wrong sections looks exactly like
an export of the right ones. A dialog that offers names the configuration
does not know about fails the run and lists what it does offer.

**"Open Emburse" has its own longer timeout and its own retries**, because
it is the first thing a cold container does — cold TLS, then Emburse's OAuth
redirect chain. After three failures spanning about two minutes, a plain
`fetch` from the container asks the one question Playwright cannot: can this
container reach Emburse *at all*, with no browser and no profile? A container
with no route and a browser that cannot use the route it has look identical
from inside Playwright and have nothing in common as fixes.

### Scheduling

`server/emburse/export-scheduler.ts`. A tick every 5 minutes, plus a
**catch-up 4 minutes after boot** for a VM that restarted inside the due
window.

That delay is deliberate and was learned: it was 60 seconds, and a VM one
minute old cannot reliably reach the internet on this host. The 6:29am run
failed at "open Emburse" while a manual run hours later opened the same URL
in under two seconds. The cost is not a slow run but a **spent attempt** —
the day allows two, so one early boot burns half the budget and the export
never lands.

### Parsing and ingesting

The PDF is parsed with `mupdf`. Expense data comes from **the file**, never
from scraping the grid — the grid is only ever used to reach the EXPORT
button.

`ingestExport()` in `server/import/ingest.ts`:

1. **Identify** each expense by a dedupe key, since the export carries no
   transaction id. The key hashes employee, date, merchant, amount, category,
   location, department — plus an `occurrence` index.
   - `location` **is** in the key: one $15.67 Sam's Club run split across five
     sites is five expenses, identical but for Location. Drop it and four are
     lost.
   - `note` is **not**: submitters edit descriptions, and an edit must update
     the row rather than create a new one.
   - `occurrence` separates two rows the export describes identically — the
     same fuel purchased twice at the same pump on the same day. Without it
     one of the two silently vanished and could never be approved.
2. **Update** what is already known, insert what is new, recording what
   changed so the queue can show it.
3. **Purge** what the export no longer carries — the expense has left Emburse's
   review queue, so it leaves here too, taking its receipts and rule verdicts
   with it. Guarded: once at least 25 expenses are waiting, an export missing
   more than 80% of them is refused as truncated rather than treated as a mass
   approval; more than 50% warns.
4. **Run the rules** over what changed, and
5. **Nudge the receipt reader** if new receipt images arrived.

An export older than one already imported is **refused** unless forced.

---

## Approve and deny

### Queuing

Clicking Approve or Deny writes a row to Postgres immediately and returns.
Nothing about the browser happens in the reviewer's tab, so **closing the app
loses nothing**.

The worker then waits **20 seconds** before starting — a gather window, so
ten clicks during a review pass become one sign-in instead of ten. **Send
now** skips it.

Only one decision may be in flight per expense.

### Applying

`runDecisions()` signs in once and works the list. Per decision
(`server/emburse/decide.ts`):

```
open Emburse                    ─┐ once per batch
sign in                          │
switch to the team view         ─┘
search for the expense
verify it is the right row
approve  |  deny  |  dry run
```

**Search wide, narrow in code.** The query is the first two words of the
merchant. Every result row is then checked against **all four** of:

| Check | How |
|---|---|
| Amount | exact, bounded — `$26.40` must not match inside `$126.40` |
| Employee | surname appears in the row |
| Merchant | first word only; Emburse truncates long names with `…` |
| Date | `9/13/2026`, `09/13/2026` or `Sep 13` |

Fetching too much costs seconds; a filter that silently excluded the right row
would report "not there" about an expense that is. Up to 250 rows are read,
and when that cap is reached the message says **"looked at the first 250 of
303 rows"** rather than claiming none of 303 matched.

**Refuse rather than guess.** No match → refuse. **Two or more matches →
refuse**, even though one is probably right: two rows agreeing on employee,
merchant, amount and date is a real thing (a split purchase) and there is no
tie-break worth guessing when the stake is approving someone else's expense.

### The click

- **Approve** — the first *visible* APPROVE inside the matched row.
- **Deny** — the row's ⋮ menu → Deny → fill the reason if a box appears →
  confirm. Four more selectors than approve, which is why a green test of
  approve says nothing about deny.

**Then it is confirmed, not assumed.** The run polls for the expense to leave
the Needs Review grid. If it does not within six seconds the decision **fails**
and says so, noting it may still have gone through. Both paths used to click,
sleep 1.5 seconds and report success unconditionally — the worst failure
available on an audit-relevant action: the queue says applied, the expense
sits unapproved, nobody looks again.

Wrongly failed is retried and finds no row. Wrongly applied is simply lost.

### Whose login

**The decider's own, always.** Emburse records an approval against whichever
account signed in, so applying Brian's denial under Eric's login would put
Eric's name on a decision he did not make — in the finance system,
permanently, where nobody would think to doubt it.

There is no shared account and no fallback. A decider with no stored login has
their decisions **left pending** with the reason attached, never applied under
somebody else's name.

### When something goes wrong

- **Failed** — attempted and rejected. The reviewer must decide again.
- **Still pending, with a reason** — could not be attempted: the browser would
  not launch, settings would not load, a password would not decrypt, no login
  is stored. The decision is still good and is retried; it just says what is
  stopping it rather than sitting silently on "shortly".

Each decision settles **as it lands**, not at the end of the batch, so the
queue counts "Applying 2 of 3". It also means a batch that dies on the third
does not leave the first two unrecorded after actioning them in Emburse.

**If the server restarts mid-run**, the decision was never settled, so it
stays pending and the worker retries it a minute after boot. It cannot
double-approve: the row has already left Needs Review, so there is nothing
to click — the retry fails instead, which is the safe direction.

### The trace

`Show every step of an approve or deny` in Configuration keeps the full run —
each stage, its detail and its timing — plus **a screenshot of the page where
it stopped**. Off by default: a healthy queue has no use for a transcript on
every row.

A **failure shows its steps whichever way the toggle is set**. That is the
moment they are wanted, and having to switch something on and then reproduce
the failure is how a one-off gets lost.

---

## Why this is fragile, and what contains it

This is browser automation against somebody else's UI. It breaks when Emburse
changes markup, and it has: a grid that is divs rather than a table, hidden
rows a naive click waits thirty seconds for, a tab called MANAGER on one
tenant and ADMIN on another.

What contains the damage:

- **Selectors are configuration**, so a markup change is a settings edit.
- **Nothing is clicked until four fields agree**, and ambiguity is refused.
- **A click is confirmed**, not assumed.
- **A failure says what it saw** — which selector matched nothing, what *is*
  on the page, and a picture of it.

**And no, an API is not the way out.** Emburse Spend's API is
provisioning-only — members, team fields, receipt upload — with no endpoint
for expenses at any tier. That is why this exists at all, and why the answer
to a broken selector is to fix the selector rather than to go looking for a
cleaner route that is not there.

---

## Where things are

| Path | What |
|---|---|
| `server/emburse/auto-export.ts` | browser, sign-in, URL building, the export run |
| `server/emburse/export-scheduler.ts` | when the export runs, attempts per day |
| `server/emburse/decide.ts` | finding, verifying and actioning one row |
| `server/emburse/decision-worker.ts` | the queue, batching, settling |
| `server/emburse/decisions.ts` | the decision table |
| `server/emburse/credentials.ts` | sealed passwords; who signs in for what |
| `server/emburse/browser-state.ts` | the cookie jar that survives deploys |
| `server/emburse/browser-lock.ts` | one browser at a time |
| `server/import/ingest.ts` | parse → update → purge → rules |
| `server/import/key.ts` | the dedupe key |
| `server/import/settings.ts` | URL, sections, receipts-only, schedule |
| `scripts/mock-emburse.ts` | a fake Emburse to test all of it against |

Testing is covered in [TESTING.md](TESTING.md).
