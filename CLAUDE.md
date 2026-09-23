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
- **A failed decision must be re-doable, and must say why it failed.** A
  failure leaves the expense UNDECIDED in Emburse, so a badge with no action
  strands the row — which is exactly what happened the first time a reviewer
  hit one. `failed` therefore shows the badge AND the Approve/Deny buttons, and
  the reason is on screen rather than in a `title` tooltip nobody hovers.
  `decisionsFor` returns the newest attempt, so a retry supersedes the failure.
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

## Rules

- **A rule is an expectation, not a filter**: WHEN conditions pick the
  expenses, MUST says what they have to be, and the action applies to the ones
  that do not. `server/rules/engine.ts` is pure and has no database in it; the
  store and the runner are separate so the logic can be tested without one.
- **`flag` and `deny` act on the FAILURES; `approve` acts on the PASSES.** That
  asymmetry is the only reading under which both "deny anything from this
  merchant" and "approve anything matching this pattern" fit one shape.
- **Evaluation is JavaScript over rows, never generated SQL.** Rules are
  user-authored data; building a WHERE clause out of them is a standing
  invitation to get that wrong once. At this size the scan costs nothing.
- **A condition can compare two columns** (`Condition.compare`), which is the
  only way to say "the total read off the receipt must equal the amount
  claimed" — the check an expense queue most needs, and one that a
  field-against-a-constant rule cannot state. Only same-kind columns compare;
  money compares with tolerance (2¢ or 1%), because two figures for one
  purchase differ by a cent for reasons nobody wants to be told about.
- **`test()` is three-state: true, false, or NULL for "cannot be judged".**
  A receipt total is null until the reader has read it, and treating that as
  "does not match" would flag the whole queue the moment somebody wrote the
  rule, while the rule looked correct. Unknown never fires: not a flag, not a
  denial, and not an approval either. An unjudgeable WHEN condition does not
  match, so the expense stays out of the rule's scope entirely.
- **Operator wording is per-field** (`opLabel`), and it is the server's answer
  so a rule reads the same in the editor, the list and the flag. "is" is fine
  for a category and ambiguous for money — nobody asks whether one amount "is"
  another, so money says **equals** / **does not equal**, and a receipt total
  says **was read** / **was not read** rather than blank.
- **A blank value must never match everything.** An empty `contains` that
  matched every row would, on an approve rule, approve the entire queue. Guarded
  in `test()` and asserted in `test-rules.ts`.
- **Four fences on approving and denying, and all four must hold**: the expense
  is still in the inbox; nothing is already queued or applied for it; the rule's
  owner has a stored Emburse login (there is no shared fallback — Emburse
  records the decision against whoever signs in); and no more than
  `MAX_DECISIONS_PER_RUN` per rule per run. The cap is the important one — a
  mistyped condition is the normal first draft of a rule, and the cap is the
  difference between catching it at 25 expenses and at 400.
- **Test through `readBody`, not only the engine.** A rule arrives as JSON and
  is rebuilt field by field rather than trusted, so a field the parser forgets
  to carry is invisible to every test that constructs a rule in memory. That is
  exactly how `compare` was dropped once, with the engine tests all green.
- **Rules run after the import COMMITS**, never inside its transaction: a
  decision must not exist for an expense whose import rolled back. A failure
  there is a warning on the import, not a failed import.
- **Editing a rule deletes its hits.** Verdicts reached under the old
  definition are not evidence of anything, and an expense the edited rule no
  longer matches would otherwise keep a flag from a rule that has stopped
  saying it.
- **Writing a rule is its own permission**, not `isAdmin` (`rules/editors.ts`).
  Admin is about shared settings; this is about approving and denying real
  expenses. The list is stored, not an env var, so somebody can be added
  without a redeploy — which is the point.
- **An empty editor list means "any admin", not "nobody".** A default-deny
  allow-list would lock out the person who has to populate it. Restriction
  starts the moment somebody is named, and emptying the list opens it back up.
- **The editor list is only as strong as `AUTH_ADMINS`.** Managing it is
  admin-only, and with `AUTH_ADMINS` unset everyone signing in is an admin and
  could re-add themselves. The panel says so rather than implying a security
  property it does not have. Do not remove that warning without setting
  `AUTH_ADMINS`.
- **Rules can test receipt line items**, so `ensureRules()` creates the
  receipt-items tables too. Without that, an app with no working Anthropic key
  has no `receipt_items` table and every import's rule run dies on the join.

## Anthropic credentials

- **Replit's integration is not a key.** It injects
  `AI_INTEGRATIONS_ANTHROPIC_API_KEY=_DUMMY_API_KEY_` and points
  `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` at a sidecar on localhost that holds the
  real credential. Both secrets are therefore always present and always look
  right whether or not an integration is attached — a full Secrets page proves
  nothing, and the only symptom is `404 Replit AI Integrations is not
  configured` at the first call.
- **One client, in `server/ai.ts`.** The sidecar gets one chance: if it 404s or
  is not listening, and `ANTHROPIC_API_KEY` is set, the client rebuilds on the
  direct key and stays there for the process. Tried once, not once per receipt.
- Never report an AI failure as a status code. `describeAiConfig()` turns the
  configuration ones into the fix.
- **Configuration is testable where it is set.** `POST /api/ai-check` makes one
  four-token call and reports which credential answered, surfaced as "Test the
  connection" on the Configuration page. Before it existed the only way to find
  out was to open an expense, find a receipt and press Check — three steps from
  the setting, with an error that could mean four different things.
- **The integration cannot be copied between Repls, and this is not a bug.**
  The key is the literal `_DUMMY_API_KEY_` and the URL is `localhost`; the real
  credential lives in a sidecar process that Replit runs only inside a Repl
  that has the integration. Each app needs its own, which is also how the
  billing is scoped. A direct `ANTHROPIC_API_KEY` *is* portable, because it is
  a credential rather than a pointer.

## Navigation

- **The rail is Review Queue · All Reports · Analytics · Rules · Import ·
  Configuration**, with the three permanent lists nested under Configuration.
  They are reference data — what Emburse offers, not what anybody does today —
  and having four of eight top-level buttons be lists buried the ones that are
  actual work.
- **A group opens when you are inside it and closes when you leave**, with no
  toggle. A collapse control that the current page immediately overrides is a
  dead control, and the group's own page lists the same destinations anyway.
- **A group's button navigates somewhere.** `configuration` is a real route
  with a contents page, not a disclosure widget — a rail button that goes
  nowhere is the other kind of dead control. New sub-pages go in `children` on
  the rail entry and pick up nesting, deep links and the mobile second row for
  free.

## Testing a connection, and viewing as somebody else

- **"Test connection" signs in and opens the grid, and decides nothing.**
  Approving a real expense used to be the only way to find out whether a login
  worked, so a new reviewer's first lesson was that a real expense "did not go
  through". It goes as far as the grid on purpose: the two failures people hit
  are the device check (at sign-in) and the grid not appearing (after it), and
  a test that stopped at "signed in" would call the second one fine.
- **While viewing as somebody, it tests THEIR login.** The first version always
  used the real signed-in person, which is precisely the login that already
  works — an admin diagnosing somebody else learned nothing. The code prompt
  still goes to whoever pressed the button, and the code itself still arrives
  on the tested account's phone, so the admin has to ask them to read it out.
- **A MISSING ADMIN TAB IS NOT A SUCCESS.** The grid every decision searches is
  Emburse's team-wide view, reached through the ADMIN tab, so an account
  without admin rights there signs in perfectly and then has no grid — and it
  surfaced three steps later as a grid problem. "Export works, approvals do
  not, same selectors" means the account, not the markup.
- **Never report a missing grid as "the grid did not appear".** `whyNoGrid`
  separates the four causes that have four different fixes: bounced back to
  sign-in, genuinely no results, a selector matching only hidden elements, or
  nothing matching at all — and it quotes the page.
- **Viewing as somebody else is READ ONLY** (`auth/view-as.ts`), and the server
  enforces it rather than the UI: every non-GET is refused while it is on, bar
  switching target, switching back, and the dry run. An admin clicking Approve
  in somebody else's view would put their name on a financial approval they
  never made.
- **The view-as cookie carries a name, never authority.** Whether it is
  honoured is re-decided from the real session on every request, so setting it
  by hand as a non-admin achieves nothing. It cannot reach anybody's password:
  those stay sealed and are only opened server-side by the worker.

## The review drawer

- **The receipt gets its own pane on the left, and it zooms.** The picture is
  the thing being reviewed; embedding it in the flow of the details meant
  scrolling away from it to reach the decision. The pane stays put while the
  details beside it scroll, and the ⤢ button hands off to full screen.
- **One zoom implementation, not two.** `ReceiptPane` holds the load /
  zoom / pan logic and takes a `tone`; `ReceiptViewer` is that pane with
  full-screen chrome. They were briefly separate and the inline one had no
  zoom, which is the one thing a reviewer squinting at thermal paper needs.
- **Approve and deny live there too.** The drawer is where somebody has
  actually read the receipt, which is the moment the decision is made — going
  back to the table to click Approve puts a step between looking and saying so.
  It uses the same `useDecisions` hook as the queue, so both stay in step.
- **A line is a card, not a table row**, because the row could not carry the
  note, the site, what it was paid with, the receipt and the decision. With no
  stored Emburse login the decide footer is dropped entirely rather than
  rendering an empty bar.

## What a daily import does to what is already there

- **Identical rows are kept apart, not collapsed.** The export has no
  transaction id, so an expense is seven fields — and two fuel purchases at the
  same pump for the same amount on the same day match on all seven. The
  importer used to key a Map on that, so the second row overwrote the first:
  rows parsed, fewer stored, and a real expense that never reached the queue.
  `dedupeKey(e, occurrence)` separates them; occurrence 0 hashes exactly as
  before, so no existing expense is re-identified.
- **Re-importing changes nothing.** The keys are deterministic and the upsert
  is `ON CONFLICT (dedupe_key)`, so the same export twice is a no-op.
- **Anything missing from the newest export leaves the queue** — `in_inbox =
  false, left_inbox_at = now()`. Flagged, never deleted: it was processed, not
  forgotten, and its history is worth keeping.
- **`note` is deliberately NOT in the key** so an edited description updates
  the row. The seven fields that ARE in it mean a re-categorised expense
  arrives as a new row while the old one leaves — correct for deciding (the
  new version is what needs a decision) but worth knowing before somebody
  reports it as a duplicate.

## The permanent lists

- **Categories, Locations/Sites and Departments are kept, not just displayed**
  (`server/import/taxonomy.ts`). Every name an import carries goes into
  `expense_taxonomy` and stays there, whether or not anything is using it
  today: "no open expenses" and "no longer a real value" are different things,
  and only Emburse knows which.
- **Nothing on the lists is authored by hand**, and the routes are read-only.
  A name typed in would belong to no expense; a name deleted would come back
  with the next export that mentions it.
- **Counts are never stored.** They are counted off `expenses` at read time, so
  they cannot go stale across re-imports, releases and the inbox flag. The
  table holds names and dates only.
- **`ensureTaxonomy()` backfills from `expenses` on every boot**, which is how
  a database that predates the table comes out complete. It inserts nothing
  when there is nothing new.
- **Location and Department come out of one wrapped Details cell**, as labelled
  pairs in either order (`parseDetails` in `parse-pdf.ts`). If Emburse renames
  a label the field must come back empty rather than wrong — a blank site is
  visible on the Locations page, a wrong one is not. The Locations page shows
  the blank count beside the names for exactly that reason.

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
- **A verification code can arrive BEFORE the sign-in form.** With a session
  already remembered, Emburse skips email and password and opens straight on
  `/code-authentication`. `signIn` raced only the form and the app, so neither
  appeared, it timed out, and it blamed the `loginEmail` selector for a page
  that selector was never meant to match — while a code box sat there waiting.
  The code box is in that race now. No amount of correcting selectors fixes
  this one, so the message must never suggest it.
- **Decisions can ask for a code too.** `decide.ts` shares `signIn` with the
  export but passed no challenge hook, so the first decision from an account
  the server's browser had never signed in as simply failed. The worker now
  passes one owned by the decider — who clicked Approve moments ago, so there
  is somebody to ask — and the prompt appears on the QUEUE, not only on the
  admin Import page where the export's copy lives.
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
