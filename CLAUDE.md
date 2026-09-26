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
- **An import deletes everything the newest export no longer carries**
  (`purgeFinished`) — the expense, its receipt links, its changes, its rule
  hits, and any image and reading nothing points at any more. Approved, denied
  and decided directly in Emburse all end the same way: the review is over.
- **Never before the expense leaves.** An expense in the inbox is still being
  reviewed, and by the time one leaves the image can never be fetched again.
  Links go first, images only when nothing references them — they are shared by
  content hash, so one purchase split across sites points several expenses at
  the same picture.
- **`expense_decisions` outlives the expense, and has no foreign key for that
  reason.** It is the only audit trail on this side of the wire, and `target`
  froze what the reviewer was looking at, so the row stands on its own once the
  expense is gone. A decision still `pending` when its expense is purged is
  cancelled, not left for the worker to retry against a row that is not there.

## Receipts

- **A receipt is a photo embedded in the export PDF.** Keep it at the camera's
  own resolution: walk the page's structured text, take the largest image
  block, and `toPixmap()` it. Rasterising the page instead caps the result at
  the page geometry — measured, that lost 72% of the pixels.
- `RENDER_VERSION` must be bumped whenever rendering changes, or re-imports
  will not replace the older images.
- **Line items are read once per image and stored** (`receipt-items.ts`), keyed
  on the same content hash as the picture, so an image belonging to several
  expenses is read once rather than once per expense. A reading goes when its
  image does, because the expense it described has gone too. An expense out of
  the inbox can never be exported again, so anything unread when it leaves is
  unread forever — which is why the reader (`receipt-reader.ts`) runs shortly
  after each import rather than on a daily schedule.

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
- **Two fields describe a GROUP, not one expense**: `dayCount` ("Matching
  expenses that day") and `dayTotal` ("Matching total that day"), counted over
  the expenses the WHEN matched, for one person on one day. "More than three
  meals in a day" and "more than $75 of meals in a day" are the two most useful
  things to ask of an expense queue, and no single row can answer either.
  They are MUST-only — computed FROM the WHEN, so using one in the WHEN would
  be circular, and `problems()` refuses it.
- **Group fields need the group passed in.** `evaluate(subject, rule, group)`:
  without it they return null and the rule fires on nothing, rather than
  guessing. `runRules` and `previewRule` both build the groups the same way,
  or the preview would lie about what the rule does.
- **`lte` / `gte` exist because "at most 3" is how a limit is spoken.**
  Writing it as "less than 4" is an off-by-one somebody gets wrong once and
  never notices.
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
- **A rule reads as what it CATCHES, not what it requires** (`summarise`). The
  old wording — "Matching total that day is more than 75 — otherwise flag it"
  — reads to anybody as "flag anything over 75" and means the opposite. Two
  real rules shipped backwards that way and caught 204 expenses out of a queue
  of 126, because the sentence agreed with the mistaken reading. Phrased as
  the catch, a correct rule reads plainly and an inverted one reads absurd.
  Approve is the exception and stays a requirement, because it acts on the
  passes.
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
  is not listening, **and `ANTHROPIC_API_KEY` is set**, the client rebuilds on
  the direct key and stays there for the process. Tried once, not once per
  receipt.
- **Never disown the gateway with nowhere to go.** `retryOnDirectKey` used to
  set `gatewayDisowned` before checking whether a direct key existed. With
  none, `aiVia()` then returned null for the rest of the process: every later
  call reported "No Anthropic credential is set" — flatly untrue, the secrets
  were right there — and the sidecar was never tried again, so attaching the
  integration appeared to change nothing until a restart. Exactly the loop the
  fallback exists to prevent.
- **`checkAi()` resets the client first.** Somebody pressing "Test the
  connection" has just changed something and is asking whether it worked NOW.
  Answering from a client chosen minutes ago, or a gateway disowned by an
  earlier failure, makes the button report the past.
- **A 429 from the test button is not a result.** The endpoint keeps a few
  seconds between calls; the page waits and retries rather than rendering
  "Give it a moment" in the same amber box as a real diagnosis, where a
  double-click read as the answer.
- Never report an AI failure as a status code. `describeAiConfig()` turns the
  configuration ones into the fix.
- **A 401 must name the key it used, and must not claim where it went.** A
  rejected key is nearly always a DAMAGED copy rather than a wrong one, and
  every way it gets damaged — a trailing newline from a paste, hand-typed
  quotes, a half-selected copy — is invisible in a Secrets box. So the message
  carries a `fingerprint()`: both ends, the length, and what is wrong with the
  shape, never the middle. And it only says "the key reached Anthropic" when
  `ANTHROPIC_BASE_URL` is unset — with a proxy or a copied sidecar address in
  there the 401 came from that URL, and sending somebody off to rotate a
  perfectly good key is the wrong answer entirely.
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
- **It tests the signed-in person's own login**, and everybody can press it —
  `requireAuth`, not `requireAdmin`. A verification code it raises goes to that
  person's own phone, so they are the one who can clear it.
- **A MISSING TEAM TAB IS NOT A SUCCESS — but it may not be the account.** The
  grid every decision searches is Emburse's team-wide view, reached through
  that tab, so an account without the rights signs in perfectly and then has
  no grid, surfacing three steps later as a grid problem. **Emburse names the
  tab per tenant, though: ADMIN on some, MANAGER on this one.** The selector
  matched only ADMIN, so every run on a MANAGER tenant reported "no ADMIN tab"
  — harmless for the export, which reaches the grid by URL, but it told people
  their account might lack a view that was on screen the whole time. It
  matches either name now (`text=/^\s*(ADMIN|MANAGER)\s*$/i`), the mock renders
  MANAGER so a regression is caught, and the failure names the selector it
  tried rather than only blaming the account. "Export works, approvals do not,
  same selectors" means the account — once you have ruled out the tab's name.
- **Never report a missing grid as "the grid did not appear".** `whyNoGrid`
  separates the four causes that have four different fixes: bounced back to
  sign-in, genuinely no results, a selector matching only hidden elements, or
  nothing matching at all — and it quotes the page.


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
- **The drawer opens on the expense that was clicked**, not on its day.
  Reports are grouped one per person per day, and the queue used to hand the
  drawer the day alone — so clicking one receipt gave a heading reading
  "3 expenses", the day's totals, and whichever receipt sorted first in the
  pane. The row you picked was somewhere in the list. The clicked line id is
  threaded through as `focusId`: it leads the header, opens the receipt pane,
  and sorts first, with the rest of that day named underneath as context.
  One receipt against one claim is the unit of review; the day is background.
- **A day rule flags a SET, so the flag count is a way into it.** "More than
  three meals" marks every expense in the day, because the problem is the
  group — read one row at a time it looks like an $11 McDonald's nobody could
  object to. Clicking the amber chip narrows the queue to that person on that
  date, with a pill saying so and a way back. Individual by default, grouped
  when you ask, which is the way round that earlier flattening decision
  already settled.
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
- **Anything missing from the newest export is DELETED.** The export is the
  queue; a row it no longer carries has been decided upstream and is not
  waiting on anybody here. Rows used to be kept behind `in_inbox = false`, and
  within weeks the app showed 572 expenses against Emburse's 137.
- **Which makes a truncated export destructive, and nothing else catches one.**
  A file holding 5 rows where yesterday held 137 reconciles against its own
  TOTAL line, is not a duplicate and is not stale. So an import is refused when
  it would take more than four in five of the WAITING expenses (and warns above
  half), unless it is forced. Measured against what is waiting rather than the
  whole table, so a first import after a long backlog is not blocked by the
  backlog it exists to clear.
- **Section names are per tenant, and a wrong one stops the export dead.**
  This tenant's chips are Needs Review · Pending Other's Review · Pending
  Submission · Denied · Completed. "Needs Manager Review" was in `ALL_SECTIONS`
  and in the defaults, matched nothing, and failed every run at "set the
  sections" — correctly, since the alternative is exporting the wrong rows.
  The failure now lists the chips the dialog does offer, so the next wrong name
  is a tick box rather than a selector hunt.
- **And `readSettings` drops a stored name that is not in `ALL_SECTIONS`.**
  Correcting the constant fixed new databases and did nothing for the row
  already written, so the export went on failing every morning and the cure
  was two clicks nobody could know to make. A name that cannot match a chip
  can only ever stop the run, so it is dropped on read, falling back to the
  default if that empties the list. `writeSettings` already filtered against
  `ALL_SECTIONS`, which is why only pre-rename rows carry one.
- **Nothing on a settings page may look saved when it is not.** The export
  settings page is long and its Save button sat at the bottom; unchecking a
  section looked like it took effect and was silently lost on refresh. A
  sticky bar now appears the moment anything is dirty.
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
- **EVERY path that signs in must save the cookie jar, not just the export.**
  `rememberCookies` was called only by `runAutoExport`, so somebody who cleared
  a device check while approving had the trust written into the browser
  profile and nowhere else — and Replit rebuilds that directory on every
  deploy. They were asked for a code again on the next ship, while the page
  said Emburse trusts this browser. It does; just not as them. Trust is per
  Emburse ACCOUNT, so each person verifies once themselves.
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
- **The FIRST navigation is not a step and must not share a step's budget.**
  It is a cold container's first outbound TLS plus Emburse's OAuth redirect
  chain, before a byte of the app arrives. A warm manual run spends 15s of a
  step's 30s on it, so the 6am scheduled run timed out at 30s three mornings
  running while every manual run looked healthy. `EMBURSE_OPEN_TIMEOUT_MS`
  (90s) is its own, and it retries once.
- **A catch-all step must not name a failure it did not witness.** Everything
  thrown out of `runSteps` was pushed as **"start browser"**, so a run whose
  navigation timed out was headlined *Stopped at "start browser"* — and the
  browser had started perfectly. It is only called that when no step ran at
  all. The failure screenshot is on a 5s leash and can never throw, for the
  same reason: a dead page timed the screenshot out too and added a second red
  step saying `page.screenshot: Timeout` on top of the real cause.
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

## What the AI costs

- **Tokens are stored; money is worked out at display time** (`server/ai/usage.ts`).
  Published prices change, and a row holding dollars would freeze whatever the
  table said that day. Correcting a price is a one-line edit, not a backfill.
- **The meter lives in `callAnthropic`**, the one place every AI call passes
  through, so nothing added later can spend money without being counted. It is
  best-effort and never awaited into the call path: a receipt that was read
  successfully must not fail because the meter did.
- **An unpriced model makes the total UNKNOWN, never lower.** Silently adding
  zero for a model with no published rate on file gives a figure that looks
  precise and is too small. The summary returns null and names the model.
- **Receipt reading runs on Haiku 4.5, not Opus.** Reading line items off a
  photograph is extraction, not reasoning. Opus was the default and cost about
  five times as much per receipt — the single biggest saving here, and larger
  than the difference between billing routes.
- **Not every model takes `effort`.** Haiku 4.5 rejects it with a 400, and
  moving receipt reading to Haiku for the cost saving broke every read until
  the parameter came out. `supportsEffort()` is an allow-list and an
  unrecognised model is assumed NOT to support it: sending it where it is
  refused fails the whole call, omitting it only loses a tuning knob. Spread
  it into `output_config` rather than building that object in a helper —
  `messages.parse` infers the parsed shape from `format`, and a helper's
  return type erases it.
- **Estimating this by hand does not work.** Every figure quoted before the
  meter existed was wrong, once by a factor of fifty, because it rested on
  assumed token counts. Quote the meter or say you do not know.

## Testing your own Emburse connection

- **It lives on "Your Emburse login", under the user icon** — the page where
  the credential is entered is where "does it work" belongs. It tests the
  signed-in person's own login and nobody else's, so Brian testing it tests
  Brian's. It used to sit on the review queue, which is neither where the
  login is set nor a place a reviewer wants an admin-shaped panel.
