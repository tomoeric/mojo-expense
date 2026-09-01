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

**The default is Emburse Professional**, the mid-market product where a reviewer
works a queue of company users' expense reports.

To confirm which one MOJO is on, check the URL people log into:

- `pro.emburse.app` or `certify.com` → **Professional** (leave `EMBURSE_PRODUCT=professional`)
- Chrome River / `chromeriver.com` → **Enterprise** (`EMBURSE_PRODUCT=enterprise`)
- `spend.emburse.com` → **Spend** (`EMBURSE_PRODUCT=spend`)

All three share one code path — the product only changes how the app
authenticates and which paths it calls, both of which are env vars.

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
