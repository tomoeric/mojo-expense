# mojo-expense — working notes for Claude

## Always end with the deploy commands — BOTH blocks, every time

Every time work is finished and pushed, end the reply with **two** copy-paste
blocks. Not inline prose, not a description of what to run, and not one block
with the other described in words.

First, the normal deploy:

```bash
git pull origin main
pnpm install
pnpm run build
```

Then "restart".

Second, **always**, without waiting to be asked and without waiting for a pull
to fail — the divergent-branch recovery:

```bash
git fetch origin main
git branch backup-local-$(date +%s)
git reset --hard origin/main
pnpm install
pnpm run build
```

The Replit workspace picks up local commits on its own (an edit in the Replit
editor, an agent run), so `git pull` fails with `divergent branches` often
enough that making it a troubleshooting step means it is missing exactly when
it is needed. The `git branch backup-local-…` line runs first on purpose: it
parks whatever the workspace had on a dated branch, so the `reset --hard` never
destroys anything — which is what makes it safe to hand over unconditionally.

Neither block is optional; a reply that ends without both is incomplete. If a
step beyond restart is needed (re-run the import, change a secret), say so after
the blocks.

## Shape

- Standalone app. Not part of ninja-live-status: own repo, own Replit app, own
  Neon database. Shares only the Entra app registration for sign-in.
- Branch `main`. Deployed as a **Reserved VM**, so the process stays alive
  between requests and background timers actually fire.
- `pnpm run typecheck` and `pnpm run build` from the root. Verification scripts
  live in `scripts/` and run with `pnpm exec tsx`.

## Schema is owned by db-bootstrap, not migrations

Tables and columns are created by idempotent `CREATE/ALTER … IF NOT EXISTS` in
`server/db.ts`, which runs on boot. A plain build + restart applies a schema
change; there is no migration step.

## The export is the app's own job

The daily export is produced **by this server**, driving Emburse in a headless
Chromium (`server/emburse/auto-export.ts`). It replaced a Power Automate flow on
a laptop, which could not be relied on: a laptop sleeps, travels, and belongs to
one person. The Reserved VM is already awake.

Three things follow, and all three are easy to break:

- **Selectors are configuration, not code.** Emburse's markup cannot be known
  from outside their tenant, so every selector is editable in Export settings
  and a failed run names the step, quotes what it looked for, and hands back a
  screenshot. Never hard-code a new one; add it to `DEFAULT_SELECTORS`,
  `SELECTOR_HELP` and `STEP_SELECTORS` so it can be corrected without a deploy.
- **The remembered device lives in two places, and needs both.** The browser
  profile (`EMBURSE_PROFILE_DIR`) carries Emburse's "remember this device"
  between runs — but it sits in the app directory, which **Replit rebuilds on
  every deploy**, so on its own the device is forgotten every time the app
  ships. The cookie jar in `emburse_browser_state` (sealed with the credential
  key) is what carries it across deploys. Anything that launches a fresh
  browser per run, or skips `restoreCookies`, silently puts somebody back to
  reading a verification code every morning.
- **No request waits for a run.** A run takes minutes; the proxy in front of
  the app gives up long before that and answers with `upstream request
  timeout` as plain text. `POST /api/export-run` returns as soon as the run
  has an id, and the page follows it by polling `/api/export-runs` — which is
  also how a parked verification-code prompt reaches the screen. Never make
  the page await a run, and never `res.json()` a response without checking it
  is JSON.
- **Absence is never success.** A selector that matches nothing must fail, not
  be read as "already done". That mistake shipped once and turned a failed
  login into three green steps.

See `docs/TESTING.md`. The mock (`scripts/mock-emburse.ts`) is the only thing
that exercises the failure paths — sign-in rejected, a second factor, a device
check, a code typed in wrong — and every one of those was a real bug it caught
before a person did. Add to it before adding to the runner.
