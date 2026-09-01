import { useState } from "react";
import { LogOut, UserRound } from "lucide-react";
import type { SessionUser } from "@/lib/api";

/** Signed-in identity + sign out, in the dark header bar. */
export function UserMenu({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
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
            <a
              href="/api/logout"
              className="flex items-center gap-2 px-3 py-2.5 text-sm transition-colors hover:bg-muted"
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
