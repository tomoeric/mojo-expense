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
- **Report drawer** — line-level detail with receipt state, with the lines that
  triggered a warning tinted.

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
