import { useEffect, useState } from "react";
import { Building2, Check, Loader2, Mail, ShieldCheck } from "lucide-react";

/**
 * The dealer door: the three screens somebody sees before they are signed in.
 *
 *   Ask for a link   — one field, and the same answer every time.
 *   Set up account   — after an invite link, with the emailed code.
 *   Enter code       — after a login link opened on another device.
 *
 * Nothing here is told whether an address exists. The copy says "if that
 * address has access" and means it: the server behaves the same either
 * way, and a screen that was more helpful than that would be a way to
 * find out who has an account.
 */

const card = "w-full max-w-sm rounded-xl border border-border bg-card p-6 text-left";
const input = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
const primary = "inline-flex w-full items-center justify-center gap-2 rounded-md "
  + "bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-extrabold tracking-tight">Dutch Miller</h1>
          <p className="mt-1 text-sm text-muted-foreground">Member portal · MOJO Car Wash</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Ask for a link
 * ------------------------------------------------------------------ */

/** Why we are back at the sign-in screen, when a link brought us here. */
const LINK_TROUBLE: Record<string, string> = {
  used: "That link has already been used. Ask for a new one below.",
  expired: "That link has expired. Ask for a new one below.",
  unknown: "That link is not valid. Ask for a new one below.",
  inactive: "That account is not active. Ask your MOJO contact.",
};

export function DealerSignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trouble = LINK_TROUBLE[new URLSearchParams(
    window.location.hash.split("?")[1] ?? "").get("link") ?? ""] ?? "";

  const ask = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/dm-auth/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? "Something went wrong."); return; }
      setSent(true);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      {trouble && !sent && (
        <p className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200">
          {trouble}
        </p>
      )}

      {sent ? (
        <div className={card}>
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Mail className="h-4 w-4 shrink-0" />
            Check your email
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            If {email} has access, a sign-in link is on its way. It works once and
            expires in 15 minutes.
          </p>
          <button
            type="button"
            onClick={() => setSent(false)}
            className="mt-4 text-sm text-sky-600 hover:underline"
          >
            Use a different address
          </button>
        </div>
      ) : (
        <form
          className={card}
          onSubmit={(e) => { e.preventDefault(); void ask(); }}
        >
          <label htmlFor="dealer-email" className="mb-1 block text-xs text-muted-foreground">
            Work email
          </label>
          <input
            id="dealer-email"
            type="email"
            autoFocus
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@dealership.com"
            className={input}
          />
          {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={busy || email.trim() === ""} className={`${primary} mt-4`}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {busy ? "Sending…" : "Email me a sign-in link"}
          </button>
          {/* Said plainly, because somebody who was never invited will
              otherwise keep trying and assume the app is broken. */}
          <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Access is by invitation. If MOJO has not set up an account for your address,
            no link will arrive — ask your MOJO contact.
          </p>
        </form>
      )}

      <p className="mt-5 text-center text-xs text-muted-foreground">
        MOJO staff: <a href="/api/login" className="text-sky-600 hover:underline">
          sign in with Microsoft</a>
      </p>
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Set up the account, after an invite
 * ------------------------------------------------------------------ */

type Pending = { email: string | null; kind: "invite" | "login" | null };

function usePending(): { pending: Pending | null; loading: boolean } {
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/dm-auth/pending");
        setPending((await res.json()) as Pending);
      } catch {
        setPending({ email: null, kind: null });
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  return { pending, loading };
}

const FIELDS = [
  { key: "firstName", label: "First name", autoComplete: "given-name" },
  { key: "lastName", label: "Last name", autoComplete: "family-name" },
  { key: "business", label: "Business affiliation", autoComplete: "organization" },
  { key: "phone", label: "Contact number", autoComplete: "tel" },
] as const;

export function DealerWelcome() {
  const { pending, loading } = usePending();
  const [form, setForm] = useState({ firstName: "", lastName: "", business: "", phone: "" });
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  if (loading) return <Frame><p className="text-center text-sm text-muted-foreground">Loading…</p></Frame>;
  if (!pending?.email || pending.kind !== "invite") return <Expired />;

  const submit = async () => {
    setBusy(true);
    setError("");
    setErrors({});
    try {
      const res = await fetch("/api/dm-auth/onboard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, code }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.errors) setErrors(body.errors);
        else setError(body.error ?? "Something went wrong.");
        return;
      }
      // Signed in. A full load, so every query starts against the new session.
      window.location.href = "/";
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      <form className={card} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Building2 className="h-4 w-4 shrink-0" />
          Set up your account
        </p>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">
          Signing in as <strong className="text-foreground">{pending.email}</strong>.
        </p>

        <div className="space-y-3">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={f.key} className="mb-1 block text-xs text-muted-foreground">
                {f.label}
              </label>
              <input
                id={f.key}
                autoComplete={f.autoComplete}
                value={form[f.key]}
                onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                className={`${input} ${errors[f.key] ? "border-red-500" : ""}`}
              />
              {errors[f.key] && (
                <p role="alert" className="mt-1 text-xs text-red-600">{errors[f.key]}</p>
              )}
            </div>
          ))}

          <div className="border-t border-border pt-3">
            <label htmlFor="code" className="mb-1 block text-xs text-muted-foreground">
              Confirmation code — we emailed it to {pending.email}
            </label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              className={`${input} font-mono text-lg tracking-[.3em] ${errors.code ? "border-red-500" : ""}`}
            />
            {errors.code && <p role="alert" className="mt-1 text-xs text-red-600">{errors.code}</p>}
            <ResendCode onDone={() => setResent(true)} done={resent} />
          </div>
        </div>

        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}

        <button type="submit" disabled={busy} className={`${primary} mt-4`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {busy ? "Setting up…" : "Finish and sign in"}
        </button>
      </form>
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Enter the code, after a link opened elsewhere
 * ------------------------------------------------------------------ */

export function DealerVerify() {
  const { pending, loading } = usePending();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (loading) return <Frame><p className="text-center text-sm text-muted-foreground">Loading…</p></Frame>;
  if (!pending?.email || pending.kind !== "login") return <Expired />;

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/dm-auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? "Something went wrong."); return; }
      window.location.href = "/";
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      <form className={card} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="text-sm font-semibold">One more step</p>
        {/* Worth explaining: otherwise being asked for a code only on the
            phone looks like a glitch rather than the point. */}
        <p className="mt-1 mb-4 text-sm text-muted-foreground">
          You opened the link on a different device from the one you asked on, so enter
          the code from the same email to finish signing in as{" "}
          <strong className="text-foreground">{pending.email}</strong>.
        </p>
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          className={`${input} font-mono text-lg tracking-[.3em]`}
        />
        {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy || code.length < 6} className={`${primary} mt-4`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </Frame>
  );
}

function ResendCode({ onDone, done }: { onDone: () => void; done: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      {done ? "A new code is on its way." : (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void fetch("/api/dm-auth/resend-code", { method: "POST" })
              .then(onDone).finally(() => setBusy(false));
          }}
          className="text-sky-600 hover:underline disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send me a new code"}
        </button>
      )}
    </p>
  );
}

function Expired() {
  return (
    <Frame>
      <div className={card}>
        <p className="text-sm font-semibold">That link is no longer valid</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Links work once and expire. Ask for a new one, or speak to your MOJO contact
          if you have not been set up yet.
        </p>
        <a href="/#/signin" className={`${primary} mt-4`}>Back to sign in</a>
      </div>
    </Frame>
  );
}
