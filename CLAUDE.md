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
- **The step-by-step trace is a switch in Configuration**, off by default
  (`app_flags.traceDecisions`). The browser run already produced the steps and
  threw all but the first failing line away, so "it did not go through"
  covered a wrong password, a device check, an account with no team view and
  a renamed button — four causes, four fixes, one message. With it on, each
  decision keeps every stage with its timing, successes included, because
  "it worked, and here is how" is what makes the next failure readable.
  `settleDecision` COALESCEs the column, so a retry cannot erase a trace that
  was already captured. A null trace means NOT RECORDED and must never be
  shown as "no steps".
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

## Finding the row

Two separate things, and confusing them cost a queue full of failures.

- **The SEARCH is what narrows Emburse's grid**, and one term is not enough.
  Our export carries the card descriptor with the merchant name run into it —
  `MAVERIK #5074MAVERIK COUNTRY STORE` — and Emburse's own search box returns
  **no rows** for `MAVERIK #5074` while the expense sits in the grid one filter
  away; searched for `MAVERIK`, it is right there. `searchTerms()` therefore
  tries the first two words, then the first word with digits and punctuation
  off, then the longest run of plain letters, stopping at the first that
  returns the expense, and finally the **cardholder's surname** — Emburse's
  names are clean where the merchant strings are not, so that is the rung most
  likely to rescue a merchant nothing else matches, and a surname alone returns
  only that person's queue. It is last, not first, only because it is not yet
  known whether this tenant's search box looks at the cardholder at all; the
  failure messages name every term and what it returned, so the moment one
  shows the surname returning rows it should be promoted. Better still would
  be Emburse's own **users filter** — a real filter rather than a text search —
  which needs one thing nobody here has: the URL parameter it uses.
  Searching WIDER is the safe direction: every row still
  has to pass all four checks below, so a broad search costs seconds while a
  term that silently excluded the right row reports "not there" about an
  expense that is.
- **The MATCH is what picks the row**, and it is strict. All four must hold:
  **amount** exact and unsigned with the sign read from the page (so `6.40`
  cannot match inside `$126.40`, and `($47.56)` is a credit); **surname**,
  with a truncation stem accepted only where the page marks the cut
  (`CRAIG W DEMORA…`); **first word of the merchant**, ≥4 chars, punctuation
  stripped from both sides; and **date** in any of Emburse's forms, padded or
  not. Exactly one VISIBLE match acts; two refuse.
- **Emburse's text search MISSES ROWS THAT ARE THERE.** Not "is fussy about
  terms" — misses them. Two LA MADRELA expenses, same cardholder, both in Needs
  Review: searching "MADRELA" returned the one from the 24th and not the one
  from the 9th. So an empty or partial search result is not evidence of
  anything, and nothing may be concluded from it.
- **Type into what the click FOCUSED, not into a box found by selector.** The
  page has its own Search field beside the users dropdown, and a union selector
  returns matches in DOM order — so `input[role=combobox], input[placeholder*=search]`
  put the cardholder's name into the PAGE search box, which filtered the grid to
  nothing and left the dropdown unnarrowed. Clicking a combobox focuses its own
  input. `userFilterInput` therefore ships EMPTY, and is only for a tenant where
  the click focuses nothing.
- **The users FILTER is the authoritative view**, and the only thing "this
  expense is not in the queue" may be claimed from. The parameter is
  `filters[user_id][]` and the value is an opaque id
  (`uk4l0byvo7zzwgfzidt34awh2afoixiphkfka8fx`), not a name, so it cannot be
  constructed — only learned by driving the dropdown once and reading the URL
  that comes back. `filterToCardholder` does that and caches the id in memory
  for the life of the process; after the first decision for a person it is one
  navigation. It is the FALLBACK, not the route: a search that works costs one
  page load, and three clicks per decision would be minutes a day.

## When a decision fails

- **EVERY navigation needs its own budget, not just the first one.** The open
  got `openTimeoutMs` (90s) while the grid navigations were left on the shared
  30s step timeout — and then the search ladder made up to three of them per
  decision, so half of one morning's failures were
  "page.goto: Timeout 30000ms exceeded" on a GRID, while the message and the
  screenshot pointed at a sign-in page. The failure report now names the step
  for exactly this reason: the same sentence means different things at
  different points in the run.
- **The export's hardening has to reach the decision path, every time.** Both
  drive the same tenant through the same browser, and twice now the export
  learned something the decisions did not inherit: the export accepted the
  item-count line as proof the grid had arrived while decisions demanded the
  grid selector, and the export opened Emburse with its own 90s budget and
  three attempts while decisions used a bare `page.goto` on the 30s step
  budget. The second one failed a whole batch of queued approvals at
  "open Emburse" with `page.goto: Timeout 30000ms exceeded` — against a
  screenshot of a sign-in page that had plainly finished rendering. Both now
  call the SAME `openEmburse()` / `gridLoaded()`. Anything added to one path
  belongs in the shared function, not copied.
- **"Not in Emburse's queue" is not a failure.** An expense that has already
  been approved or denied LEAVES Needs Review, so once our copy of the queue is
  a few days stale, every decision on it fails that way — forty red rows nobody
  can act on, burying the handful that need somebody. `expense_decisions.
  not_in_queue` keeps them apart: a quiet grey badge, excluded from the failure
  count, and skipped by **Try all again** (retrying searches the same empty view
  for ever). They clear when the next import deletes the expense. It is set
  ONLY for the unambiguous case — the grid loaded and is empty — never for
  "rows came back and none matched", which is the shape a matching bug takes
  (truncated cardholder, unpadded day, credit read as a charge) and which must
  stay retryable.
- **It travels as a type, not a phrase.** `NotInQueue` is thrown by
  `whyNoGrid`/`whyNoRows`, `makeStepper` records it as `absent` on the step, and
  the worker reads that. Matching on the wording would break the first time
  somebody improved a sentence.
- **A failure is a recording, and the UI has to date it.** `expense_decisions`
  keeps the error for ever, which is right, but an unchanged sentence reads as
  a fresh verdict — "this approval error didn't go away" was a three-deploy-old
  error nobody had re-run. The dialog now says when it was tried, notes when
  the app has restarted since (`bootedAt` on `/api/config`), and carries
  **Try again**.
- **One cause fails a whole batch, so recovering from it is one button.**
  `/api/decisions/retry-failed` re-queues every failure whose expense is still
  in the queue, under the login of whoever presses it (never the original
  decider's — Emburse records the approval against the login it is applied
  under, and the strip says so).
- **A hidden copy of a row is not a second expense.** The grid reports seven
  rows for a four-row page: it keeps copies to measure itself, and a copy
  carries the same date, merchant, cardholder and amount. Matching now narrows
  to the VISIBLE matches before refusing. Two rows a person can SEE that agree
  on everything are a split purchase and still refuse — that property is what
  the narrowing must not cost, and there is a test for each.

## The table

- **A cell holding CONTROLS must not truncate.** Every column truncates so
  eleven fit on one line, and the hover title gives back what the ellipsis ate —
  which is right for text and wrong for buttons: `truncate` sets
  `white-space: nowrap`, defeating the flex-wrap on the controls, so a badge
  plus an "auto" chip plus Approve/Deny ran off the right edge and was clipped
  by the scroll container. A title attribute cannot give back a button nobody
  can click. Columns opt out with `wrap: true` on the column definition.

## Pausing

- **`holdDecisions` is the stop button, and it stops BOTH ends.** The
  automatic-approvals switch only stops new ones being QUEUED; it says nothing
  about the hundred already waiting, and those are what stands between the
  morning import and the browser it needs. Paused means: queue nothing
  automatically (`autoQueueApprovals`) and start no new batch
  (`decision-worker`'s tick returns before reading the queue). Nothing is
  cancelled — pending decisions stay pending and go on resume, which nudges the
  worker so it does not wait out the idle timer.
- **And it reaches the batch that is already running.** It did not at first, and
  the excuse sounded like care: "a batch already at the browser finishes,
  because abandoning a half-clicked approval is worse than letting it land."
  True of one decision. The batch was a hundred and forty, so "finishes" meant
  two more hours of them, and the failure count climbed while the strip said
  Paused. `runDecisions` now asks `shouldStop` BETWEEN decisions, never during
  one. The ones not reached are simply absent from the results, so they stay
  queued, and their note says "Paused before this one was reached" rather than
  reporting a fault that did not happen.
- **Automatic approvals also stand aside while an import is in flight**
  (`exportInFlight`: an `export_runs` row with no `finished_at`). An import adds
  and removes expenses underneath the queue the automation reads, and the rules
  have not seen the new arrivals. It resumes by itself. The one-hour age limit
  on that query is a fuse, not a nicety: a process killed mid-run leaves a row
  that never finishes, and without it that stuck row would disable the
  automation for ever — a fault indistinguishable from the feature being broken.
- **The control lives on the QUEUE**, not only in Configuration. The moment
  somebody wants it is the moment they are watching a hundred decisions march
  into Emburse. The strip stays on screen while paused, or the pause could never
  be lifted from the page that set it.

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

## A flag beats a queued approval

- **Checked at APPLY time, not only at queue time.** The automation only ever
  queues expenses nothing flagged — and then the receipt is read minutes
  later, the rules run again on what it turned out to say, and the expense is
  flagged while its approval is already in the queue. Nothing re-checked, so
  it went to Emburse regardless: rows sat in the Flagged tab reading
  "Approved · sending". The worker now asks `flaggedNow()` before each batch
  and takes those back with `cancelBecauseFlagged`.
- **Cancelled, not failed.** Nothing went wrong and nothing was tried, and the
  row goes back to offering Approve and Deny — which is where it belongs.
- **Only the MACHINE is stopped.** A person who clicks Approve on a flagged
  expense means it, and often should: a flag is a prompt to look, not a
  prohibition. Stopping a human here would make flags useless for the thing
  they are for. That is what `automatic` is for, and there is a test that a
  person's approval still goes through on a flagged expense.

## A flag has to be able to go away

- **`runRules` clears verdicts it did not reproduce.** `not-applicable` is
  skipped when writing, which is right, and for a long time nothing removed
  what an earlier run had written — so a flag was permanent. Correct a receipt
  total that was read off the wrong line and the amounts match on screen while
  the row sits in the flagged bucket. Stale hits are now deleted, scoped to the
  rules and expenses THAT RUN examined so a keyed run cannot wipe anything
  else, and rows with `acted = true` are kept: they are the record that an
  approve/deny fired, and deleting one would let it fire twice.
- **Reading a receipt re-judges the expenses it belongs to.** A rule about a
  receipt returns UNKNOWN while it is unread and records no hit, so reading it
  changes nothing by itself — the verdicts stored at import time stay. Both the
  reader's pass and the "Read again" button now call `runRules({ keys })` for
  the affected expenses, BEFORE automatic approvals.
- **That second one was not cosmetic.** Automatic approval refuses to touch an
  expense until every enabled rule has run since it arrived — but `last_run_at`
  is per RULE, so a rule that ran at import time counted as run for a receipt
  read hours later. The one case that module exists to prevent, straight
  through the back door.

## Reading a receipt total

- **The figure labelled "Total" is not what the card was charged.** A
  restaurant slip prints Total, then Tip, then Amount Paid, and the word Total
  sits against the SMALLER number. A Texas Roadhouse receipt read 38.24 against
  a $45.89 charge, and the app reported an ordinary meal as $7.65 of
  overclaiming — the tip, exactly. The prompt now shows that layout and says to
  take the last figure.
- **And `withTip()` checks the arithmetic afterwards**, because a prompt is a
  request. When the total agrees with subtotal + tax to the penny and there is
  a tip beside it, the tip is demonstrably not in it, so it is added and a note
  says so. Both figures must be present and must reconcile, or nothing is
  changed: a guess dressed as a correction is worse than the fault.
- **Menards does the same thing with tax.** It prints `TOTAL 12.49`,
  `TAX 1.05`, `TOTAL SALE 13.54` — the word TOTAL against the PRE-TAX figure,
  and the reading took it, reporting $1.05 of overclaiming. Same shape, same
  fix: the last money figure, on the payment line.
- **Transcribe the summary block; choose in code.** Which figure is "the
  total" is a judgement, and it was got wrong twice in opposite directions —
  the tip line and the tax line. `totals` is now every money line at the foot
  of the receipt, labels as printed, in order; `fromTotalsBlock` picks the one
  naming a payment, or failing that the largest line that is not change, cash
  tendered or a rebate. Transcription is what the model is reliable at.
- **And it is shown the receipt twice: whole, and the lower part enlarged**
  (`receipt-zoom.ts`, using mupdf, which is already a dependency). The reason
  is arithmetic, not hope: a vision model scales to ~1568px on the LONG edge,
  so a 2000×3000 photograph arrives at half size. Cutting the top off makes
  the crop wider than it is tall, so the long edge becomes the width and the
  same budget buys ~1.4× the detail on the figures. An earlier version refused
  to touch anything it would have to shrink and therefore did nothing at all
  for phone photographs — the exact images it was for. It fails silently: no
  second look is the state of affairs it improves on, not a fault it adds.
- **`paid` is the field that settles it.** Receipts print what the card was
  charged against the card itself (`AMERICAN EXPRESS 1002  13.54`), so the
  reader is asked for that line directly; where it exists it beats any
  arithmetic. `chargedTotal()` prefers it, then falls back to the reconciliation
  above, then leaves the reading alone.
- **`READER_VERSION` is how a fixed reader reaches receipts already read.**
  Readings are cached by image hash and never read twice — right, since a
  vision call per receipt is the expensive part — but that also means a prompt
  fix never reaches the backlog. `unreadReceipts` re-queues anything read by an
  older reader. Bumping it costs one call per stored receipt, so bump it only
  when what changed makes the old readings WRONG rather than merely better.
- **Receipt figures are shown to the cent** (`moneyExact`, not `money`). They
  exist to be compared with a card charge, and rounding 38.24 to "$38" against
  "$45.89" hides both the real total and the fact that the gap is exactly the
  printed tip.

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
- **The reader judges alcohol per line, and it is three-state.** A keyword
  list never catches MODELO ESP 12PK, CAB SAUV GLS or TITOS; the model knows
  what those are, so `alcohol` is a boolean on each extracted line and the
  prompt names both the traps — brands that do not say "beer", and ginger
  beer / O'Doul's / mocktails that are not alcohol. **Null is "cannot say",
  never "no".** A receipt nobody could read is not a receipt with no alcohol
  on it, and `test()` returns null for an unknown yes/no rather than falling
  through to the text path, where "" vs "yes" would come back false and make
  exactly that claim.
- **What the receipt says it is, against what was claimed.** The reader
  always pulled the merchant and the date off the image and they were stored
  and never shown; they are now on the receipt detail and testable as
  `receiptDate` / `receiptMerchant` against `date` / `merchant`. A receipt
  dated three weeks before the transaction, or printed by a different
  business, used to look like every other receipt.
- **Comparison is by KIND: money, date, name, text.** Only like compares with
  like, so "Date on the receipt is the Transaction date" is offered and
  "…is the Merchant" is not. A comparison that can never be true is worse
  than none, because somebody writes it and believes it.
- **Business names are matched loosely, and only name-against-name.** Emburse
  prints "KENT ELECTRICAL SUPPLYKENT ELECTRICAL SUPPLY, LLC" where the
  receipt says "Kent Electrical Supply"; compared as strings that is a
  mismatch on nearly every row. `nameKey()` drops punctuation, legal suffixes
  and store numbers and collapses Emburse's doubled name. A hand-typed value
  stays EXACT — otherwise "Merchant is Walmart" quietly swallows Walmart
  Pharmacy and Walmart Fuel.
- **Dates are ordered, not searched.** ISO strings compare correctly as text,
  so before/after and equality are one path — and `contains` never reaches a
  date. A missing receipt date is UNKNOWN, never a mismatch.
- **`receiptReadable` is legible AND itemised.** An order summary reading
  "1 Item $141.24" is perfectly legible and answers nothing, so for rule
  purposes it is not readable. It exists so the hole in alcohol detection is
  itself flaggable: the reader cannot see into a bar tab printed as one
  "FOOD & BEV" line, and a rule can catch that rather than passing it.
- **A yes/no field offers a dropdown, not a text box.** "Yes"/"yes"/"y"/
  "true" are four ways to write a rule that silently matches nothing.
- **Only receipts read AFTER the change carry it.** Readings are cached by
  image content hash and are not re-read, so a new extracted field arrives as
  the queue turns over rather than all at once.
- **Rules can test receipt line items**, so `ensureRules()` creates the
  receipt-items tables too. Without that, an app with no working Anthropic key
  has no `receipt_items` table and every import's rule run dies on the join.

## Automatic approvals

- **An automation that only runs on the back of something else looks broken.**
  `autoQueueApprovals()` originally ran in exactly two places — after an import,
  and at the end of a receipt-reading pass that read something. Both are silent
  on a settled queue (the reader returns early when nothing is unread, and no
  import runs until the next schedule), so switching the setting on produced
  nothing observable for hours. It now also sweeps on its own clock
  (`startAutoApprove()`, every 15 minutes) and has a **Run now** button.
  Anything unattended added later needs its own trigger for the same reason.
- **"On, and nothing is happening" has to have an answer in the app.**
  `autoApproveReport()` puts every queued expense in the bucket of the FIRST
  reason it does not qualify — flagged / already decided / waiting for the rules
  to run / waiting for a receipt to be read / eligible — and the buckets sum to
  the queue total on purpose. It shares its SQL tests with the pass itself
  (`TESTS` in `auto-approve.ts`); a report that classified by slightly
  different rules would confidently name the wrong reason.
- **Run now is restricted to the flag's owner, not to admins.** Every approval
  it makes is recorded in Emburse against whoever switched the automation on, so
  a second admin pressing it would put a colleague's name on approvals they
  never made. Same rule as everywhere else: a decision is applied under the
  decider's own login.
- **An automatic approval is marked as one.** It is applied under the login of
  whoever switched the automation on, so `decided_by` is a real person and the
  badge reads exactly like a click. `expense_decisions.automatic` is what
  separates them, the queue shows an **auto** chip beside the badge, and the
  Approved tab says how many of the batch nobody looked at. A retry carries
  the mark through — pressing "try again" re-attempts the applying, it is not
  somebody reviewing the expense, and clearing it there would launder every
  automatic approval into a reviewed one the first time a batch had to be
  re-run.
- **An expense with no receipt means the IMPORT lost it.** Emburse will not
  accept one without, so every row in the queue has a receipt by the time
  it reaches us — a row with none is a receipt page that matched no expense
  and was skipped with a warning. It and the ones the reader gave up on are
  both permanently unapprovable while any rule reads receipts, and both
  showed on the queue as plain Unflagged, so the card said "held back on
  purpose, not stuck" about rows that were exactly that. Counted apart now
  (`stuck.noReceipt`, `stuck.unreadable`) and named on the card. They sit
  INSIDE `awaitingReceipt` rather than beside it, so the buckets still sum
  to the queue.
- **One switch per reviewer, all off by default.** The global `autoApprove`
  flag still works exactly as it did — one owner, their own queue — and each
  reviewer with a stored login can now switch it on for theirs
  (`reviewer_imports.auto_approve`, Export settings → *Per-reviewer imports
  and approvals*). Without it the card told somebody "whoever they belong to
  has to switch this on for themselves" and there was nowhere in the app to
  do it: 340 expenses and an instruction that could not be followed. A pass
  runs once per switched-on owner, each under their own login, and a save
  that omits the flag reads as OFF — a missing field must never switch on
  the one path that approves money with nobody looking.
- **The refusals are in one place.** `setup()` reads the switch, the owner, the
  number and the enabled rules and returns the single reason a run would do
  nothing, so the pass and the report cannot disagree about it.
- **It only ever sweeps the owner's own queue.** An approval is applied by
  signing in as the owner, so another reviewer's expense could not be actioned
  under it even if the sweep queued it — the row is not in the Needs Review
  the browser is reading, and it would fail after a minute of browsing with a
  matching error that reads like broken selectors. Unattended and on a timer
  is the worst place in the app to get "whose is this" wrong. The report
  counts other reviewers' rows separately (`elsewhere`) and says so on the
  card, rather than folding them into a reason the pass skipped something;
  automatic approvals are per person, and whoever owns a queue switches them
  on for it.

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
- **The queue splits Flagged / Unflagged, and flagged splits by rule.** A
  queue of 126 with 16 flagged reads as 126 things to do; the tabs say what
  needs a human and what is waiting for a click. Inside flagged, one rule at
  a time — "the category is wrong" and "that is a fourth meal today" are
  different jobs judged differently. Counts sit on the tabs rather than being
  discovered by opening an empty one.
- **A flag carries `group` — the rule's name — rather than it being parsed
  back out of `label`.** The label is `"<rule> — <detail>"`, and splitting on
  the separator works until a rule name contains one, which is the kind of
  bug that surfaces months later against real data.
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
- **Every "have we seen this before" guard is scoped to one reviewer and one
  list.** Stale export, duplicate file and the truncation fence all compare
  against what we hold, and "we" is the person whose Needs Review the file
  came out of, not the table. Unscoped, the stale check refused Brian's very
  first pull — a correct, current export of his own queue — for being older
  than Eric's rows, and told him to re-run the export he had just run.
  `expense_imports` carries `reviewer` and `source` so the question can be
  asked at all. Anything new that asks it must be scoped the same way.
- **Rules and Configuration are shared; Import and the Review Queue are not.**
  One set of rules judges everybody's expenses and the settings are the app's,
  but a queue and an import history belong to the one Emburse account they
  were read from. Anything new goes in one of those two buckets deliberately,
  not by whichever query was easiest to write.
- **One stage's decision does not discharge the next one's.** The chain
  means the same expense — same seven fields, same `dedupe_key` — passes
  through two queues, and `expense_decisions` has no foreign key on purpose
  so Eric's approval is still in the table when Brian's import brings the
  expense back as his. Every "has this been decided" check must therefore
  ask *decided by whom*: `TESTS.decided` compares `decided_by` against the
  row's `reviewer`, and `decisionsFor`/`appliedCount` take the viewer.
  Unscoped, Brian's queue badges every second-stage row Approved on the
  strength of Eric's approval and the sweep skips all of them, which is the
  most convincing possible way to be wrong. Covered by
  `scripts/test-approval-chain.ts`.
- **You can watch the browser, but not literally see it.** Headless on a VM
  with no display: a headful Chromium behind Xvfb and VNC is a system
  package tree, a WebSocket path and a second auth surface in front of a
  live finance session; `recordVideo` only yields a file once the context
  closes, so a twenty-minute run shows nothing until it is over; tracing
  stores whole API response bodies, i.e. the queue's contents in a zip. So
  it is a frame on request (`live-view.ts`, `GET /api/export-live.png`,
  admin-only). PULL, so nothing is captured unless somebody is looking, and
  rate-limited IN THE SERVER so several watchers cost the same as one — a
  1600x1000 encode is real CPU in the same Chromium that is driving the
  run. A cached frame keeps its own caption rather than the step that has
  started since.
- **A run proves WHO it is signed in as** ("confirm who is signed in",
  right after sign-in). Every other step reports the account we MEANT to
  use, and sign-in returns early on "already signed in" without looking —
  so a run could be signed in as somebody else and print the right name at
  every stage, which is exactly what a shared browser profile produced. It
  needs no selector: if another login this app holds is on the page and
  ours is not, that is proof, and the run stops before anything is
  exported. Our own address present means confirmed; neither present means
  it could not tell, which is honest and not grounds to refuse.
- **Chasing this as a credentials problem wastes days** — but so does
  assuming the opposite. The logins and sessions work; what was never
  checked is whether the browser was still holding somebody else's
  session, which the step above now settles in one line of the run log
  instead of by comparing item counts after the fact.
- **Nothing about this is a credentials problem, and chasing it as one
  wastes days.** The logins work, the sessions work, the stamping works.
  Signed in as Brian, Emburse shows him 300+ rows because he is an approver
  and the export clicks the TEAM-WIDE tab — the whole company's review
  stage, not "waiting on Brian". That is also the answer to "how could it
  pull mine, I would have to be logged in": it never read Eric's account,
  it read a list Brian's own account can see. One wrong URL, not a wrong
  identity. Check the URL before suspecting anything else.
- **A test run can try a list without saving it** (`probe` on
  `attemptExport`, dry runs only, enforced there as well as at the route).
  Finding out which list is really somebody's should not require changing
  how the import works first.
- **Two reviewers never share an import slot.** One browser runs them one
  at a time, so a shared minute means the second waits out the first — and
  on an export Emburse takes fifteen minutes to build, that can push it
  past its own grace window and be recorded as a miss it never had a
  chance at. Worse when a run parks for a verification code. A reviewer on
  the shared schedule is offset by their position in a SORTED list
  (`STAGGER_MINUTES`, 02:00 / 02:20 / 02:40); sorted because
  `listCredentials` orders by how recently a login worked, and a slot that
  moved whenever somebody else signed in would be missed every time.
  Anybody with their own times is left exactly where they put them.
- **Whose LOGIN reads a queue is not whose queue it is** (`run_as` on
  `reviewer_imports`). A manager sees the rows waiting on the people under
  them, so one login can pull everybody's — each narrowed by that person's
  own filters and stamped as theirs. Worth far more than tidiness: a second
  reviewer's login means a second verification code, from somebody who is
  not at the screen, every time Emburse stops trusting the browser. The
  stamp follows the QUEUE (`opts.reviewer`), never the login, or an admin
  pulling for somebody else takes their expenses.
- **Needs Review on the MANAGER tab is already per account.** Signed in as
  Brian it is what is waiting on Brian — so the ordinary setup for a second
  reviewer is nothing at all: their own login, their own slot, the shared
  stage and the shared path. Do not send anybody to the PERSONAL tab (that
  is their own card spending) and do not ask for a filter they do not need.
- **Borrowing a login REQUIRES a filter, and the run refuses without one.**
  Because Needs Review is per account, `run_as` somebody else with no
  `grid_query` reads THEIR queue and files it under this reviewer's name,
  green all the way down. Refused in `attemptExport` rather than warned
  about: a warning on an unattended run is read after the queue has already
  changed hands.
- **Emburse's Current Reviewer dropdown is what separates two approvers**,
  and its values are opaque ids nobody can type. So they are not
  constructed, they are pasted: Export settings takes a URL copied from
  Emburse and pulls the path, section and filters out of it
  (`partsOfGridUrl`, stored as `grid_query`). The search box and the
  receipts setting are dropped from a paste on purpose.
- **Approval is a CHAIN: Eric approves, then it goes to Brian.** Two stages,
  two queues, one at a time. Needs Review in Emburse IS per account — but the
  export clicks the team-wide tab and opens
  `/transactions/team?filters[section]=inbox`, and on that tab the section is
  the whole review stage across everybody. So both accounts read the same 320
  items, $18,289.08, and the per-account distinction never reached the app.
  A reviewer's own `grid_path`/`grid_section` (`reviewer_imports`, Export
  settings) points their run at their own stage, and a run pointed away from
  `/team` skips the team-tab click. The upsert keeps
  the FIRST reviewer who imported a row, because "last import wins" moved the
  entire queue between two people on a timer.
- **Ownership of unclaimed rows must never be derived from a credential's
  state.** It used to be "the credential most recently proven to work", so a
  successful first export MOVED every unclaimed row to the person whose export
  had just worked. Nothing that changes when somebody signs in may decide
  whose expenses are whose. One login owns them; two and nobody named means
  nobody does, and the app says so and offers to stamp them (Import page →
  claim) rather than guessing.
- **`setReviewerImport` writes only the fields it is given.** One row holds
  a reviewer's schedule, their import list and the switch that approves
  spending unattended, and three screens write to it. Writing every column
  every time meant flipping the automation switch silently cleared the grid
  path that had just been set to separate two queues — each fix undoing
  another. `schedule: null` still clears the times (that is how somebody
  goes back to the shared schedule); omitting a field leaves it alone, and
  the route passes through only what the request actually carried.
- **Three routes are writable from inside a view, and no more**
  (`CONTROLS` in `view-as.ts`): `view-as` itself, `export-run`, and
  `reviewer-imports`. The first two because there would otherwise be no way
  out and no way to refresh what you came to look at. The third because
  starting and stopping somebody's automation grants the admin nothing they
  did not already have — the same admin can set the same switch for the
  same person from the settings page without entering a view. All three
  judge the real user and record them, so `updated_by` names who pressed
  it, not whose row changed. Deciding stays refused, and so do the shared
  flags: those are not the viewed person's to change on their behalf.
- **A view never counts as the viewed person's visit.** `authMiddleware`
  runs before `viewAsMiddleware`, so `noteVisit` gets the real user. It has
  to stay that way: an admin looking at somebody's screen must not reset the
  "approved since your last login" count that person has not seen yet.
- **`requireAdmin` judges the REAL person, not the viewed one.** Judging on
  `req.user` meant an admin looking at the app as a non-admin lost every
  admin surface — no automation card, no per-reviewer settings, no failure
  summary — which is the opposite of what the view is for. Not a hole: the
  view-as middleware refuses every non-GET before `requireAdmin` runs, so
  this widens what an admin may SEE through a view and nothing about what
  anybody may change. Admin controls shown inside a view are rendered
  disabled rather than left live to produce a 403 on click.
- **Changing who you are is a page reload, not a cache operation.** Two
  clever versions were both wrong: `invalidateQueries` refetches while still
  serving what it has, so for a second the page rendered one person's
  expenses under the other's name; `clear()` fixed that and left the app
  with no data and nothing to refetch, so the button appeared to do nothing.
  Identity is carried in a cookie the server reads on every request — there
  is no honest way to keep half the screen while it changes.
- **"First reviewer keeps it" needs a way out, and it is `reset`.** A
  reviewer whose import claimed rows that were never theirs keeps them, and
  no later import can take them back. Import page → **Start ownership over**
  unstamps every waiting expense (`reviewer = ''`) and lets each next import
  claim what is genuinely in that person's Needs Review. It deletes nothing.
- **`scopeFor` is the single definition of whose data something is**
  (`server/emburse/credentials.ts`): your own rows, plus the unclaimed ones if
  you are the shared importer. It exists because the rule had been written out
  by hand in four places and had drifted in three, which is how Brian came to
  be looking at Eric's receipts. Use it rather than another copy, and use
  `MINE(a, b)` from `decisions.ts` for the SQL half.
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

`docs/EMBURSE.md` is the written-down version of all of this: how the grid
URL is built, what the export run does step by step, and how an approve or
deny finds its row and proves it hit the right one. Keep it current when any
of that moves — the alternative is re-deriving it from the code every time,
which is what this document exists to stop.

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
- **A failed read is retried three times, then left alone.** A read that
  errored wrote a row with `error` set, which still counted as unread — so it
  came back every pass, for ever. The morning a bad request made every read
  fail, that was several hundred model calls spent re-failing on the same
  receipts with nothing being imported. A request-shape error (400,
  invalid_request, "does not support") is marked final immediately: retrying
  it buys the same answer at the same price. Success resets the count.
- **Price by FAMILY, not by the build the API answers with.** Requests say
  `claude-haiku-4-5`; responses say `claude-haiku-4-5-20251001`, and that is
  what gets recorded. Filing the dated name verbatim made the cost page say
  "no published price on file" for the only model in use, and every total
  read as a dash — a meter measuring nothing while looking like it worked.
- **There is no "check this receipt" button, and should not be.** The total
  is read once when the receipt arrives and stored; the verdict is a
  subtraction over data already present (`src/lib/receipt-verdict.ts`). The
  old button re-fetched the image, re-asked the model for a total it already
  had, kept the answer in memory until restart, and only ran when somebody
  remembered to press it. A check you have to remember to run is a check that
  does not happen.
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
