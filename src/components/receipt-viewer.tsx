import { useEffect, useState } from "react";
import { X, ExternalLink, AlertTriangle, Loader2 } from "lucide-react";
import type { ExpenseLine } from "@/lib/api";
import { moneyExact, shortDate } from "@/lib/format";

/**
 * Shows one line's receipt, fetched through our own server (never straight
 * from Emburse — the browser has no credentials and never sees an Emburse URL).
 *
 * Images render in an <img>, which cannot execute script even if the payload
 * is an SVG. PDFs go in an <object> with a link-out fallback for browsers
 * without an inline viewer.
 */
export function ReceiptViewer({ line, onClose }: { line: ExpenseLine; onClose: () => void }) {
  const [state, setState] = useState<"loading" | "pdf" | "image" | "error">("loading");
  const [message, setMessage] = useState("");

  const src = `/api/receipts/${encodeURIComponent(line.id)}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    // HEAD first: it tells us image-vs-PDF, and surfaces a JSON error message
    // instead of leaving a broken <img> on screen.
    void fetch(src, { method: "HEAD" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = (await fetch(src).then((r) => r.json()).catch(() => null)) as
            | { error?: string }
            | null;
          setMessage(body?.error ?? `Could not load the receipt (${res.status}).`);
          setState("error");
          return;
        }
        const type = res.headers.get("content-type") ?? "";
        setState(type.includes("pdf") ? "pdf" : "image");
      })
      .catch(() => {
        if (cancelled) return;
        setMessage("Could not reach the server to load the receipt.");
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70" onClick={onClose}>
      <header className="flex shrink-0 items-start justify-between gap-4 px-5 py-3 text-white">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {line.merchant} · {moneyExact(line.amount)}
          </p>
          <p className="truncate text-xs text-white/60">
            {line.category} · {shortDate(line.date)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open in a new tab"
            className="rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
          >
            <ExternalLink className="h-5 w-5" />
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close receipt"
            className="rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div
        className="flex min-h-0 flex-1 items-center justify-center px-5 pb-5"
        onClick={(e) => e.stopPropagation()}
      >
        {state === "loading" && <Loader2 className="h-6 w-6 animate-spin text-white/70" />}

        {state === "image" && (
          <img
            src={src}
            alt={`Receipt for ${line.merchant}`}
            className="max-h-full max-w-full rounded-lg bg-white object-contain shadow-2xl"
          />
        )}

        {state === "pdf" && (
          <object data={src} type="application/pdf" className="h-full w-full max-w-3xl rounded-lg bg-white">
            <div className="grid h-full place-items-center p-8 text-center text-sm">
              <p>
                This browser cannot display the PDF inline.{" "}
                <a href={src} target="_blank" rel="noreferrer" className="font-semibold underline">
                  Open it in a new tab
                </a>
                .
              </p>
            </div>
          </object>
        )}

        {state === "error" && (
          <div className="max-w-md rounded-xl bg-white p-5 text-center">
            <AlertTriangle className="mx-auto h-6 w-6 text-amber-500" />
            <p className="mt-2 text-sm font-semibold">Receipt unavailable</p>
            <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          </div>
        )}
      </div>
    </div>
  );
}
