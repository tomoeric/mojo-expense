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

## Whose queue is whose

Emburse's **Needs Review is per account**: the expenses waiting on Eric are
not the expenses waiting on Brian. One import signing in as one account
therefore cannot serve two reviewers — it shows each of them the other's
work.

So every expense now carries the **reviewer** whose Needs Review brought it
in, and that is not metadata, it is what the row IS. The purge is the reason
it had to exist before a second credential did: "delete every expense this
export no longer carries" is correct for one reviewer and catastrophic for
two, because each one's hourly import would delete the other's entire queue
— the receipts, the rule hits and the change history with it — and the app
would flip between two sets of expenses all day. It is scoped now, and so is
the truncation fence, which otherwise reads Brian's thirty rows as about to
delete Eric's ninety.

A hand-uploaded file imports as the blank reviewer, and can only purge other
blank-reviewer rows, so nobody's scheduled queue is at the mercy of a PDF
somebody dragged in.

**Two lists, not one.** Transactions is the queue this app was built around;
**Reimbursements** is a separate page with its own queue and the same export
dialog, so the whole run works on it unchanged once pointed at the right
path. Both are in Export settings, each with its own path, and each is read
on its own timeline. Every row carries which list it came from, and the
purge is scoped by it for exactly the reason it is scoped by reviewer:
without that, each hourly run would delete everything the other brought.

**And their own timetable, settable at last.** The scheduler could always
run two people on two schedules — it asks "is an import due" once per
person and counts their attempts separately — but nothing on any screen
could say so, so both ran the shared one and the capability may as well not
have existed. Export settings → *Per-reviewer imports and approvals* →
**Own times** sets a reviewer's timezone, first run, runs per day, hours
between and grace; blank is the shared schedule, and *Back to shared* puts
them there. A second stage of an approval chain is behind the first by
definition, so an afternoon start is the point of it.

Saves on that row write only the fields they carry. The same row holds the
schedule, the import list and the approval switch, three screens write to
it, and a save that wrote every column meant flipping the switch silently
cleared the grid path that had just been set to separate the two queues.

**Each reviewer has their own timeline.** The scheduler asks "is an import
due" once per person with a stored Emburse login, counts their attempts
separately in `export_runs`, and signs in as them — so the first reviewer's
morning run no longer spends everybody's attempts while the rest never
update. A reviewer with no times of their own runs on the shared schedule
(`reviewer_imports` holds the overrides), which is what everybody gets until
somebody wants different ones: a reviewer whose expenses arrive in the
afternoon has no use for a 2am run.

**And the queue shows you your own.** Rows are filtered to the signed-in
person's reviewer, which is also what makes "view as Brian" show Brian's
expenses rather than a copy of Eric's.

**What is shared and what is not.** Rules and Configuration are the whole
company's: one set of rules judges every expense, and the settings are the
app's settings. **Import and the Review Queue are one person's** — their
own Emburse account's Needs Review, their own import history, their own
totals. The Import page inside a view is the viewed person's page: it used
to show Brian 45 expenses stored, 44 awaiting review and $9,649, every
figure of it Eric's.

Rows no import has claimed — everything from before the reviewer column
existed, and anything uploaded by hand — belong to **whoever the shared
import runs as**. Showing them to everyone was the first attempt and did
exactly the thing it was meant to prevent: every old row is blank, so a
second reviewer signed in and found the whole of the first one's queue. A
deployment with one login is unaffected, because that login owns them; a
reviewer who has not imported yet sees nothing, which is the truth, since
Emburse has not been asked for their Needs Review.

**Approval is a chain, and the export was flattening it.** Eric approves
first; the expense then goes to Brian to approve. Two stages, two queues,
one at a time — and **Needs Review in Emburse is per account**, so each of
them genuinely has their own list.

The export did not ask for it. It clicks the team-wide tab and opens
`/transactions/team?filters[section]=inbox`, and on the team tab that
section is the whole review STAGE across everybody, not "waiting on me". So
it asked Emburse the same question whoever signed in — Eric's run and
Brian's first run each read *320 items, $18,289.08*, to the cent. The import's rule was "last import wins", written on the stated
assumption that a row waits on one approver, so every import MOVED all 320
expenses to whoever had just run: Brian's 3:40pm import took Eric's whole
queue, approvals and all, and Eric's next one would have taken it straight
back. An admin watching that is right to call it a leak.

An expense now belongs to the **first** reviewer who imported it. That does
not decide who *should* hold a row two accounts can both see — nothing in
here can know that — but it stops the churn, leaves the purge with exactly
one owner per row, and lets the import say what it found: *"320 of the 320
expenses in this export are already in eric.s's queue… both Emburse accounts
are reading the same list."* The Import page shows the standing split
(waiting expenses by reviewer) and can hand the whole queue, or just the
unheld rows, to one person — the way back from a queue that ended up with
the wrong reviewer.

**Each reviewer's export can now be pointed at their own stage.** A reviewer
may override the grid path and the section the export opens
(`reviewer_imports.grid_path` / `grid_section`, Export settings → *Which list
each reviewer imports*); leave both blank and nothing changes, which is every
single-reviewer tenant. A run pointed away from the team-wide list skips the
team-tab click, because landing there first would read the wrong list and
leave Emburse remembering the wrong tab for the next run.

What the right path is cannot be guessed from outside: the tenant's own URLs
are the only answer, and they differ per tenant. So the way to find it is to
open the list in Emburse as that person, copy the path and the
`filters[section]` value out of the address bar, and press **Test run** —
which stops before exporting, produces no file, emails nobody, and prints
what that URL returns at the *read the item count* step. A wrong guess costs
a minute.

Once each reviewer reads their own stage the overlap goes to zero and the
handoff happens by itself: Eric approves, the expense leaves his Needs
Review, his next import purges it, and Brian's next import brings it in as
his.

**And the second stage can actually be approved.** The same expense in two
queues is the same seven fields and so the same `dedupe_key`, and
`expense_decisions` carries no foreign key on purpose — the record of who
approved what outlives the purge, because it is the only audit trail on this
side of the wire. Put those together and every "has this been decided" check
would have answered yes for Brian on the strength of Eric's approval: his
queue badging each row Approved, the sweep skipping all of them, and nothing
in the second half of the chain ever approvable through this app. Decidedness
is per reviewer now — `decided_by` against the row's reviewer — so Eric's
approval settles Eric's stage and nothing else.

**And that ownership never moves.** It was resolved as "the credential most
recently proven to work" — the same rule that picks a login, borrowed for a
question it cannot answer, because it drifts. Brian's first export succeeded
at 3:40pm; that gave his credential the newest `last_ok_at`, which made him
the shared importer, which handed him every unclaimed row in the table. His
own import working is what took Eric's expenses off Eric and showed them to
Brian, silently, at the moment it worked.

So nothing is guessed at now. One stored login owns the unclaimed rows,
because there is nobody else they could belong to. With two and nobody
named it is genuinely ambiguous, so they are shown to **nobody** and the
Import page says how many there are and offers to settle it — and settling
it stamps the reviewer onto the rows, which ends the question in the data
instead of adding another rule for re-deriving it. Claiming can only ever
take rows nobody holds; it cannot move an expense between reviewers.

Swapping views **clears** the client cache rather than invalidating it.
Invalidating refetches while still serving what it has, so for the second it
takes, one person's expenses render under the other's name — merchants,
notes, amounts and all. It looks exactly like the leak this mode exists to
prevent, because for that second it is one.

Both the reviewer and that ownership are part of the cache key as well as
the query: keyed on the date window alone, whoever asked first would serve
their queue to everybody for the life of the entry.

**An admin can pull the import for the person they are viewing.** It is the
one action allowed from inside a view, and it is allowed because of what it
is: an import reads Emburse and writes our own tables, approving nothing,
denying nothing, putting nobody's name on a decision. The run records the
real admin as having asked and the viewed person as whose queue was read.
Everything that decides stays refused.

**A manual export signs in as whoever pressed it**, and the run list and
"next attempt due" are that person's. Outside a view it passed an empty
reviewer, which means the shared import — whose login is still chosen by
"the credential most recently proven to work" — so on a day when Brian's
export had succeeded most recently, Eric pressed *Run export now* on his
own settings page, not viewing as anybody, and the run signed in as Brian
and imported Brian's Needs Review. Nothing on the page said it would. Only
somebody with no stored login of their own falls back to the shared import,
which is the single-login deployment and the env fallback.

**Each Emburse account has its own browser profile and its own cookie jar.**
Keying the jar was not enough on its own: the persistent Chromium profile
holds cookies, localStorage and IndexedDB, survives between runs, and was
one directory for everybody — so a run opened with the previous account's
session already live whatever the jar put in. A run started from Brian's
view, labelled with his address, reported *"sign in — already signed in"*
in 1.6 seconds and read **157 items, $29,287.03** off the grid, which is
Eric's queue. It never signed in as Brian, imported Eric's Needs Review and
stamped it as Brian's, and showed eleven green steps doing it. One
directory per account, cookies cleared before that account's are restored,
so "already signed in" can only mean signed in as them.

**The jar itself** (`emburse_browser_jars`).
One jar was right when one login was the whole app and is a data leak with
two: it hands whoever runs next the live session of whoever signed in last,
and because sign-in returns early on *"already signed in"*, that run skips
the password step and reads the first person's Needs Review while reporting
its own name. Every other scope here could be perfect and a run would still
come back with the wrong person's expenses, intermittently, depending only
on who exported last. A run with no account name gets no cookies and signs
in the long way.

**A manual export signs in as whoever pressed it**, and the run list and
"next attempt due" are that person's. Outside a view it passed an empty
reviewer, which means the shared import — whose login is still chosen by
"the credential most recently proven to work" — so on a day when Brian's
export had succeeded most recently, Eric pressed *Run export now* on his
own settings page, not viewing as anybody, and the run signed in as Brian
and imported Brian's Needs Review. Nothing on the page said it would. Only
somebody with no stored login of their own falls back to the shared import,
which is the single-login deployment and the env fallback.

**Each Emburse account has its own cookie jar** (`emburse_browser_jars`).
One jar was right when one login was the whole app and is a leak with two:
it hands whoever runs next the live session of whoever signed in last, and
because sign-in returns early on *"already signed in"*, that run skips the
password step and reads the first person's Needs Review while reporting its
own name. Every other scope here could be perfect and a run would still
come back with the wrong person's expenses, intermittently, depending only
on who exported last. A run with no account name gets no cookies and signs
in the long way.

**And nothing one reviewer does can stop another importing.** The queue was
separated before the import was, and the gap showed up on Brian's very first
pull: every step green, 320 items read out of his own Needs Review, and then
*"this export is older than one already imported — re-run today's export
instead"*. The expenses it was older than were Eric's. Three guards in the
import ask **have we seen this before**, and the answer is only ever about
one reviewer's queue and one Emburse list:

| Guard | Refuses when | Now asks |
| --- | --- | --- |
| Stale export | the file's newest expense predates one already stored | the newest **we hold for them, on this list** |
| Duplicate file | the same bytes have been imported before | the same bytes **by them, on this list** |
| Truncation fence | the file would delete most of the waiting queue | most of **their** waiting queue |

Each import row records whose queue it was and which list, so these can be
asked at all. Nothing about Eric's queue can say anything about whether
Brian's export is current, and the sharpest version of that is the one that
happened: the guard did not corrupt anything, it told a correct, current
export to go away.

The same question — *whose is this* — is answered in one place now
(`scopeFor`), because it had been written out by hand in four and had
drifted in three. Everything that counts or lists now asks it: the queue,
the "what changed since the last sync" badges (which read the newest import
in the table, so Brian's hourly pull silently blanked every one of Eric's),
the applied count the Live strip subtracts, the failure summary and its
markdown, and the pending and recent decisions, which belong to whoever made
them.

**An admin can start and stop a reviewer's automation from their view**, and
see the automation queue, the count of approvals made since that person last
signed in, the failures and the downloadable failure report — all of it
theirs. The switch is the one write the view allows beyond the import,
because it grants the admin nothing they did not already have: the same
admin can set the same switch for the same person from the settings page
without entering a view at all. It is recorded against whoever pressed it,
and the approvals that follow are still applied by signing in as the
switch's owner, with their name on them in Emburse. Deciding stays refused,
and so do the shared flags.

Looking at somebody's screen does not count as their visit — `noteVisit`
runs on the real user, so an admin checking Brian's automation cannot reset
the "approved since your last login" count he has not seen yet.

**And a view shows their automation, not a copy of yours.** `requireAdmin`
judges the real person rather than the viewed one — judging on the viewed
one took every admin surface away from the admin doing the looking, which
is the opposite of the point. The automation card, the failure summary and
the downloadable failure report all describe the person being viewed, and
every control on them is rendered disabled, because the server refuses
writes from a view and a live button could only ever produce a 403.

**Automatic approvals are one switch per reviewer**, all off until somebody
turns one on. The global switch is unchanged — one owner, one queue — and
each reviewer with a stored Emburse login has their own beside it (Export
settings → *Per-reviewer imports and approvals*), sweeping their own queue
under their own login. Before that, the Configuration card ended on
"whoever they belong to has to switch this on for themselves" with nowhere
in the app to do it.

**The automation only approves its owner's own queue.** An approval is made
by signing in as the owner, so an expense in somebody else's Needs Review
could not be actioned under it even if the sweep queued it — it would fail
after a minute of browsing with an error that reads like broken selectors.
Expenses belonging to other reviewers are counted apart on the Configuration
card and named as such, rather than being folded into "why nothing moved";
automatic approvals are per person, and whoever owns a queue switches them on
for it. And `queueDecision`, which every approval and every denial in the app
goes through, refuses an expense that is demonstrably somebody else's — a row
stamped with another reviewer, or an unclaimed row when somebody else owns
the unclaimed ones. Unclaimed-and-unowned goes through: hiding a row from
somebody shows them too little, while refusing to let them decide it stops
the work, and every row from before the reviewer column existed is unclaimed.

Which account the shared import signs in as used to be decided by
accident: "the credential most recently proven to work, else the most
recently saved". It is a deliberate choice now (`importAs`), every export
logs whose queue it read and whether that was chosen or fallen back to, and
naming somebody with no stored login refuses rather than substituting
another account.

## What runs on its own

Four loops, all started at boot in `server/index.ts`, all continuous:

| Loop | Cadence | What it does |
| --- | --- | --- |
| `startExportScheduler` | the slots in Export settings | signs into Emburse, exports Needs Review, imports it |
| `startReceiptReader` | 30s while there is work, 30 min idle, 10s after an import brings new images | reads receipt images, re-reads the ones whose total does not match, re-judges and re-queues |
| `startAutoApprove` | 15 min, first sweep 3 min after boot | queues approvals for expenses no rule flagged — **the automation that approves** |
| `startDecisionWorker` | 1s while there is work, 5 min idle | signs in as the decider and clicks approve or deny in Emburse |

Approving and applying are two different loops on purpose. The sweep only ever
writes a row to `expense_decisions`; the worker is the only thing that touches
Emburse. So pausing stops the clicking without losing the decisions, and a
flag that lands in between still gets its say (below).

Reading and deciding were always continuous. The import was not: its slots
were **retries**, so the first one that succeeded closed the day and the queue
showed whatever Emburse held at 6am until tomorrow. **Keep importing all day**
in Export settings changes what those slots mean — every one of them runs,
success or not — so the queue keeps up with Emburse: an expense submitted at
eleven is here by noon, and one somebody approved in Emburse by hand stops
being offered for a decision. Default is hourly, 6am to 9pm.

With it on, "is the data current?" stops meaning "did this morning work?" and
starts meaning "has anything arrived since the last slot that was due?" — the
Import page reports *behind* when nothing has, which is the only thing that
distinguishes a live queue from a dead importer. Overnight, when no slot is
due, nothing is reported. Frequency is safe against a truncated export: the
import already refuses one that would delete more than four in five of the
waiting expenses without a decision of ours to explain it.

## Automatic approval

`server/rules/auto-approve.ts`. This is the only path in the app that approves
somebody's spending with nobody looking, so most of it is fences. It is **off
until switched on** (Configuration → Automatic approvals), and switching it on
attaches it to the person who did: approvals are made in Emburse under *their*
login, because Emburse records an approval against whoever signed in. Never a
shared login, and never a fallback to one.

**Before a pass runs at all**, in this order — the first that holds is the one
reported, and the page shows the sentence rather than just doing nothing:

1. the switch is off
2. everything is paused (the Pause button on the queue)
3. an import is in flight — it adds and removes expenses underneath the very
   queue this reads, so approvals wait for it to finish and the rules to run
4. nobody owns the automation, so there is no login to make approvals under
5. the owner has no Emburse password stored
6. no rules are enabled — "nothing was flagged" is vacuously true of an
   expense nothing checked

**Then, per expense, four tests.** All four must pass, and they are written
once and shared by the pass and by the "why is nothing moving" report, so the
page cannot explain one rule while the automation applies another:

| Test | An expense is skipped when |
| --- | --- |
| `flagged` | any enabled rule caught it |
| `awaitingRules` | some enabled rule has not run since it arrived — *not* "it has no hit row", because a rule that does not apply writes no row at all |
| `decided` | it is already pending, applied, or failed and waiting on a person |
| `awaitingReceipt` | any receipt on it has not been read, and some enabled rule depends on a reading |

That fourth one is the fence that is easy to miss, and the reason this is not
simply "flags is empty". **An expense whose receipt has not been read is
unflagged because nothing has been checked, not because everything passed** —
rules about alcohol, receipt totals and merchant names all return UNKNOWN with
no reading, so the newest expenses look cleanest of all. Approving on that
basis would systematically approve exactly the expenses nothing had examined,
and it would look like it was working perfectly. It is *every* image on the
expense, not one: an expense with the bar tab on page two must not pass on the
strength of page one. A receipt the reader gave up on after three tries stays
unread for this purpose, deliberately — that is a reason for a person to look,
not a reason to wave it through.

Qualifying expenses are queued in date order, up to the per-run limit
(default 10, hard ceiling 100), **through the same `queueApprovalFor` a
person's click uses**. A machine does not get a shorter path to somebody
else's money than a human does. Each row is stamped `automatic`, so the queue
can always say which approvals nobody looked at.

**A flag still beats a queued approval, right up to the last moment.** The
receipt is often read minutes after the approval is queued, the rules run
again on what it said, and the expense is flagged *after* it is already in the
queue. So the decision worker re-checks every automatic approval against the
current flags immediately before signing in, and cancels the ones now flagged
— "a rule flagged this after the approval was queued, so it was not sent."
Only the machine's are stopped. A person who clicks Approve on a flagged
expense means it, and often should: a flag is a prompt to look, not a
prohibition.

**At the browser**, one more rule, because Emburse can show several rows that
match an expense equally well — one purchase split across sites is seven
identical rows. The automation may take one of them only if the queue holds a
decision for *every* matching row, in which case the choice is bookkeeping and
all seven get approved anyway. Holding fewer, it refuses and says so rather
than guessing.

**What may be believed about a receipt.** Three rules, each learned from a
wrong flag on a purchase that was perfectly ordinary:

- **An illegible reading is evidence of nothing.** The reader answers
  `legible` separately from `error`, and a reading that says "too faded to
  read" can still return a total. It is a guess. Its total, date, merchant
  and lines are all excluded from the rules; the only thing it establishes is
  that the receipt could not be read, which is its own flag.
- **A payment line settles the total, in both directions.** Where the card
  line agrees with the printed total, the receipt has answered the question
  and no arithmetic may reopen it — an invoice whose "Subtotal" already
  includes the tax was otherwise "corrected" upward by exactly the tax.
- **The charge decides between the print and the arithmetic.** A receipt can
  be internally inconsistent and still honest: a crumpled slip whose 6 read
  as a 5 in all three places it was printed, while its own items and tax add
  to exactly what was charged. Both figures are offered as candidates and
  whichever answers the charge wins — never the arithmetic on its own, since
  that is what got the invoice above wrong.

**Both sides of the ambiguity guard mean the same thing.** The guard reads:
several rows match this expense equally well, so the automation may take one
only when the queue holds a decision for every one of them. That reasoning
needs "matching row" and "one like it" to be the same relation, and they were
not — the browser accepted any row sharing a long word of the merchant, while
`peersFor` counted our own expenses alike only when the strings were
identical. Every Mammoth descriptor ends "MAMMOTH HOLDINGS LLC", so three
$29.99 car washes on one day were three rows on one side and one peer on the
other, refused for ever. Both now go through `merchantAlike`.

**Forgiving about the vendor when FINDING a row, strict when telling two
apart.** The amount and date identify an expense and the name is
corroboration, so one word in common is enough to stop the run refusing
"ACE HARDWARE #18…" for "ACE HARDWARE HELM, LLC". That same looseness made
three car washes at $29.99 on one day — BUSY BEE CARWASH - KENDA, PITSTOP
CARWASH - FAIRHO, PITSTOP CARWASH - GULFPO — all match each other on the word
"carwash", so the automation called them interchangeable and refused all
three. They are nothing of the kind: approving the wrong one approves another
site's expense, and the ambiguity guard was comparing these fuzzy row matches
against a peer count taken on the exact merchant. The run now scores the
vendor name and keeps only the closest rows, so a sibling site is set aside
and a genuine twin still ties.

**And before calling an approval unconfirmed, ask the server.** The whole
confirmation reads the page already open, which is right while the grid
repaints itself and useless when it does not — then thirty seconds of polling
a stale DOM says exactly what the first look said. A reload is not a retry
and clicks nothing: it re-fetches the same filtered view, where a row that
really left is gone and one that is really still there is still there. That
difference is a question only Emburse can answer.

**Confirming a decision means one FEWER matching row, not none.** A split
receipt puts several identical rows in Emburse — six shares of one lunch are
six rows agreeing on employee, merchant, amount and date, because they are
that expense six times over. Approving one leaves five, so "is the expense
still in Needs Review?" answers yes and is right; the question was wrong. The
run counts the matching visible rows before the click and requires one fewer
after. For an ordinary expense that is the same question: one before, none
after. A click that lands on nothing still fails, which is the fence this
must not cost.

**Nobody is watching an automatic approval.** Emburse asks an unrecognised
browser for a verification code, and the decision worker offers that prompt to
the reviewer — reasonable when somebody just clicked Approve, and false for a
batch the sweep queued on a timer a quarter of an hour ago. Parking there
holds the browser, the profile lock and the rest of the batch for the full
ten-minute wait and then abandons the sign-in anyway. A batch with no human
click in it now fails fast instead, exactly as the scheduled export does; the
moment a person decides anything the prompt comes back, and answering it once
re-trusts the device for everything after.

**A profile lock outlives the Chromium that left it.** The browser takes an
exclusive lock on its profile directory and drops it on a clean exit; a
process killed instead leaves it behind, and every launch afterwards fails
with "Failed to create a ProcessSingleton for your profile directory". On a
container that rebuilt its filesystem each deploy this was self-clearing. On a
VM the directory persists, so it is forever — every import, every approval,
until somebody deletes a file nobody knows about. A launch that fails that way
now clears the stale lock and tries once more.

**The code prompt has to be followable by somebody who has never seen it.**
Emburse MAILS the verification code rather than texting it, often to a
different address than the one they signed into this app with, and there is a
deadline. So the prompt names the inbox, numbers the steps, shows the time
left ticking, and says plainly that this is the only time they will be
asked — which is the difference between a small chore and a thing worth
refusing to set up.

That last claim is kept by two mechanisms, not one: the run ticks Emburse's
"remember this device" box before submitting the code, and the browser's
cookies are then written to the database, so the trust survives a deploy that
rebuilds the profile directory. If the box is ever missing or its selector
stops matching, the boot log says VERIFIED BUT NOT REMEMBERED rather than
letting a broken promise pass as success.

**A fix to the alcohol list reaches readings already stored.** The floor
under the model's answer is a pure function of the line's own text — "RED
BULL SUDACHI LIME 12" is not alcohol however the model felt about it — so
widening it does not need the image read again. Bumping `READER_VERSION`
gets there eventually, but eventually is one vision call per receipt in the
whole backlog: hours, and real money, to fix a word list. `reapplyAlcoholFloor()`
runs on boot, before the rule re-check so the flags it clears actually clear,
and it only ever REMOVES the mark — a line the model called clean stays
clean.

**Correcting a category is the third option, and often the right one.** A
fuel purchase at an Exxon filed under Travel · Mileage & Ground
Transportation is not a thing to deny: the spend is fine and the coding is
wrong, and denying it tells an employee off for a mistake that is not theirs
to fix. **Fix category** in the drawer changes it in Emburse — the choices
offered are the categories this tenant actually uses, gathered from every
import rather than typed into the code.

**A correction is a record, not a button press.** The run takes about a
minute, and the first version awaited it inside the request — so closing the
drawer threw away the only thing that knew the answer. It is written down
first now and applied by the worker that already holds the browser, which
means the queue row shows the category it is being changed TO from the
moment the button is pressed, whoever is looking and whatever is open. Two
corrections on one expense at once are refused rather than raced. A failure
keeps its reason and offers the whole run as markdown, because the cause is
almost always a selector that no longer matches and the fix is a field in
Export settings.

It is the only path here that CHANGES a finance record rather than deciding
on one, so: under the corrector's own Emburse login, never a fallback; never
automatic, because a person picks the category; exactly ONE matching row, as
a correction has no second correction coming to tidy up the others; and the
row is re-read afterwards rather than the save being assumed. Every control
it touches is a stored selector, and one it cannot find is reported by
listing what IS on the form, so the right value can be set from the failure
instead of a second trip.

**A denial's note is the point of denying.** It is the sentence the employee
reads. The run used to fill Emburse's reason box when it found one and carry
on silently when it did not — so the denial landed with no explanation
attached while the record here said "denied, reason: …" about a reason
nobody would ever see. A note with nowhere to go now stops the denial before
anything is confirmed. And the failure report names the decision and carries
the note, since a failed denial is the one failure where something was
written as well as clicked, and losing it means retyping from memory.

**Viewing as somebody must never become acting as them.** An admin can look
at the app through another reviewer's eyes — the control is in the main
header, the people offered are those with an Emburse login stored, and a band
under the header says whose view it is for as long as it lasts. It swaps the
identity the whole app reads, because that is what makes the view honest:
whether a login is stored and so whether anything can be decided, which
failures are theirs, what the automation did while they were away.

That identity also stamps every write — `decidedBy` on a decision, who saved
a rule, who flipped a flag — and an approval reaches Emburse under the
decider's own login and carries their name in the finance system
permanently. So the rule is not "be careful which writes to allow", it is
**allow none**: `viewAsMiddleware` refuses every request that is not a GET
while the mode is on. An allow-list of safe methods, so a write route added
next month is refused by default rather than discovered later. Admin rights
are re-checked on every request against the real signed-in user.

**An expense Emburse no longer has is not a failure.** Somebody approving or
denying directly in Emburse is allowed and normal, and when a run reads that
cardholder's whole Needs Review and finds no row for the amount, there is
nothing to fix and nothing to retry. The decision is settled as *cancelled*
(the record stays, `not_in_queue` still says which kind it was) and the
expense comes off the list on the spot — silently, with nothing reported.
Safe because it is self-correcting in the direction that matters: if Emburse
does still hold it, the next import carries it and the row comes straight
back.

**What it did while you were away** is reported once, at the top of the
queue. The automation approves with nobody watching, which is the point of it
and also the problem with it: a reviewer comes back to a queue forty rows
shorter than they left it and nothing says why. Each person's last visit is
recorded (`user_visits`), and returning after a gap of half an hour or more
freezes the window they missed — so the count is a plain fact about a fixed
period rather than a number creeping upwards as they read it. It names how
many carry *their* Emburse login, because an automatic approval is made under
a real person's account. It counts `applied_at`, not when the decision was
queued: the claim is that these reached Emburse, so a decision that failed on
the way is not an approval. Dismisses to nothing; nothing in it needs doing.

A login is the wrong hinge for this and it is worth saying why: sessions are
signed cookies renewed silently through Entra, so somebody can use the app for
weeks without a login event ever happening. "Since I last logged in" means
"since I was last here", and that is what a gap measures.

**Why nothing is moving** is a question the Configuration card answers
directly: every expense in the queue lands in the bucket of the first reason
it does not qualify — flagged, decided, awaiting rules, awaiting receipt,
eligible — and the buckets sum to the queue. A total that does not add up is a
reason to distrust the whole card. The sweep exists for the same reason: it
used to ride on the import and the receipt reader, both of which are silent on
a settled queue, so switching the automation on did nothing observable for
hours — indistinguishable from a broken feature.

## Importing the daily export

Emburse Spend's API is provisioning-only — members, team fields, receipt
upload — with no endpoint for expenses at any tier. The data therefore comes
from the **Expenses PDF export**, uploaded on the Import page.

How the app drives Emburse to get that file — the browser, the grid URL, and
how an approve or deny finds its row — is written up in
[docs/EMBURSE.md](docs/EMBURSE.md).

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

The app runs that PDF export itself, in a headless browser, and imports the
file directly — see `server/emburse/auto-export.ts`. Nothing is written to or
read from SharePoint any more.

### Getting an export in by hand

**Import → Choose PDF**, for when the automation cannot run. Identity is
derived from the row fields rather than the file, so a PDF loaded later
attaches its receipts to rows that already arrived another way.

Loading the *same* file twice is a no-op (content hash). Loading an **older**
export is refused: every row in an imported file is marked back into the inbox
and everything absent from it is marked as having left, so an older snapshot
would resurrect already-decided expenses and evict the ones actually waiting.
Force is available for somebody who is certain.

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
