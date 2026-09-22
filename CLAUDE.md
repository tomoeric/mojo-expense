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

## What the app does and does not control

The daily export is produced by a Power Automate Desktop flow on a laptop. The
app cannot start it, schedule it, or read its state. Everything the app shows
about the schedule is **a record of what was agreed plus what actually
arrived** — never a claim about what the robot did. Keep that distinction in
the copy, or the UI starts lying the first time the flow breaks.

See `docs/POWER-AUTOMATE.md` for the flow and `docs/TESTING.md` for how it is
verified.
