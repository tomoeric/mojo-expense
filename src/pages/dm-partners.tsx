import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Building2, Check, Loader2, Plus, Power, Settings2, X,
} from "lucide-react";
import { Empty, SectionTitle } from "@/components/ui";
import { openAccount } from "@/lib/partner";

/**
 * Partner Accounts — the platform's own page.
 *
 * Outside any partner. This is where an account administrator sees
 * every partner on the platform, opens one, and creates the next.
 *
 * It is deliberately plain. A partner is a name, a path, a wash and a
 * state; everything else about it lives inside the account, where the
 * people who run it work. A dashboard here would mean reading six
 * partners' numbers on one screen, which is a thing nobody has asked
 * for and which puts one dealership's figures in front of anybody who
 * can see another's.
 */

export type PartnerAccount = {
  id: string;
  slug: string;
  name: string;
  affiliation: string;
  line: string;
  status: "active" | "inactive";
  templateVersion: number;
  createdAt: string;
  createdBy: string;
  deactivatedAt: string | null;
  deactivatedBy: string | null;
  deactivateReason: string;
  counts: { members: number; tags: number; vendors: number } | null;
};

type Listing = {
  platform: string;
  accounts: PartnerAccount[];
  current: string | null;
  isAccountAdmin: boolean;
  templateVersion: number;
  reserved: string[];
};

export function useAccounts() {
  return useQuery({
    queryKey: ["dm-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/accounts");
      if (!res.ok) throw new Error("Could not read the partner accounts.");
      return (await res.json()) as Listing;
    },
  });
}

export function DmPartnersPage() {
  const qc = useQueryClient();
  const q = useAccounts();
  const [adding, setAdding] = useState(false);
  const [manage, setManage] = useState<PartnerAccount | null>(null);

  const list = q.data?.accounts ?? [];
  const admin = q.data?.isAccountAdmin === true;
  const live = list.filter((a) => a.status === "active");
  const off = list.filter((a) => a.status === "inactive");

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Partner Accounts"
        description={admin
          ? "Every partner on the platform. Open one to work in it, or add the next."
          : "The partners you can open."}
      />

      {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && (
        <p className="text-sm font-semibold text-red-600">{(q.error as Error).message}</p>
      )}

      {admin && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5
                       text-sm font-semibold text-background"
          >
            <Plus className="h-3.5 w-3.5" />
            Add New Account
          </button>
          <p className="text-xs text-muted-foreground">
            A name is all it needs. Everything else has a safe default, and nothing is
            copied from another partner.
          </p>
        </div>
      )}

      {adding && <AddAccount reserved={q.data?.reserved ?? []} onDone={() => setAdding(false)} />}

      {!q.isPending && list.length === 0 && (
        <Empty>No partner accounts are available to you.</Empty>
      )}

      {live.length > 0 && (
        <div className="space-y-2">
          {live.map((a) => (
            <AccountRow key={a.id} account={a} admin={admin} onManage={() => setManage(a)} />
          ))}
        </div>
      )}

      {off.length > 0 && (
        <div className="space-y-2">
          <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Deactivated
          </p>
          {/* Kept, and kept visible. Reviewing a dormant partner is the
              reason it was deactivated rather than removed. */}
          {off.map((a) => (
            <AccountRow key={a.id} account={a} admin={admin} onManage={() => setManage(a)} />
          ))}
        </div>
      )}

      {manage && (
        <ManageAccount
          account={manage}
          onClose={() => {
            setManage(null);
            void qc.invalidateQueries({ queryKey: ["dm-accounts"] });
          }}
        />
      )}
    </div>
  );
}

function AccountRow({
  account, admin, onManage,
}: {
  account: PartnerAccount;
  admin: boolean;
  onManage: () => void;
}) {
  const live = account.status === "active";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border
                    bg-card px-4 py-3">
      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{account.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {account.affiliation ? `${account.affiliation} · ` : ""}
          /{account.slug}
          {account.counts && (
            <>
              {" · "}
              {account.counts.members} member{account.counts.members === 1 ? "" : "s"}
              {" · "}
              {account.counts.tags} tag{account.counts.tags === 1 ? "" : "s"}
              {account.counts.vendors > 0 && ` · ${account.counts.vendors} vendor`}
              {account.counts.vendors > 1 && "s"}
            </>
          )}
        </p>
        {!live && account.deactivateReason && (
          <p className="mt-0.5 truncate text-xs text-amber-700 dark:text-amber-400">
            {account.deactivateReason}
          </p>
        )}
      </div>
      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs
                        font-semibold whitespace-nowrap ${live
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-amber-200 bg-amber-50 text-amber-700"}`}>
        {live ? "active" : "deactivated"}
      </span>
      {live && (
        <button
          type="button"
          onClick={() => openAccount(account.slug)}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-semibold"
        >
          Open Account
        </button>
      )}
      {admin && (
        <button
          type="button"
          onClick={onManage}
          className="rounded-md border border-border px-2.5 py-1 text-xs"
        >
          Manage
        </button>
      )}
    </div>
  );
}

/**
 * Add a partner.
 *
 * The name is the only thing asked for. The path is suggested from it
 * and can be corrected, because it goes in a URL that gets read over
 * the phone — and once a dealership has it in an email it should not
 * move.
 */
function AddAccount({ reserved, onDone }: { reserved: string[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  const [affiliation, setAffiliation] = useState("");
  const [error, setError] = useState("");

  const suggest = (v: string) => v.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  const path = touched ? slug : suggest(name);
  const clash = reserved.includes(path);

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dutch-miller/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, slug: path, affiliation }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not create it.");
      return body as { account: PartnerAccount; created: boolean };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dm-accounts"] });
      onDone();
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <p className="text-sm font-semibold">A new partner</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-xs font-medium">
          Partner name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Smith Ford"
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
          />
        </label>
        <label className="block text-xs font-medium">
          Wash affiliation <span className="text-muted-foreground">(optional)</span>
          <input
            value={affiliation}
            onChange={(e) => setAffiliation(e.target.value)}
            placeholder="SUDS Car Wash"
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
          />
        </label>
        <label className="block text-xs font-medium">
          Path
          <input
            value={path}
            onChange={(e) => { setTouched(true); setSlug(e.target.value); }}
            placeholder="smithford"
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5
                       font-mono text-sm"
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        The account will live at <span className="font-mono">/{path || "…"}</span>.
        {clash && (
          <span className="ml-1 font-semibold text-red-600">
            That path is reserved by the application.
          </span>
        )}
      </p>
      {/* Said out loud, because the opposite is what people expect of a
          "new account from a template" and the difference matters the
          first time somebody looks for their reviewer list in it. */}
      <p className="text-xs text-muted-foreground">
        It starts with no members, no RFID stock and no vendors. Shared users, roles and
        email settings apply to it straight away; anything specific to this partner is set
        inside the account.
      </p>
      {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={name.trim().length < 2 || !path || clash || create.isPending}
          onClick={() => { setError(""); create.mutate(); }}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5
                     text-sm font-semibold text-background disabled:opacity-50"
        >
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Check className="h-3.5 w-3.5" />}
          Create account
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-border px-3 py-1.5 text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Rename a partner, or switch it off.
 *
 * Deactivation keeps everything. What stops is operational access,
 * refused on the server so a deep link or a tab left open cannot walk
 * past it. It is NOT the partner-access switch inside the account —
 * that one pauses the emailed-link door and leaves MOJO working.
 */
function ManageAccount({
  account, onClose,
}: {
  account: PartnerAccount;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(account.name);
  const [affiliation, setAffiliation] = useState(account.affiliation);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const live = account.status === "active";

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? "Could not save it.");
    return out;
  };

  const rename = useMutation({
    mutationFn: () => post(`/api/dutch-miller/accounts/${account.id}`, { name, affiliation }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["dm-accounts"] }); onClose(); },
    onError: (e) => setError((e as Error).message),
  });

  const flip = useMutation({
    mutationFn: () => post(`/api/dutch-miller/accounts/${account.id}/status`,
      { active: !live, reason }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["dm-accounts"] }); onClose(); },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto
                    bg-black/40 p-4 sm:p-10">
      <div className="w-full max-w-lg space-y-4 rounded-xl border border-border bg-background p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{account.name}</p>
            <p className="text-xs text-muted-foreground">
              /{account.slug} · template v{account.templateVersion} · created{" "}
              {new Date(account.createdAt).toLocaleDateString()}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium">
            Partner name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
            />
          </label>
          <label className="block text-xs font-medium">
            Wash affiliation
            <input
              value={affiliation}
              onChange={(e) => setAffiliation(e.target.value)}
              placeholder="None"
              className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
            />
          </label>
        </div>
        {/* The one thing somebody will try to change and must not be
            able to: every record, link and permission hangs off it. */}
        <p className="text-xs text-muted-foreground">
          The path and the account's identifier never change. Renaming moves no records.
        </p>

        <div className="rounded-lg border border-border p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <Power className="h-3.5 w-3.5" />
            {live ? "Deactivate this partner" : "Bring this partner back"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {live
              ? "Everything is kept — members, tags, invitations, roles and history. "
                + "What stops is access: nobody but an account administrator can open it, "
                + "and a saved link is refused on the server rather than hidden."
              : `Deactivated ${account.deactivatedAt
                ? new Date(account.deactivatedAt).toLocaleDateString() : ""}`
                + `${account.deactivatedBy ? ` by ${account.deactivatedBy}` : ""}`
                + `${account.deactivateReason ? ` — ${account.deactivateReason}` : ""}`}
          </p>
          {live && (
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is it being deactivated?"
              className="mt-2 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
            />
          )}
          <button
            type="button"
            disabled={flip.isPending || (live && reason.trim().length < 5)}
            onClick={() => { setError(""); flip.mutate(); }}
            className={`mt-2 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm
                        font-semibold disabled:opacity-50 ${
              live ? "bg-red-600 text-white" : "bg-foreground text-background"}`}
          >
            {flip.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {live ? "Deactivate" : "Reactivate"}
          </button>
        </div>

        {error && (
          <p className="flex items-start gap-1.5 text-sm font-semibold text-red-600">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={rename.isPending}
            onClick={() => { setError(""); rename.mutate(); }}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background
                       disabled:opacity-50"
          >
            Save changes
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Account Settings.
 *
 * Reserved, and empty on purpose. The brief asks for the destination
 * to exist before the settings do, which is fine — as long as the
 * page says that rather than showing switches that do nothing.
 */
export function DmAccountSettingsPage() {
  return (
    <div className="space-y-5">
      <SectionTitle
        title="Account Settings"
        description="Platform-wide configuration."
      />
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Settings2 className="h-4 w-4" />
          Nothing is configured here yet
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          This section is reserved for platform settings that are not yet specified. The
          settings that exist today all live where they apply: a partner&rsquo;s name,
          affiliation and state under Partner Accounts, its RFID placement inside the
          account, and the shared users, roles, security and email configuration in their
          own sections.
        </p>
      </div>
    </div>
  );
}
