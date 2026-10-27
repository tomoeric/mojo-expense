import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, Info, KeyRound, Loader2, Plus, ShieldAlert, Trash2, X,
} from "lucide-react";
import { EmburseCheck } from "@/components/emburse-check";

/**
 * Where one person stores the Emburse logins the app signs in with.
 *
 * ONE PERSON, MORE THAN ONE ACCOUNT. Eric submits expenses in two
 * Emburse tenants, so this is a list rather than a form. Each card
 * is one Emburse account: what it signs in as, whether it is
 * working, when it last did, and whether it is sitting on a
 * verification code.
 *
 * The part that is easy to get wrong and expensive to get wrong:
 * WHICH TAB EACH ACCOUNT SERVES IS DECIDED BY ITS EMBURSE ADDRESS,
 * never by the address the person uses for this app. The connection
 * already stored here signs in as the Mammoth address while its
 * owner signs into this app as MOJO; believing those agree is how a
 * receipt ends up attached in the wrong tenant. So the mapping is
 * shown, with the comparison it was made from, and a tab that
 * matches nothing says what IS on file instead of quietly using it.
 *
 * Entered once, never shown again — to its owner or to an
 * administrator — and the page still says plainly where that
 * guarantee stops.
 */

type Connection = {
  userEmail: string;
  loginEmail: string;
  updatedAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  needsReentry: boolean;
  accountKey: string;
  label: string;
  isPrimary: boolean;
  awaitingCode: boolean;
  codeAskedAt: string | null;
};

type Lane = {
  key: string;
  label: string;
  kind: "manager" | "personal";
  loginEmail: string;
  connection: Connection | null;
  problem: string;
};

type Answer = { connections: Connection[]; lanes: Lane[] };

export function MyEmburseLoginPage() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  /** The account being replaced, by key. Empty means none. */
  const [replacing, setReplacing] = useState("");
  const [error, setError] = useState("");

  const q = useQuery({
    queryKey: ["my-emburse-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/my-emburse-accounts");
      if (!res.ok) {
        throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      }
      return (await res.json()) as Answer;
    },
  });

  const connections = q.data?.connections ?? [];
  const lanes = q.data?.lanes ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["my-emburse-accounts"] });

  if (q.isLoading) {
    return <Loader2 className="mx-auto mt-10 h-6 w-6 animate-spin text-muted-foreground" />;
  }
  if (q.isError) {
    return (
      <p className="flex max-w-2xl items-start gap-2 rounded-lg border border-amber-500/30
                    bg-amber-500/10 p-3 text-sm">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        {(q.error as Error).message}
      </p>
    );
  }

  return (
    <div className="max-w-2xl space-y-5">
      {/* No heading: the shell already renders the page's title
          above this, and the screenshot showed "Your Emburse
          login" twice, a paragraph apart. */}
      <p className="text-sm text-muted-foreground">
        One for each Emburse account you have — they are kept apart, and a sign-in, an
        import or a receipt upload always uses the account it belongs to. To add another,
        enter its Emburse address below: that address is what decides which tab it serves,
        so there is nothing else to choose.
      </p>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-sm">{error}</p>
      )}

      {connections.length === 0 && !adding && (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          Nothing stored yet. Add the Emburse account you sign in with.
        </p>
      )}

      {connections.map((c) => (
        <ConnectionCard
          key={c.accountKey}
          connection={c}
          lanes={lanes.filter((l) => l.connection?.accountKey === c.accountKey)}
          replacing={replacing === c.accountKey}
          onReplace={() => { setReplacing(replacing === c.accountKey ? "" : c.accountKey); }}
          onDone={() => { setReplacing(""); void refresh(); }}
          onError={setError}
        />
      ))}

      {adding ? (
        <CredentialForm
          title="Another Emburse account"
          note="Its own login, its own password, and its own sign-in state. Adding one does
                not change the account you already have."
          onCancel={() => setAdding(false)}
          onDone={() => { setAdding(false); void refresh(); }}
          onError={setError}
        />
      ) : (
        <button
          type="button"
          onClick={() => { setError(""); setAdding(true); }}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3.5
                     py-2 text-sm font-semibold"
        >
          <Plus className="h-4 w-4" />
          Add another Emburse account
        </button>
      )}

      {/* The mapping, and the comparison it was made from. A tab
          that matches nothing is the case worth showing: the answer
          is "add that address", never "use the one that is here". */}
      {lanes.length > 1 && (
        <div className="space-y-2 rounded-xl border border-border p-3.5">
          <p className="text-sm font-semibold">Which account each tab uses</p>
          <p className="text-xs text-muted-foreground">
            Matched on the Emburse address, not on the address you sign into this app with.
            They are often different, and the one already stored here is.
          </p>
          {lanes.map((l) => (
            <div key={l.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5
                                        border-t border-border pt-2 text-sm">
              <span className="font-semibold">{l.label}</span>
              {l.connection ? (
                <>
                  <span className="text-muted-foreground">signs in as</span>
                  <span className="font-mono text-xs">{l.connection.loginEmail}</span>
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                </>
              ) : (
                <span className="flex-1 text-xs text-amber-700 dark:text-amber-400">
                  {l.problem}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3
                    text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong className="text-foreground">What this does and does not protect.</strong> No
          page in this app shows a password again, including to an administrator, and they are
          encrypted in the database. But the export runs at six in the morning with nobody
          present, so the server has to be able to use them unaided — which means whoever
          controls the deployment and its secrets could recover them. If that matters, use a
          dedicated Emburse service account here rather than your own login, and there is no
          personal password to protect.
        </span>
      </p>
    </div>
  );
}

function ConnectionCard({
  connection, lanes, replacing, onReplace, onDone, onError,
}: {
  connection: Connection;
  lanes: Lane[];
  replacing: boolean;
  onReplace: () => void;
  onDone: () => void;
  onError: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    onError("");
    try {
      const res = await fetch(
        `/api/my-emburse-accounts/${encodeURIComponent(connection.accountKey)}`,
        { method: "DELETE" });
      if (!res.ok) {
        throw new Error(((await res.json()) as { error?: string }).error ?? "Could not remove it.");
      }
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{connection.loginEmail}</span>
        {connection.label && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{connection.label}</span>
        )}
        {connection.isPrimary && (
          <span
            title="The manager queue is read with this one, and your approvals and denials are
                   applied under it."
            className="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-700
                       dark:text-sky-300"
          >
            manager &amp; decisions
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Saved {new Date(connection.updatedAt).toLocaleString()}
        {connection.lastOkAt
          ? ` · last signed in successfully ${new Date(connection.lastOkAt).toLocaleString()}`
          : " · not used yet"}
        {lanes.length > 0 && ` · ${lanes.map((l) => l.label).join(", ")}`}
      </p>

      {/* A connection waiting on six digits. Said HERE, on the one
          it belongs to, so the other account's card cannot be read
          as the thing that needs attention. */}
      {connection.awaitingCode && (
        <p className="flex items-start gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10
                      p-2.5 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>This account is waiting for a verification code.</strong> Emburse asked{" "}
            {connection.loginEmail} to prove the browser. Answer it on the Import page — the
            code goes to this account only.
          </span>
        </p>
      )}

      {connection.needsReentry && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40
                      bg-amber-500/10 p-2.5 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>Emburse rejected this login.</strong> Replace the password below.
            <span className="mt-1 block text-xs text-muted-foreground">
              {connection.lastError}
            </span>
          </span>
        </p>
      )}

      {/* A sign-in can fail without the password being wrong — a
          device check, a renamed button. Saying so is worth doing;
          sending somebody to re-type a working password is not. */}
      {!connection.needsReentry && connection.lastError && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-2.5
                      text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            <strong>The last sign-in did not get through</strong> — but not because of this
            password, so there is nothing to re-enter.
            <span className="mt-1 block text-xs text-muted-foreground">
              {connection.lastError}
            </span>
          </span>
        </p>
      )}

      {/* Tested per account, because "is it working" is a question
          about one Emburse tenant and the answer for the other one
          says nothing about it. */}
      <EmburseCheck
        canDecide
        accountKey={connection.accountKey}
        loginEmail={connection.loginEmail}
      />

      {replacing ? (
        <CredentialForm
          title={`Replace ${connection.loginEmail}`}
          note="The Emburse address can change too — this stays the same stored account, with
                the same tab mapping recalculated from whatever it signs in as."
          accountKey={connection.accountKey}
          defaultEmail={connection.loginEmail}
          defaultLabel={connection.label}
          onCancel={onReplace}
          onDone={onDone}
          onError={onError}
        />
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onReplace}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3
                       py-1.5 text-sm"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Replace password
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={`Remove ${connection.loginEmail}`}
            onClick={() => void remove()}
            className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted-foreground
                       hover:text-red-600 disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" /> Remove
          </button>
        </div>
      )}
    </div>
  );
}

function CredentialForm({
  title, note, accountKey, defaultEmail, defaultLabel, onCancel, onDone, onError,
}: {
  title: string;
  note: string;
  accountKey?: string;
  defaultEmail?: string;
  defaultLabel?: string;
  onCancel: () => void;
  onDone: () => void;
  onError: (s: string) => void;
}) {
  const [loginEmail, setLoginEmail] = useState(defaultEmail ?? "");
  const [label, setLabel] = useState(defaultLabel ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setBusy(true);
    onError("");
    try {
      const res = await fetch("/api/my-emburse-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginEmail, password, label, accountKey }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
      // Out of component state the moment it is stored; there is no
      // reason for the password to outlive the request that carried it.
      setPassword("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-foreground/20 bg-muted/30 p-3">
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-xs text-muted-foreground">{note}</p>

      <label className="block">
        <span className="text-sm font-semibold">Emburse email</span>
        <input
          type="email"
          autoComplete="off"
          value={loginEmail}
          placeholder="you@example.com"
          onChange={(e) => setLoginEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-transparent px-2 py-1.5
                     text-sm outline-none focus:border-sky-500"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          The address you sign into EMBURSE with. It decides which tab this account serves,
          and it is often not the address you sign into this app with.
        </span>
      </label>

      <label className="block">
        <span className="text-sm font-semibold">Password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-transparent px-2 py-1.5
                     text-sm outline-none focus:border-sky-500"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          Stored encrypted. It is never shown again, to you or to anyone else.
        </span>
      </label>

      <label className="block">
        <span className="text-sm font-semibold">
          Name it <span className="font-normal text-muted-foreground">(optional)</span>
        </span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="MOJO"
          className="mt-1 w-full rounded-lg border border-border bg-transparent px-2 py-1.5
                     text-sm outline-none focus:border-sky-500"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          A name for you to read. It decides nothing — the Emburse address does.
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || !password || !loginEmail}
          onClick={() => void save()}
          className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-sm
                     font-semibold text-white transition-colors hover:bg-sky-500
                     disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          Save
        </button>
        {saved && (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-500">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <X className="h-4 w-4" /> Cancel
        </button>
      </div>
    </div>
  );
}
