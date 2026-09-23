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

## Approving and denying

- **Deciding records; a worker applies.** Clicking Approve/Deny writes a row in
  `expense_decisions` and returns. `decision-worker.ts` applies the queue in one
  browser session that signs in once — because on the real tenant a sign-in is
  ~50s and a decision that drove Emburse on the click would be ~90s each.
- **One browser, shared.** The export and decisions drive the same profile and
  Chromium locks it, so both go through `withBrowser()` in `browser-lock.ts`.
  Anything new that opens a browser must too, or it will collide with the 6am
  export and fail on a lock error that blames nothing.
- **A decision is applied under the decider's own Emburse login**
  (`credentialForUser`), never a shared one and never a fallback. Emburse
  records an approval against whichever account signed in, so the wrong login
  puts the wrong name on it in the finance system. Somebody with no stored
  Emburse login is refused at the point of clicking, not left with decisions
  that can never be carried out.
- **The target comes from our records, never the request.** It is what the
  browser verifies the Emburse row against; a client that could supply it could
  name one expense and describe another.
- **A denial needs a reason**, enforced in `queueDecision` rather than only in
  the dialog.
- **Receipts are released only once an export confirms the expense left the
  inbox.** An approval is known to have taken only then, and by that point the
  image can never be fetched again. Links go first, images only when nothing
  references them — they are shared by content hash.

## Receipts

- **A receipt is a photo embedded in the export PDF.** Keep it at the camera's
  own resolution: walk the page's structured text, take the largest image
  block, and `toPixmap()` it. Rasterising the page instead caps the result at
  the page geometry — measured, that lost 72% of the pixels.
- `RENDER_VERSION` must be bumped whenever rendering changes, or re-imports
  will not replace the older images.
- **Line items are read once per image and stored** (`receipt-items.ts`), keyed
  on the same content hash as the picture — so a shared receipt is read once,
  and the items survive the image being released after an approval. That
  survival is the point: an approved expense's receipt can never be fetched
  again, so anything unread when it goes is unread forever. The reader
  (`receipt-reader.ts`) runs shortly after each import for that reason, not on
  a daily schedule.

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
  be read as "already done". That mistake shipped four times: a failed login
  reported as three green steps, an exports link silently not clicked, section
  chips silently skipped, and a chip whose state could not be read treated as
  "off" and then toggled six times.
- **Wait for a condition, never sample one.** The dialog's title renders before
  its body, the dashboard paints seconds after sign-in, and a click re-renders
  what was just read. Anything using `isVisible()` as a one-shot answer is a
  bug waiting for a slow morning.
- **A warning that fires every time is worse than none.** The page-1 header
  check warned on every successful export, because Emburse prints the grid's
  search there and never names the dialog's chips. Suppressed only where the
  run verified the chips itself (`sectionsVerified`); files arriving any other
  way still get the check.

See `docs/TESTING.md`. The mock (`scripts/mock-emburse.ts`) is the only thing
that exercises the failure paths — sign-in rejected, a second factor, a device
check, a code typed in wrong — and every one of those was a real bug it caught
before a person did. Add to it before adding to the runner.
