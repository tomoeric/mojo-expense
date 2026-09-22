# Automating the daily Emburse PDF export

The goal: the receipt-bearing PDF export lands in SharePoint every morning
without anyone clicking anything, and MOJO Expense picks it up on its own.

## Why this has to be RPA

Three routes were checked. Only one survives.

| Route | Verdict |
| --- | --- |
| Emburse REST API | **Dead.** The Spend API grants `manage_users`, `manage_tags`, `upload_receipts`. No expense data, no export, receipt *upload* only. |
| Emburse Scheduled Export → SFTP | **Half.** Automates transaction data on a schedule, but Emburse support confirmed (Chi, 15 Sep) receipt images are not a supported SFTP format. The custom CSV carries a receipt yes/no flag, not the image. |
| Cloud flow on the "export is ready" email | **Dead.** Checked the real message: sender `noreply@spend.emburse.com`, subject `Your expense export is ready`, **zero attachments**. The Download button points at `email.spend.emburse.com/c/<token>`, a click-tracker that redirects into the Emburse app — "you can now log in to download your export". A cloud flow has no Emburse session, so it cannot follow it. |

That leaves Power Automate **Desktop** driving the Emburse UI the way a person
does. Everything below assumes that.

## Shape of the automation

The export is **asynchronous** — you request it, then Emburse emails you minutes
later when the file is ready. So the work splits in two:

1. **Request** — sign in, filter, select, Export → PDF.
2. **Collect** — when the ready-email arrives, sign in, open the exports list,
   download the newest file, drop it in SharePoint.

Don't collapse these into one flow with a fixed `Wait 5 minutes`. Export time
scales with the number of receipts; a fixed wait is the thing that will break
first, and it breaks silently (you get yesterday's file).

### Delivery: use the synced folder, not the SharePoint connector

Point OneDrive sync at **AI Projects → Documents → Emburse Transactions** on
the runner machine, and have the desktop flow save the download straight into
that local folder. The sync client does the upload.

This is deliberately simpler than a `Create file` SharePoint action: no second
connector, no 11 MB binary passing through Power Automate, no separate
credential to rotate. If the machine is offline the file queues locally and
uploads when it comes back.

**Name the file with a datestamp** — `emburse-YYYY-MM-DD.pdf`. A constant
filename still works (the app treats a changed eTag as a new file) but you lose
the ability to see at a glance whether a day was missed.

## Build it

### 0. The runner machine

**The runner is a personal laptop**, because the corporate desktop won't allow a
signed-in Edge profile — a managed policy that clears cookies on exit kills the
persistent-session approach outright, and without a session the flow has nothing
to automate.

That trade is the right way round, but it has a consequence worth naming once: a
laptop sleeps, travels, and gets shut. It will miss runs. The whole design below
therefore assumes missed runs are normal rather than exceptional, and makes them
harmless instead of trying to prevent them.

#### Why attended mode actually suits a laptop

The lock-screen problem that ruled out an unattended desktop mostly goes away
here. You are logged into your own laptop during the working day, so an
**attended** flow on a **free** Power Automate licence is a genuine fit — no
Premium, no unattended add-on, no GPO exemption to negotiate.

The cost is that the flow needs the machine awake and you signed in, which is
exactly what the retry design in step 3 is for.

#### What the laptop needs

- [ ] **Power Automate for desktop** installed (ships with Windows 11).
- [ ] **An Edge profile signed into Emburse**, which persists between runs.
      Launch the flow's browser with `Clear cache` and `Clear cookies` both OFF.
- [ ] **OneDrive signed in**, syncing AI Projects → Documents → Emburse
      Transactions. If the laptop is offline the file queues locally and uploads
      when it reconnects, which is one fewer thing to handle.
- [ ] **Emburse reachable** off the corporate network too, since the laptop will
      not always be on it.

#### Expect the browser to steal focus

Attended UI automation clicks real windows. When the flow fires, a browser opens,
works for a minute and closes — on top of whatever you were doing. Schedule it
for a time you are unlikely to be mid-sentence: early morning, or over lunch.

#### The Emburse login for the bot

With a personal laptop and a persistent profile, the simplest thing is to stay
signed in as yourself and let the sign-in branch of the flow be a rare fallback.

Worth knowing what you are accepting: the exports run under your name in
Emburse's audit trail, and a password change or a forced re-auth stops the
automation until you sign in by hand. If that becomes annoying, you have Emburse
admin and can move to a dedicated service account with MFA exempted.

If Emburse sign-in goes through Microsoft SSO with MFA, the fallback branch
cannot work at all — a bot cannot satisfy an MFA prompt. In that case the
persistent profile is not a convenience, it is the only mechanism, and it needs
"remember this device" set.

Hold any password in a flow variable marked **Sensitive** (its value is then
masked in the designer and in run logs). Never type it into an action as a
literal.

### 1. Desktop flow — "Emburse · request export"

The manual path today is:

> login → transactions → advanced filter → receipts = true → apply → export →
> pdf → export

The flow is those steps plus the scaffolding a human does without thinking:
opening the browser, waiting for each page to settle, setting the fields in the
export dialog, and noticing when something went wrong.

Lines marked **`+`** have no equivalent in the manual path.

```
  +   Launch new Microsoft Edge
          Launch mode ............ Launch new instance
          Initial URL ............ the Emburse sign-in page
          Window state ........... Normal    (Minimized hides real failures)
          Clear cache / cookies .. both OFF  (this is what keeps a session alive)
          → produces the variable  Browser

login   If web page contains  →  the sign-in form
          Populate text field on web page .. username
          Populate text field on web page .. password   (Sensitive variable)
          Press button on web page ......... Sign in
  +       Wait for web page content ........ the dashboard has loaded
        End
        └ the If matters: on a run where the session is still good, Emburse
          skips sign-in entirely and these actions would fail

  +   Click link on web page ............... the ADMIN tab
        └ Emburse opens on whichever of ADMIN / PERSONAL you last used, and
          PERSONAL shows only your own expenses — see below

transactions
        Click link on web page ............. left nav → Cards → Transactions
  +     Wait for web page content .......... the grid has rows

advanced filter
        Click link on web page ............. ADVANCED FILTERS
        Set drop-down list value ........... Receipts → true
        Press button on web page ........... APPLY
  +     Wait for web page content .......... the item-count line has updated
  +     Get details of element on web page . the "N items, $X" line → variable

export
        Press button on web page ........... EXPORT  (top right of the grid)
  +     Wait for web page content .......... the Export Expenses dialog is up

  +     For each of the four Section chips to include:
            If web page contains ........... that chip in its UNCHECKED state
                Click link on web page ..... that chip
            End
  +     If web page contains ............... Completed in its CHECKED state
            Click link on web page ......... Completed        (switch it off)
        End
        └ the chips are toggles, so clicking blind turns an already-on section
          OFF; test the state and click only when it needs changing

        Set drop-down list value ........... Select a format → PDF
                                             (the template dropdown greys
                                             itself out — no action needed)
  +     If web page contains ............... the text "all expense(s)"
                                             └ else: rows are selected, bail out
        Press button on web page ........... EXPORT  (in the dialog)
  +     Wait for web page content .......... the "export started" confirmation

  +   Close web browser ...................... Browser
  +   On error (any action above) ............ Send email to the AP inbox
```

#### No row checkboxes — and the dialog tells you which mode you are in

With nothing ticked, the dialog reads *"You will be exporting **all**
expense(s) that are tagged with"* and lists the active **Section(s)** and
**Filter(s)**. It acts on grid state, so no selection is needed.

Tick a row and it changes: the header becomes *"You will be exporting **1**
expense(s)"* and the Section(s) chips disappear entirely, leaving only the
filters. The export is now scoped to that one row.

That second mode is the failure worth guarding against, because it produces a
perfectly valid PDF containing almost nothing. Before clicking EXPORT in the
dialog, assert the text still says **"all expense(s)"** — one `If web page
contains` that costs nothing and catches a stray selection left behind by a
human, a mis-aimed click earlier in the flow, or a row checkbox that Emburse
restored from a remembered session.

#### ADMIN, not PERSONAL

Emburse has **ADMIN** and **PERSONAL** tabs at the top left, and it reopens on
whichever you last used. PERSONAL shows only your own expenses — a flow that
lands there exports a handful of rows, succeeds, and quietly replaces the
company-wide data with one person's.

Click ADMIN explicitly at the start of every run. Never rely on where Emburse
left you.

#### The Section chips, set in the dialog

The export covers the **Section(s)** ticked in the Export Expenses dialog. Four
are wanted, and one is not:

| Section | Include |
| --- | --- |
| Needs Review | yes |
| Needs Manager Review | yes |
| Pending Submission | yes |
| Denied | yes |
| Completed | no |

Widening from one section to four is the difference between 34 rows and 275, so
keep the **2,500-transaction export cap** in view as volume grows.

**The chips are toggles.** Clicking one that is already blue switches it *off*,
so a flow that clicks all four unconditionally lands on the inverse of the
intended state — and it looks like it worked. Guard each with an `If web page
contains` against the chip's *unchecked* appearance and click only when it needs
changing. Capture the checked and unchecked variants as separate UI elements;
they differ by the tick and the fill.

One consequence worth knowing downstream: with these four sections the export is
everything that is not Completed, so the app's `in_inbox` flag comes to mean
"still somewhere in the approval pipeline" rather than "awaiting first review".
Rows drop out when they complete, which is the behaviour you want.

#### Capture the item count

The grid prints a line like **`34 items, $42,249.94`** above the table. Grab it
with `Get details of element on web page` before clicking EXPORT and put it in
the alert email (or a log file next to the PDF).

That one number is the cheapest possible check on the whole pipeline. The
importer already reconciles its parsed total against the total printed on page 1
of the PDF; having Emburse's own on-screen figure as well means a filter that
silently failed to apply shows up as a mismatch instead of as a quiet, plausible,
wrong export.

It also makes the best wait condition after APPLY — wait for that line to change
rather than for a fixed number of seconds.

#### The two waits that actually matter

`Wait for web page content` after **APPLY** and after **Sign in** are not
padding. Both re-render asynchronously, and PAD will fire the next click into a
page that has not caught up — so EXPORT opens against the unfiltered grid and you
get a correct-looking export of the wrong set. Nothing errors; the totals are
just wrong.

#### The template dropdown looks after itself

**Choose a template** sits above **Which format** and defaults to
`Default CSV export`, but choosing PDF greys it out — templates only apply to the
delimited formats (CSV, Pipe Delimited, Semi-Colon Delimited). So there is no
template action in the flow at all.

Order matters, though: set the format **first**. Touching the template selector
before PDF is chosen just adds a step that will be disabled a moment later.

Leave **Export Disabled Expense Tags** unticked unless you know you want it.

#### The part only you can do: selectors

Every `Click link` / `Press button` above needs a **UI element**, and those
cannot be written from outside — they have to be captured against the live
Emburse DOM. Record the whole path in one pass, then loosen each selector:

- Delete generated ids and `nth-child(n)` position steps.
- Keep the element's **text** and any stable `data-*` or `aria-*` attribute.
- Where Emburse gives you nothing stable, anchor on the nearest parent with a
  real name rather than on a chain of divs.

The Section chips and the dialog's EXPORT button deserve particular care: the
grid and the dialog both have a control labelled EXPORT, so a loose text-only
selector can match the wrong one.

#### A note on sign-in

The `If web page contains` branch assumes a username/password form. If your login
goes through Microsoft SSO or prompts for MFA, that branch needs different
handling — a bot cannot satisfy an MFA challenge. Either use an Emburse service
account exempted from MFA (you have admin now), or keep the Edge profile
permanently signed in and let the If branch be a rare fallback.

#### What gets exported

Receipts = true with no date filter, so every run exports the full set for the
chosen sections rather than just yesterday's.

That is the right default, and it is what the importer is built for:

- The same bytes twice is a no-op (content hash).
- A row that reappears unchanged is left alone; a row whose note or category was
  edited is **updated**, not duplicated.
- A row that has left the inbox is marked `in_inbox = false`, never deleted.

So the run is self-healing: if Tuesday fails, Wednesday backfills it. The one
limit to respect is that **a PDF export caps at 2,500 transactions** — past that,
add a date range and let the flow produce two files. The importer takes multiple
files per day without complaint.

#### Fail loudly

Set the `On error` path on sign-in, the APPLY wait and the confirmation wait: a
couple of retries, then **send mail to the AP inbox**, with the captured item
count in the body. An export automation that stops quietly is worse than a manual
one, because you stop checking.

### 2. Desktop flow — "Emburse · collect export"

```
Launch new Microsoft Edge  (same profile)
Go to web page → the Exports / Downloads list
Wait for web page content  the newest row showing status Complete
  └ retry: every 30s, up to 20 times, then fail loudly
Click  Download on the newest row
Wait for file  in the browser's download folder
Rename file  emburse-%CurrentDateTime as yyyy-MM-dd%.pdf
Move file  → the OneDrive-synced Emburse Transactions folder
Close web browser
```

Poll the exports list rather than trusting the email's Download button — the
button is a tracking redirect and lands you in the same list anyway.

### 3. Scheduling, and the three-hour retry

A laptop will be asleep at 05:00. So rather than schedule one daily run and hope,
**run every three hours and make all but the first run a no-op.**

#### Make the flow idempotent first

Both flows start by asking "has today already been done?" and exit immediately if
so. This is what makes a frequent schedule safe.

**Request flow** — first and last actions:

```
  first   Get current date and time  → %Today% formatted yyyy-MM-dd
          Read text from file ........ %LocalAppData%\MojoExpense\requested.txt
          └ one line, "<date> <attempts|done>", e.g. "2026-09-22 1"
          If  the line's date = %Today%
              If  it reads "done"  →  Stop flow   (already requested today)
              If  its count >= 2   →  Stop flow   (today is written off)
          End
          Write text to file ......... "%Today% <count+1>"   (an attempt begins)

   ...the eight-step export path...

   last   Write text to file ......... requested.txt ← "%Today% done"
          └ only after the "export started" confirmation, never before
```

**Collect flow** — the marker is the file itself:

```
  first   If folder contains  emburse-%Today%.pdf   → Stop flow
```

Note which write happens when. The **attempt count** goes up at the start, so a
flow that dies halfway still burns an attempt and cannot loop forever. The
**success** marker is written only after Emburse confirms the export started —
writing that one optimistically would turn a single failed run into a whole day
with no data.

#### Then schedule it every three hours

Two Windows Task Scheduler tasks, each running:

```
"C:\Program Files (x86)\Power Automate Desktop\PAD.Console.Host.exe" "ms-powerautomate:/console/flow/run?workflowName=Emburse - request export"
```

Trigger: daily at 06:00, **repeat every 3 hours for a duration of 3 hours** —
which fires at 06:00 and 09:00, then stops. Two attempts, then the day is left
alone until tomorrow. Collect runs on the same cadence, offset 30 minutes.

Do not lean on the duration arithmetic alone. Have the request flow keep its own
count in the marker file and stop at the cap: Task Scheduler's repeat semantics
are easy to misread, and a miscounted duration that retries all day means eight
export requests and eight emails from Emburse.

Settings tab — these four matter on a laptop:

| Setting | Value | Why |
| --- | --- | --- |
| Run only when user is logged on | **on** | attended UI automation has no session otherwise |
| Run task as soon as possible after a scheduled start is missed | **on** | slept through 06:00 → runs on wake, not three hours later |
| Stop the task if it runs longer than | 30 minutes | a flow wedged on a changed selector should not block the next attempt |
| Stop if the computer switches to battery power | **off** | otherwise unplugging mid-run kills it |

Leave *Start only if the computer is on AC power* unchecked too, or a laptop on
battery never runs at all.

#### What this gets you

- Laptop asleep at 06:00 → first attempt on wake, or at 09:00.
- Emburse down, or a selector broke → one more attempt three hours later, then
  the day is left alone rather than hammering a service that is clearly unwell.
- Already succeeded → every later run exits in under a second, and Emburse gets
  exactly one export request per day rather than eight.
- Whole day missed → tomorrow backfills it, because the export is the full
  receipted inbox rather than one day's rows.

The last point is the important one. The retry loop covers a bad morning; the
full-inbox export covers a bad week.

#### If you later want it properly hands-off

Power Automate Premium (~$15/user/month) lets a cloud flow trigger the desktop
flow, including on **When a new email arrives (V3)** filtered to
`noreply@spend.emburse.com` / `Your expense export is ready`. Collect then fires
when the export is genuinely ready instead of on a three-hour guess. Worth
revisiting once the free version has proved the click path is stable — not
before.

### 4. Make it fail loudly

An RPA flow that breaks quietly is worse than no automation — you stop checking
and the data silently goes stale. On the `On error` path of both flows, send
mail to the AP inbox. Then add a floor: a scheduled cloud flow (or a calendar
reminder) that checks the Emburse Transactions folder has a file newer than 36
hours, and shouts if it doesn't.

## What MOJO Expense does with the file

Already built, nothing to configure beyond one permission:

- Polls the folder every `SHAREPOINT_POLL_MINUTES` (default 60) **and** whenever
  someone loads the queue or the Import page. The second path matters: this Repl
  deploys to Replit **autoscale**, which stops the container when no requests
  arrive, so overnight there is no process alive to fire a timer. If the export
  must be in the database before anyone asks for it, the deployment needs to be
  a Reserved VM that stays awake.
- Skips files already seen, by SharePoint item id + eTag — a replaced file
  counts as new.
- Content-hashes the PDF, so re-importing the same bytes is a no-op.
- Parses rows, dedupes on employee + date + merchant + amount + category +
  location + department, updates rows that changed, and marks rows absent from
  the file `in_inbox = false` rather than deleting them.
- Reconciles the parsed total against the total printed on page 1 and records
  the import as balanced or needing a check.

It also shows where the schedule has got to, on the Import page: whether today's
export has arrived, and when the next attempt is due. That strip is derived from
the agreed schedule and the last arrival — the server cannot see the laptop, so
it reports what turned up rather than what the flow claims. Keep `EXPORT_*` in
`.env` in step with the Task Scheduler trigger, or the app will be the one that
is wrong.

`pnpm exec tsx scripts/verify-schedule.ts` checks the boundaries you cannot
reach by running the app today — the grace window expiring, a day being written
off, and both US DST switches.

The target folder is already the built-in default in `server/env.ts`:

| Setting | Value |
| --- | --- |
| `SHAREPOINT_DRIVE_ID` | `b!VegnEte7u0m9UoLreL1k7gzPwGK6nyJEhvVReyQS-aNV3-A-6WbnQamyPpjTyWnK` |
| `SHAREPOINT_FOLDER_ID` | `01AKEC4WI273BYVMAHNZAJEEVRTHS5DFSA` |

Site: `https://mammothholdingsllc.sharepoint.com/sites/AIProjects` →
Shared Documents → Emburse Transactions.

**The one outstanding prerequisite:** the Entra app registration needs the
**application** permission `Sites.Read.All` (or `Sites.Selected` scoped to the
AI Projects site) with admin consent. The delegated scopes used for sign-in are
not enough — without it the sync returns 403 on every poll.
