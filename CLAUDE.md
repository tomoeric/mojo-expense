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

## Before any change is called done

Seven steps. Not a style guide — every one of them is here because
skipping it shipped something broken, and the note under each says which.

**1. `pnpm run typecheck` and `pnpm run build`, both clean.**
Typecheck runs `scripts/check-sql-templates.mjs` first, which refuses a
backtick inside a SQL template literal — that has broken the build three
times and the error always lands dozens of lines from the cause.

**2. Run every affected suite against a real database, and say which in the
reply, with the count.** Not "tests pass": `25 suites pass` and the names of
the new ones. The suites need Postgres:

```bash
su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/pg_ctl \
  -D /var/lib/postgresql/mojotest \
  -o '-p 5599 -k /tmp -c listen_addresses=127.0.0.1' -l /tmp/pg.log start"

export DATABASE_URL="postgres://postgres@127.0.0.1:5599/mojo"
export SESSION_SECRET="test-secret-at-least-32-characters-long"
pnpm exec tsx scripts/test-<name>.ts
```

A change to the Dutch Miller side means at least: `accounts`, `blocks`, `nav`,
`registration`, `isolation`, `signups`, `rfid`, `vendors`, `bulk`, `grants`,
`placement`, `sticker`, `dm-users`, `roles`, `notify`, `delivery`, `reminders`,
`vehicles`, `dealer-auth`, `view-scope`, `viewas-log`, `permissions`,
`app-access`, `events`, `two-reviewers`, `propagation`, `custom-fields`.

Anything touching the arranging canvas or the Shared Template page also means
the two browser passes: `pnpm run build` first, then
`scripts/test-arrange-ui.ts` and `scripts/test-template-ui.ts`. They boot
`dist/server.js` on a spare port with a forged session cookie **and a
`mojo_app=dutch-miller` cookie** — the real switch endpoint sets that one
`secure: true`, so it never sticks over http and the shell would otherwise
render the Emburse console and every assertion would fail for the wrong
reason.

**3. A new suite for any rule that could fail QUIETLY.** The test to write is
not the happy path — it is the one where the application keeps working and the
data is wrong: one partner reading another's records, a tag issued twice, a
hidden field skipping a validation, a template that is secretly a snapshot.
If the failure would show as a red screen, a test adds little; if it would
show as a plausible-looking page, it is the whole job.

**4. Boot the server and exercise the routes.** A typecheck cannot see a route
collision — `GET /events` was silently shadowed by a second route at the same
path, and only a real request found it. Anything touching routes, middleware
or permissions gets an HTTP pass; `scripts/test-isolation.ts` is the pattern,
assembling the same middleware stack as `index.ts` and speaking to it over a
socket with a real signed session cookie.

**5. A browser pass over every changed page.** Playwright is installed and
needs no options. Load the page with a forged session cookie, assert it
renders what it should, and assert **zero console errors** — a React crash
below the fold is invisible to every other check here. Click the controls that
were added; "it compiles" is not "the button works".

**5a. A change on the Emburse side means at least**: `credentials`,
`connections`, `decisions`, `import-as`, `unclaimed`, `run-as`,
`reviewer-schedules`, `manager-queue`, `view-as-brian`, `two-reviewers`,
`corrections`, `decision-trace`, `auto-approve`, `rules`, `bulk-approve`,
`lanes`, `two-accounts`, `rule-scope`, `receipt-mail`, `signin-errors`, `writeback`, `receipt-link`,
`personal-grid`, `cookie-jars`, `device-trust` (needs a build). For a change to "Your Emburse login", Export
settings or the review queue, also
`test-accounts-ui.ts` and `test-lanes-ui.ts` after a build.

**6. Two things that only an EMPTY database shows.** Run the suites once
against a fresh database, because the live one has every table already and
hides both: a column or index that was never written (the signup soft-delete
shipped with the TypeScript referencing `deleted_at` and no `ALTER` for it),
and a module whose schema needs another module's table first (`signups` needs
`dm_rfid` and `dm_audit`; `accounts` needs `dm_users`). Harmless on this
deployment, fatal on the first boot of a new one.

```bash
psql -h /tmp -p 5599 -U postgres -d postgres -c "CREATE DATABASE mojofresh"
DATABASE_URL="postgres://postgres@127.0.0.1:5599/mojofresh" pnpm exec tsx scripts/test-accounts.ts
```

**7. Update `CLAUDE.md` in the SAME commit, and say in the reply what was NOT
done.** Both halves matter. A rule that lives only in a commit message is a
rule the next change breaks. And a summary that lists what works and stays
quiet about what does not is how three reviews in a row had to come back and
find the same gap — name the thing that is not built, the check that could not
be run here, and the verification that is still the user's to do on the
deployment.

### What counts as evidence

- **"It compiles" is not evidence.** Neither is "the page renders" for
  anything with a rule behind it.
- **Report the actual output.** If a suite fails, say so with what it said.
  If a step was skipped, say which and why.
- **Never claim a check that was not run.** vPIC is blocked by this
  container's proxy, so the vehicle lookups are only ever exercised on their
  offline paths here — that gets said every time rather than rounded up to
  "vehicles pass".
- **Clean up after a test.** A suite that leaves rows behind makes the next
  run lie. Every one here has a `finally` that removes what it made and
  nothing it did not.

### Two standing rules that are not negotiable

- **Isolation is re-checked whenever data or routes change.** One partner must
  never read another's members, tags, vendors, documents, layout or
  navigation, and an id from the wrong account must answer exactly as an id
  that never existed.
- **Hiding is never a control.** Removing a button, a field or a page from the
  interface changes presentation only. Whatever it protected is enforced on
  the server, or it is not enforced.

## Two apps on one deployment

- **Emburse and Dutch Miller share this VM, this sign-in and this origin, and
  nothing else.** Assignment is by email in `server/auth/apps.ts`. The rule in
  one sentence: **Dutch Miller is opt-in by list, and Emburse is open to
  everyone who may sign in EXCEPT people assigned to Dutch Miller, unless they
  are assigned to Emburse as well.**
- **The asymmetry in the defaults is deliberate.** `EMBURSE_ALLOWED` unset means
  "carry on as before" — a list that started empty would lock out every
  reviewer on the deploy that introduced it. `DUTCH_MILLER_ALLOWED` unset means
  the two named people and nobody else, because it has no users to preserve.
  A secret REPLACES its default rather than adding to it: a default nobody can
  remove is a backdoor.
- **Hiding pages is not access control.** The routes are on the same origin and
  anybody signed in can call them. `app.use("/api", requireApp("emburse"))` in
  `index.ts` sits after `authRouter` and before every Emburse router, so a route
  added later is protected by default rather than by somebody remembering. Dutch
  Miller mounts at `/api/dutch-miller` behind its own guard — put its routes
  there, never on an Emburse router.
- **The app cookie is a preference, never a grant.** It is read only to choose
  between apps somebody already holds; a cookie naming one they do not is
  ignored wherever it is read, and `POST /api/auth/app` refuses it outright.
- **Judged on the REAL person, like `isAdmin`.** A view-as changes whose data is
  on screen, never which product you are in.
- Switching does a full reload. The two shells have different polling, routes
  and caches, and swapping in place leaves the old app's queries running
  against endpoints the server has just started refusing.

## The two doors (READ BEFORE TOUCHING ANY PERMISSION CHECK)

- **MOJO staff sign in with Microsoft. Dealer staff are INVITED by an admin
  and sign in with an emailed one-time link.** There is no self-signup
  anywhere; `/api/dm-auth/request` sends nothing to an address no admin
  invited, and answers identically either way so it cannot be used to find
  out who has an account.
- **NEVER decide "is this one of ours" from the email address.** Once an
  admin can invite an outside address, somebody invited as
  `anything@mojocarwash.com` would inherit staff powers. The test is the
  DOOR: `session.via === "microsoft"` AND the domain is in `STAFF_DOMAINS`
  (default `mojocarwash.com`, `mammothholdings.com`). Use `isStaff(user)`
  (`dutch-miller/users.ts`) and `isAdminUser(user)` (`auth/index.ts`) —
  both take a SESSION, not a string. A bare `isAdmin(email)` in a request
  path is the bug these replaced.
- **A link session gets Dutch Miller and nothing else**, enforced in
  `appsFor(email, via)` regardless of any list. Emburse is behind the
  Microsoft door, permanently.
- **Super admin is pinned by `DM_SUPER_ADMINS`** (default
  `eric.s@mojocarwash.com`), never a row. Only a account admin can make
  somebody an admin, change one, switch one off or remove one — an admin
  who could promote could promote themselves. The old "empty table makes
  everyone an admin" fallback is GONE; the pinned account admin does that job
  without leaving the door open.
- **A LINK IS NEVER SPENT BY A GET.** Mail providers fetch the URLs in
  incoming messages to scan them, so a redeem-on-GET burned invites on
  delivery — reported from the real world within a day of shipping.
  `GET /redeem` only PEEKS (`peekToken`), parks the token in the signed
  httpOnly pending cookie and shows a Continue button; `POST /continue`
  spends it. Never move redemption back onto a GET, and never send an
  email from one.
- **Setting up asks for NO code.** Opening a one-time link emailed to the
  address already proves the inbox; a code to the same inbox proves it
  twice. The invite link is therefore the only credential in that flow,
  so it lives 3 days rather than 7.
- **First sign-in from a browser DOES ask for a code, then that browser
  is trusted for 14 days** (`devices.ts`). Trust is a row, not just a
  cookie, so revoking sessions or disabling an account clears it —
  otherwise "signed out everywhere" leaves every machine able to walk
  back in with no code. Trust is checked against the device secret AND
  the address, or one person's trust on a shared machine carries the
  next person past the code.
- **Nothing is stored in the clear.** `dm_login_tokens` and
  `dm_verify_codes` hold SHA-256 only. Links are single-use (conditional
  `UPDATE`, same trick as the RFID claim), asking again kills the previous
  one, 15 min for a login and 7 days for an invite. A login link is softly
  bound to the browser that asked: opened elsewhere it also wants the
  six-digit code, which is what makes a leaked URL on its own worthless.
  An invite cannot be browser-bound (an admin asks, somebody else opens),
  so it ALWAYS requires the code — which is also how the address is verified.
- **Sessions are revocable** despite being stateless cookies: each link
  session carries `dm_users.session_epoch` from when it was minted, and
  disabling or revoking raises it. Checked in `authMiddleware`, cached 10s;
  call `forgetEpoch(email)` after any change so it bites at once.
- **Lockout and audit are one table** (`dm_audit`). The lockout is DERIVED
  from the trail over a rolling window, not stored, so it cannot drift from
  it and clears itself with nothing to sweep up. Never write a token, a
  code, or anything derived from one into `detail`. There is no route that
  edits or deletes a line, deliberately.
- **Email goes out through Graph** (`server/mail.ts`), sending as `MAIL_FROM`.
  It prefers a dedicated registration (`MAIL_TENANT_ID` / `MAIL_CLIENT_ID` /
  `MAIL_CLIENT_SECRET`) and falls back to the `AZURE_*` sign-in app. Prefer
  the dedicated one: the sign-in app also holds `Sites.ReadWrite.All` and
  `Mail.Read`. Scope it with an application access policy either way —
  `Mail.Send` as an application permission can otherwise send as ANY mailbox
  in the tenant. **Users → Test email** sends to the admin asking and nobody
  else, and passes the Graph status through for setup.
- **Access comes from a named ROLE, never from the person.** `dm_roles`
  holds name + pages + `administers`; `dm_users.role_key` points at one.
  The old per-person `pages` column is legacy and is no longer read. Two
  built-ins are seeded and cannot be renamed, removed, or have their
  administering changed — the guards and the default assignment are
  written against them. Their PAGES can be edited.
  - **`administers` implies every page**, whatever is ticked. An admin who
    could open Users but not Member Signups is not what anybody means.
  - A role cannot be deleted while anybody holds it; renaming keeps the
    key, so holders survive it. Deleting out from under somebody would
    grant nothing rather than everything (`dmAccessFor` checks).
  - **Approving a membership is the CSC role and nothing else**, via an
    `approves` column that is NOT offered in the role editor — a boot
    statement re-asserts `approves = (key = 'csc')` every time, so a
    row edited by hand cannot hand it to another role. An administrator
    does NOT get it: administering is "who may use the app", which is a
    different job from "this member may wash". The account admin does,
    because locking the owner out of their own app is not a security
    model. `canApprove()` in `routes.ts` also requires `isStaff`, so a
    dealer account given the CSC role still cannot approve.
  - **Only a SUPER admin writes roles** (`requireSuper`) or hands out one
    that administers. A role is a grant, so an admin who could write one
    could write themselves a better one.
- **The account menu is no longer gated on administering.** Its list is already
  filtered to what the person holds, and Vendors is granted by role rather than
  by level — a second check in `UserMenu` hid it from exactly the people it had
  been granted to.
- **Users, Roles and Settings live under the USER ICON, never in the rail.**
  The rail is for the pages people come here to do work in; these
  administer the app, and putting them in the same column makes an
  occasional errand look like part of the job.
  - **Users is a DIALOG, not a page** (`dm-people.tsx`), opening over
    whatever is on screen — setting a role is a thirty-second errand and
    losing your place to run it is the annoying part. It is the single
    users surface, with invite, test email, audit trail, and per-row
    edit · view as · switch off · resend · remove.
  - Its list has **no directory lookup and needs no Graph permission**.
    `DUTCH_MILLER_ALLOWED` IS the list of Microsoft accounts that may use
    the app, so the three sources are the pinned account admins, that
    secret, and anybody with a `dm_users` row. Reading the tenant would
    add hundreds of people who cannot sign in. Don't reintroduce it.
  - Roles and Settings stay routes (`#/roles`, `#/settings`) so the back
    button and a pasted link behave — they are simply not in the rail.
- **View as, for a account admin.** Reuses the existing `view-as` machinery
  (`VIEW_AS_COOKIE`, `viewAsMiddleware`), so the hard part — EVERY non-GET
  is refused while viewing, by allow-list — is already true for Dutch
  Miller routes. `mayView()` admits an Emburse admin or a pinned super
  admin, **Microsoft door only**: an invited account spelled like the owner
  must never inherit it.
  - **Authority on the REAL person, the view on the VIEWED one.** `/me` and
    `requirePage` read `req.user` (already swapped), so the rail and the
    refusals are faithfully theirs — including `staff`, or the viewer would
    see their own MOJO controls inside somebody else's app. `requireDmAdmin`
    stays on the real person, same precedent as `requireAdmin`, so the way
    out never disappears.
  - Candidates come from `dm_users` only — never an arbitrary address — and
    include invited accounts, since "what do they see?" is usually asked
    about somebody just added.
- **The Security Log is only what FAILED** (`SUSPICIOUS` in `audit.ts`,
  page under the user icon). Never add a successful sign-in to it:
  four real attempts buried in nine hundred ordinary lines is how they
  get missed — that is what the audit trail is for. It groups by
  address and by origin, because one address fumbling their own
  sign-in looks nothing like one origin reaching for several, and only
  the grouping tells them apart.
- **Email Settings** holds notifications and reminders. A reminder is
  daily on any days ticked or weekly on one; the scheduler checks each
  minute and records the MINUTE SLOT it last sent, which is what stops
  a restart loop mailing the same digest repeatedly. Nothing is sent
  when nothing is outstanding. Watch 12 AM (hour 0) and 12 PM (hour 12)
  if `hour24` is ever touched.
- **Bulk member upload is ALL OR NOTHING** (`dutch-miller/bulk.ts`). One
  bad row refuses the whole file, named by row and column, and the user
  re-uploads. Never make it partial: each accepted row spends an RFID
  tag permanently, so a half-import leaves tags issued against members
  who are not there and no way to tell which half landed.
  - The file carries NO RFID column — whoever fills it in cannot know
    which tags are free. Each row takes the next one via
    `createSignup(..., { assignAnyRfid: true })`, whose claim is
    `FOR UPDATE SKIP LOCKED` so two rows arriving together take two
    different tags instead of fighting over one.
  - Checking is a separate route from committing and writes nothing.
    Committing is ONE ROW PER REQUEST, so review-each and send-all are
    the same code path, differing only in whether the page waits.
  - The send-all choice lives in component state only, so it lasts for
    that upload and no longer. A remembered "don't ask again" would
    quietly turn every later import into a straight-through one.
  - Both the upload and the finished run are written to the audit trail
    (`bulk.uploaded`, `bulk.committed`).
- **Live updates are PUSHED, not polled** (`server/events.ts` +
  `src/lib/live.ts`). The shell holds one server-sent-events connection
  and `emitChange(topic)` on every write invalidates the matching
  queries. This exists because the notification is sent AFTER the
  response, so the step recording it lands once the page has already
  fetched — without a push the page shows something that stopped being
  true. The bus is in-process: fine for one Reserved VM, swap for
  Postgres LISTEN/NOTIFY if it is ever scaled out. Keep the heartbeat;
  proxies close a silent stream. A slow poll remains as a fallback only.
- **The tracker's four steps are events, not guesses**: submitted, email
  sent (Graph accepted it), opened in MOJO, completed. The third is
  OPENING THE RECORD, never an email open — that would be a pixel, and a
  pixel reads as "never opened" behind blocked images and as "opened"
  when a scanner prefetches, which is the exact behaviour that burned an
  invite here. The badge has three states to match: Submitted → Under
  review (somebody opened it) → Completed, and the three filters must
  stay mutually exclusive or the counts stop adding up.
- **Signup notifications** (Dutch Miller → Settings, admin only). Recipients
  live in `dm_settings`, a small key-value table with a TYPED ACCESSOR per
  key (`getSignupNotify`) — never reach in with a raw string. Three
  independent gates produce an empty list: switched off, no recipients, or
  a submitter-copy with notifications off; `recipientsFor()` is the only
  place that decides.
- **Sending is FIRE-AND-FORGET, outside the submission.** By the time it
  runs the member exists and the tag is claimed, so failing the request
  would tell a dealer their signup did not work when it did — and they
  cannot retry without burning a second tag. Every outcome goes to the
  audit trail (`notify.sent` / `notify.failed`) so a notification nobody
  got is visible rather than silent. One message PER RECIPIENT: a single
  bad address in `toRecipients` can take the whole send with it.
- Date formatting in `notify.ts` uses explicit components, not
  `dateStyle`/`timeStyle` — Intl THROWS when those are combined with
  `timeZoneName`, and in there the throw is swallowed, so every
  notification would silently become a `notify.failed` line.
- Tests: `scripts/test-dealer-auth.ts` (links, codes, lockout),
  `scripts/test-dm-users.ts` (roles, invite states, revocation) and
  `scripts/test-view-as.ts` (who may view, and that no view can write) and
  `scripts/test-notify.ts` (recipient parsing, the three empty-list gates,
  and what the message carries) and `scripts/test-roles.ts` (built-ins,
  renaming keeps holders, a held role cannot be deleted).
- **Still one factor.** The link and the code both land in the same inbox,
  so this is possession-of-email, not MFA. The onboarding form collects a
  contact number precisely so a real second factor (an SMS code at sign-in)
  can be added without another migration.

## Inside Dutch Miller

- **Two layers, and they answer different questions.** `auth/apps.ts` (a
  Secret) says who comes through the door; `dutch-miller/users.ts` (the
  `dm_users` table) says what they find once inside. Being listed in
  `dm_users` grants nothing on its own, and being on the Secret's list grants
  no page.
- **An EMPTY `dm_users` makes everyone an administrator**, same reasoning as
  `AUTH_ADMINS`: a permission table that starts empty would lock the first
  person out of the page that fills it in. **The first row closes it**, so it
  cannot quietly stay open — and the shell says so in a banner while it is.
  The last administrator cannot be removed, because with the table non-empty
  the fallback does not come back.
- **`DM_PAGES` in `users.ts` is the one registry of pages.** The rail, the
  Users page's tick-boxes and the `requirePage()` guards all read it, so a new
  page is one entry there plus a route in the shell. Never keep a second copy
  in the UI: a typo in it grants access to nothing while looking like access
  to something.
- **The rail is built from `GET /api/dutch-miller/me`**, so a page somebody
  cannot open is never offered — and every route under `/api/dutch-miller`
  carries `requirePage()` or `requireDmAdmin` so that is a rule, not a
  decoration. Hiding is never the control.
- **RFID numbers are physical tags**, which is where the two hard rules come
  from: one of each (`number` is the primary key, and an upload reports the
  repeats it dropped rather than silently de-duplicating), and **issued once**
  — `useRfid` claims with `WHERE status <> 'used'` so the database picks the
  winner when two requests arrive together, and a used tag can never be made
  active again. Excel dropping a leading zero turns `01234+567890` into ten
  digits; the parser refuses those and says why rather than padding a guess.
- **Member Signups is two sub-pages of ONE page**, `#/member-signups/review`
  and `#/member-signups/add`. Access is granted at the parent, because a
  tick-box per tab would only be a way to hand somebody Add New without
  Review Existing. The rail renders `DM_PAGES[].children` as a dropdown —
  that is why the top tab row from the mockup is not there.
- **The generated values are minted AND SIGNED by the server** (`newHandle`
  / `handleIsOurs` in `signups.ts`, HMAC over `SESSION_SECRET`). The form
  carries the signature through verification untouched. Without it
  "read-only" is a styling choice: a client could post any creation time or
  replay a GUID. This is why there is no table of half-started drafts.
- **The tag is claimed in the SAME transaction that writes the member**, with
  a conditional `UPDATE … WHERE status = 'active'` rather than a read then a
  write, plus a unique index on `dm_member_signups.rfid` underneath. A tag
  issued with no member is lost; a member with no tag means the next customer
  gets the same one. `ON CONFLICT (guid) DO NOTHING` makes a retry or a
  double-click idempotent. **Selecting a tag in the form does nothing** — only
  Confirm & Submit claims it.
- **Two internal marks.** `submitted_at` — reached MOJO; always set, because
  the row only exists once it has (a separate always-true boolean would be a
  flag waiting to disagree with reality). `completed_at`/`completed_by` — a
  MOJO employee dealt with it, set only by an `@mojocarwash.com` account
  (`isMojoStaff`), NOT by a Dutch Miller administrator: being an admin of the
  dealer's app says nothing about working at MOJO. Reversible, because the
  alternative to an undo is a wrong record nobody can correct.
## The security workspace and the event trail

- **ONE table, three views.** `dm_audit` holds security, access and business
  events alike; Security, Sign-ins and Audit History are reads over it, not
  separate logs. An investigator's first question is "what else happened around
  then", and three tables cannot answer it.
- **Category, outcome and severity are DERIVED from the action**, in
  `event-catalog.ts`, never stored on the row. That is why the whole pre-existing
  trail arrives classified with no migration. Adding an action means one entry
  there — a row whose action has no entry reads as `unknown`, never as a guess.
- **Two products, one table, TWO security logs.** `dm_audit.app` is
  `dutch-miller`, `emburse`, or empty for shared (signing in, signing out,
  view-as). Every Dutch Miller read appends `DM_SCOPE`, so the other product's
  refused API routes never appear on this security page — a new query that
  forgets it leaks them straight back. Nothing is deleted: an Emburse denial is
  still recorded, it is simply the other log's business. Sign-in events are
  tagged by what the person actually HOLDS, so somebody with Emburse alone does
  not clutter the dealer log.
- **Successful sign-ins ARE recorded.** They were dropped once to keep the log
  short, which left it unable to answer the only question it is for: did the
  attempt eventually work. They are kept out of the Concerns feed, not out of the
  record. Never "fix" noise by dropping events.
- **`audit()` redacts.** Every detail line goes through `redact()` and every path
  loses its query string, because a sign-in link in a query string is exactly how
  a credential lands in the log meant to prove none leaked. Never bypass it.
- **`actor` is the EFFECTIVE identity, `actor_real` the person at the keyboard.**
  An action taken during a view belongs to both. Use the `who(req)` helper in
  `routes.ts` for every `audit()` call so a new route cannot record less.
- **Nothing automatic may call anything an incident.** `detect.ts` produces
  CONCERNS: a stated threshold, the count that met it, the events behind it, and
  a caveat saying what the pattern is NOT. One failure is never a concern. A
  sign-in after a run of refusals is raised FOR REVIEW and says so. Only a person,
  in `investigations.ts`, can record `confirmed-incident`, and only with a written
  conclusion.
- **Investigations never touch the evidence.** `dm_audit` is append-only — no code
  updates or deletes a row. Status, classification, notes and ownership live in
  `dm_investigations` / `dm_investigation_notes`, pointing at events by id.
- **Coverage & health states the gap.** Entra, the WAF and the network are NOT
  connected, and the page says an empty log is not proof nothing happened. If a
  source is ever connected, say so there; never imply coverage that does not exist.

## Member and RFID rules that must not be re-broken

- **An import may NEVER attest that a sticker is attached.** The tag is allocated
  by the server, one row at a time, AFTER the file was written — so nobody filling
  in that spreadsheet can know which sticker goes on which windshield. Bulk rows
  land `sticker_state = 'pending'`; the assignment manifest says which tag belongs
  to which vehicle; somebody confirms afterwards. Do not put a "Sticker Attached"
  column back in the template.
- **Three sticker states, not a boolean.** `confirmed` (somebody ticked it at
  submission), `pending` (an import allocated it), `legacy` (predates the
  question). A boolean made old rows read as "somebody checked and found none",
  which is a claim nobody made. Never backfill `legacy` to confirmed.
- **Approval requires `sticker_state = 'confirmed'`**, enforced in `setComplete`,
  not in the form. Approving means the member can drive up and wash.
- **Deleting a MEMBER does not free their tag** unless whoever deleted the record
  explicitly released it. A sticker already on a windshield must never be issued
  twice.
- **A deleted RFID never returns to the pool** — not by re-uploading the file that
  brought it in, not through Make active, not through `useRfid`.

## Vendors: approval on creation AND on every change

- **TWO tables, and that is the whole design.** `dm_vendors` holds the APPROVED
  record — nothing writes its fields except an approval — and
  `dm_vendor_revisions` holds every version ever proposed. If an edit wrote
  straight into the vendor there would be, between submitting and approving, a
  vendor on file nobody approved. That is the thing the review exists to prevent.
- **There is deliberately NO add control on the Vendors page.** Where a new
  vendor is submitted from has not been decided; the page is a register, and
  `VendorForm` still submits (it is what proposes a change from a vendor's
  detail). Wiring an add back in is rendering that same form with `BLANK` and
  no `vendorId` — do not build a second submit path.
- **Vendors is reached from the account menu, not the rail** — see the platform
  section below. The grant, the routes and the records are unchanged.
- A new vendor is a row with EMPTY approved content and one pending revision.
  `status: pending` with blank fields is not a half-written record; it is a
  request. Never "fix" it by writing the proposal into the vendor.
- Rejecting an edit leaves an established vendor exactly as it was, still
  approved. Only a vendor that was never approved becomes `rejected`.
- **One pending revision per vendor**, enforced by a partial unique index. A
  second proposal SUPERSEDES the first in the same transaction, so the history
  says what happened to it; two pending changes approved in turn would apply one
  over the other with nobody told.
- `validateVendor` is what stops a SUBMISSION (the contact block).
  `approvalBlockers` is what a REVIEWER should look at (W-9, insurance, expiry,
  tax ID) and is reported, never enforced — approving anyway is a decision with
  their name on it.
- Approving is its own grant (`dm_roles.approves_vendors`), deliberately not the
  CSC one: a membership says a car may be washed, a vendor says a company may be
  paid.

## MOJO Partners: one application, many partners

Dutch Miller was built as the only tenant there would ever be. It is now the
FIRST ACCOUNT on a platform, and every rule below exists so that a second one
cannot see its data.

- **`server/dutch-miller/accounts.ts` is the spine.** `dm_accounts` holds one row
  per partner: an immutable `id`, a unique `slug` (routing), a name, an
  affiliation, a status and the template version it was provisioned at.
- **The ID is the only ownership key.** A slug is a URL and a name is a label;
  both get changed by somebody who does not realise what hangs off them, which
  is exactly why neither may ever decide who reads what. Renaming an account
  moves no records, and there is a test that says so.
- **Dutch Miller's id is the CONSTANT `acct_dutchmiller`.** That is what made the
  migration a column default — `ADD COLUMN account_id text NOT NULL DEFAULT
  'acct_dutchmiller'` backfills every pre-existing row in one statement, with no
  script to run, no ordering to get right and nothing that can happen twice. A
  generated id would have needed all three. Never change it.
- **Scoped: `dm_member_signups`, `dm_rfid`, `dm_vendors`, `dm_settings`,
  `dm_audit`.** Shared: `dm_users`, `dm_roles`, `dm_investigations`,
  `dm_mail_sends`, the notification and reminder settings. That split is the
  brief's: users, roles, security and email are platform-wide and managed
  centrally; members, tags, vendors and sticker placement are the account's.
- **An RFID number stays a GLOBAL primary key.** A sticker is a physical thing
  with one number printed on it and the gate readers have never heard of
  accounts. Keying per account would let two partners hold the same number and
  bill the second car to the first one's membership. An upload of a number
  another partner holds adds nothing, reports it, and does NOT name who has it.
- **The account is part of every lookup, not a check after it.**
  `getSignup(guid, account)`, `getVendor(id, account)`. Another partner's record
  answers exactly as an id that never existed does — a GUID gets pasted into
  chats and left in bookmarks, and "find it, then see whether you were allowed"
  is the shape that leaks a name and a plate through an error message.
- **`dm_settings` is keyed on (account_id, key)**, with `''` meaning shared. The
  primary key was dropped and replaced by a unique index because `ADD PRIMARY
  KEY` has no `IF NOT EXISTS` and the statement runs on every boot. An
  `ON CONFLICT` on that table must name `(account_id, key)` or no target at all.
- **`dm_audit.account_id` is `''` for platform-wide events** — sign-ins,
  refusals, user administration — and set for business events. A scoped
  administrator reads their own partners plus the platform-wide rows
  (`historyScope` in `routes.ts`); an account administrator reads everything.
  Partner lifecycle has its own `partner.*` actions, deliberately NOT the
  `account.*` family, which has always meant a person's account.

### Which partner a request is in

- **ONE middleware ahead of every route in `routes.ts`**, same reasoning as the
  app guard above it: a route added later is scoped by being there rather than
  by somebody remembering. Forgetting the app guard shows one product to the
  other product's user; forgetting this shows one partner's members to another
  partner.
- **The browser says which account on the `X-Partner-Account` header**, set from
  the PATH by a `fetch` wrapper in `src/lib/partner.ts`. A header, not a
  re-rooted URL, because every route is already under `/api/dutch-miller` and
  moving them would break every emailed link in existence. The SSE stream takes
  `?account=` instead, because `EventSource` cannot set a header.
- **The path is the only source of truth, deliberately not a cookie.** A
  remembered selection is shared between tabs, so somebody comparing two
  partners would have both tabs reading the same one and would not find out
  until they acted on it.
- **A header naming an account they do not hold is REFUSED, not ignored.** The
  app cookie is ignored because it is a preference; this one is how somebody
  would go looking. Not-found and not-yours answer identically, so the error
  cannot be used to enumerate partners.
- **Patching `window.fetch` is heavy, and is the point.** There are some eighty
  calls to these routes; a header that has to be remembered at each would be
  missing from the one added next month — and would not fail loudly, it would
  read the wrong partner's data.

### Account Administrator and Admin

- **Account Administrator = the pinned list** (`DM_ACCOUNT_ADMINS`, falling back
  to `DM_SUPER_ADMINS`). Holds every account including ones created later,
  creates and deactivates them, and sets who may open what.
- **Admin = `administers`, within assigned accounts only.** `dm_account_access`
  holds explicit assignments; `dm_users.all_accounts` is the mark for MOJO staff
  who work across partners. The mark is NOT "tick all seven": the difference
  shows the day an eighth is created, when a list of seven is silently missing
  from it. An invited (link-door) account can never hold it.
- **Scope is a grant, so widening it is the account administrator's alone.** An
  admin cannot create a partner, deactivate one, give themselves every partner,
  or assign themselves another. Tested over HTTP, not just in the model.
- **Account scope and business permissions are separate questions.** Holding an
  account says nothing about what you may do in it; that is still the role.

### Two switches, and they are not the same

- **`dm_accounts.status`** — the ACCOUNT, deactivated. Blocks everybody but an
  account administrator, both doors, enforced in the middleware so a deep link
  or a stale tab cannot walk past it. Needs a reason. Keeps every record.
- **`dm_settings.dealer_account_active`, per account** — the partner's own door,
  paused. Shuts the EMAILED-LINK door only; MOJO staff keep working, because
  they are who would switch it back on and locking them out to lock out a
  partner turns a pause into an outage. Judged on `via`, never on the address.
  Open by default; switching OFF needs a reason, which the dealer is shown.
- Keeping both is deliberate: pausing a dealer's logins while MOJO clears a
  backlog is an ordinary week, and shutting the partner down is not.
- **A deactivated account stays in `accountsFor`.** Membership and permission to
  work are different questions — dropping it from the list would tell the dealer
  whose partner went dark that it is "not available to you", when what they need
  to read is that it was deactivated and why.

### Provisioning

- **A NAME is the whole requirement.** The path is suggested from it, the
  affiliation is optional, and nothing else is invented. An account that claims
  a reviewer it does not have is worse than one that plainly has none.
- **Idempotent on the slug.** A double-click or a retried request returns the
  account already there, flagged `created: false`, rather than minting a twin.
- **`RESERVED_SLUGS` is wider than the paths in use.** Reserving a word nobody
  wanted costs nothing; releasing one that is already in somebody's emailed URL
  costs a broken link.
- **Provisioning never copies.** Shared code, current defaults, empty data.
  Copying Dutch Miller's reviewers, tags or members is how one partner's details
  end up on another partner's screen.
- **`TEMPLATE_VERSION` is a RECORD, never a selector.** Every account is always
  rendered by the deployed code. The moment that number chooses behaviour it has
  become a fork, which is what this whole module exists to prevent.

### Routing and the shell

- **`/<slug>` is the account; `/` is the platform.** The page stays in the hash,
  so every existing `#/member-signups/review` link still works — a legacy link
  with no slug resolves to the person's first account, which for everybody today
  is Dutch Miller. The server already serves `index.html` for any path.
- **The header is MOJO Partners, with the partner's line under it** — "Dutch
  Miller — SUDS Car Wash", or the name alone when no affiliation is set. Never a
  dangling separator, never an invented wash.
- **One account and no slug: open it, do not offer it.** Somebody who works for
  one dealership lands in that dealership. An account administrator is the
  exception, because the list IS their page.
- **`PlatformShell` in `dutch-miller.tsx` is its own shell**, not the partner one
  with the pages swapped. Outside an account there is no partner whose members
  they would be, so a rail offering them would offer pages that cannot load.
  Users, Roles, Security and Email are the SAME pages there as inside an
  account, because they are the same shared configuration.
- **Vendors left the partner rail** (`DM_PAGES`), kept its grant
  (`DM_GRANTS`), its routes and its records, and is reached from the account
  menu like Users and Roles. The rail is the work a dealership comes to do;
  approving a company to be paid is not that job, and on a platform where most
  partners will never have a vendor it is an empty heading for nearly everybody.
  `#/vendors` is rewritten to `#/admin/vendors` in the shell, because a hash
  never reaches the server.

### Schema ordering, which only an empty database shows

`signups.ts` has a foreign key to `dm_rfid` and a backfill that reads
`dm_audit`; `accounts.ts` carries people over from `dm_users`. Each awaits the
others' `ensure*Schema()` now. On any database that has ever run this changes
nothing — and on an EMPTY one it is the difference between the app coming up and
the first request failing on whichever module happened to be touched first,
which is exactly what a new environment hits.

### The shared template and editable buckets

`server/dutch-miller/blocks.ts`. A PAGE has a fixed registry of items; a BUCKET
is a named group of some of them, shared; a LAYOUT is which buckets one
account's page shows, in what order and at what width. Four pages are built
this way: Member Signups (Review Existing and Add New), RFID Instructions and
RFID Inventory.

- **The registry is the whole vocabulary.** `ITEM` in `blocks.ts` names every
  field and piece of content a bucket may hold, per page. A key that is not in
  it is REFUSED on save rather than rendered as a gap — a gap is the hardest
  bug to notice and the person who notices it is a dealership. There is
  deliberately no free-text field name anywhere in the editor.
- **Definitions are shared; arrangements are the account's.** One bucket, so
  improving it improves it everywhere on the next deploy with nothing to
  re-copy. `dm_account_layout` holds overrides, and a row there is the only
  thing that makes a page the account's own.
- **Resolution happens at READ time, never at provisioning.** A new account is
  given no rows. `layoutFor()` starts from `dm_template_layout` and lays the
  account's overrides on top, which is what makes all three of these true at
  once: an untouched page follows a change to the base; an arranged page keeps
  its arrangement; a bucket added to the template later is available without
  being imposed. Copying the base into a new account would be a fork on day one
  and nothing on screen would say so. There is a test for exactly this.
- **An account's `items` override is null when it matches the bucket.** So an
  account that merely reordered a page still receives a field added to the
  shared bucket later. Freezing the list on a reorder is the subtle way this
  design turns back into a snapshot.
- **ESSENTIAL items cannot be hidden, unticked, or edited out of the shared
  bucket** — three separate code paths, three separate refusals, each tested.
  Hiding is presentation only: it deletes nothing and relaxes no validation, so
  an item a workflow depends on must stay on screen or the page quietly stops
  working. `layoutFor` also ignores a `hidden` row on such a bucket, because a
  row can arrive from a restore or a hand-edited database as well as a save.
- **Required-ness is not decided by the form.** The server validates every
  submission against its own rules, so a field taken off Add New cannot produce
  a record that would otherwise be refused — only a form that cannot be
  submitted. That is why required fields are registered essential rather than
  re-added by the page.
- **Archiving, never deleting.** A layout row still points at a retired bucket,
  so a dangling id would mean a page that fails to resolve. Bringing it back
  restores every account's arrangement exactly. A built-in cannot be retired:
  the base layout is made of them and a page with none left is a blank screen
  with no way back.
- **Both arrangement controls are offered.** Buttons that move a bucket one
  place AND dragging. The buttons are not a fallback — they are the ones that
  work with a keyboard and on a phone.
- **Restore deletes the overrides** rather than writing today's base into them,
  which is what keeps the page FOLLOWING the template afterwards.
- **An account's saved layout is the WHOLE page, not a per-bucket patch.** The
  first version merged the base into the gaps, which looks harmless and is
  not: a bucket somebody deliberately removed came back on the next load,
  because "absent from the account's rows" and "follow the base" meant the
  same thing. It also forced a bucket added to the base later into a layout
  somebody had customised — the one thing the brief says not to do. An account
  with NO rows still follows the base, which is what keeps a shared correction
  reaching everybody who has not arranged the page.
- **Promoting is how an account-level correction carries over.**
  `promoteLayout` makes one account's arrangement the shared base, so every
  partner created afterwards starts with it and every partner still following
  the base gets it now. It says how many that is BEFORE the click. Layout only
  — order, width, height — because what a bucket CONTAINS is a template edit
  and promoting a field selection would rewrite a shared definition from
  inside one partner. The promoting account stops overriding afterwards: it is
  the base now, and an override saying the same thing would be a copy that
  stops following the next correction. Account administrator only; it reaches
  other partners, so it cannot be one partner's administrator's to take.
- `scripts/test-blocks.ts` covers the model; `test-isolation.ts` covers the
  routes, including that an administrator cannot touch the shared template.

### A customised page still hears from the template

A whole-page override answers "an account keeps what it arranged" and, on its
own, answers it too well: before this, a correction promoted afterwards
reached every account still on the base and silently missed the customised
ones, and nobody was ever told. **Saving a complete page is NOT a reason for
later shared corrections to stop reaching it.** The rule now:

- **The account's arrangement is never overwritten.** No code path rewrites an
  account's layout because the base changed. That part was right and stays.
- **`dm_template_layout_rev` counts corrections, one row per page**, bumped
  inside the same transaction as `saveBaseLayout` with a note saying WHY.
  Bumping it with no change behind it would send every customised account to
  review something that did not happen.
- **`dm_account_layout.base_rev` records which revision an arrangement was
  made against.** Rows written before the column existed were caught up to the
  current revision once, in `ensure()` — an account that has not been left
  behind must not be told it has.
- **`layoutDrift()` computes the difference on every read** and the page shows
  it: what the shared layout has that this page does not, what this page has
  that it no longer does, and which buckets are placed differently. Only an
  account with its own arrangement can be behind; one following the base
  already has every correction by reading them, and telling it otherwise
  would train everybody to dismiss the notice.
- **Three answers, all the account's**: take one bucket of it (`adoptFromBase`,
  which keeps the rest of the page — a correction is usually about one bucket
  and "all or nothing" would make taking it cost an afternoon's work), take all
  of it, or keep ours (`acknowledgeDrift`, which changes no layout). Keeping
  ours is **not a permanent opt-out**: the next correction raises the notice
  again, because silence is the thing this mechanism exists to end.
- `scripts/test-propagation.ts` covers all of it; `test-arrange-ui.ts` proves
  the notice actually appears in a browser and that both buttons are there.

**What propagates, and what does not — the whole contract in one table:**

| Changed in the template | Account on the base | Account with its own layout |
| --- | --- | --- |
| A bucket's NAME, columns, or field list | immediately | **immediately** — definition, not arrangement |
| A field's label, help text, type | immediately | **immediately** |
| A field ADDED to a bucket | immediately | immediately, unless that account picked its own fields for that bucket — then it is in the inventory |
| A bucket's position / width / height | immediately | kept, **and the notice says so**, one click to take |
| A bucket ADDED to the base layout | immediately | offered in the notice and in Add-a-bucket; never imposed |
| A new bucket in the catalogue, not on the base | offered | offered |

`scripts/demo-propagation.ts` prints all six rows against live scratch
accounts and restores the template afterwards. Run it rather than reasoning
about it.

### Fields the template defines, with each account's data its own

`server/dutch-miller/fields.ts`. The registry is still the whole vocabulary
for what CODE provides, and it is still not enough: a partner asking for
"Deal Jacket #" cannot be told to wait for a deploy.

- **The definition is shared, the data is not.** `dm_template_fields` holds one
  definition; `dm_custom_values` is keyed on **(account, page, subject,
  field)** with the account FIRST, so isolation is a property of the schema
  rather than of remembering a WHERE clause. There is no read in that file
  that is not account-scoped.
- **`itemsFor(page)` is the full vocabulary** — code's items then the
  template's, oldest first — and everything that validates a key uses it. A
  key nobody defined is still refused rather than rendered as a gap.
- **A custom key is minted `cf_<slug>_<ts>`** so it can never shadow a
  code-registered key, now or after somebody registers a new one.
- **A custom field is never essential.** Essential means a workflow depends on
  it, and no workflow written before the field existed can.
- **Renaming is free; the KEY never moves.** Answers point at the key, so
  "Deal Jacket #" becoming "Jacket #" does not orphan a year of them.
- **Retire, never delete.** A retired field leaves the vocabulary and stops
  rendering without being taken out of the bucket, and every answer is kept;
  un-retiring brings them all back.
- **SUBJECT is what the answer is about**: a member record's guid on Review
  Existing, the empty string on Account Registration (one registration per
  partner). Add New passes `canWrite={false}` — the record the answer would
  belong to does not exist yet.
- `scripts/test-custom-fields.ts`, including the case that matters: two
  partners asking for the same subject id get their own answers and never
  each other's.

### "New", including on content that has been there for years

`dm_new_marks` (page, item key) plus `new_until` on buckets and custom fields.

- **It is presentation and nothing else** — no access, no validation, no
  ordering changes. It **expires by itself**, because a badge somebody has to
  remember to take down is still on the page in March.
- **It works on EXISTING content**, which is the case actually asked for: a
  field the application registered in 2019 that nobody has ever noticed. The
  marks table is separate from the things it marks precisely so that anything
  with a key on a page can carry one.
- Flagged from the Shared Template page: buckets from the canvas inspector,
  fields (code's and the template's alike) from "Fields on this page".

### The rail is a catalogue, arranged per account

`server/dutch-miller/nav.ts`. Same split as the buckets: a PAGE is code and
lives in the template; which pages an account shows, and whether each sits at
the top of the rail or under something else, is the account's.

- **The catalogue is code, deliberately.** A page is a route, a guard and a
  component, so "create a page" from an account editor could only ever mean a
  blank one — and a blank page in a dealership's rail is worse than no page.
  An account adds a page that already exists; a page that does not exist is
  added by shipping it. The picker says so rather than offering to invent one.
- **One instance per account, enforced by the PRIMARY KEY** on
  `dm_account_nav (account_id, page_key)`. The picker only offers what is
  unused, and that is a convenience: a second tab, a stale page and a retried
  request all walk past a picker. Adding the same page twice, under a different
  parent, or under a different name are all refused — the LABEL is a display
  name and the KEY is what decides duplicates. Two concurrent adds produce one
  winner and the loser is told, never a success that added nothing.
- **`dm_template_nav` is the shared base, resolved at read time.** An account
  with no additions follows a change to it; an account's own additions survive
  one. Account Registration is in the base, which is what puts it on Dutch
  Miller's rail and on every account provisioned after, with no per-account
  migration.
- **A base entry is not an account's to remove.** A dealership without Member
  Signups is not a layout choice, it is an outage with no way back from inside
  the app. Only what the account added comes off.
- **Routes did not move.** `member-signups/review`, `rfid-review`, `vendors` —
  every one is in somebody's bookmarks and in sent email. The rail decides
  where a BUTTON sits; `useRoute` in the shell matches route strings, longest
  first, and is driven by routes rather than by the rail's shape because the
  two are now different questions.
- **Vendors left the user menu and the base rail, and stayed in the
  catalogue.** It spent one release in the account menu, which was wrong for a
  second reason: that menu is where the app is administered and approving a
  company to be paid is work. Records, routes, reviews and audit history are
  untouched, and a partner that genuinely has vendors adds the button back.
- **Add Page exists at BOTH levels, and they are different jobs.** The
  account's picker (`components/add-page.tsx`) puts a button on ONE account.
  **Shared navigation** on the Shared Template page (`components/template-nav.tsx`
  → `addTemplateNav` / `removeTemplateNav`) puts it on the base rail, which
  reaches every account that has not already got that page — because the rail
  is read fresh rather than copied. Adding a page to twelve partners one
  account at a time is how eleven of them end up with it. Taking one off the
  base removes the BUTTON, never the page: its route, records and history are
  untouched, and an account that needs it adds it back. A heading with pages
  still under it is refused rather than orphaning them.
- **The parent-dependency prompt.** A page with a `naturalParent` (Review
  Existing and Add New belong under Member Signups) used to be REFUSED on a
  rail without that heading — naming a button the person cannot see and giving
  them nowhere to go. `navOptions` now reports `needsParent`, the picker says
  "saving will add Member Signups too", and `addNav({ withParent: true })`
  inserts the heading first. It is sent explicitly, never inferred server-side:
  putting a second button on somebody's navigation is not a side effect of
  adding the first, however obvious it looks from here. Removing the last page
  under a heading THIS ACCOUNT added takes the heading with it — an empty
  heading is a button that opens nothing.

### Account Registration

`server/dutch-miller/business.ts`, one row per partner in `dm_business`. The
page is shared; the record never is.

- **Opening it writes nothing and sends nothing.** An account with no record
  gets a usable empty draft — not a row, not an invented example. Reading a
  form and starting a process are different things.
- **A draft saves half-finished; a SUBMISSION is what validates.** Malformed
  values are refused either way, because catching a mistyped address at the
  keyboard beats finding out when the verification link bounces.
- **A failed submission keeps the draft** and lists everything missing at once.
  A submission that threw the form away is how somebody stops trying.
- **The verification belongs to the ADDRESS that was proved.** Changing the
  business email keeps the old verified address on the record and blocks the
  submission on the mismatch. Carrying it over would mean a registration
  approved on a check nobody did — the subtlest failure in this whole feature,
  and the one with its own test.
- **The agreement is recorded by VERSION**, not as a boolean. Accepting a
  version that is not the current one is refused, and a moved-on agreement is
  not an agreement anybody made.
- **Proof of business only when MOJO asks**, per account, off by default. An
  upload control that is always there invites paperwork nobody wanted and then
  has to store it. One live document; a replacement supersedes. The bytes live
  in Postgres, not on a disk the deployment rebuilds, and `documentBytes` takes
  the account id so another partner's id answers exactly as one that never
  existed — that rule matters more here than anywhere else, because the file is
  somebody's business licence.
- **Approving is a judgement, not a grant.** It records that MOJO accepts the
  business details and gives nobody a single extra page. Access is still Users
  & Access. Said on the panel, because "approved" is exactly the word somebody
  reads as "and now they can do more".
- **Naming a primary contact creates no login.** Said on the page, for the same
  reason.
- **The verification link is spent by a POST**, never by the GET that loaded
  the page — mail providers fetch URLs in incoming messages to scan them, which
  is the lesson the dealer invitations learned the hard way within a day of
  shipping. Single use, hashed, replaced when resent.
- **No tax IDs, bank details or card numbers**, deliberately. None is needed to
  say a dealership is who it says it is, and a field that exists gets filled in.
- Its buckets are in the same system as every other page, so an account can
  rearrange them; the required fields are registered essential and so cannot be
  hidden or unticked.
- `scripts/test-nav.ts` and `scripts/test-registration.ts`, plus HTTP coverage
  in `test-isolation.ts` for one account's rail and registration not reaching
  another's.
- **The grant is new, so only administrators hold it** until an account
  administrator ticks `account-registration` on a role. There is no backfill:
  a predecessor grant would be a guess, and inventing access is worse than
  somebody having to grant it.

### An account's own roles, and the people it invites

The shared template owns the BASE roles; an account adds its own on top. Both
are true at once and neither weakens the other.

- **`dm_roles.account_id`** — empty is a shared template role, present in every
  partner, writable only by a platform account administrator. An account id is
  one partner's own, invisible and inapplicable everywhere else.
- **Keys are prefixed with the account** (`acct_x__service-writer`). Keys are
  global because `dm_users.role_key` points straight at one, so two partners
  both calling a role "Service Writer" would collide and the second would
  silently edit the first's. The prefix is invisible in the interface.
- **An account's own role grants PAGES and `rfid_read_only`, nothing more.**
  Administering, deleting and approving vendors stay with the platform. The
  rule this codebase has had since roles existed — somebody who can hand out a
  grant can hand it to themselves — does not stop being true inside a partner.
  `rfid_read_only` is allowed because it RESTRICTS rather than grants.
- **`dmAccessFor(email, accountId)`.** An account-local role carried into
  another account grants nothing there, as if the person held no role at all.
  Without it, somebody assigned to two partners would take one partner's job
  title and its pages into the other. Every guard in `routes.ts` passes
  `req.account?.id`; the platform's own screens pass nothing, which means "not
  in an account".
- **Inviting from inside an account assigns that account**, added to what the
  person already holds rather than replacing it, so re-inviting somebody who
  works for two partners does not take the other away. Without it an invitee
  lands with a role and no partner to use it in, and the step that fixes that
  is the one that gets forgotten.
- **A role has to apply HERE to be handed out.** `/users` refuses a role that
  is neither shared nor this account's — it would give somebody a job title
  that grants nothing, which reads as a broken account.
- Roles & Permissions is no longer account-administrator-only: an account's
  administrator opens it to manage their own. What they may WRITE is decided
  on the page and again on the route, and the widening grants are not even
  rendered for them — a tick-box that would only be rejected is worse than
  none.
- `scripts/test-account-roles.ts`, plus HTTP coverage in `test-isolation.ts`.

### Editing a page in place

`ArrangedPage` in `components/buckets.tsx` is the one entry point: a page
passes its registry-key renderer and gets the live page, the pencil, and the
editor. Four pages use it and none of them knows how any of it works.

- **The editor edits the LIVE page, not a list beside it.** A list of
  dropdowns is easier to build and is the wrong thing: somebody arranging a
  page is deciding how it will look, and a control panel makes them imagine
  the result instead of seeing it.
- **Three control clusters, each in a fixed place so they are learnt once.**
  TOP-RIGHT of a bucket: settings, remove, drag handle, and the two arrows
  that do the same job with a keyboard. TOP-LEFT of a field: remove — the
  opposite corner on purpose, so it can never be mistaken for the bucket's.
  RIGHT-HAND INSPECTOR: width presets, columns, a height slider, the field
  inventory, and the buttons that end the session.
- **Everything is a DRAFT until Save**, which is the only reason Cancel can
  honestly claim to restore what was there.
- **A removed field returns to that bucket's inventory and can be put back.**
  The inventory is the bucket's template fields minus the ones placed in it —
  a field already on the page must never also be offered as something to add,
  because that is the duplicate somebody makes first. Deliberately NOT
  excluded from other buckets on the same page: the brief leaves that open,
  so the narrower rule is the one implemented.
- **Removing a field or a bucket is a layout change.** It deletes no template
  field, no submitted value and no other account's anything.
- **The editor's buttons carry their own accessible names** — "Save this
  page's arrangement", "Cancel arranging", "Restore the shared layout". On Add
  New the panel sits beside a form with its own Cancel and Submit, and two
  controls called Cancel is a trap for anybody reading the page rather than
  looking at it. The smoke test found this as a strict-mode violation, which
  is the same ambiguity a screen reader would have hit.
- **An empty section is always shown inside a bucket**, so a bucket that is
  not full says so and there is somewhere obvious for the next field to go.
- **The size controls must change the bucket ON THE CANVAS.** Width always
  did; height did not — `TALL[...]` was applied to the live page and not to
  the thing being edited, so the slider moved, nothing happened, and the
  change only appeared after saving and leaving. Both are applied in
  `EditableBucket` now, and the inspector prints "4/6 wide · 2 columns ·
  short, scrolls" because a slider with no readout is a control somebody has
  to guess at. The three heights are different KINDS of thing and the panel
  says which: auto fits, short caps and scrolls (shrinks a tall bucket), tall
  is a floor of 24rem (grows a short one, and does nothing to one that is
  already taller — which reads as broken unless the panel has said why).
  `scripts/test-arrange-ui.ts` measures the rendered box before and after.
- **The same canvas arranges the SHARED template** (`components/template-canvas.tsx`,
  from the Shared Template page). Same controls in the same corners, so
  somebody who has arranged one account's page already knows how to use it.
  Two differences, both stated on the panel before the save: moving or
  resizing a bucket changes the BASE LAYOUT (accounts following it get it;
  accounts with their own are told), while putting a field in or taking one
  out changes the BUCKET ITSELF for every partner at once, arrangement or
  not. The palette lists every field the page has — code's and the
  template's — minus the ones the selected bucket already holds.

### Shared administration says so on the page

All five sections say it now — Users & Access, Roles & Permissions, Account
Settings, Security, Email & Notifications. A setting that looks like this
account's and is not is how somebody switches off one partner's reminders and
stops everybody's.

Users & Access and Email & Notifications are platform-wide and now read that
way — "everyone who can reach the platform", "these recipients apply to every
partner account". They were still saying Dutch Miller, which is the kind of
wording that makes somebody switch off one partner's reminders and stop
everybody's.

A signup notification carries the partner's NAME in its subject and its body,
and its review link carries the partner's SLUG (`signupUrl(origin, guid,
slug)`). The settings are shared, so one reviewer's inbox holds every partner's
signups: without the name they are indistinguishable before opening, and
without the slug the link lands in the wrong account, where the record
correctly does not exist and the isolation rules working properly read as a
broken link.

## The member's own contact details

- **`customer_phone` / `customer_email` are the MEMBER's**, not the dealer's —
  `submitted_by` has always been the dealer. Optional (a walk-in at a desk does
  not always hand over both), validated when given, and shown on the record, the
  detailed export and the reviewer's email.
- Phone is stored FORMATTED by `formatPhone()`, so the list, the export and the
  email read the same without three callers agreeing on it. Anything with
  letters in it — an extension, a note — is kept exactly as typed.
- **Bulk columns are positional in the tests.** Adding a column to
  `BULK_COLUMNS` shifts every fixture row in `test-bulk.ts`.

## More than one CSC Reviewer

- `SignupNotify.reviewers` is a LIST. It was one person, on the reasoning that
  "who is reviewing this?" needs a single answer — which holds until that person
  is on holiday. Safe to share because approving is one-way and first-come: a
  second reviewer opening an approved record is told it is done.
- `getSignupNotify()` still reads BOTH older shapes (a flat `recipients` list,
  and a single `reviewer`). Do not drop that — the alternative to reading an old
  setting is silently sending nobody anything.
- A reviewer is never also a notifier, and `checkReviewer` runs per person, so a
  list where only the third cannot approve still says which one.

## Vehicle year, make and model

- **Year is arithmetic**, not a lookup: next year down to 1981 (the first
  17-character VIN). It works with no network, ever.
- **Make and model come from NHTSA vPIC** (`vpic.nhtsa.dot.gov`, free, no key),
  fetched SERVER-side and cached in `dm_vehicle_lookup` for 30 days — a form
  field must not wait on somebody else's website or stop working when it stops.
- **Three softnesses that must stay.** A seed list of makes is bundled so the
  field works behind a firewall; the catalogue adds to it and never replaces it.
  A stale cached list is served when a fetch fails — last year's models beat
  none. And a failed lookup returns empty rather than throwing.
- **Nothing is refused for being off the list.** These are `datalist`
  suggestions on a combo box, not an enumeration: a kit car, a fleet body or
  next spring's model must stay enterable, and every historical record is free
  text. Never turn these into strict selects.
- vPIC is **blocked by the dev container's proxy**, so the offline paths are
  what the tests exercise. Verify the live path on the deployment.

## Sticker placement: inside or outside the glass

- **ONE stored value** (`dm_settings.sticker_placement`, default `inside`) drives
  the RFID Instructions page, the diagram caption, and the wording of the
  confirmation a dealer ticks on a new signup. It is a property of the TAGS —
  an adhesive meant for the inside fails on the outside — not a preference.
- **Never make this copy in two places.** The two would disagree within a month,
  and the person it misleads is standing at a vehicle holding the sticker. Both
  variants live in `PLACEMENT` in `dm-rfid-instructions.tsx`; the one-line
  confirmation comes from `placementLine()` in the same file.
- Served on `/me` so the form and the page never render one wording then swap.
  Admin writes only; readable by anybody who can open the instructions.
- **A missing diagram shows a gap, never the other variant's photograph** — that
  picture shows the opposite of what the page is asking for. Drop an image at
  `public/rfid-sticker-placement-outside.webp` and it appears; nothing else
  needs changing.

## Email delivery

- **`sendOnce` (delivery.ts), not `sendMail`, for anything a person waits on.**
  Bounded retries (3 attempts, growing pause), transient failures only — a refused
  mailbox is not retried, because the answer will not change. Keyed on
  resource + kind + email so a second call cannot send a second copy.
- **Recipients are independent.** One bad address must never stop the reviewer's
  message; `Promise.allSettled` over one send each, never a combined
  `toRecipients`.
- **"Sent" means ACCEPTED BY MICROSOFT.** Delivery, bounces and reads are not
  observable here. Never word anything as though they were.
- **The CSC Reviewer is validated on every settings load**, against whether they
  can actually approve — reported, never refused, so a save cannot silently leave
  the previous reviewer in place.

## View as must show the VIEWED person's scope

- **What is SHOWN follows the viewed person; what is DONE follows the real one.**
  A view exists to answer "what can they see?", so an administrator's own
  buttons under somebody else's name is the view lying about the one thing it is
  for. Display flags go through `shownFor(req)` (reads `req.user`, which the
  middleware has already swapped); write guards keep using
  `req.viewingAs?.real ?? req.user`.
- Safe only because **every non-GET is refused while viewing** — view-as.ts's
  allow-list. Do not loosen that to make something work inside a view.
- Read guards follow the viewed person too: `requirePage`, `requireDmAdmin`,
  `requireApp`, and the app list on `/auth/user`. So a view can land on "this
  account is assigned to nothing", which is useful rather than broken.
- **The exit must survive every one of those.** Stop viewing is driven by
  `viewingAs`, never by `isAdmin` or by holding an app — including on the
  nothing-assigned screen, which replaces the whole shell and so carries its own.

## The sign-in gate belongs to the DEPLOYMENT, not to Emburse

- **The OIDC callback admits anybody who holds ANY app** —
  `appsFor(email, "microsoft").length > 0`, never `isAllowed()` alone.
  `AUTH_ALLOWED` is the EMBURSE list and was the only one when that gate was
  written; checking it by itself refused a Dutch Miller partner at the front
  door of the app they had been given, and told them to ask about a list that
  would never mention them. Never narrow this back to one product's list.
- Each product's own guard still decides the rest: `requireApp` refuses the one
  they do not hold, exactly as before. Widening the door grants no room.
- Signing in is NOT the same as having a Dutch Miller role. Somebody newly let
  through lands on the shell with no pages until a account admin gives them one
  under Users & Access. That is correct, and worth saying out loud when adding
  somebody, because it looks like the fix did not work.

## The manager queue switch (Emburse)

- **`reviewer_imports.manager_enabled`, per reviewer, default ON.** Off skips only
  the team-wide grid (`MANAGER_GRID` = `/transactions/team`) on that person's
  SCHEDULED import. It deliberately does NOT touch their schedule, their other
  lists (Reimbursements keeps running), their automatic approvals, or a run
  started by hand — that narrowness is the whole reason it exists instead of
  people switching `enabled` off and losing all of it.
- Judged on the grid the run would actually open, via `gridPathFor`, not the
  list's default: a reviewer pointed at the personal grid is not reading the
  manager queue and must not be stopped by this.
- **Owner-only, not admin.** `/api/manager-queue` is gated on `requireOwner`
  (pinned `DM_SUPER_ADMINS`, Microsoft door). It is deliberately absent from the
  generic `/reviewer-imports` POST so an administrator cannot flip it. `isOwner`
  on `/auth/user` is what hides the menu item; the route decides again.

## Permissions

- **`DM_GRANTS` is what a role is given; `DM_PAGES` is only the rail's layout.**
  Member Signups is one heading over TWO grants — `member-signups` (Review
  Existing) and `member-signups-add` (Add New) — because enrolling and reviewing
  are different jobs. Guards follow: reads use the first, create/bulk the second.
  The split backfilled Add New onto every role that held the old single grant,
  once, behind a marker row in `dm_settings` so an admin who removes it does not
  find it back after a restart.
- **"Account Administrator" is the name; `role: "super"` is still the stored
  and wire value**, as are `isSuperEmail`, `requireSuperTo` and `superOnly`.
  Renaming those buys nothing a reader can see and would break a cached client
  mid-deploy. `DM_ACCOUNT_ADMINS` is read before `DM_SUPER_ADMINS`, so the
  secret can be renamed whenever it suits and either name keeps working.
- **Deleting is grantable per role** (`dm_roles.deletes_signups` /
  `deletes_rfid`), off by default, set only by a account administrator, and
  **never implied by administering** — that rule has a test and must keep one.
  Both are soft deletes, which is what makes them safe to hand out.
- **RFID Inventory has a view-only mode** (`dm_roles.rfid_read_only`): the page,
  the counts and the search, with no buttons at all. It beats a delete grant and
  beats administering — administering is every PAGE, never a licence to change
  what is on one. The owner is never read-only. Enforced by `requireRfidWrite` on
  every RFID write, not just hidden.
- **Test-only tags** (`dm_rfid.test_only`): a real tag in the pool that the pool
  will never hand out, so no import can spend one, and that only the pinned
  owner can name on a signup (`mayUseTestTags`, judged on the REAL person).
  Marking and un-marking is the owner's alone. Not the same as holding one back:
  held is out of the pool, test is usable by one person on purpose.

- **Page access and action permissions are different questions.** `actions.ts`
  derives what a role can DO from the rules the guards apply; it is read-only in
  the UI on purpose. These are not stored per role, so editable checkboxes would
  broaden access the first time somebody saved one.
- **Approving belongs to the built-in CSC role and the pinned account admin.** The
  account admin inherits it from configuration — which is why approvals work with
  nobody holding CSC. Say that on screen rather than leaving it inferable from the
  code.

- **A view is STARTED from the eye icon on a person's row in Users**, never
  from the header. There is no picker beside the account menu — the row
  already says who they are, what role they hold and how many pages they see,
  and a second list in the header read as part of the signed-in identity. The
  only header control is **Stop viewing** (`dm-stop-viewing.tsx`), which must
  stay: once a view is on, everything below it is the other person's app,
  Users included, so the exit cannot live inside it.
- **The App switcher appears only for somebody holding BOTH products**, and
  is hidden outright while viewing as somebody. `apps` comes from the REAL
  person (a view changes whose data is on screen, never which products you
  hold), so under the viewed person's name it read as a claim about them —
  a dealer's menu offering Emburse. Stop viewing first, then switch.
- **Deleting is a MARK, never a DELETE — account admin only, note required.**
  Both member records (`deleteSignup`) and RFID numbers (`deleteRfids`) set
  `deleted_at` / `deleted_by` / `delete_note` and keep the row; neither issues
  a `DELETE`. A membership or a tag that simply vanished leaves nobody able to
  answer why a vehicle is on the plan or what became of a number, which is the
  question actually asked months later. The note is enforced in the model (≥5
  characters), not by the form, so a direct request cannot skip it. Both lists
  grow a **Deleted** chip, and the three live states still add up to **All** —
  deleted is counted beside them, never inside.
  - **A deleted member's tag stays issued unless explicitly released.** The
    dialog asks; there is no default. Releasing is the only path back to the
    pool, and it is the reason the unique index on `dm_member_signups.rfid` is
    **partial** (`WHERE deleted_at IS NULL`, `dm_member_signups_rfid_live`) —
    an unconditional one would let a deleted row hold a released number
    forever.
  - **A deleted RFID never comes back.** Not by re-uploading the file that
    brought it in (`addRfids` reports it as held-and-removed and adds nothing),
    not through Make active, and not through `useRfid`. A number returning
    quietly could land on a second windscreen while the first still carries the
    sticker.
  - Every delete writes `signup.deleted` / `rfid.deleted` to the audit trail
    with the note and the request's IP.
- Tests: `scripts/test-rfid.ts`, `scripts/test-dm-users.ts`,
  `scripts/test-signups.ts`, `scripts/test-accounts.ts` (partner isolation in
  the model), `scripts/test-blocks.ts` (the template and the per-account
  layouts), `scripts/test-nav.ts` (the rail catalogue and the one-instance
  rule), `scripts/test-registration.ts` (the business record and its review)
  and `scripts/test-isolation.ts` (isolation over HTTP, against a
  real server with a real session cookie — the only level at which a route
  collision or a mis-ordered middleware shows, and the level at which both have
  already bitten) — all need `DATABASE_URL`. The users test SKIPS against a non-empty `dm_users` rather
  than deleting somebody's configuration.

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
- **A NOTE IS NOT EVIDENCE, and a receipt is not only purchases.** Two false
  flags, one shape. The Gas Category rule asked the note alone — contains
  "gas" — and flagged a cleaning supplier's invoice for two foam tires noted
  "Replacing gas powered pressure washer wheels"; the auto-category sweep
  then correctly refused it, because it asks for a witness on the paper too,
  and the two numbers disagreeing was its own unexplainable thing. The fuel
  test now lives in `rules/fuel.ts`, both sides use it, and `receiptFuel`
  lets a rule ask it. Separately, a Shell slip for $81.13 of unleaded was
  flagged for ALCOHOL: printed under "Please come again" were "16OZ MONSTER
  2 FOR $5" and "20OZ COCA COLA 2 FOR $3.75" — in-store ADVERTS, taken as
  purchased lines. The items prompt excluded totals and payment lines and
  said nothing about advertising. "Gas powered", "gas line", "gasket", and a
  forecourt's promo board are all things that look like the answer and are
  not it: ask the receipt and the merchant, never the words around them.
- **An uploaded "receipt" has a KIND, and the rules can ask about it.** Two
  things a reviewer needs that nothing could express: a **lost-receipt
  form** (Missing Receipt Affidavit, declaration, a template the employee
  filled in and signed) and a receipt that **does not say what was bought**
  (a card slip, an order summary reading "1 Item $141.24"). The reader
  already decided `itemised` but only folded it into `receiptReadable`, so
  the second could only be asked as "not readable" — a different sentence
  and a false one about a crisp card slip. The first had no signal at all: a
  form reads cleanly and itemises nothing, so it passed as an unremarkable
  un-itemised upload. `receipt_readings.substitute` and the two rule fields
  `receiptItemised` / `receiptSubstitute` carry them, and both are in
  `UNKNOWN_WHEN_EMPTY` territory by way of `YES_NO`: an unread receipt
  answers NEITHER question. That is the part that matters — read as "no",
  the first rule anybody writes flags the whole queue, because right after
  an import nothing has been read yet.
- **Sign-in is OIDC, and a stale cookie jar poisons it.** Emburse signs in
  through a redirect chain ending at `/login/oidc/assertion?state=…&code=…`.
  An OIDC flow is stateful: the `state` nonce is tied to a cookie set at the
  START of it. We restore a saved jar into a fresh browser before every run,
  so a jar carrying a dead session hands the identity host something it
  cannot reconcile and it answers with its own error page — "Oops! Something
  went wrong … the page is missing or the url has been assembled
  incorrectly" — which has NO FORM ON IT. The run reported "check the
  loginEmail selector against that page" and that sentence cost a day spent
  hunting an Emburse account lockout that did not exist; the account was
  signed in fine in an ordinary browser the whole time. Worse, the state was
  PERMANENT: the jar that caused it is the jar restored next time, so one
  reviewer sat stuck across eight scheduled runs over a full day while the
  other healed on his own, for no reason but which jar happened to be stale.
  `StrandedAtIdentity` now carries it as a type, and `signIn` drops that
  login's jar and retries once from nothing. The jar is a cache and never a
  credential, so the cost of being wrong is one password sign-in.
- **A code nobody can answer still has to reach the app.** `challenge.ts`
  parks a live browser while somebody types six digits, and it is wired up
  only when somebody is watching — a scheduled run is given no prompt hook on
  purpose, because parking a browser for a prompt nobody will see just delays
  the same failure while holding the profile lock. That reasoning is right and
  the consequence was not: the unattended case left **no trace in the app at
  all**. A 5am import hit the verification screen, Emburse mailed a code to
  the reviewer, the run stopped, and the only signal anybody got was an email
  at five in the morning. The import just looked as though it had not run.
  `challenge-log.ts` is the durable half: one open row per login, counted
  rather than repeated, cleared by the next successful sign-in for that login.
  The banner does NOT ask for the mailed code — it expired hours ago and
  asking for it teaches people the banner lies — it starts a fresh sign-in so
  the live prompt can appear. Anything new that signs in unattended inherits
  this through `signIn`, which clears on every success in one place because
  it has four ways of succeeding and clearing at each is how one gets missed.
- **Emburse does not call it Deny — the mock must say what the tenant says.**
  The ⋮ menu item reads "Deny", but the dialog it opens is titled **Return
  Transactions** and its buttons are **CANCEL** and **SEND BACK**. The word
  "Deny" is nowhere on that dialog, so the shipped `denyConfirm` default of
  `button:has-text("Deny")` matched nothing and every manual denial died on
  the final click — nine of them over seven weeks, including $8,255.78, each
  with the reason already typed and read back, each still in Needs Review and
  returning on every import, with the employee never told. Every deny test
  was green throughout, because `mock-emburse.ts` had put a `Deny` button on
  that dialog: **a mock built to agree with our assumption tests the
  assumption, not the tenant.** When a selector default is written, the mock
  gets the tenant's real markup, not ours.
- **A failure keeps the row it matched.** `matched_row` used to be stored only
  on success, and the dialog reads `matchedRow ?? "no row was matched"` — so
  every failure announced that the search had found nothing, including the
  nine above, directly above their own step list confirming employee,
  merchant, amount and date all matched. The headline is read first and it
  sends people to debug the wrong step. A null there means "not recorded",
  never "nothing matched", and the two must never share a sentence.
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

## One person, more than one Emburse account

`server/emburse/connections.ts`. Eric submits expenses in two Emburse
tenants, so a person's login is a LIST now. `emburse_credentials` was widened
in place — `account_key text NOT NULL DEFAULT 'primary'`, primary key
`(user_id, account_key)` — so every row that already exists becomes the
primary connection and every caller asking the old question gets the old
answer, with no migration step.

- **`primary` is a JOB, not a label.** It is the connection the manager queue
  is read with and the one every approval and denial is applied under.
  `credentialForUser`, `credentialForExport` and `hasCredential` are all
  pinned to it. A second connection must NEVER be able to inherit that by
  being newer or by having signed in more recently — this codebase has
  already been bitten once by "most recently proven to work" silently moving
  whose queue the app shows, and Emburse records an approval against
  whichever account signed in, permanently, in the finance system.
- **No fallback between one person's own accounts.** A lane with nothing
  linked is an error with a sentence. `credentialFor(userEmail, accountKey)`
  is the only function that decrypts and it always names its account; there
  is deliberately no variant that takes a person and works out which.
- **A tab is linked by COMPARING EMBURSE ADDRESSES.** `emburse_lanes` holds
  the tab (Manager · Personal Tab - MOJO · Personal Tab - Mammoth) and the
  Emburse login it is defined by; `linkedLanes()` links a stored connection
  to a tab only when the connection's `login_email` IS that address. **The
  app user's own email says nothing about it** — the connection already
  stored signs in as `eric.s@mammothholdings.com` while its owner signs into
  this app as `eric.s@mojocarwash.com`, and believing those agree is how a
  receipt gets attached in the wrong tenant. A tab that matches nothing is
  returned unlinked, with a sentence naming what IS on file.
- **The mapping is seeded as DATA, not written as a constant.** `SEED` in
  `connections.ts` inserts the owner-confirmed rows with `ON CONFLICT DO
  NOTHING`, so a second person with two Emburse accounts is a row rather than
  a code change and an edit survives a redeploy.
- **The same Emburse login twice is refused.** Two rows for one tenant is two
  sealed passwords that can disagree, two sign-in states, and a lane link
  that picks whichever came back first — an intermittent sign-in failure
  nobody could reproduce.
- **A label decides nothing.** Naming a connection "Personal Tab - MOJO" does
  not make it the MOJO tab's; the address does. Tested.
- **A verification code belongs to one connection.** `awaiting_code` is per
  row, set around `waitForCode` in the connection test. There is one browser
  between every connection, so the other account's card must be able to say
  "Mammoth is waiting" rather than offer a code box that would submit six
  digits to the wrong tenant.
- **A connection is managed only by its owner, signed in as themselves.** The
  routes key on `req.user.id`, so there is no id to substitute, and view-as
  is refused outright — somebody looking through another person's eyes must
  not be able to store or delete that person's Emburse password.
- **`noteResult` was being given an email where the query uses `user_id`**, so
  the Emburse-check's result was never recorded: "last signed in
  successfully" stayed blank however many times somebody pressed the button,
  and a password Emburse had rejected was never flagged for re-entry from
  there. Fixed while making the test name its account. If a status on that
  page ever looks stale again, check that call first.
- `scripts/test-connections.ts`.

## Three tabs for one person: the manager queue and two personal accounts

`reviewer_imports` was keyed on the person, which was true until somebody had
a second Emburse account with its own stages, lists, receipt filter,
schedule and history. Widened in place: `lane text NOT NULL DEFAULT
'manager'`, primary key `(user_email, lane)`.

- **Every existing row becomes the MANAGER tab.** Deliberately the
  conservative reading — the manager queue is the thing the brief says must
  not move, and calling an existing row "personal" on the strength of its
  grid path would be guessing about live data.
- **`reviewerImports()` returns one row per (person, tab)**, built from
  `linkedLanesOf()`. A person with one Emburse account still gets exactly one
  tab, so nothing changes for them.
- **A personal tab signs in as ITS OWN Emburse account**, via
  `credentialForLaneOf` in `attemptExport`. Not the primary one and not the
  other personal one: Needs Review is per account, so reading the wrong
  tenant's list files one company's expenses under the other with every step
  green. The manager tab is untouched — still `credentialForUser`, still the
  primary connection — and the run-as guard is skipped for personal tabs
  because their login is decided by the tab, not by `runAs`.
- **A personal tab with nothing linked is OFF.** Leaving it on means a run
  every twenty minutes that can only fail, filling a half-configured tab with
  failures that read like a broken import rather than a missing password.
- **Attempts, slots and history are per tab.** `todaysAttempts` and `nextDue`
  take a lane; `export_runs.lane` records it; each tab gets its own stagger
  slot. Three tabs sharing a day's budget means the first one read spends it
  and the other two never update — the two-reviewers fault, one level along.
  The manager tab passes the EMPTY lane, which is what every run recorded so
  far carries, so its counts are unchanged.
- **Every write names its tab.** `setReviewerImport` takes `lane`; the route
  checks it against that person's own tabs rather than taking it as given, so
  a request naming a tab somebody does not have is refused instead of
  creating a configuration nothing runs and nothing shows.
- **The in-panel grid selector was renamed "Manager queue" / "Personal
  queue".** It said "Manager tab", and so did the new tab above it — one page,
  two different controls, one name. Ambiguous to read and broken for a screen
  reader; the smoke test found it as a strict-mode violation, the same way the
  two Cancel buttons were found.
- `scripts/test-lanes.ts` and `scripts/test-lanes-ui.ts`.

## A personal tab must never touch the team-wide grid

The symptom was one line in a run log: a personal tab reporting "clicked the
team-wide tab" and then exporting `/transactions/team` — the approver's
queue. Two separate causes, and either one alone reproduces it.

- **Look a person's import settings up BY TAB. There is one lookup, and it is
  `importFor(reviewer, lane)`.** `reviewerImports()` returns a row per
  (person, tab), and `attemptExport` had the lookup written twice: lane-aware
  where it picked the PASSWORD, email-only where it picked the LIST. So a
  personal run got the MANAGER row — its grid path, its stages, its receipt
  filter. The manager row stores no path of its own, so `gridPathFor` came
  back undefined and the run fell through to the deployment default, which is
  the team grid. **Never add a second lookup by email alone**; the first row
  for anybody with two tabs is the manager one.
- **The browser reaches for the team view on its own, twice, and has to be
  told not to.** `runAutoExport`/`runSteps` take `personalQueue`, set from
  the lane's kind in `attemptExport`:
  1. the "switch to the team view" step clicks the MANAGER/ADMIN tab before
     anything is opened. The old guard was a path test
     (`!/\/team\b/.test(sel.gridPath)`), which a hand-typed path defeats —
     and the click is not harmless even when the URL corrects it afterwards,
     because Emburse reopens on whichever tab was last used;
  2. a path that fails to load is retried as `"<path>/team"`, the tenant's
     naming scheme for a list's team-wide view. Right for an approver reading
     `/reimbursements`; on a personal tab it answers "your own list did not
     load" by exporting other people's expenses, and says so only in a NOTE
     at the end of a step that PASSED. A nav link into a `/team` view is
     refused for the same reason. A personal tab whose own list does not load
     has nothing to fall back to and should fail.
- **`PERSONAL_GRID = "/transactions"` is a default on the LANE, not an
  inheritance.** Null means inherit, and what a personal tab inherited was
  the shared team grid. `reviewerImports()` resolves it from `lane.kind`, the
  same way it forces `receiptsOnly` to false there.
- **The "Needs Review is off" warning is manager-only.** On a personal tab it
  is backwards — those expenses are the person's own, at whatever stage, and
  the advice sends them to re-tick a filter that removes most of what they
  came for. The personal equivalent is "no stages selected at all".
- **The same applies to every OTHER browser run, not just the import.** A
  write-back and a category correction both signed in to the personal
  account and then searched `settings.selectors.gridPath` — the team-wide
  list. The row is not there, so the edit failed with "not in the queue"
  having signed in and searched; on a tenant where the same merchant and
  amount recur it could instead find a DIFFERENT row and change that one.
  `selectorsForLane(who, lane, base)` in `decision-worker.ts` is the one
  place that scopes them. A non-empty lane gets the personal grid even with
  no import row of its own, because `laneTag` makes the manager queue the
  empty string — so "non-empty" IS "personal". The manager queue gets the
  base object back unchanged, deliberately: it has read the team grid since
  before tabs existed.
- **"Test connection" too, which is the instrument people use to find out
  which of these is happening.** It goes one step past signing in and opens
  the grid — and opened the deployment's team-wide one for every account, so
  testing a PERSONAL connection signed in as that account and then looked
  for the approver's queue. A good connection could come back red with a
  message pointing at the password. The route is handed an `accountKey`
  rather than a tab, so `laneForAccount(userEmail, accountKey)` in
  `connections.ts` converts. **The PRIMARY connection always maps to the
  manager queue**, even where a personal tab is linked to it as well (Eric's
  Mammoth login is both): one connection serving two tabs has no single
  answer, so it keeps the answer it has always had, because scoping the
  primary to a personal grid would stop this testing what every approval
  does. The step now names the list it opened, since "the grid is there" did
  not say which one.
- **A personal tab whose STORED path is the team list is refused before a
  browser opens.** Defaults were not the end of it: `reviewer_imports.
  grid_path` is only defaulted to `PERSONAL_GRID` when it is NULL, so a tab
  where somebody once pressed "Manager queue" (or pasted a team URL) keeps
  `/transactions/team` and every other fix sails straight past it — the
  right login, the team-view step correctly skipped, and then the approver's
  queue opened anyway. **Emburse answers an account that is not an approver
  of that tenant with the nav and an empty main area**, so the run waited out
  its timeout and reported "the grid did not appear … tried the grid selector
  and the item-count line", offering to correct four selectors that were
  perfectly right. `attemptExport` now throws on
  `personalQueue && /\/team\b/.test(chosenPath)`, naming the list, the tab
  setting that fixes it, and the words "this is not a selector problem".
  **Refused, not quietly rewritten**: the Scope row would go on reading
  "Manager queue" while the run read something else, which is a worse lie
  than the one being fixed. The same check catches the case where nothing is
  stored and the path fell through to the source default, because it tests
  the RESOLVED path. Section 10 of `test-lanes.ts`, which asserts no browser
  is opened — the point is milliseconds rather than a 60-second timeout.
- **"Which Emburse lists" shows the path THE TAB will read, not the shared
  one.** `l.path` is the deployment-wide setting for a list, and printing it
  there read "Transactions /transactions/team" on a personal tab whose Scope
  said Personal queue — two controls on one screen contradicting each other,
  with the small-type one looking like the fault. It is not: for the main
  list (the EMPTY source key) `gridPathFor` gives the tab's path precedence,
  and the label now mirrors that, saying "Path from Scope above" when it
  differs. Only a separately-keyed list, Reimbursements, has a page of its
  own that Scope does not move.
- `scripts/test-personal-grid.ts` — the lane-aware lookup, plus a mock run
  per tab asserting the team tab is pressed for the manager and never for a
  personal one (`mock.state().admin`). Section 10 of `test-writeback.ts`
  covers `selectorsForLane`, section 10 of `test-connections.ts`
  `laneForAccount`.

## A remembered device belongs to ONE EMBURSE ACCOUNT

Emburse issues "remember this device" against the account that signed in, so
trust is per Emburse login — which is how `emburse_browser_jars` and the
Chromium profile directory are both keyed (`openBrowser(login.email)`,
`rememberCookies(ctx, login.email)`). **The jar's column is called
`user_email` and holds the LOGIN address, not the app address.** Those were
assumed equal and are not: a mojocarwash.com user holds a
mammothholdings.com login, and one person now holds two at once. Reading
that table with an app address is the single mistake behind all of this.

- **The readout is per tab and names the account.** It used to be
  `cookiesSavedAt(ownLoginEmail(user))` — the person's FIRST credential,
  i.e. the primary connection — on every tab. So a personal tab could read
  "Emburse trusts this browser" about an account that had never been
  trusted, and a run then stopped for a code the page had just said was
  unnecessary. `deviceAccount(reviewer, lane)` in `import/routes.ts`
  resolves the tab's own connection; the route answers
  `device: { loginEmail, label, linked, rememberedAt }`. **`linked` is a
  third state and load-bearing**: a tab with no account attached is
  unconfigured, not untrusted, and the two need different sentences.
- **Adoption is offered BY LOGIN ADDRESS**, from `deviceChoices()`, labelled
  with the tabs that connection serves. The buttons used to list app users
  (`listCredentials().map(c => c.userEmail)`), so the shared jar landed under
  a key no run reads, reported success, and the account was asked for a code
  anyway — it appeared to work for `eric.s@mojocarwash.com`, where the two
  strings coincide, and could never work for `eric.s@mammothholdings.com`.
  The route **validates the address against a stored connection**: the jar
  and the profile directory are both named from this string, so an arbitrary
  one is a silent no-op reported as success. An adoption that carried
  nothing says so (`carried: false`) rather than returning a cheerful tick.
- **The offer stays visible while ANY account still lacks trust.** It was
  hidden once the tab on screen was trusted, which on a three-tab page is
  most of the time — so the offer was invisible to the accounts that needed
  it. An account that already has its own is shown disabled: adopting over
  it would replace live trust with an older jar.
- **`forgetCookies(login)` no longer deletes the shared row.** It did,
  whatever was named, so clearing one tab's stale jar destroyed the
  pre-keying trust every OTHER account was still waiting to adopt — a code
  already given, thrown away by a button that said it was about one account.
  Unnamed still clears everything, which is the "this browser has gone
  strange" answer. The "Forget it" link beside the readout now names that
  tab's account only.
- **`dropLegacyDevice()` / `DELETE /api/export-device/legacy`** retires the
  shared row once every connection has its own, without touching anybody's
  trust — adoption COPIES, so the row outlives being given away.
- **`deviceChoices` is admin-gated on the ROUTE**, not just in the page: it
  names other people's Emburse accounts, and hiding a button is not a
  control.
- **A scheduled run is given no code hook** (`trigger === "scheduled"`), so
  on an account whose profile has never been trusted it fails as "the
  scheduled import is locked out" rather than parking. Trust each account
  once from a manual Test run, which does ask.
- `scripts/test-device-trust.ts` (over HTTP, needs a build) and the new
  sections of `scripts/test-cookie-jars.ts`; section 5c of
  `test-lanes-ui.ts` asserts the rendered line names the tab's own account.


## Two personal queues, and the account an expense came from

- **`expenses.lane` is which Emburse account the row came from**, and the
  manager queue's lane is the **empty string** — which every row already in
  the table has, so nothing is re-identified. `laneTag()` in `connections.ts`
  is the ONE place `"manager"` becomes `""`; everything downstream of
  `attemptExport` deals in tags, never lane keys.
- **The lane is part of the dedupe key**, appended only when non-empty, the
  same trick `occurrence` uses. The same purchase submitted in both tenants
  is two expenses and both must survive; collapsing them loses one silently,
  exactly as the duplicate pair was lost before `occurrence` existed. A
  changed key is a new expense with no decision history, for every row at
  once — hence the empty default, and hence the test that asserts
  `dedupeKey(e) === dedupeKey(e, 0, laneTag(MANAGER_LANE))`.
- **`purgeFinished` scopes by lane** as well as reviewer and source. "Delete
  everything this export no longer carries" is a statement about ONE Needs
  Review list; it was right for one reviewer, then for one list, and now for
  one account.
- **The queue reads one lane, the manager one by default.** `?lane=all`
  exists and is deliberately not the default: a queue that silently mixes two
  companies' expenses is the thing this column prevents, and somebody has to
  ask for it. The lane is in both the server cache key and the React Query
  key, because two queues asking for the same window are asking two
  different questions.
- **The switcher appears only when there is more than one queue**, and each
  button names the Emburse account it reads. The complaint that produced the
  reviewer column was somebody looking at a queue with no way to tell whose
  it was; two companies is that question again.
- **`source_login` records the Emburse address a run signed in as**, for the
  trace. It is never matched on — a login can change and the expenses it
  brought in are still that account's.
- `scripts/test-two-accounts.ts`, and section 6 of `test-lanes-ui.ts`.
- **When a queue test inserts rows late and they do not appear, it is the
  cache, not a bug.** The server caches per (person, lane, window). Insert
  before the first page load, or pass `refresh=1`.

## A rule says which Emburse accounts it judges

`expense_rules.scope jsonb` — a list of lane tags, where `""` is the manager
queue.

- **NULL is manager-only, and that is the whole point.** Every rule written
  before this column existed was written about the manager queue; extending
  them silently to somebody's personal accounts would be a rule nobody wrote,
  acting on expenses nobody meant — with approve and deny among the actions
  available. An empty array is read the same way rather than literally, since
  "judges nothing" is never what somebody meant to save.
- **`""` is a real answer, so the list is never filtered for truthiness.**
  Dropping the empty string would turn a manager rule into one that judges
  nothing while looking saved. Both the route and the store keep it.
- **The day group key includes the lane.** Three MOJO meals and two Mammoth
  meals is not five meals in a day, and a rule scoped to both accounts would
  otherwise fire on each from the other's total. Tested both ways: nothing
  fires on two-and-two, and it does fire once one account alone goes over.
- **A rule does NOT decide in a personal account.** `queueDecision` applies
  under the decider's PRIMARY connection, which is a different tenant —
  approving a personal MOJO expense under the Mammoth login would record it
  in the wrong finance system, permanently. The rule still flags, and the run
  warns, naming the account. The owner has not been asked yet whether
  personal expenses should be decided automatically at all; **ask before
  changing this.**
- **The scope is shown on the rule list, not only in the editor** — "does
  this rule touch my MOJO expenses" is a question about a rule somebody is
  scanning past.
- `scripts/test-rule-scope.ts`.

## A write never lands in the wrong tenant

Two paths reach Emburse with an edit, and both work ONE account's list:

- **A decision** (`queueDecision`) signs in with the decider's PRIMARY
  connection. An expense in their own second tenant is not in that Needs
  Review, so the attempt would either fail after a minute of browsing with an
  error that reads like broken selectors — or, on a tenant where the same
  merchant and amount recur, find a DIFFERENT expense and approve that one.
  **Refused** in `queueDecision`, which is the single place every approval
  passes through: a click, the automation's sweep, and anything that posts a
  dedupe key. Approving is not what a personal tab is for in any case; you
  submit your own expenses.
- **A category correction** (`decision-worker.ts`) now reads the expense's
  lane and signs in with THAT account's connection, refusing with a sentence
  when none is stored. Before accounts existed this could only be the primary
  one.
- The second case is the reason both are refusals rather than "likely to
  fail": a silent wrong-expense edit in a finance system is not recoverable
  by retrying.
- Section 7 of `scripts/test-two-accounts.ts`.

## What a personal tab defaults to, and why it matters

Two defaults were inherited from the shared settings and both were wrong for
a personal tab. Neither failed loudly; they just meant the tab read the wrong
list and then filtered out the only rows worth having.

- **`PERSONAL_GRID` (`/transactions`), not the team grid.** Null means
  "inherit", and the shared default is `/transactions/team` — so the first
  personal tab anybody set up was reading the APPROVER'S queue, which is the
  opposite of what a personal tab is. The lane already knows what it is; it
  should not need telling. The manager tab still inherits, exactly as before.
- **`receiptsOnly` defaults to FALSE on a personal tab.** "Receipts: true" is
  right for the manager queue, where an expense with no receipt is not yet
  worth reviewing, and **exactly backwards** on a personal one: the expenses
  that need a receipt FOUND are the ones with none attached, so the filter
  removes precisely the rows the mailbox search exists to serve. The tab
  would import fine and have nothing to match.
- **Both are said on the page, not silently corrected**, when somebody sets
  them the other way: a personal tab on the team grid, and the receipt filter
  on, each get a line saying what it will do. Somebody may mean it.
- Section 2 of `scripts/test-lanes.ts`.

## Receipts that arrive as email

`server/emburse/receipt-mail.ts`, page under the user menu.

- **READ ONLY, on both sides.** Every Graph call in that file is a GET;
  nothing moves, deletes, marks as read, flags, files or replies to a
  message, and nothing touches Emburse. Somebody's inbox is not this app's to
  tidy.
- **THE MAILBOX IS NOT THE EMBURSE LOGIN AND NOT THE APP LOGIN.** Three
  different concepts, and on this deployment three different addresses: the
  person signs into the app as MOJO, their saved Emburse connection signs in
  as Mammoth, and the mailbox is a third thing. `receipt_mail_settings` holds
  it per person, configured on its own, and the page says so.
- **ACCOUNT IDENTITY COMES FROM THE EXPENSE.** One MOJO mailbox holds
  receipts for both personal accounts; a receipt belongs to an account
  because it matches an expense in it, never because it arrived there. The
  candidate carries the lane of ITS OWN expense, and the evidence carries
  none at all.
- **A candidate is never "confirmed".** Strongest is `strong`, which still
  means a person says yes. Scoring is additive with REASONS as the output
  rather than a by-product — "same amount" alone cannot reach strong, because
  two $12.99 lunches in a month is not a coincidence, it is Tuesday.
  Explicitly handled and tested: refunds (equal and opposite), currency
  mismatch, date offsets (a card posts a day or two later), body-only
  receipts, and an unlabelled total read as the largest figure.
- **Both conflict shapes are shown, neither is resolved.** One receipt wanted
  by several expenses, and one expense with several plausible receipts.
  Choosing one candidate rejects the other candidates FOR THAT EXPENSE only —
  one receipt covering several expenses is real when a purchase was split
  across sites, which this app already handles, so that stays a person's
  call.
- **Graph access reuses the sign-in app's `Mail.Read`**, via `graphToken()`
  exported from `mail.ts`. One token cache, not two.
- `scripts/test-receipt-mail.ts` (reading and scoring, against real message
  text) and `test-receipt-mail-ui.ts`.
- **The owner's decisions, taken 2026-10-27 — do not change these without
  asking again.** Writable on a matched receipt: **the receipt image, Note/
  description, and Category**, and nothing else. **Always ask** — even a
  strong match waits for a click; nothing reaches Emburse unattended. **Never
  submit** — matching and field updates never submit, approve or deny.

## The pipeline, in order — and why the order is the design

Import → search the mailbox → match → **LINK INTO THE APP** → the reader
reads it → fill the fields from what it says → send image and fields back to
the originating account → (next: generate rules from the pattern).

**The step that is easy to skip is the fourth**, and skipping it was the
first thing I got wrong here: it is tempting to take a matched receipt
straight from the mailbox to Emburse, because that is the visible outcome.
Doing that attaches a picture and learns nothing from it.

`server/emburse/receipt-link.ts` puts the bytes in `receipt_blobs` and the
link in `expense_receipts` — the tables the app already uses — so an emailed
receipt is indistinguishable from one that arrived in the export. For free:

- **The reader reads it.** `unreadReceipts` picks up any blob with no current
  reading, so merchant, date, totals and line items come off it on the next
  pass. **That reading is what the field fill is made of**; without it there
  is nothing to fill from but a subject line.
- **The queue shows it**, and the receipt-versus-claim check works on it.
- **The upload stops depending on the mailbox.** Once the bytes are here,
  sending them does not need the message to still exist — and a message filed
  or deleted between matching and sending is the ordinary case.
- **Content-addressed**, so one image across two expenses is a row, not a
  copy, and re-linking is a no-op. A scan finds the same message every time,
  so re-linking is the normal path.

`noteFromReading` prefers the receipt over the email and falls back when the
reader has not got there yet or could not read it. Proposals still in
`proposed` are recomputed on every page read so the better text appears once
the reading lands — **never one a person has already approved**, because
changing the text under an approval means what gets written is not what was
agreed to.

`scripts/test-receipt-link.ts`, and section 9 of `test-writeback.ts`.

## Sending a matched receipt back

`server/emburse/receipt-writeback.ts` (the model) and `attachAndAnnotate` in
`decide.ts` (the browser step, the same road a category correction takes).

- **Only the three fields the owner named** have a code path: the receipt
  image, the description and the category. Widening that is a code change,
  not a setting somebody can wander into.
- **Nothing runs without a click.** `queueWrite` is the only way a proposal
  becomes eligible, and it is reached from a button. A strong match does not
  queue itself; proposing is not sending; nothing is on a timer.
- **Nothing submits, approves or denies.** No path here touches a submit
  control.
- **It writes to THE ACCOUNT THE EXPENSE IS IN**, via `credentialForLaneOf`.
  No fallback to the primary connection — a write to the wrong tenant is not
  a failed attempt, it is an edit to a record that is not this expense. A
  manager-queue expense is refused outright.
- **A retry does not duplicate.** `applied` and `already` are terminal, so a
  second pass cannot re-send a write that landed — and re-proposing does not
  reopen them. The browser step also checks the form for a receipt already on
  it before uploading: **a save that landed just as the step timed out is the
  ordinary case, not the rare one.**
- **A conflict stops the write.** The description is re-read on the form and
  compared against what it said when the change was proposed; if somebody
  edited it in Emburse since, nothing is written and the row goes `stale`.
  This is the one thing a write-back can do that a read never can.
- **The proposed description is dull on purpose** — merchant, date,
  reference, from the evidence already extracted. No invention, and an empty
  one is never proposed: setting a description to "Receipt" overwrites
  something that may have said more.
- **A body-only receipt is rendered to PDF** from the message's own HTML,
  with the network blocked so a tracking pixel cannot tell the sender a
  machine opened it.
- **`editNote` / `editReceipt` / `editReceiptPresent` are GUESSES** until
  somebody has looked at this tenant's edit form. The step refuses and prints
  every control that IS there rather than typing into the wrong box — a guess
  that matches the wrong field writes a receipt total into a cost centre.
  "Look at the edit form" on the Import page answers it without changing
  anything.
- `scripts/test-writeback.ts`. **The browser step is unverified against real
  Emburse** — this container has no tenant.


## What the shell hangs off `isStandalone`

The account switcher, the Live strip's expense count and the reports
loading/error states are all about the EXPENSE QUEUE, and `isStandalone` in
`App.tsx` is the one list that keeps them off pages that are not.

- **"Your Emburse login" belongs on that list and did not.** The switcher
  rendered three buttons named after the three tabs, one greyed out,
  directly above the form that adds an account — which reads exactly like
  the control for choosing which tab you are adding to. It is not: an
  account links itself by its Emburse address and there is nothing to
  choose. The first person to see the page asked how to use them, which is
  the whole evidence needed.
- **A new page under the user menu goes on the list too** unless it is
  genuinely about the queue. Checked by `test-accounts-ui.ts`, which asserts
  the switcher and the expense count are absent and that the page's title
  appears once rather than twice.

## Why a sign-in failed: say the right thing

`credentialsRejected` / `isCredentialFault` / `whyStuck` in `auto-export.ts`
decide the single most-read sentence in the app. Getting one wrong breaks
nothing and sends a person to fix the wrong thing, which is worse, because
they believe it.

- **Match a SHAPE, not a phrase.** It was a list of exact phrases and it did
  not contain the one Emburse uses: the page reads **"Incorrect email address
  and/or password"**, which matches none of "incorrect password", "wrong
  email or password" or "invalid email". A plainly rejected login was
  therefore reported as *"if that looks like Emburse, the loggedIn selector
  is what needs correcting"*, and the password was never flagged for
  re-entry. The rule is now a rejection word, then up to forty characters
  that are not a sentence end, then "password" or "credentials" — the
  sentence boundary is what keeps "Incorrect code. Enter password" out.
- **Say the ADDRESS might be wrong too.** Emburse's own wording is "email
  address and/or password" and it means it: a typo in the address gets the
  same screen. Telling somebody only to re-type the password is the same
  mistake one step along.
- **An SSO hand-off says there may be no password at all.** An account that
  signs in through Microsoft or Okta cannot be driven by a stored email and
  password, and the message says so rather than implying a bad secret.
- **`scripts/test-signin-errors.ts`**, which needs nothing to run. These
  checks used to live in `test-export.ts`, behind a required export PDF
  nobody has to hand — so the test that should have caught this wording had
  not run in a long time. **A test that needs a file nobody has is a test
  that is not run**; pure classification belongs somewhere it always runs.

## Testing your own Emburse connection

- **Per account.** `POST /api/emburse-check` takes an `accountKey` and
  defaults to the primary, which is what a single-login deployment has always
  tested. Each connection card has its own button, because "is it working" is
  a question about one Emburse tenant and the answer for the other says
  nothing about it.
- **It lives on "Your Emburse login", under the user icon** — the page where
  the credential is entered is where "does it work" belongs. It tests the
  signed-in person's own login and nobody else's, so Brian testing it tests
  Brian's. It used to sit on the review queue, which is neither where the
  login is set nor a place a reviewer wants an admin-shaped panel.
