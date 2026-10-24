import { useState } from "react";
import {
  LogOut, UserRound, SlidersHorizontal, KeyRound, LayoutGrid, Check, ChevronRight,
  Crown, Users,
} from "lucide-react";
import { APP_LABEL, type AppKey, type SessionUser } from "@/lib/api";

/** Signed-in identity + sign out, in the dark header bar. */
export function UserMenu({
  user,
  isAdmin,
  apps = [],
  app = null,
  onSwitchApp,
  product = "emburse",
  dmAdmin = false,
  onDmUsers,
  onDmRoles,
  onDmSettings,
}: {
  user: SessionUser;
  isAdmin: boolean;
  /** Every product this person may use. One or none means no switcher. */
  apps?: AppKey[];
  app?: AppKey | null;
  onSwitchApp?: (next: AppKey) => void;
  /**
   * Which product's items to offer below the switcher. Identity, the
   * switcher and sign-out are shared; everything else is one app's own, and
   * offering Emburse's settings inside Dutch Miller would be a link into a
   * 403 for somebody who holds only the one.
   */
  product?: AppKey;
  /** Administers Dutch Miller — a separate question from Emburse's `isAdmin`. */
  dmAdmin?: boolean;
  /** Opens the Users dialog over whatever is on screen. */
  onDmUsers?: () => void;
  /** Only passed for a super administrator; absent hides the item. */
  onDmRoles?: () => void;
  onDmSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  // Only for somebody who actually holds more than one. A switcher
  // offering a single choice is furniture, and one offering a product
  // they cannot open is a door into a 403.
  const canSwitch = apps.length > 1 && Boolean(onSwitchApp);
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
            {canSwitch && (
              <div className="border-b border-border">
                <button
                  type="button"
                  onClick={() => setAppsOpen((v) => !v)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-sm transition-colors hover:bg-muted"
                >
                  <LayoutGrid className="h-4 w-4" />
                  <span className="flex-1 text-left">App</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {app ? APP_LABEL[app] : ""}
                  </span>
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 transition-transform ${appsOpen ? "rotate-90" : ""}`}
                  />
                </button>
                {appsOpen && (
                  <div className="bg-muted/40 pb-1">
                    {apps.map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          if (key !== app) onSwitchApp?.(key);
                        }}
                        className="flex w-full items-center gap-2 py-2 pr-3 pl-9 text-sm transition-colors hover:bg-muted"
                      >
                        <span className="flex-1 text-left">{APP_LABEL[key]}</span>
                        {key === app && <Check className="h-3.5 w-3.5 shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
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
              </>
            )}
            {/* Administering the app, kept out of the rail: the rail is
                for the pages people come here to work in. */}
            {product === "dutch-miller" && dmAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => { setOpen(false); onDmUsers?.(); }}
                  className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted"
                >
                  <Users className="h-4 w-4" />
                  Users
                </button>
                {onDmRoles && (
                  <button
                    type="button"
                    onClick={() => { setOpen(false); onDmRoles(); }}
                    className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <Crown className="h-4 w-4" />
                    Roles
                  </button>
                )}
                {onDmSettings && (
                  <button
                    type="button"
                    onClick={() => { setOpen(false); onDmSettings(); }}
                    className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <SlidersHorizontal className="h-4 w-4" />
                    Email Settings
                  </button>
                )}
              </>
            )}
            <a
              href="/api/logout"
              className="flex items-center gap-2 border-t border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted"
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
