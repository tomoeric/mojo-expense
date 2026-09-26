import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, KeyRound, Check, Trash2, ShieldAlert, Info } from "lucide-react";
import { EmburseCheck } from "@/components/emburse-check";

type Credential = {
  userEmail: string;
  loginEmail: string;
  updatedAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  needsReentry: boolean;
};

/**
 * Where one person stores the Emburse login the export signs in with.
 *
 * Entered once. It is not shown again afterwards — to its owner or to an
 * administrator — and the page says plainly where that guarantee stops, because
 * a promise of privacy that quietly does not hold is worse than none.
 */
export function MyEmburseLoginPage() {
  const qc = useQueryClient();
  const [loginEmail, setLoginEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const q = useQuery({
    queryKey: ["my-emburse-login"],
    queryFn: async () => {
      const res = await fetch("/api/my-emburse-login");
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      return (await res.json()) as { credential: Credential | null; signedIn: boolean };
    },
  });

  const credential = q.data?.credential ?? null;

  async function save() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/my-emburse-login", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginEmail: loginEmail || credential?.loginEmail, password }),
      });
      const body = (await res.json()) as { credential?: Credential; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
      // Drop it from component state the moment it is stored; there is no
      // reason for the password to outlive the request that carried it.
      setPassword("");
      setLoginEmail("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await qc.invalidateQueries({ queryKey: ["my-emburse-login"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await fetch("/api/my-emburse-login", { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["my-emburse-login"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (q.isLoading) {
    return <Loader2 className="mx-auto mt-10 h-6 w-6 animate-spin text-muted-foreground" />;
  }

  // A credential belongs to a person, so without a signed-in one there is
  // nobody to store it against. Say that, rather than offering a form whose
  // Save can only ever fail.
  if (q.data && !q.data.signedIn) {
    return (
      <p className="flex max-w-2xl items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        Microsoft sign-in is not configured on this deployment, so there is no account to store a
        login against. Set the <code>AZURE_*</code> secrets and sign in first.
      </p>
    );
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-bold">
          <KeyRound className="h-4 w-4" />
          Your Emburse login
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The app signs into Emburse with this to fetch the daily export. Enter it once — you will not
          be asked again unless the sign-in stops working.
        </p>
      </div>

      {credential?.needsReentry && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>Emburse rejected this login.</strong> Enter the password again below.
            <span className="mt-1 block text-xs text-muted-foreground">{credential.lastError}</span>
          </span>
        </p>
      )}

      {/* A sign-in can fail without the password being wrong — a device check,
          a renamed button. Saying so is worth doing; sending somebody to
          re-type a working password is not, because it fails identically and
          spends the credibility of the warning above. */}
      {credential && !credential.needsReentry && credential.lastError && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            <strong>The last sign-in did not get through</strong> — but not because of this password,
            so there is nothing to re-enter here.
            <span className="mt-1 block text-xs text-muted-foreground">{credential.lastError}</span>
          </span>
        </p>
      )}

      {credential && !credential.needsReentry && (
        <div className="rounded-xl border border-border p-3.5 text-sm">
          <p className="font-semibold">{credential.loginEmail}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Saved {new Date(credential.updatedAt).toLocaleString()}
            {credential.lastOkAt
              ? ` · last signed in successfully ${new Date(credential.lastOkAt).toLocaleString()}`
              : " · not used yet"}
          </p>
        </div>
      )}

      <div className="space-y-3 rounded-xl border border-border p-3.5">
        <label className="block">
          <span className="text-sm font-semibold">Emburse email</span>
          <input
            type="email"
            autoComplete="off"
            value={loginEmail}
            placeholder={credential?.loginEmail ?? "you@mojocarwash.com"}
            onChange={(e) => setLoginEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-sky-500"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold">
            {credential ? "New password" : "Emburse password"}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-sky-500"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Stored encrypted. It is never shown again, to you or to anyone else.
          </span>
        </label>

        {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-sm">{error}</p>}

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy || !password || (!loginEmail && !credential)}
            onClick={() => void save()}
            className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            {credential ? "Replace" : "Save"}
          </button>

          {saved && (
            <span className="inline-flex items-center gap-1.5 text-sm text-emerald-500">
              <Check className="h-4 w-4" /> Saved
            </span>
          )}

          {credential && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" /> Remove
            </button>
          )}
        </div>
      </div>

      {/* Tested here rather than on the queue. Approving a real expense used to
          be the only way to find out whether a login worked, so a new
          reviewer's first lesson was that a real expense "did not go through".
          This is the page where the login is entered, so it is where "does it
          work" belongs — and it tests the signed-in person's own credentials,
          never anybody else's. */}
      <EmburseCheck canDecide={Boolean(credential)} />

      <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong className="text-foreground">What this does and does not protect.</strong> No page in
          this app shows the password again, including to an administrator, and it is encrypted in the
          database. But the export runs at six in the morning with nobody present, so the server has to
          be able to use it unaided — which means whoever controls the deployment and its secrets could
          recover it. If that matters, use a dedicated Emburse service account here rather than your own
          login, and there is no personal password to protect.
        </span>
      </p>
    </div>
  );
}
