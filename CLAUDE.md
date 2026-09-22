# mojo-expense — working notes for Claude

## Always end with the deploy commands

Every time work is finished and pushed, give the Replit deploy commands as one
copy-paste block — not inline prose, not a description of what to run:

```bash
git pull origin main
pnpm install
pnpm run build
```

Then "restart". This is not optional; a reply that ends without it is
incomplete. If a step beyond restart is needed (re-run the import, change a
secret), say so after the block.

If a pull fails with `divergent branches`, the workspace has local commits:

```bash
git fetch origin main
git branch backup-local-$(date +%s)
git reset --hard origin/main
pnpm install
pnpm run build
```

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
- **The browser profile is persistent** (`EMBURSE_PROFILE_DIR`). That is what
  makes Emburse's "remember this device" mean anything. Anything that launches
  a fresh browser per run silently undoes it.
- **Absence is never success.** A selector that matches nothing must fail, not
  be read as "already done". That mistake shipped once and turned a failed
  login into three green steps.

See `docs/TESTING.md`. The mock (`scripts/mock-emburse.ts`) is the only thing
that exercises the failure paths — sign-in rejected, a second factor, a device
check, a code typed in wrong — and every one of those was a real bug it caught
before a person did. Add to it before adding to the runner.
