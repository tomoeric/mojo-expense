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

## Importing the daily export

Emburse Spend's API is provisioning-only — members, team fields, receipt
upload — with no endpoint for expenses at any tier. The data therefore comes
from the **Expenses PDF export**, uploaded on the Import page.

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

Both land in the same watched SharePoint folder, and because identity is
derived from the row fields rather than the file, a PDF imported later attaches
its receipts to rows that already arrived another way.

### SharePoint sync

Set `SHAREPOINT_DRIVE_ID` and `SHAREPOINT_FOLDER_ID` (defaults point at
AI Projects → Shared Documents → Emburse Transactions) and the app polls that
folder every `SHAREPOINT_POLL_MINUTES` (default 60), importing anything new.
There is also a **Sync SharePoint** button on the Import page.

Graph is called **app-only**, so the Entra app registration needs the
APPLICATION permission `Sites.Read.All` — or `Sites.Selected` granted on this
site — with admin consent. The delegated scopes used for sign-in are not
enough, and that mismatch is the usual cause of a 403.

Each SharePoint item is remembered by id and eTag so a file is downloaded once;
a file that fails to import is recorded with its error and not retried every
poll, so one malformed export cannot wedge the loop.

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
