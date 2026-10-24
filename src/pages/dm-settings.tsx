import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Loader2, Send } from "lucide-react";

type Notify = {
  recipients: string[];
  enabled: boolean;
  copySubmitter: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

/**
 * Dutch Miller settings.
 *
 * One section for now. It is its own page rather than a panel on Users
 * because the next setting will not be about people, and a settings page
 * that starts as a tenant of another page never moves out.
 */
export function DmSettingsPage() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [copySubmitter, setCopySubmitter] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const data = useQuery({
    queryKey: ["dm-notify"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/settings/notifications");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as { notify: Notify; mailConfigured: boolean };
    },
  });

  // Seed the editor once, and never again: refetching while somebody is
  // halfway through typing a list of addresses would wipe it.
  useEffect(() => {
    if (!data.data || dirty) return;
    setText(data.data.notify.recipients.join("\n"));
    setEnabled(data.data.notify.enabled);
    setCopySubmitter(data.data.notify.copySubmitter);
  }, [data.data, dirty]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/settings/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipients: text, enabled, copySubmitter }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save.");
      return body as { notify: Notify };
    },
    onSuccess: (b) => {
      setError("");
      setDirty(false);
      setText(b.notify.recipients.join("\n"));
      setNote(b.notify.recipients.length === 0
        ? "Saved. Nobody is on the list, so no notifications will be sent."
        : `Saved. ${b.notify.recipients.length} recipient`
          + `${b.notify.recipients.length === 1 ? "" : "s"}.`);
      void qc.invalidateQueries({ queryKey: ["dm-notify"] });
    },
    onError: (e) => { setError((e as Error).message); setNote(""); },
  });

  const sample = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/settings/notifications/sample", {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not send.");
      return body as { to: string; usedRealSignup: boolean };
    },
    onSuccess: (b) => {
      setError("");
      setNote(`Sample sent to ${b.to}${b.usedRealSignup
        ? ", built from the most recent signup."
        : " — no signups yet, so it uses made-up details."}`);
    },
    onError: (e) => { setError((e as Error).message); setNote(""); },
  });

  const mailOff = data.data && !data.data.mailConfigured;
  const count = text.split(/[,;\n\r]+/).map((s) => s.trim()).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Dutch Miller settings. Administrators only.
        </p>
      </div>

      {mailOff && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200">
          Email is not configured, so nothing will be sent whatever is set here.
        </p>
      )}
      {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
      {note && <p className="text-sm text-emerald-700 dark:text-emerald-400">{note}</p>}

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Bell className="h-4 w-4" />
              New member notifications
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              When a dealer submits a member signup, email the details to these addresses.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => { setEnabled(e.target.checked); setDirty(true); }}
            />
            On
          </label>
        </div>

        <label htmlFor="recipients" className="mb-1 block text-xs text-muted-foreground">
          Recipients — one per line, or separated by commas
        </label>
        <textarea
          id="recipients"
          rows={4}
          value={text}
          onChange={(e) => { setText(e.target.value); setDirty(true); setNote(""); }}
          placeholder={"memberships@mojocarwash.com\noperations@mojocarwash.com"}
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {count === 0
            ? "Nobody listed — no notifications will be sent."
            : `${count} address${count === 1 ? "" : "es"}.`}
          {" "}Each one gets its own message, so a bad address cannot stop the others.
        </p>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={copySubmitter}
            onChange={(e) => { setCopySubmitter(e.target.checked); setDirty(true); }}
          />
          Also send a copy to whoever submitted it
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <button
            type="button"
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate()}
            className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-semibold text-background disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {dirty ? "Save" : "Saved"}
          </button>
          {/* To the administrator asking, never to the list: checking the
              wording should not mail the finance team. */}
          <button
            type="button"
            disabled={sample.isPending || mailOff}
            onClick={() => sample.mutate()}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            {sample.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send me a sample
          </button>
          {data.data?.notify.updatedAt && !dirty && (
            <span className="text-xs text-muted-foreground">
              Last changed {new Date(data.data.notify.updatedAt).toLocaleString()}
              {data.data.notify.updatedBy ? ` by ${data.data.notify.updatedBy}` : ""}
            </span>
          )}
        </div>
      </section>

      {/* Worth saying where it does NOT reach: somebody expecting a
          notification for a tag going out, or for the Mark complete, will
          otherwise assume it is broken. */}
      <p className="text-xs text-muted-foreground">
        Notifications are sent for member signups only, at the moment one is submitted.
        A failed send never fails the signup — the member is saved and the RFID claimed
        first — and every attempt is recorded in the audit trail on the Users page.
      </p>
    </div>
  );
}
