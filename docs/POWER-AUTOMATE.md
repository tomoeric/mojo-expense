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

This is the flow that replaces the manual pull. Each line is a real Power
Automate Desktop action, in order; indented lines are what you set on it.

```
Launch new Microsoft Edge
    Launch mode ............ Launch new instance
    Initial URL ............ the Card Transactions tab
    Window state ........... Normal        (Minimized hides real failures)
    Clear cache / cookies .. both OFF      (this is what keeps you signed in)
    → produces the variable  Browser

If web page contains  →  Element, the sign-in form
    Populate text field on web page    the username field
    Populate text field on web page    the password field  (Sensitive variable)
    Press button on web page           Sign in
    Wait for web page content          the transactions grid appears
End

Click link on web page ............... Advanced Filters
Set drop-down list value on web page . Receipt → True
Press button on web page ............. Apply

Wait for web page content ............ the filtered grid has finished loading

Click link on web page ............... the select-all checkbox in the header
Click link on web page ............... Export
Set drop-down list value on web page . file type → PDF
Press button on web page ............. Export

Wait for web page content ............ the "export started" confirmation
Close web browser .................... Browser
```

**The `Wait for web page content` after Apply is not optional.** The grid
re-renders asynchronously; without it the select-all click lands on the
unfiltered list and you export the wrong set. Same story after sign-in.

#### The part only you can do: selectors

Every `Press button` / `Click link` above needs a **UI element**, and those
cannot be written from outside — they have to be captured against the live
Emburse DOM. Use the recorder for the whole click path in one pass, then go back
through the UI elements repository and loosen each selector:

- Delete generated ids and `nth-child(n)` position steps.
- Keep the element's **text** and any stable `data-*` or `aria-*` attribute.
- Where Emburse gives you nothing stable, anchor on the nearest parent that has
  a real name rather than on a chain of divs.

A selector pinned to a generated class name is the thing most likely to break,
and it breaks the week Emburse ships a UI change.

#### What to export each day

**Export the whole open inbox every run, not just yesterday.** It costs a bigger
PDF and nothing else, because the importer is built for it:

- The same bytes twice is a no-op (content hash).
- A row that reappears unchanged is left alone; a row whose note or category was
  edited is **updated**, not duplicated.
- A row that has left the inbox is marked `in_inbox = false`, never deleted.

So a full-inbox export is self-healing: if the flow fails on Tuesday, Wednesday's
run backfills it. A "yesterday only" export turns every missed run into a
permanent hole in the data.

The one limit to respect: **a PDF export caps at 2,500 transactions.** If the
open inbox could exceed that, split into two date ranges and let the flow produce
two files — the importer takes multiple files per day without complaint.

#### Fail loudly

On the `On error` tab of the sign-in, the Apply wait, and the final confirmation
wait: set a couple of retries, then **send mail to the AP inbox** rather than
letting the flow end quietly. An export automation that silently stops is worse
than a manual one, because you stop checking.

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
