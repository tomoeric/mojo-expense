import { LogIn, ShieldCheck } from "lucide-react";

/** Full-page sign-in gate, shown whenever no session cookie is present. */
export function SignIn({ authConfigured }: { authConfigured: boolean }) {
  return (
    <div className="grid min-h-screen place-items-center px-5">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-xl font-extrabold tracking-tight">MOJO Expense</h1>
        <p className="mt-1 text-sm text-muted-foreground">Emburse reviewer console</p>

        {authConfigured ? (
          <>
            <a
              href={`/api/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.hash)}`}
              className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800"
            >
              <LogIn className="h-4 w-4" />
              Sign in with Microsoft
            </a>
            <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Restricted to your Microsoft 365 account
            </p>
          </>
        ) : (
          <div className="mt-7 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-left text-sm">
            <p className="font-semibold text-amber-900">Sign-in is not configured</p>
            <p className="mt-1 text-amber-800">
              Set <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">AZURE_TENANT_ID</code>,{" "}
              <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">AZURE_CLIENT_ID</code> and{" "}
              <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">AZURE_CLIENT_SECRET</code> as
              Secrets, then restart.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
