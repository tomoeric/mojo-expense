# Testing the automation

Four layers, innermost first. Each one is worth getting green before moving out,
because a failure at layer 4 is hard to attribute if layers 1–3 were never
checked.

The failure paths in layer 5 are the ones people skip. They are also the whole
point: an automation that works when everything goes right is not an automation,
it is a demo.

---

## Layer 1 — the parser and the schedule, with no network

Runs anywhere, including here. No credentials, no Emburse, no SharePoint.

```bash
pnpm exec tsx scripts/verify-schedule.ts     # 26 boundary cases
pnpm exec tsx scripts/verify-import.ts <export.pdf>
```

`verify-import` reparses a real export and reports reconciliation and
idempotency: whether the parsed total matches the total printed on page 1, and
whether importing the same file twice changes anything.

**Is the schedule configured the way you think?** Different question from "is the
logic right", and the one that actually goes wrong, because `EXPORT_*` has to
agree with a Task Scheduler trigger on a laptop and nothing enforces that:

```bash
pnpm exec tsx scripts/simulate-schedule.ts
pnpm exec tsx scripts/simulate-schedule.ts --arrives-at 6
```

Prints what the Import page will say, hour by hour, for the current config.
Catches a wrong timezone or a first-run hour nobody is awake for, in a second,
without waiting a day.

---

## Layer 2 — can the app reach SharePoint?

The single check on whether `Sites.Read.All` actually took.

1. Deploy, sign in, open **Import**.
2. Press **Sync now**.

| Result | Meaning |
| --- | --- |
| "Checked N files — nothing new" | Graph works. Done. |
| 403 with the Sites.Read.All message | Consent did not stick. Application permission, not delegated, and admin consent granted. |
| 404 | `SHAREPOINT_DRIVE_ID` / `SHAREPOINT_FOLDER_ID` are wrong. |
| "SharePoint sync is not configured" | One of the `AZURE_*` secrets is missing on the deployment. |

Do this before touching Power Automate. If the app cannot read the folder, a
perfect flow delivers into a void.

---

## Layer 3 — does an export import correctly?

Still no automation. You are testing the pipeline the flow will feed.

1. Do the export by hand, exactly as the flow will: ADMIN tab, four Section
   chips, Receipts: true, PDF.
2. Drop the PDF into **AI Projects → Shared Documents → Emburse Transactions**.
3. **Sync now**.

Check three things:

- **Reconciled.** The import row says balanced, not check. If it says check, the
  parser and the PDF disagree on the total and the data is not trustworthy yet.
- **The count matches.** Compare against the `N items, $X` line you captured from
  the grid. This is why the flow captures it.
- **Receipts came through.** The stat chips show a receipt count and a storage
  size. Open one from the queue and read the total on it.

Then press **Sync now** again. Nothing should import — the content hash makes a
repeat a no-op. If it imports twice, stop and say so; everything downstream
assumes that guard holds.

---

## Layer 4 — does the flow drive Emburse?

Now the automation. Run it from the Power Automate Desktop designer with **Run**,
not from Task Scheduler, so you can watch it and stop it.

**Run it once with the browser visible.** Do not minimise the window to make it
tidy — you are watching for the flow clicking before a page has settled, which is
the failure that produces a correct-looking export of the wrong rows.

Then check, in this order:

1. It landed on **ADMIN**, not PERSONAL.
2. The grid's item count after APPLY matches what you get filtering by hand.
3. The dialog shows **four** blue Section chips and Completed grey.
4. The dialog header says **"all expense(s)"**, not "N expense(s)".
5. Format is PDF and the template dropdown is greyed out.

**Run it a second time immediately.** It should stop within a second — today is
already done. If it exports again, the marker file logic is wrong and you will
get a pile of duplicate exports and emails.

---

## Layer 5 — does it fail the way it should?

Each of these is a deliberate break. Do them once, before trusting the thing
overnight.

### The flow exports the wrong scope

**Tick one row in the grid, then run.** The dialog will say "1 expense(s)" and the
flow must **bail out**, not export. This is the failure that produces a valid PDF
containing nothing, which the importer would accept without complaint.

### A section chip is in the wrong state

**Manually toggle Completed on, then run.** The flow must switch it back off. Then
**toggle a wanted chip off** and run — it must switch that one on. If the flow
clicks chips unconditionally, one of these two runs ends up inverted and still
looks successful.

### The session has expired

**Sign out of Emburse in the flow's Edge profile, then run.** Either the sign-in
branch handles it, or the flow fails and mails you. What must not happen is the
flow clicking happily through a login page and "succeeding".

### Emburse changed its UI

You cannot cause this, but you can approximate it: **rename a UI element's
selector to something that will not match** and run. The flow should fail on that
action and mail you, not carry on to the next step.

### The retry cap holds

**Break the flow deliberately** (a bad selector), then let Task Scheduler run it.
Expect exactly two attempts, three hours apart, then nothing until tomorrow.
Check the marker file reads `<today> 2`. A flow that keeps retrying all day means
the duration arithmetic is wrong and Emburse gets eight export requests.

### The laptop was asleep

**Close the lid over a scheduled slot.** On wake, Task Scheduler's *run as soon as
possible after a missed start* should fire it. If nothing happens, that setting
is not on.

### A whole day is missed

The self-healing claim, and worth proving once because it is what lets you
tolerate everything above. **Skip a day entirely**, then run normally the next
day. Every transaction from the missed day should appear, because the export is
the full receipted inbox rather than one day's rows.

### The app notices

With no export today and both slots passed, the Import page should show the amber
**MISSED** strip. You do not need to wait for a real failure to see it — point
`EXPORT_FIRST_RUN` at a time that has already passed, restart, and look:

```
EXPORT_FIRST_RUN=00:01
EXPORT_ATTEMPTS_PER_DAY=1
```

Put it back afterwards.

---

## What is not covered

- **Graph app-only auth has never been exercised against the live tenant** from
  here — layer 2 is the first real test of it.
- **The schedule strip's rendering** is typechecked and its logic is unit-tested,
  but it has not been looked at in a browser with real data.
- **The collect half of the automation** (fetching the finished PDF out of
  Emburse) is documented but not built. Until it is, layer 3 is manual: you move
  the file into SharePoint yourself.
