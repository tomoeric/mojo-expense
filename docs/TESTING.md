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
logic right", and the one that actually goes wrong — a timezone or a first-run
hour can be perfectly valid and still not be what anybody meant:

```bash
pnpm exec tsx scripts/simulate-schedule.ts
pnpm exec tsx scripts/simulate-schedule.ts --arrives-at 6
```

Prints what the Import page will say, hour by hour, for the current config.
Catches a wrong timezone or a first-run hour nobody is awake for, in a second,
without waiting a day.

---

## Layer 1a — is there a browser on the host?

The first thing to fail on a new deployment, and the one that makes every other
question moot.

`.replit` asks Nix for a `chromium` package, and both the postinstall step and
the app itself look for a host-provided browser before falling back to
Playwright's own download. On Replit that means the browser is the one the
image built, nothing is downloaded, and no path needs configuring.

That indirection exists because Playwright's own build is linked against shared
libraries a Nix host does not carry: it installs cleanly and then refuses to
start, which reads as *"A browser is installed but cannot start"*. A host
browser has no such problem — it was built for the machine it runs on.

Check what will be used:

```bash
node scripts/find-chromium.mjs     # prints the path, or nothing
```

Nothing printed, and a run stops at **start browser** → no host browser was
found and the fallback download did not work either:

```bash
pnpm exec playwright install --only-shell chromium
```

Still failing → set `PLAYWRIGHT_CHROMIUM_PATH` explicitly. It overrides the
search, and is the escape hatch when detection guesses wrong.

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

Do this before anything else touches SharePoint. If the app cannot read the
folder, a perfect export lands in a void.

---

## Layer 3 — does an export import correctly?

Still no automation. You are testing the pipeline the runner will feed.

1. Do the export by hand, exactly as the runner will: ADMIN tab, the configured
   Section chips, Receipts: true, PDF.
2. Drop the PDF into **AI Projects → Shared Documents → Emburse Transactions**.
3. **Sync now**.

Check three things:

- **Reconciled.** The import row says balanced, not check. If it says check, the
  parser and the PDF disagree on the total and the data is not trustworthy yet.
- **The count matches.** Compare against the `N items, $X` line above the grid.
  This is why the runner captures it.
- **Receipts came through.** The stat chips show a receipt count and a storage
  size. Open one from the queue and read the total on it.

Then press **Sync now** again. Nothing should import — the content hash makes a
repeat a no-op. If it imports twice, stop and say so; everything downstream
assumes that guard holds.

---

## Layer 4 — does the runner drive Emburse?

Now the automation, which is this server rather than anything on a laptop.

Everything below except the last two items runs **against a stand-in Emburse**,
with no tenant and no credentials, in about two minutes:

```bash
pnpm exec tsx scripts/test-export.ts <any-export.pdf>
pnpm exec tsx scripts/test-decide.ts
```

`test-export` starts a fake Emburse (`scripts/mock-emburse.ts`), drives the real
runner against it and asserts what actually happened on the server side — which
chips ended up on, whether the receipts filter was applied, whether an export was
requested at all. It proves the machinery. It cannot prove the selectors match
the real Emburse; nothing outside their tenant can.

Then, against the real thing, from **Export settings → Run the export**:

1. Press **Test run**. It does everything up to clicking Export, so it can be
   repeated freely — nothing is produced and nobody is emailed.
2. Read the step list. A failure names the step, quotes what it looked for and
   shows the page it was looking at. Fix that one selector inline and run again.
3. When every step is green, press **Run export now** once and check the import.

### If Emburse asks for a verification code

The test run stops and asks you for it, in the page, with a picture of what
Emburse is showing. Type the code in and the run carries on from where it
stopped.

That should happen **once**, including across deploys. Three things have to hold
for that, and each has failed at least once:

1. The app ticks *remember this device* before submitting the code.
2. The browser keeps a persistent profile (`EMBURSE_PROFILE_DIR`), so the
   trust survives between runs.
3. The cookies are also kept in the database (`emburse_browser_state`), so the
   trust survives a **deploy** — which rebuilds the profile directory.

The run page says which state you are in: *"Emburse trusts this browser —
remembered &lt;when&gt;"*, or that it does not know the browser yet. If you are
asked for a code when it says it is trusted, the jar has gone stale: press
**Forget it** and pass one more code.

If you are asked again right after passing one, the tick did not take — check
the `mfaRemember` selector, because the default matches the first checkbox on
the page and a tenant may put something else there.

Prove the whole chain without a tenant:

```bash
pnpm exec tsx scripts/test-browser-state.ts    # needs DATABASE_URL + a browser
```

It passes a code, wipes the profile directory the way a deploy does, and
requires the next run to sign in with nobody there to ask.

Two things it deliberately will not do:

- **A scheduled run never waits for a code.** There is nobody there to give one,
  and a parked browser holds the profile lock. It fails with the reason instead.
- **Only the person who started the run can answer it.** A parked challenge is a
  half-open session to a finance system; being an administrator is not the same
  as being its owner.

---

## Layer 5 — does it fail the way it should?

Most of these are asserted by `test-export.ts` on every run, which is the point
of the mock — each one was a real bug it caught before a person did.

| Failure | What must happen | Covered by |
| --- | --- | --- |
| A row is ticked, so the dialog is scoped to a selection | Refuse before requesting anything | §3 |
| A section chip is in the wrong state | Corrected, in both directions, by reading it first | §1 |
| A selector matches nothing | Fail at that step — never read absence as "already done" | §5 |
| The password is wrong | Say so, quoting the page — not a shortlist of three possibilities | §6 |
| A second factor is asked for | Named as a code prompt, not as a device check | §6 |
| A device check is asked for | Named as a device check, not as a code prompt | §7 |
| A device trusted once | Stays trusted on the next run | §7 |
| A code is typed in wrong | Asked again, up to three times | §8 |
| A code is accepted | *Remember this device* was ticked, so there is no next code | §8 |
| Somebody else tries to answer the challenge | Refused, and told whose it is | §9 |
| Somebody walks away mid-challenge | The run ends and the browser closes | §10, §11 |

Run them:

```bash
pnpm exec tsx scripts/test-export.ts <any-export.pdf>
```

Two that the mock cannot cover, worth doing once against the real tenant:

### Emburse changed its UI

You cannot cause this, but you can approximate it: **set a selector to something
that will not match** in Export settings and press Test run. It must fail on that
step and show you the page — not carry on to the next one. Put it back.

### A whole day is missed

The self-healing claim, and worth proving once because it is what lets you
tolerate everything above. **Skip a day entirely**, then run normally the next
day. Every transaction from the missed day should appear, because the export is
the full receipted inbox rather than one day's rows.

### The app notices

With no export today and every slot passed, the Import page should show the amber
**MISSED** strip. You do not need to wait for a real failure to see it — set the
first run to a time that has already passed, with one attempt per day, and look.
Put it back afterwards.
