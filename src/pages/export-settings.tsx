import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, ShieldAlert, Check, AlertTriangle } from "lucide-react";
import { ExportRunner } from "@/components/export-runner";
import { useAuth } from "@/lib/api";

type Schedule = {
  timezone: string;
  firstRun: string;
  retryHours: number;
  attemptsPerDay: number;
  graceMinutes: number;
  allDay: boolean;
};

type ImportSource = { key: string; label: string; path: string; enabled: boolean };

type Settings = {
  sections: string[];
  sources: ImportSource[];
  selectors: Record<string, string>;
  selectorHelp: Record<string, string>;
  stepSelectors: Record<string, string[]>;
  defaultSelectors: Record<string, string>;
  receiptsOnly: boolean;
  schedule: Schedule;
  updatedAt: string | null;
  updatedBy: string | null;
  allSections: string[];
};

type Reviewer = {
  userEmail: string;
  enabled: boolean;
  gridPath: string | null;
  gridSection: string | null;
  gridQuery: string | null;
  sections: string[] | null;
  receiptsOnly: boolean | null;
  sources: string[] | null;
  autoApprove: boolean;
  autoApprovePerRun: number | null;
  shared: boolean;
  schedule: Schedule;
  runAs: string | null;
  staggeredBy: number;
};

/** Zones the export schedule is plausibly set in. */
const ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC",
];

/** The two lists an approver reads, by the path Emburse uses for each. */
const TABS = [
  { path: "/transactions/team", label: "Manager", why: "Expenses waiting on them to approve." },
  { path: "/transactions", label: "Personal", why: "Their own expenses, which they submit rather than approve." },
];

/**
 * One import per person, and nothing shared between them.
 *
 * The page used to be a column of deployment-wide settings — stages,
 * receipts, lists, one schedule — with the per-reviewer rows underneath as
 * an afterthought. Every real question asked of it ("what will Brian's
 * import pull?") was answered by reading five controls, three of which were
 * everybody's and looked like his. Unticking a stage while reading his tab
 * changed Eric's import too.
 *
 * So: a tab per person, and inside it only what makes up THEIR import —
 * who they are, what it reads, when it runs, the buttons to try it, and the
 * browser doing it. Shared defaults still exist, because a deployment needs
 * them, but they are folded away at the bottom where nobody mistakes them
 * for one person's settings.
 */
export function ExportSettingsPage({ isAdmin }: { isAdmin: boolean }) {
  const auth = useAuth();
  const viewingAs = auth.data?.viewingAs?.viewed ?? null;
  const qc = useQueryClient();
  const [forWhom, setForWhom] = useState<string | null>(null);
  const [error, setError] = useState("");

  const settings = useQuery({
    queryKey: ["export-settings"],
    queryFn: async () => {
      const res = await fetch("/api/export-settings");
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      return (await res.json()) as Settings;
    },
  });

  const people = useQuery({
    queryKey: ["reviewer-imports"],
    queryFn: async () => {
      const res = await fetch("/api/reviewer-imports");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()) as { reviewers: Reviewer[] };
    },
    enabled: isAdmin,
  });

  if (settings.isLoading) {
    return <Loader2 className="mx-auto mt-10 h-6 w-6 animate-spin text-muted-foreground" />;
  }
  if (settings.error) {
    return (
      <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm">
        {(settings.error as Error).message}
      </p>
    );
  }

  const rows = (people.data?.reviewers ?? []).filter((r) => r.userEmail);
  // Yours, not whoever sorts first. Opening on somebody else's tab is how a
  // setting gets changed for the wrong person by somebody who never looked.
  const want = (forWhom ?? viewingAs ?? auth.data?.user?.email ?? "").toLowerCase();
  const current = rows.find((r) => r.userEmail.toLowerCase() === want) ?? rows[0] ?? null;

  async function post(body: Record<string, unknown>) {
    setError("");
    const res = await fetch("/api/reviewer-imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? "Could not save.");
    await qc.invalidateQueries({ queryKey: ["reviewer-imports"] });
  }

  return (
    <div className="max-w-2xl space-y-5">
      {!isAdmin && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          You can see this but not change it. Ask an administrator.
        </p>
      )}

      {isAdmin && people.isLoading && (
        <p className="text-sm text-muted-foreground">Loading the reviewers…</p>
      )}

      {isAdmin && !people.isLoading && rows.length === 0 && (
        <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          Nobody has stored an Emburse login yet, so there is no import to configure. A reviewer
          appears here once their login is saved under <strong>Your Emburse login</strong>.
        </p>
      )}

      {/* A tab per person, at the top, and everything below it is theirs.
          Nothing on this page is shared between two tabs. */}
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-border">
          {rows.map((r) => (
            <button
              key={r.userEmail}
              type="button"
              onClick={() => setForWhom(r.userEmail)}
              className={`-mb-px rounded-t-lg border-b-2 px-3 py-1.5 text-sm font-semibold ${
                r.userEmail === current?.userEmail
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.userEmail}
            </button>
          ))}
        </div>
      )}

      {/* One browser runs these one at a time, so two people due in the same
          minute means the second waits out the first and can lose its own
          window. Said once, above the tabs, because it is the one fact about
          an import that is not contained in its own tab. */}
      {rows.length > 1
        && new Set(rows.map((r) => r.schedule.firstRun)).size < rows.length && (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
          Two of these start at the same minute (
          {rows.map((r) => `${r.userEmail} ${r.schedule.firstRun}`).join(" · ")}). One browser runs
          them in turn, so the second waits out the first. Give one of them a different first run.
        </p>
      )}

      {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">{error}</p>}

      {current && (
        <ReviewerPanel
          key={current.userEmail}
          row={current}
          isAdmin={isAdmin}
          everyone={rows.map((r) => r.userEmail)}
          allSections={settings.data?.allSections ?? []}
          sharedSections={settings.data?.sections ?? []}
          sharedReceiptsOnly={settings.data?.receiptsOnly ?? true}
          lists={settings.data?.sources ?? []}
          selectors={settings.data?.selectors ?? {}}
          help={settings.data?.selectorHelp ?? {}}
          stepSelectors={settings.data?.stepSelectors ?? {}}
          defaults={settings.data?.defaultSelectors ?? {}}
          onPost={(body) => void post({ email: current.userEmail, ...body })}
        />
      )}

      {/* Everything that is genuinely the deployment's rather than one
          person's, folded away. It is still here — a tenant that keeps its
          lists somewhere else needs it — but it is not mixed in with
          somebody's import any more. */}
      {isAdmin && settings.data && <SharedDefaults data={settings.data} viewingAs={viewingAs} />}
    </div>
  );
}

/**
 * One person's import, start to finish, and nothing else.
 *
 * Who · what it reads · when · try it · watch it. In that order, because
 * that is the order somebody sets one up in and the order they debug one in.
 */
function ReviewerPanel({
  row, isAdmin, everyone, allSections, sharedSections, sharedReceiptsOnly, lists,
  selectors, help, stepSelectors, defaults, onPost,
}: {
  row: Reviewer;
  isAdmin: boolean;
  everyone: string[];
  allSections: string[];
  sharedSections: string[];
  sharedReceiptsOnly: boolean;
  lists: ImportSource[];
  selectors: Record<string, string>;
  help: Record<string, string>;
  stepSelectors: Record<string, string[]>;
  defaults: Record<string, string>;
  onPost: (body: Record<string, unknown>) => void;
}) {
  const qc = useQueryClient();
  const [href, setHref] = useState("");
  const [urlError, setUrlError] = useState("");

  const path = row.gridPath ?? TABS[0]!.path;
  // What this import covers today: their own stages where they have them,
  // otherwise the deployment default they inherited.
  const stages = row.sections?.length ? row.sections : sharedSections;
  const receipts = row.receiptsOnly ?? sharedReceiptsOnly;
  // Which Emburse lists this person imports. Theirs where they have chosen,
  // otherwise whichever are switched on in the defaults.
  const mineLists = row.sources ?? lists.filter((l) => l.enabled).map((l) => l.key);
  const reads = row.runAs ?? row.userEmail;
  const borrowed = Boolean(row.runAs && row.runAs !== row.userEmail);

  /** Take the filters out of a URL copied from Emburse's address bar. */
  function pasteUrl(text: string) {
    let u: URL;
    try {
      u = new URL(text.trim());
    } catch {
      setUrlError("That does not look like a URL. Copy the whole address from Emburse.");
      return;
    }
    setUrlError("");
    const keep = new URLSearchParams();
    let section = "";
    for (const [k, val] of u.searchParams) {
      if (k === "filters[section]") { section = val; continue; }
      // The search box belongs to whoever typed in it and the receipts
      // setting is the app's own — a pasted URL must not flip either.
      if (k === "filters[query]" || k === "filters[receipt]") continue;
      keep.append(k, val);
    }
    onPost({ gridPath: u.pathname, gridSection: section, gridQuery: keep.toString() });
  }

  return (
    <div className="space-y-6">
      {/* WHO. One line, so the answer to "whose import am I looking at" is
          never inferred from a tab somebody scrolled past. */}
      <div>
        <h2 className="text-lg font-bold">{row.userEmail}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {borrowed
            ? <>Signs into Emburse as <strong>{reads}</strong> and files what it finds as{" "}
               {row.userEmail}&rsquo;s.</>
            : <>Signs into Emburse as themselves and imports their own queue. Their expenses and
               their decisions are theirs alone — no other tab on this page touches them.</>}
        </p>
        {borrowed && !row.gridQuery && (
          <p className="mt-2 rounded-lg bg-red-500/10 p-3 text-sm">
            <strong>This reads the wrong queue.</strong> It signs in as {reads} with no filter, so
            what it finds is <em>{reads}&rsquo;s</em> — and it would be filed as{" "}
            {row.userEmail}&rsquo;s. Put the login back to themselves under Advanced, or paste a
            URL that picks their rows out.
          </p>
        )}
      </div>

      {/* SCOPE. Which Emburse tab, and which stages off it. */}
      <section>
        <h3 className="text-sm font-bold">Scope — what this import pulls</h3>

        <div className="mt-2 flex flex-wrap gap-1 rounded-lg bg-muted p-1">
          {TABS.map((t) => (
            <button
              key={t.path}
              type="button"
              disabled={!isAdmin}
              onClick={() => onPost({ gridPath: t.path })}
              className={`rounded-md px-3 py-1 text-sm font-semibold disabled:opacity-50 ${
                path === t.path ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              {t.label} tab
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {TABS.find((t) => t.path === path)?.why ?? path}
        </p>

        <div className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
          {allSections.map((name) => {
            const on = stages.includes(name);
            return (
              <label
                key={name}
                className={`flex cursor-pointer items-center gap-3 p-2.5 text-sm hover:bg-muted ${
                  isAdmin ? "" : "cursor-not-allowed opacity-70"
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!isAdmin}
                  onChange={() =>
                    onPost({
                      sections: on ? stages.filter((s) => s !== name) : [...stages, name],
                    })}
                  className="h-4 w-4 shrink-0 accent-sky-600"
                />
                <span className="font-semibold">{name}</span>
              </label>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {row.sections?.length ? "Theirs." : "Inherited from the defaults below until you change one — then it is theirs."}
          {" "}Saved as you tick.
        </p>

        {/* WHICH Emburse list, before which stages off it. Transactions and
            Reimbursements are separate pages with separate queues — each
            keeps its own rows and its own timeline, so turning one on
            cannot disturb the other. */}
        <div className="mt-3 rounded-xl border border-border p-3">
          <p className="text-sm font-semibold">Which Emburse lists</p>
          <div className="mt-2 space-y-2">
            {lists.map((l) => {
              const on = mineLists.includes(l.key);
              return (
                <label key={l.key} className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!isAdmin}
                    onChange={() => onPost({
                      sources: on
                        ? mineLists.filter((k) => k !== l.key)
                        : [...mineLists, l.key],
                    })}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600"
                  />
                  <span>
                    <span className="font-semibold">{l.label}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{l.path}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {l.key === ""
                        ? "Card transactions — the main queue."
                        : "A separate page in Emburse, with its own queue and its own timeline."}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {row.sources ? "Theirs." : "Inherited from the defaults below until you change one."}
            {" "}Each list is read separately, on their schedule, one after the other.
          </p>
          {mineLists.length === 0 && (
            <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2.5 text-sm">
              No list is ticked, so nothing is imported for {row.userEmail}.
            </p>
          )}
        </div>

        {/* The receipt filter. Part of scope, not a footnote somewhere else
            on the page: it is what puts the receipt image in the export at
            all, and without it there is nothing for the receipt-vs-claim
            check to read. */}
        <label
          className={`mt-3 flex items-start gap-3 rounded-xl border p-3 text-sm ${
            isAdmin ? "cursor-pointer hover:bg-muted" : "cursor-not-allowed opacity-70"
          } ${receipts ? "border-border" : "border-amber-500/50 bg-amber-500/10"}`}
        >
          <input
            type="checkbox"
            checked={receipts}
            disabled={!isAdmin}
            onChange={(e) => onPost({ receiptsOnly: e.target.checked })}
            className="mt-0.5 h-4 w-4 shrink-0 accent-sky-600"
          />
          <span>
            <span className="font-semibold">Receipt image</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {receipts
                ? "On — the export is filtered to Receipts: true, so every expense it brings in has an image to read."
                : "Off — the export is not filtered to Receipts: true. Expenses with no image come in too, and the receipt-vs-claim check has nothing to read for them."}
            </span>
          </span>
        </label>

        {!stages.includes("Needs Review") && (
          <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
            <strong>Needs Review is off.</strong> That is the approver&rsquo;s queue — the expenses
            waiting on {row.userEmail}. With it off their import brings in expenses they cannot act
            on, and the ones they can disappear from the queue.
          </p>
        )}
      </section>

      {/* WHEN. Always their own times; there is no shared schedule here. */}
      <section>
        <h3 className="text-sm font-bold">Schedule — when it runs</h3>
        <ReviewerSchedule
          row={row}
          isAdmin={isAdmin}
          onSaved={() => void qc.invalidateQueries({ queryKey: ["reviewer-imports"] })}
        />
      </section>

      {/* TRY IT, and WATCH IT. One set of buttons, in the tab they belong to:
          the runner takes the reviewer, so Test run here is this person's. */}
      <section className="border-t border-border pt-5">
        <ExportRunner
          isAdmin={isAdmin}
          reviewer={row.userEmail}
          lists={lists.filter((l) => mineLists.includes(l.key))}
          selectors={selectors}
          help={help}
          stepSelectors={stepSelectors}
          defaults={defaults}
          onSaveSelectors={async (next) => {
            const res = await fetch("/api/export-settings", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ selectors: next }),
            });
            const body = (await res.json()) as Settings & { error?: string };
            if (!res.ok) throw new Error(body.error ?? "Could not save selectors");
            qc.setQueryData(["export-settings"], body);
          }}
        />
      </section>

      {/* The two controls almost nobody needs, out of the way of the five
          that everybody does. */}
      {isAdmin && (
        <details className="rounded-xl border border-border p-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Advanced — exact Emburse URL, and whose login reads it
          </summary>

          <p className="mt-3 text-xs text-muted-foreground">
            Only needed when the two choices above cannot describe the list. Open it in Emburse as
            them — setting <strong>Current Reviewer</strong> if the chain needs it — and paste the
            whole address.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={href}
              onChange={(e) => setHref(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text");
                if (!/^https?:\/\//.test(text.trim())) return;
                e.preventDefault();
                setHref(text);
                pasteUrl(text);
              }}
              placeholder="https://spend.emburse.com/transactions/team?filters…"
              className="min-w-72 flex-1 rounded-lg border border-border bg-background px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              disabled={!href.trim()}
              onClick={() => pasteUrl(href)}
              className="rounded-lg bg-foreground px-3 py-1 text-sm font-semibold text-background disabled:opacity-40"
            >
              Use this
            </button>
            {(row.gridQuery || row.gridSection) && (
              <button
                type="button"
                onClick={() => { setHref(""); onPost({ gridSection: "", gridQuery: "" }); }}
                className="rounded-lg border border-border px-3 py-1 text-sm font-semibold"
              >
                Clear the filters
              </button>
            )}
          </div>
          {urlError && <p className="mt-1 text-xs text-red-600">{urlError}</p>}
          {(row.gridSection || row.gridQuery) && (
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {row.gridSection ? `filters[section]=${row.gridSection}` : ""}
              {row.gridSection && row.gridQuery ? " · " : ""}
              {row.gridQuery ?? ""}
            </p>
          )}

          <p className="mt-4 text-xs text-muted-foreground">
            Whose Emburse login does the fetching. Themselves is the right answer: the queue is per
            account, so their own login already shows only theirs. Another login saves them a
            verification code but then needs a filter above, or it reads <em>that</em> person&rsquo;s
            queue.
          </p>
          <select
            value={row.runAs ?? ""}
            onChange={(e) => onPost({ runAs: e.target.value })}
            className="mt-2 rounded-lg border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="">{row.userEmail} (themselves)</option>
            {everyone.filter((o) => o !== row.userEmail).map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </details>
      )}
    </div>
  );
}

/**
 * One reviewer's import times.
 *
 * Always presented as theirs, never as "the shared ones" — two imports
 * cannot share a slot, because one browser runs them in turn and the second
 * would wait out the first. The server still seeds an unset reviewer from
 * the defaults, staggered so no two collide; saving here pins the times
 * where somebody put them.
 */
function ReviewerSchedule({
  row, isAdmin, onSaved,
}: {
  row: Reviewer;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [sc, setSc] = useState<Schedule>(row.schedule);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const dirty = JSON.stringify(sc) !== JSON.stringify(row.schedule);

  async function save() {
    setBusy(true);
    try {
      // Only the schedule. The same row holds their scope and the switch
      // that approves spending unattended, and the server writes only what
      // it is sent.
      await fetch("/api/reviewer-imports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: row.userEmail, schedule: sc }),
      });
      setDone(true);
      setTimeout(() => setDone(false), 2000);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  const field = (
    label: string, value: string | number,
    onChange: (v: string) => void, width = "w-24",
  ) => (
    <label className="text-xs">
      <span className="block text-muted-foreground">{label}</span>
      <input
        value={String(value)}
        disabled={!isAdmin}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-0.5 ${width} rounded border border-border bg-background px-1.5 py-1 disabled:opacity-60`}
      />
    </label>
  );

  return (
    <div className="mt-2 space-y-2">
      <p className="text-sm text-muted-foreground">
        First at <strong>{row.schedule.firstRun}</strong>, then every {row.schedule.retryHours}h ·{" "}
        {row.schedule.attemptsPerDay} a day · {row.schedule.timezone}
        {row.shared && row.staggeredBy > 0
          ? ` — offset ${row.staggeredBy} min so it never collides with another import`
          : ""}
      </p>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-2.5">
        <label className="text-xs">
          <span className="block text-muted-foreground">Timezone</span>
          <select
            value={sc.timezone}
            disabled={!isAdmin}
            onChange={(e) => setSc({ ...sc, timezone: e.target.value })}
            className="mt-0.5 rounded border border-border bg-background px-1.5 py-1 disabled:opacity-60"
          >
            {[...new Set([sc.timezone, ...ZONES])].map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </label>
        {field("First run", sc.firstRun, (v) => setSc({ ...sc, firstRun: v }), "w-24")}
        {field("Runs a day", sc.attemptsPerDay,
          (v) => setSc({ ...sc, attemptsPerDay: Number(v) || 1 }), "w-20")}
        {field("Hours between", sc.retryHours,
          (v) => setSc({ ...sc, retryHours: Number(v) || 1 }), "w-20")}
        {field("Grace, min", sc.graceMinutes,
          (v) => setSc({ ...sc, graceMinutes: Number(v) || 0 }), "w-20")}
        <label className="flex items-center gap-1.5 pb-1 text-xs">
          <input
            type="checkbox"
            checked={sc.allDay}
            disabled={!isAdmin}
            onChange={(e) => setSc({ ...sc, allDay: e.target.checked })}
          />
          <span className="text-muted-foreground">All day</span>
        </label>
        <button
          type="button"
          disabled={!isAdmin || busy || !dirty}
          onClick={() => void save()}
          className="ml-auto rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save their times"}
        </button>
        {done && <span className="text-xs text-emerald-600">Saved</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        <strong>All day</strong> on, these are simply when the import runs — every one of them, so
        the queue keeps up with Emburse through the day. Off, they are retries and the first one
        that succeeds closes the day.
      </p>
    </div>
  );
}

/**
 * What a reviewer with nothing of their own inherits, plus the bits that
 * really are deployment-wide: which Emburse lists exist, whether the export
 * is filtered to receipts, and the selectors.
 *
 * Collapsed, and labelled as defaults rather than as settings, because the
 * whole fault this page had was that these sat above somebody's name and
 * read as theirs.
 */
function SharedDefaults({ data, viewingAs }: { data: Settings; viewingAs: string | null }) {
  const qc = useQueryClient();
  const [sections, setSections] = useState<string[]>(data.sections);
  const [receiptsOnly, setReceiptsOnly] = useState(data.receiptsOnly);
  const [schedule, setSchedule] = useState<Schedule>(data.schedule);
  const [sources, setSources] = useState<ImportSource[]>(data.sources ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Reseed when the server's copy changes, but never while a save is in
  // flight — a background refetch must not discard what somebody is typing.
  useEffect(() => {
    if (saving) return;
    setSections(data.sections);
    setReceiptsOnly(data.receiptsOnly);
    setSchedule(data.schedule);
    setSources(data.sources ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.updatedAt]);

  const dirty =
    JSON.stringify(sections) !== JSON.stringify(data.sections) ||
    receiptsOnly !== data.receiptsOnly ||
    JSON.stringify(schedule) !== JSON.stringify(data.schedule) ||
    JSON.stringify(sources) !== JSON.stringify(data.sources);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/export-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sections, receiptsOnly, schedule, sources }),
      });
      const body = (await res.json()) as Settings & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
      qc.setQueryData(["export-settings"], body);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const num = (
    label: string, value: number, onChange: (n: number) => void,
  ) => (
    <label className="text-xs">
      <span className="block text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-0.5 w-20 rounded border border-border bg-background px-1.5 py-1"
      />
    </label>
  );

  return (
    <details className="rounded-xl border border-border p-3">
      <summary className="cursor-pointer text-sm font-semibold">
        Defaults — what a new reviewer starts with
      </summary>

      <p className="mt-3 text-xs text-muted-foreground">
        Not anybody&rsquo;s import. These seed a reviewer who has set nothing of their own; the
        moment they change something in their tab, their tab wins and this stops applying to them.
      </p>

      {viewingAs && (
        <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
          These are everybody&rsquo;s, so saving them is refused while you are viewing as{" "}
          {viewingAs}. {viewingAs}&rsquo;s own import is in their tab above and does save.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {data.allSections.map((name) => (
          <label key={name} className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs">
            <input
              type="checkbox"
              checked={sections.includes(name)}
              onChange={() => setSections((p) =>
                p.includes(name) ? p.filter((s) => s !== name) : [...p, name])}
              className="h-3.5 w-3.5 accent-sky-600"
            />
            {name}
          </label>
        ))}
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={receiptsOnly}
          onChange={(e) => setReceiptsOnly(e.target.checked)}
          className="h-3.5 w-3.5 accent-sky-600"
        />
        <span>
          <strong>Receipts: true</strong> — only expenses with a receipt attached.
        </span>
      </label>

      <div className="mt-3">
        <p className="text-xs font-semibold">The Emburse lists, and where they live</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Ticked here means a reviewer who has not chosen for themselves imports it. Who imports
          which list is set in their tab.
        </p>
        <ul className="mt-1 space-y-1.5">
          {sources.map((src, i) => (
            <li key={src.key} className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={src.enabled}
                  onChange={(e) => setSources((p) =>
                    p.map((x, k) => (k === i ? { ...x, enabled: e.target.checked } : x)))}
                  className="h-3.5 w-3.5 accent-emerald-600"
                />
                <span className="font-semibold">{src.label}</span>
              </label>
              <input
                value={src.path}
                onChange={(e) => setSources((p) =>
                  p.map((x, k) => (k === i ? { ...x, path: e.target.value } : x)))}
                spellCheck={false}
                className="ml-auto w-64 rounded border border-border bg-transparent px-2 py-1 font-mono text-xs"
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3">
        <p className="text-xs font-semibold">Default times</p>
        <div className="mt-1 flex flex-wrap items-end gap-3">
          <label className="text-xs">
            <span className="block text-muted-foreground">Timezone</span>
            <select
              value={schedule.timezone}
              onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })}
              className="mt-0.5 rounded border border-border bg-background px-1.5 py-1"
            >
              {[...new Set([schedule.timezone, ...ZONES])].map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="block text-muted-foreground">First run</span>
            <input
              type="time"
              value={schedule.firstRun}
              onChange={(e) => setSchedule({ ...schedule, firstRun: e.target.value })}
              className="mt-0.5 rounded border border-border bg-transparent px-1.5 py-1"
            />
          </label>
          {num("Runs a day", schedule.attemptsPerDay,
            (n) => setSchedule({ ...schedule, attemptsPerDay: n }))}
          {num("Hours between", schedule.retryHours,
            (n) => setSchedule({ ...schedule, retryHours: n }))}
          {num("Grace, min", schedule.graceMinutes,
            (n) => setSchedule({ ...schedule, graceMinutes: n }))}
          <label className="flex items-center gap-1.5 pb-1 text-xs">
            <input
              type="checkbox"
              checked={schedule.allDay}
              onChange={(e) => setSchedule({ ...schedule, allDay: e.target.checked })}
            />
            <span className="text-muted-foreground">All day</span>
          </label>
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty || saving || sections.length === 0}
          onClick={() => void save()}
          className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save defaults
        </button>
        {saved && (
          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
        {dirty && (
          <span className="inline-flex items-center gap-1.5 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" /> Unsaved
          </span>
        )}
        {data.updatedAt && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            Last changed {new Date(data.updatedAt).toLocaleString()}
            {data.updatedBy ? ` by ${data.updatedBy}` : ""}
          </span>
        )}
      </div>
    </details>
  );
}
