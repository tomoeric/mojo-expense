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

Store the credential in **Power Automate's credential store or Windows
Credential Manager**, never as a literal in the flow.

### 1. Desktop flow — "Emburse · request export"

```
Launch new Microsoft Edge
  └ profile: the persistent one, so the session survives reboots
Go to web page → the Card Transactions tab
If (sign-in form is present)
  └ Populate text field  username / password from the credential store
  └ Press button  Sign in
  └ Wait for web page content  the transactions grid
Apply Advanced Filters
  └ Receipt: True
  └ date range: as per the review window
Click  select-all checkbox
Click  Export → PDF → Export
Wait for web page content  the "export started" confirmation
Close web browser
```

Two notes on the UI steps:

- **Record the selectors, don't hand-write them.** Use the recorder, then open
  each UI element and loosen the selector — drop generated ids and `nth-child`
  positions, keep text and stable attributes. Emburse ships UI changes; a
  selector pinned to a generated class name is the second thing that will break.
- **Export caps at 2,500 transactions.** If a day's filter could exceed that,
  split the date range and expect two files. The importer handles multiple files
  fine — each is deduped on content hash, and rows are deduped on their own key.

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
