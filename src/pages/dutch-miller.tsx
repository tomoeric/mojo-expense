import { Building2 } from "lucide-react";

/**
 * Dutch Miller — the second app on this deployment.
 *
 * Intentionally a shell. The work that had to come first is the split it
 * sits inside: assignment by email, a server that REFUSES the other
 * product's routes rather than merely hiding them, and a switcher for
 * whoever holds both. Pages land here once the configuration is settled.
 */
export function DutchMillerPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <div className="rounded-xl border border-border bg-card p-8">
        <div className="flex items-start gap-3">
          <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="space-y-3">
            <div>
              <h1 className="text-lg font-semibold">Dutch Miller</h1>
              <p className="text-sm text-muted-foreground">
                Set up and running on this deployment — not configured yet.
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              Sign-in, who can reach this app, and the separation from Emburse are all in
              place. What goes on these pages comes next.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
