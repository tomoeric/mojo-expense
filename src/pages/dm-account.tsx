import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Power } from "lucide-react";

/**
 * The partner account, open or shut.
 *
 * One switch that closes Dutch Miller to everybody outside MOJO. Not
 * the same as disabling people one at a time, which is what Users is
 * for: this is the whole partner relationship ending, or something
 * having to stop right now, and nobody wants to be clicking through
 * thirty rows while it does.
 *
 * It shuts the EMAILED-LINK door only. MOJO staff keep working —
 * they are the people who would switch it back on, and locking them
 * out of their own app to lock out a partner turns a pause into an
 * outage. That is judged on the door somebody came through, never on
 * their address.
 */
export function DmAccountPage({ canSwitch }: { canSwitch: boolean }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const q = useQuery({
    queryKey: ["dm-account"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/account");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        active: boolean; reason: string;
        updatedAt: string | null; updatedBy: string | null;
      };
    },
  });

  const save = useMutation({
    mutationFn: async (active: boolean) => {
      const res = await fetch("/api/dutch-miller/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active, reason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save it.");
      return body;
    },
    onSuccess: () => {
      setConfirming(false);
      setReason("");
      setError("");
      void qc.invalidateQueries({ queryKey: ["dm-account"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const active = q.data?.active ?? true;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Account</h1>
        <p className="text-sm text-muted-foreground">
          Whether the Dutch Miller partner account is open.
        </p>
      </div>

      {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}

      {q.data && (
        <div className={`rounded-lg border p-5 ${
          active
            ? "border-emerald-500/40 bg-emerald-500/5"
            : "border-rose-500/40 bg-rose-500/10"
        }`}>
          <p className="flex items-center gap-2 text-sm font-semibold">
            {active
              ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              : <Power className="h-4 w-4 text-rose-600" />}
            {active ? "Partner access is ON" : "Partner access is OFF"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {active
              ? "Invited dealer accounts can sign in and use the pages their role gives them."
              : "No invited dealer account can sign in or use the app. MOJO staff are unaffected."}
          </p>
          {!active && q.data.reason && (
            <p className="mt-2 rounded-md bg-background px-3 py-2 text-sm">
              <strong>Reason shown to them:</strong> {q.data.reason}
            </p>
          )}
          {q.data.updatedAt && (
            <p className="mt-2 text-xs text-muted-foreground">
              Last changed {new Date(q.data.updatedAt).toLocaleString()}
              {q.data.updatedBy ? ` by ${q.data.updatedBy}` : ""}.
            </p>
          )}

          {canSwitch && !confirming && (
            <button
              type="button"
              onClick={() => { setConfirming(true); setReason(q.data?.reason ?? ""); }}
              className={`mt-4 inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold ${
                active
                  ? "bg-rose-600 text-white"
                  : "bg-foreground text-background"
              }`}
            >
              <Power className="h-4 w-4" />
              {active ? "Switch partner access off" : "Switch partner access on"}
            </button>
          )}
          {!canSwitch && (
            <p className="mt-3 text-xs text-muted-foreground">
              Only an account administrator can change this.
            </p>
          )}
        </div>
      )}

      {confirming && (
        <div className="rounded-lg border border-border bg-card p-5">
          {active ? (
            <>
              {/* What it does and does not do, before the button. The
                  cost of getting this wrong is every dealer locked
                  out at once. */}
              <p className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <span>
                  <strong>Every invited dealer is refused on their next request</strong>,
                  not at their next sign-in — including anyone with the app open now.
                  MOJO staff are unaffected and can switch it back on. Nothing is
                  deleted: roles, invitations, members and tags all stay exactly as
                  they are.
                </span>
              </p>
              <label className="mt-3 block">
                <span className="mb-1 block text-xs font-semibold text-muted-foreground">
                  Why? <span className="text-rose-600">Required</span> — dealers see this.
                </span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="Partner agreement under review. Contact MOJO operations."
                  className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm"
                />
              </label>
            </>
          ) : (
            <p className="text-sm">
              Invited dealers will be able to sign in again immediately. Their roles
              and accounts are exactly as they were.
            </p>
          )}

          {error && <p className="mt-2 text-sm font-semibold text-red-600">{error}</p>}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={save.isPending || (active && reason.trim().length < 5)}
              onClick={() => save.mutate(!active)}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${
                active ? "bg-rose-600 text-white" : "bg-foreground text-background"
              }`}
            >
              {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {active ? "Yes, switch it off" : "Switch it back on"}
            </button>
            <button
              type="button"
              onClick={() => { setConfirming(false); setError(""); }}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
