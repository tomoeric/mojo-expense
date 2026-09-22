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

### 0. Prerequisites

- An **always-on Windows machine**. A laptop that sleeps is not a runner.
- **Power Automate for desktop** installed (ships with Windows 11).
- **OneDrive** on that machine, syncing the Emburse Transactions folder.
- An **Emburse login the bot can use**. Two options:
  - A dedicated Emburse service account with a password and MFA exempted — you
    now have Emburse admin, so this is available. Preferred: a human changing
    their own password doesn't break the automation.
  - A persistent Edge/Chrome profile kept signed in as a real user. Works, but
    any forced re-auth stops the flow until someone logs in again.

Hold the password in a flow variable marked **Sensitive** (its value is then
masked in the designer and in run logs), or pull it from **Azure Key Vault** if
you have the connector. Never type it into an action as a literal.

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

transactions
        Click link on web page ............. left nav → Cards → Transactions
  +     Wait for web page content .......... the grid has rows
  +     Click link on web page ............. the Section chip you export from
                                             (Needs Review / Needs Manager
                                             Review / …) — see below

advanced filter
        Click link on web page ............. ADVANCED FILTERS
        Set drop-down list value ........... Receipts → true
        Press button on web page ........... APPLY
  +     Wait for web page content .......... the item-count line has updated
  +     Get details of element on web page . the "N items, $X" line → variable

export
        Press button on web page ........... EXPORT  (top right of the grid)
  +     Wait for web page content .......... the Export Expenses dialog is up
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

#### The Section chips decide what you get

This is the part worth getting right, because it is silent when it is wrong.

The Transactions grid has section tabs — **Needs Review**, Needs Manager Review,
Pending Submission, Denied, Completed — and the export inherits whichever are
active. The dialog echoes them back as chips, and they are editable there too.
So there are two places the section can be set, and they have to agree with what
you actually want in the review console.

Decide this deliberately rather than inheriting whatever tab was last open:

- **Needs Review alone** is the reviewer's working set — the queue MOJO Expense
  exists to work through.
- Adding the other sections gives history, and lets the app watch things move
  out of the inbox rather than simply vanish.

Whichever you choose, set it explicitly in the flow. Emburse remembers the last
tab, so a flow that relies on the default exports whatever a human left behind.

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

### 3. Scheduling

**Option A — no extra licence.** Windows Task Scheduler runs each flow:

```
"C:\Program Files (x86)\Power Automate Desktop\PAD.Console.Host.exe" "ms-powerautomate:/console/flow/run?workflowName=Emburse - request export"
```

Request at 05:00, collect at 05:20. This works and costs nothing, but it is not
a documented Microsoft interface — treat it as something to re-verify after a
Power Automate update.

**Option B — supported, needs Power Automate Premium** (~$15/user/month, plus
the unattended add-on if nobody is logged in on the runner):

- Cloud flow on a daily **Recurrence** → *Run a flow built with Power Automate
  for desktop* → "request export".
- Cloud flow on **When a new email arrives (V3)**, filtered to
  `noreply@spend.emburse.com` with subject `Your expense export is ready` →
  *Run a flow built with Power Automate for desktop* → "collect export".

Option B is genuinely better: the collect step fires when the export is actually
ready instead of 20 minutes later and hoping. If the licence is affordable, take
it.

### 4. Make it fail loudly

An RPA flow that breaks quietly is worse than no automation — you stop checking
and the data silently goes stale. On the `On error` path of both flows, send
mail to the AP inbox. Then add a floor: a scheduled cloud flow (or a calendar
reminder) that checks the Emburse Transactions folder has a file newer than 36
hours, and shouts if it doesn't.

## What MOJO Expense does with the file

Already built, nothing to configure beyond one permission:

- Polls the folder every `SHAREPOINT_POLL_MINUTES` (default 60).
- Skips files already seen, by SharePoint item id + eTag — a replaced file
  counts as new.
- Content-hashes the PDF, so re-importing the same bytes is a no-op.
- Parses rows, dedupes on employee + date + merchant + amount + category +
  location + department, updates rows that changed, and marks rows absent from
  the file `in_inbox = false` rather than deleting them.
- Reconciles the parsed total against the total printed on page 1 and records
  the import as balanced or needing a check.

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
