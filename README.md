# MOJO Expense

A reviewer console over the Emburse expense-report API. It answers the one
question a reviewer opens a tool to ask — *what is waiting on me, and which of
it needs a closer look?* — and then gets out of the way.

This is a **standalone app**. It shares no build, database or auth with
`ninja-live-status`; it only borrows its visual language so the two read as one
system.

## Which Emburse product this talks to

Emburse sells four different things under one brand, and only two of them have
the submit → review → approve workflow:

| Product | Formerly | Reviewer workflow? | Auth |
|---|---|---|---|
| **Emburse Professional** | Certify | **Yes** — employees submit reports, a reviewer approves, an accountant processes | API key + secret headers |
| **Emburse Enterprise** | Chrome River | **Yes** — same workflow, enterprise scale | OAuth2 client credentials |
| Emburse Spend | Abacus | No — card-led, real-time transactions | OAuth2 client credentials |
| Emburse Cards | — | No — virtual card issuing | OAuth2 client credentials |

**MOJO is on Emburse Spend** (`spend.emburse.com`), so `spend` is the default:
base `https://api.emburse.com/v1`, bearer or OAuth2 auth, and `transactions`
rather than `expensereports` as the primary collection.

The other products remain one env var away — `EMBURSE_PRODUCT` changes how the
app authenticates and which paths it calls, both of which are configuration.

### Getting Spend API access

Unlike Professional, this is **not self-service**. The Spend API is gated to
Partners and customers on the **Plus** plan; App Integrations in the Spend admin
UI is Slack-only and will never show an API key. Ask your Emburse Account
Manager to enable API access, which yields either a bearer token
(`EMBURSE_ACCESS_TOKEN` — set it alone and the OAuth exchange is skipped) or
client credentials.

## Running it

```bash
pnpm install
pnpm run dev     # http://localhost:5000 — one process serves the API and the UI
```

With no credentials set the app runs on **deterministic sample data** and says
so on every page. Nothing is presented as real until Emburse is connected.

```bash
pnpm run build  # typecheck → vite build → esbuild the server
pnpm run start  # production
```

### On Replit

Import the repo as a new Repl, then add the secrets below. The run and deploy
commands are already in `.replit`.

Replit ships pnpm, so nothing extra is needed. Do **not** add a
`packageManager` field to `package.json`: pnpm 10 then tries to self-install
that exact version, which fails inside Replit's sandbox and retries in a loop
until the container runs out of threads (`pthread_create: Resource temporarily
unavailable`). If you ever hit that, delete the field.

## Microsoft SSO

Sign-in is Entra ID (OpenID Connect + PKCE), using the **same app registration
as ninja-live-status** — so no new Azure setup beyond one redirect URI.

1. In the Entra app registration → **Authentication** → **Web**, add the
   redirect URI:
   `https://<your-repl>.replit.app/api/callback`
2. Add these Secrets:

| Secret | Notes |
|---|---|
| `AZURE_TENANT_ID` | same value as ninja-live-status |
| `AZURE_CLIENT_ID` | same |
| `AZURE_CLIENT_SECRET` | same |
| `SESSION_SECRET` | **required in production** — `openssl rand -hex 32` |
| `AUTH_ALLOWED` | optional; comma-separated emails and/or domains |

The issuer is tenant-scoped (`login.microsoftonline.com/<tenant>/v2.0`), so
only accounts in your Entra tenant can sign in at all. `AUTH_ALLOWED` narrows
that further to named reviewers; leave it unset to admit the whole tenant.

### AUTH_ALLOWED format

Individual reviewers — separate with commas:

```
AUTH_ALLOWED=eric.s@mojocarwash.com,ap@mojocarwash.com,jane.d@mojocarwash.com
```

A whole domain — everyone with that email suffix:

```
AUTH_ALLOWED=mojocarwash.com
```

Mixed, if a contractor on another domain needs in:

```
AUTH_ALLOWED=mojocarwash.com,auditor@partnerfirm.com
```

Parsing is forgiving on purpose, since this gets hand-typed into a Secrets box:

- commas, spaces or newlines all work as separators
- case-insensitive — `Eric.S@MojoCarWash.com` matches `eric.s@mojocarwash.com`
- surrounding quotes are stripped, so a pasted `"a@b.com"` still works
- a domain written `@mojocarwash.com` is accepted as well as bare

Someone in the tenant but not on the list gets a clear "Access denied" page
naming their address, not a silent failure. The boot log prints how many
entries were parsed (never the addresses) so you can confirm it took effect:

```
AUTH_ALLOWED: 3 entries
```

**Changing it requires a restart** — it is read from the environment at
request time, but Replit only re-reads Secrets when the process restarts.

**Sessions have no database.** A session is an HMAC-signed, httpOnly cookie
holding only the user's id, name and email — no access or refresh token ever
reaches the browser. It lasts 8 hours; after that the user is bounced back
through Entra, which is silent while their Microsoft session is alive.

### The fail-closed rule

| Emburse | Sign-in | Behaviour |
|---|---|---|
| not set | not set | Open. Demo data only — nothing real to leak. |
| not set | set | Sign-in required; demo data behind it. |
| **set** | **not set** | **`/api/reports` returns 503 and serves nothing.** |
| set | set | Normal operation. |

The third row is the point: the moment real credentials exist, real data is
never served to an anonymous caller — even if sign-in was never wired up.

## What runs on its own

Four loops, all started at boot in `server/index.ts`, all continuous:

| Loop | Cadence | What it does |
| --- | --- | --- |
| `startExportScheduler` | the slots in Export settings | signs into Emburse, exports Needs Review, imports it |
| `startReceiptReader` | 30s while there is work, 30 min idle, 10s after an import brings new images | reads receipt images, re-reads the ones whose total does not match, re-judges and re-queues |
| `startAutoApprove` | 15 min, first sweep 3 min after boot | queues approvals for expenses no rule flagged — **the automation that approves** |
| `startDecisionWorker` | 1s while there is work, 5 min idle | signs in as the decider and clicks approve or deny in Emburse |

Approving and applying are two different loops on purpose. The sweep only ever
writes a row to `expense_decisions`; the worker is the only thing that touches
Emburse. So pausing stops the clicking without losing the decisions, and a
flag that lands in between still gets its say (below).

Reading and deciding were always continuous. The import was not: its slots
were **retries**, so the first one that succeeded closed the day and the queue
showed whatever Emburse held at 6am until tomorrow. **Keep importing all day**
in Export settings changes what those slots mean — every one of them runs,
success or not — so the queue keeps up with Emburse: an expense submitted at
eleven is here by noon, and one somebody approved in Emburse by hand stops
being offered for a decision. Default is hourly, 6am to 9pm.

With it on, "is the data current?" stops meaning "did this morning work?" and
starts meaning "has anything arrived since the last slot that was due?" — the
Import page reports *behind* when nothing has, which is the only thing that
distinguishes a live queue from a dead importer. Overnight, when no slot is
due, nothing is reported. Frequency is safe against a truncated export: the
import already refuses one that would delete more than four in five of the
waiting expenses without a decision of ours to explain it.

## Automatic approval

`server/rules/auto-approve.ts`. This is the only path in the app that approves
somebody's spending with nobody looking, so most of it is fences. It is **off
until switched on** (Configuration → Automatic approvals), and switching it on
attaches it to the person who did: approvals are made in Emburse under *their*
login, because Emburse records an approval against whoever signed in. Never a
shared login, and never a fallback to one.

**Before a pass runs at all**, in this order — the first that holds is the one
reported, and the page shows the sentence rather than just doing nothing:

1. the switch is off
2. everything is paused (the Pause button on the queue)
3. an import is in flight — it adds and removes expenses underneath the very
   queue this reads, so approvals wait for it to finish and the rules to run
4. nobody owns the automation, so there is no login to make approvals under
5. the owner has no Emburse password stored
6. no rules are enabled — "nothing was flagged" is vacuously true of an
   expense nothing checked

**Then, per expense, four tests.** All four must pass, and they are written
once and shared by the pass and by the "why is nothing moving" report, so the
page cannot explain one rule while the automation applies another:

| Test | An expense is skipped when |
| --- | --- |
| `flagged` | any enabled rule caught it |
| `awaitingRules` | some enabled rule has not run since it arrived — *not* "it has no hit row", because a rule that does not apply writes no row at all |
| `decided` | it is already pending, applied, or failed and waiting on a person |
| `awaitingReceipt` | any receipt on it has not been read, and some enabled rule depends on a reading |

That fourth one is the fence that is easy to miss, and the reason this is not
simply "flags is empty". **An expense whose receipt has not been read is
unflagged because nothing has been checked, not because everything passed** —
rules about alcohol, receipt totals and merchant names all return UNKNOWN with
no reading, so the newest expenses look cleanest of all. Approving on that
basis would systematically approve exactly the expenses nothing had examined,
and it would look like it was working perfectly. It is *every* image on the
expense, not one: an expense with the bar tab on page two must not pass on the
strength of page one. A receipt the reader gave up on after three tries stays
unread for this purpose, deliberately — that is a reason for a person to look,
not a reason to wave it through.

Qualifying expenses are queued in date order, up to the per-run limit
(default 10, hard ceiling 100), **through the same `queueApprovalFor` a
person's click uses**. A machine does not get a shorter path to somebody
else's money than a human does. Each row is stamped `automatic`, so the queue
can always say which approvals nobody looked at.

**A flag still beats a queued approval, right up to the last moment.** The
receipt is often read minutes after the approval is queued, the rules run
again on what it said, and the expense is flagged *after* it is already in the
queue. So the decision worker re-checks every automatic approval against the
current flags immediately before signing in, and cancels the ones now flagged
— "a rule flagged this after the approval was queued, so it was not sent."
Only the machine's are stopped. A person who clicks Approve on a flagged
expense means it, and often should: a flag is a prompt to look, not a
prohibition.

**At the browser**, one more rule, because Emburse can show several rows that
match an expense equally well — one purchase split across sites is seven
identical rows. The automation may take one of them only if the queue holds a
decision for *every* matching row, in which case the choice is bookkeeping and
all seven get approved anyway. Holding fewer, it refuses and says so rather
than guessing.

**What may be believed about a receipt.** Three rules, each learned from a
wrong flag on a purchase that was perfectly ordinary:

- **An illegible reading is evidence of nothing.** The reader answers
  `legible` separately from `error`, and a reading that says "too faded to
  read" can still return a total. It is a guess. Its total, date, merchant
  and lines are all excluded from the rules; the only thing it establishes is
  that the receipt could not be read, which is its own flag.
- **A payment line settles the total, in both directions.** Where the card
  line agrees with the printed total, the receipt has answered the question
  and no arithmetic may reopen it — an invoice whose "Subtotal" already
  includes the tax was otherwise "corrected" upward by exactly the tax.
- **The charge decides between the print and the arithmetic.** A receipt can
  be internally inconsistent and still honest: a crumpled slip whose 6 read
  as a 5 in all three places it was printed, while its own items and tax add
  to exactly what was charged. Both figures are offered as candidates and
  whichever answers the charge wins — never the arithmetic on its own, since
  that is what got the invoice above wrong.

**Both sides of the ambiguity guard mean the same thing.** The guard reads:
several rows match this expense equally well, so the automation may take one
only when the queue holds a decision for every one of them. That reasoning
needs "matching row" and "one like it" to be the same relation, and they were
not — the browser accepted any row sharing a long word of the merchant, while
`peersFor` counted our own expenses alike only when the strings were
identical. Every Mammoth descriptor ends "MAMMOTH HOLDINGS LLC", so three
$29.99 car washes on one day were three rows on one side and one peer on the
other, refused for ever. Both now go through `merchantAlike`.

**Forgiving about the vendor when FINDING a row, strict when telling two
apart.** The amount and date identify an expense and the name is
corroboration, so one word in common is enough to stop the run refusing
"ACE HARDWARE #18…" for "ACE HARDWARE HELM, LLC". That same looseness made
three car washes at $29.99 on one day — BUSY BEE CARWASH - KENDA, PITSTOP
CARWASH - FAIRHO, PITSTOP CARWASH - GULFPO — all match each other on the word
"carwash", so the automation called them interchangeable and refused all
three. They are nothing of the kind: approving the wrong one approves another
site's expense, and the ambiguity guard was comparing these fuzzy row matches
against a peer count taken on the exact merchant. The run now scores the
vendor name and keeps only the closest rows, so a sibling site is set aside
and a genuine twin still ties.

**Confirming a decision means one FEWER matching row, not none.** A split
receipt puts several identical rows in Emburse — six shares of one lunch are
six rows agreeing on employee, merchant, amount and date, because they are
that expense six times over. Approving one leaves five, so "is the expense
still in Needs Review?" answers yes and is right; the question was wrong. The
run counts the matching visible rows before the click and requires one fewer
after. For an ordinary expense that is the same question: one before, none
after. A click that lands on nothing still fails, which is the fence this
must not cost.

**Nobody is watching an automatic approval.** Emburse asks an unrecognised
browser for a verification code, and the decision worker offers that prompt to
the reviewer — reasonable when somebody just clicked Approve, and false for a
batch the sweep queued on a timer a quarter of an hour ago. Parking there
holds the browser, the profile lock and the rest of the batch for the full
ten-minute wait and then abandons the sign-in anyway. A batch with no human
click in it now fails fast instead, exactly as the scheduled export does; the
moment a person decides anything the prompt comes back, and answering it once
re-trusts the device for everything after.

**A profile lock outlives the Chromium that left it.** The browser takes an
exclusive lock on its profile directory and drops it on a clean exit; a
process killed instead leaves it behind, and every launch afterwards fails
with "Failed to create a ProcessSingleton for your profile directory". On a
container that rebuilt its filesystem each deploy this was self-clearing. On a
VM the directory persists, so it is forever — every import, every approval,
until somebody deletes a file nobody knows about. A launch that fails that way
now clears the stale lock and tries once more.

**A fix to the alcohol list reaches readings already stored.** The floor
under the model's answer is a pure function of the line's own text — "RED
BULL SUDACHI LIME 12" is not alcohol however the model felt about it — so
widening it does not need the image read again. Bumping `READER_VERSION`
gets there eventually, but eventually is one vision call per receipt in the
whole backlog: hours, and real money, to fix a word list. `reapplyAlcoholFloor()`
runs on boot, before the rule re-check so the flags it clears actually clear,
and it only ever REMOVES the mark — a line the model called clean stays
clean.

**Viewing as somebody must never become acting as them.** An admin can look
at the app through another reviewer's eyes — the control is in the main
header, the people offered are those with an Emburse login stored, and a band
under the header says whose view it is for as long as it lasts. It swaps the
identity the whole app reads, because that is what makes the view honest:
whether a login is stored and so whether anything can be decided, which
failures are theirs, what the automation did while they were away.

That identity also stamps every write — `decidedBy` on a decision, who saved
a rule, who flipped a flag — and an approval reaches Emburse under the
decider's own login and carries their name in the finance system
permanently. So the rule is not "be careful which writes to allow", it is
**allow none**: `viewAsMiddleware` refuses every request that is not a GET
while the mode is on. An allow-list of safe methods, so a write route added
next month is refused by default rather than discovered later. Admin rights
are re-checked on every request against the real signed-in user.

**An expense Emburse no longer has is not a failure.** Somebody approving or
denying directly in Emburse is allowed and normal, and when a run reads that
cardholder's whole Needs Review and finds no row for the amount, there is
nothing to fix and nothing to retry. The decision is settled as *cancelled*
(the record stays, `not_in_queue` still says which kind it was) and the
expense comes off the list on the spot — silently, with nothing reported.
Safe because it is self-correcting in the direction that matters: if Emburse
does still hold it, the next import carries it and the row comes straight
back.

**What it did while you were away** is reported once, at the top of the
queue. The automation approves with nobody watching, which is the point of it
and also the problem with it: a reviewer comes back to a queue forty rows
shorter than they left it and nothing says why. Each person's last visit is
recorded (`user_visits`), and returning after a gap of half an hour or more
freezes the window they missed — so the count is a plain fact about a fixed
period rather than a number creeping upwards as they read it. It names how
many carry *their* Emburse login, because an automatic approval is made under
a real person's account. It counts `applied_at`, not when the decision was
queued: the claim is that these reached Emburse, so a decision that failed on
the way is not an approval. Dismisses to nothing; nothing in it needs doing.

A login is the wrong hinge for this and it is worth saying why: sessions are
signed cookies renewed silently through Entra, so somebody can use the app for
weeks without a login event ever happening. "Since I last logged in" means
"since I was last here", and that is what a gap measures.

**Why nothing is moving** is a question the Configuration card answers
directly: every expense in the queue lands in the bucket of the first reason
it does not qualify — flagged, decided, awaiting rules, awaiting receipt,
eligible — and the buckets sum to the queue. A total that does not add up is a
reason to distrust the whole card. The sweep exists for the same reason: it
used to ride on the import and the receipt reader, both of which are silent on
a settled queue, so switching the automation on did nothing observable for
hours — indistinguishable from a broken feature.

## Importing the daily export

Emburse Spend's API is provisioning-only — members, team fields, receipt
upload — with no endpoint for expenses at any tier. The data therefore comes
from the **Expenses PDF export**, uploaded on the Import page.

How the app drives Emburse to get that file — the browser, the grid URL, and
how an approve or deny finds its row — is written up in
[docs/EMBURSE.md](docs/EMBURSE.md).

Point the app at a Neon connection string; the schema creates itself on boot
(idempotent `CREATE … IF NOT EXISTS`, no migration step). With a database
configured the app reads imported expenses and ignores the Emburse API
entirely.

**Which variable to use.** Three names are read, in this order:

1. `NEON_DATABASE_URL` — **prefer this**
2. `EXTERNAL_DATABASE_URL`
3. `DATABASE_URL`

`DATABASE_URL` is last deliberately. Replit injects that name itself whenever a
managed Postgres is attached to a Repl, and the injected value can win over a
hand-set secret — so an app aimed at an external Neon project silently reads
the wrong database instead of failing. Using `NEON_DATABASE_URL` avoids the
collision. The boot log names the source and host it resolved:

```
Database: ep-xyz-pooler.us-east-2.aws.neon.tech (from NEON_DATABASE_URL)
```

Use Neon's **pooled** connection string (hostname contains `-pooler`): Replit
opens and drops connections freely and the pooler is built for that.

### Where the file comes from

Two routes, because Emburse supports two very different exports:

| | Scheduled SFTP export | PDF export |
|---|---|---|
| Automatable | **yes** | **no** — manual only |
| Transaction data | yes | yes |
| **Receipt images** | **no** | **yes** |
| Cap | — | 2,500 transactions per file |

Emburse does not deliver receipt images over SFTP in any format. Receipts come
only from Card Transactions / Reimbursements → filter `Receipt: True` →
Export → PDF, which a person runs. So a fully automated feed gives transactions
without receipts, and receipts require someone to run the PDF export.

The app runs that PDF export itself, in a headless browser, and imports the
file directly — see `server/emburse/auto-export.ts`. Nothing is written to or
read from SharePoint any more.

### Getting an export in by hand

**Import → Choose PDF**, for when the automation cannot run. Identity is
derived from the row fields rather than the file, so a PDF loaded later
attaches its receipts to rows that already arrived another way.

Loading the *same* file twice is a no-op (content hash). Loading an **older**
export is refused: every row in an imported file is marked back into the inbox
and everything absent from it is marked as having left, so an older snapshot
would resurrect already-decided expenses and evict the ones actually waiting.
Force is available for somebody who is certain.

### What the importer guarantees

| Situation | Behaviour |
|---|---|
| Same file uploaded twice | Detected by content hash; nothing is written |
| An expense already known | Updated, never inserted again |
| A description edited upstream | Updates the existing row |
| A row that has left the Emburse inbox | Kept and flagged `in_inbox = false`, never deleted |
| That row returning later | Re-opened, not duplicated |
| The same receipt arriving daily | Stored once, by content hash |

**Dedupe key** — the export carries no transaction id, so identity is a hash of
employee, date, merchant, amount, category, **location** and department.
Location is in the key because one purchase split across five sites differs in
nothing else; the note is out of it because submitters edit descriptions, and
an edit must update a row rather than create a second one.

**Reconciliation** — page 1 of the export prints a TOTAL. Every import compares
its parsed sum against that figure and records whether it balanced. An import
that does not reconcile is flagged in the history rather than trusted.

`scripts/verify-import.ts <file.pdf>` reruns the reconciliation and the
idempotency check against any export.

## Connecting Emburse

Add these as Replit Secrets (or a local `.env` — see `.env.example`):

| Variable | For | Notes |
|---|---|---|
| `EMBURSE_PRODUCT` | all | `professional` (default), `enterprise`, or `spend` |
| `EMBURSE_API_KEY` | Professional | issued per tenant |
| `EMBURSE_API_SECRET` | Professional | issued per tenant |
| `EMBURSE_CLIENT_ID` | Enterprise / Spend | OAuth2 client credentials |
| `EMBURSE_CLIENT_SECRET` | Enterprise / Spend | |
| `EMBURSE_TOKEN_URL` | Enterprise / Spend | tenant token endpoint |

`GET /api/config` reports exactly which of these are still missing.

### If a call 404s, change config — not code

Emburse publishes its API reference behind a tenant login, so resource paths and
query-parameter names vary by product tier and contract. **Every wire detail is
an env var** (`EMBURSE_REPORTS_PATH`, `EMBURSE_PAGE_PARAM`,
`EMBURSE_DATE_START_PARAM`, …; full list in `.env.example`). Diff the defaults
against your tenant's Swagger and override what disagrees.

The defaults are the documented Emburse Professional shape: base
`https://api.certify.com/v1`, an `expensereports` collection and an `expenses`
collection, paged with `index`.

## What it does

- **Review Queue** — only reports awaiting a decision, oldest first, filterable
  down to the flagged or ageing ones.
- **All Reports** — every report in the window, filtered by status, department
  or free text.
- **Analytics** — spend by month, category and department.
- **Report drawer** — line-level detail with the lines that triggered a warning
  tinted, and **View** on any receipted line to see the receipt itself.

### Receipts

Receipts are fetched **through this server**, never straight from Emburse. The
browser asks for `/api/receipts/<lineId>`; the server resolves that line from
its cached report set and fetches the bytes using the API credentials, which
never leave the process. The client cannot supply a URL, so this is not an open
proxy — and a receipt URL that arrives inside an Emburse payload is only
followed when its host matches `EMBURSE_API_URL`, so a mangled or hostile
record cannot point the server at an internal address.

Images render in an `<img>` (so an SVG payload cannot execute), PDFs in an
`<object>` with a link-out fallback. Responses carry `nosniff` and a sandbox
CSP, and only image and PDF types are served at all — anything else is refused
rather than echoed back from our own origin.

### Checking the receipt against the claim

**Check N receipts** in the report drawer reads each receipt image with Claude
vision and compares the printed total to the claimed amount. Four outcomes:

| Badge | Meaning |
|---|---|
| **Over $X** | The claim is more than the receipt total. **The one worth a reviewer's time.** |
| **Under** | The receipt total is larger than the claim — usually a split bill. |
| **Match** | Agrees within tolerance. |
| **Unread** | The receipt arrived but no total could be read from it. |

**A difference is a prompt to look, not proof of an error.** Split bills, tips
added after printing, excluded personal items and currency conversion all
produce a legitimate difference. Only over-claims are styled as a problem —
colouring the benign cases red would train reviewers to ignore the badge.

The model is never told the claimed amount; it reads the receipt cold and the
comparison happens in code, so it cannot be nudged into agreeing.

Two credential shapes are accepted, checked in this order:

1. **Replit's Anthropic AI integration** — `AI_INTEGRATIONS_ANTHROPIC_API_KEY`
   plus `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`. This is what ninja-live-status
   already uses, so provisioning the integration on this Repl needs no separate
   Anthropic account and no separate billing. The key only works against its
   own gateway, which is why the base URL travels with it.
2. **A direct key** from console.anthropic.com in `ANTHROPIC_API_KEY`.

The boot log says which one was found, and whether it is going through the
gateway. If the gateway rejects the default model, set `RECEIPT_AUDIT_MODEL` to
one it serves — ninja-live-status uses `claude-sonnet-4-6` through it.

Configuration:

| Variable | Default | Notes |
|---|---|---|
| `AI_INTEGRATIONS_ANTHROPIC_*` or `ANTHROPIC_API_KEY` | — | Absent = the check is unavailable; everything else still works |
| `RECEIPT_AUDIT_MODEL` | `claude-opus-5` | Runs at low effort — extraction, not reasoning |
| `RECEIPT_AUDIT_TOLERANCE` | `0.02` | Absolute dollar slack |
| `RECEIPT_AUDIT_TOLERANCE_PCT` | `0.01` | Proportional slack, for conversion and rounding |

It is **on demand, per report** — never automatic. Each check is a model call
with an image attached, so auditing every line of every report on page load
would cost real money for data nobody asked to see. Results are cached in
memory, so re-opening a report is free; **that cache is lost on restart, so
this is not an audit trail.** Persisting verdicts needs a real table.

Until Emburse is connected the verdicts are simulated (labelled SAMPLE) so the
flow is demonstrable — no model calls are made against our own placeholder
images.

Set `EMBURSE_RECEIPTS_PATH` if your tenant's receipt collection is not
`receipts`. Both response shapes are handled: raw bytes, or JSON carrying
base64 (with or without a `data:` prefix). Until Emburse is connected, **View**
shows a drawn placeholder stamped SAMPLE.

### Review flags

Derived server-side in `server/emburse/policy.ts`, so they are identical
regardless of which Emburse product supplied the data:

| Flag | Severity | Threshold |
|---|---|---|
| Missing receipt | warn | line ≥ `POLICY_RECEIPT_REQUIRED_OVER` (default $25) with no receipt |
| Possible duplicate | warn | two lines share merchant + amount + date |
| Ageing | warn | submitted ≥ `POLICY_AGEING_AFTER_DAYS` ago (default 5) and still unreviewed |
| Large line | info | line ≥ `POLICY_LARGE_LINE_OVER` (default $500) |
| Weekend spend | info | line dated a Saturday or Sunday |

## Shape

```
server/
  index.ts            Express: API + Vite middleware (dev) / static (prod)
  env.ts              every tunable, one place
  routes.ts           /api/config, /api/reports, /api/reports/:id
  cache.ts            TTL cache with in-flight de-duplication
  emburse/
    provider.ts       picks a provider from EMBURSE_PRODUCT
    professional.ts   Emburse Professional (key/secret)
    oauth.ts          Enterprise + Spend (client credentials)
    demo.ts           deterministic sample data
    policy.ts         review flags
    map.ts            provider rows → domain model
src/                  React + Tailwind client
```

## Read-only, on purpose

v1 never writes to Emburse — no approve, reject or submit. Approvals stay in
Emburse where the audit trail lives. This app decides *what deserves attention*;
the decision itself is still made in the system of record.
