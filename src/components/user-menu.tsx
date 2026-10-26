import { useState } from "react";
import {
  Crown, KeyRound, ListChecks, LogOut, ScrollText, Shield, SlidersHorizontal,
  UserRound, Users,
} from "lucide-react";
import { APP_LABEL, type AppKey, type SessionUser } from "@/lib/api";

/** One per administrative destination, so the menu scans at a glance. */
const DM_ICON: Record<string, React.ReactNode> = {
  users: <Users className="h-4 w-4" />,
  roles: <Crown className="h-4 w-4" />,
  security: <Shield className="h-4 w-4" />,
  email: <SlidersHorizontal className="h-4 w-4" />,
  audit: <ScrollText className="h-4 w-4" />,
};

/** Signed-in identity + sign out, in the dark header bar. */
export function UserMenu({
  user,
  isAdmin,
  product = "emburse",
  dmDestinations = [],
  onDmGo,
  onManagerQueue,
}: {
  user: SessionUser;
  isAdmin: boolean;
  /**
   * Which product's items to offer below the switcher. Identity, the
   * switcher and sign-out are shared; everything else is one app's own, and
   * offering Emburse's settings inside Dutch Miller would be a link into a
   * 403 for somebody who holds only the one.
   */
  product?: AppKey;
  /** Administers Dutch Miller — a separate question from Emburse's `isAdmin`. */
  /**
   * The administrative pages this person may open, in menu order.
   *
   * Built from what the server already said they hold, so the menu
   * never offers a door into a 403 — and listing one here grants
   * nothing: every route behind them refuses independently.
   */
  dmDestinations?: { key: string; label: string }[];
  onDmGo?: (key: string) => void;
  /**
   * Opens the manager-queue switches. Absent hides the item.
   *
   * Only the account owner is given it — it switches off the queue
   * the approvals come from, for somebody else, and that was asked to
   * be one person's to flip rather than any administrator's.
   */
  onManagerQueue?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const initials =
    user.name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] ?? "")
      .join("")
      .toUpperCase() || "?";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={user.email}
        className="flex items-center gap-2 rounded-full py-1 pr-2.5 pl-1 text-xs text-white/80 transition-colors hover:bg-white/10 hover:text-white"
      >
        <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15 text-[10px] font-bold">
          {initials}
        </span>
        <span className="hidden max-w-40 truncate sm:inline">{user.name}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-60 overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg">
            <div className="border-b border-border px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <UserRound className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{user.name}</span>
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
            {product === "emburse" && (
              <>
                {/* Everyone has their own Emburse login; only admins set the
                    export scope, which governs what everybody sees. */}
                <a
                  href="#/emburse-login"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted"
                >
                  <KeyRound className="h-4 w-4" />
                  Your Emburse login
                </a>
                {isAdmin && (
                  <a
                    href="#/settings"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted"
                  >
                    <SlidersHorizontal className="h-4 w-4" />
                    Export settings
                  </a>
                )}
                {onManagerQueue && (
                  <button
                    type="button"
                    onClick={() => { setOpen(false); onManagerQueue(); }}
                    className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <ListChecks className="h-4 w-4" />
                    Manager queue
                  </button>
                )}
              </>
            )}
            {/* Each destination, directly. No Administration entry and
                no intermediate page: one click opens the actual page.
                The list comes from the server's answer about this
                person, so it never offers a door into a 403, and every
                route behind it still refuses on its own. */}
            {/* Not gated on administering any more. The list itself
                is already filtered to what this person holds, and
                Vendors is granted by role rather than by level — so
                a second check here would hide it from exactly the
                people it was granted to. */}
            {product === "dutch-miller" && onDmGo
              && dmDestinations.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => { setOpen(false); onDmGo(d.key); }}
                  className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted"
                >
                  {DM_ICON[d.key] ?? <SlidersHorizontal className="h-4 w-4" />}
                  {d.label}
                </button>
              ))}
            {/* The separator the brief asks for: sign-out is a
                different kind of thing from the destinations above. */}
            <a
              href="/api/logout"
              className="flex items-center gap-2 border-t-2 border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </a>
          </div>
        </>
      )}
    </div>
  );
}
