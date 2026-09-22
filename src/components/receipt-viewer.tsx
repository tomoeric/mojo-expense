import { useCallback, useEffect, useRef, useState } from "react";
import { X, ExternalLink, AlertTriangle, Loader2, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
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

  // Zoom is 1 = fit to the pane. Pan is only meaningful once zoomed in.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const MIN = 1;
  const MAX = 8;
  const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z));

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  /** Zoom about a point so the pixel under the cursor stays put. */
  const zoomAt = useCallback((factor: number, originX = 0, originY = 0) => {
    setZoom((prev) => {
      const next = clamp(prev * factor);
      if (next === prev) return prev;
      const ratio = next / prev;
      setPan((p) => ({
        x: originX - (originX - p.x) * ratio,
        y: originY - (originY - p.y) * ratio,
      }));
      return next;
    });
  }, []);

  const src = `/api/receipts/${encodeURIComponent(line.id)}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomAt(1.25);
      else if (e.key === "-" || e.key === "_") zoomAt(1 / 1.25);
      else if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, zoomAt, reset]);

  // A new receipt starts fit to the pane.
  useEffect(reset, [line.id, reset]);

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
    /* No click-outside-to-close. It used to fire for the zoom controls and the
       receipt itself, so the first click on anything dismissed the viewer; and
       once panning exists, a stray click after a drag closing the image is
       worse than having no shortcut. Escape and the X button close it. */
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70">
      <header className="flex shrink-0 items-start justify-between gap-4 px-5 py-3 text-white">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {line.merchant} · {moneyExact(line.amount)}
          </p>
          <p className="truncate text-xs text-white/60">
            {line.category} · {shortDate(line.date)}
            {state === "image" && (
              <span className="hidden sm:inline"> · scroll to zoom, drag to move, double-click to toggle</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {state === "image" && (
            <div className="mr-2 flex items-center gap-1 rounded-lg bg-white/10 p-0.5">
              <button
                type="button"
                onClick={() => zoomAt(1 / 1.25)}
                disabled={zoom <= MIN}
                aria-label="Zoom out"
                className="rounded p-1.5 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={reset}
                title="Reset to fit (0)"
                className="tnum min-w-14 rounded px-1 text-xs font-semibold text-white/80 hover:bg-white/10 hover:text-white"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => zoomAt(1.25)}
                disabled={zoom >= MAX}
                aria-label="Zoom in"
                className="rounded p-1.5 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={reset}
                aria-label="Fit to window"
                className="rounded p-1.5 text-white/80 hover:bg-white/10 hover:text-white"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>
          )}
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
          <div
            className={`flex h-full w-full items-center justify-center overflow-hidden ${
              zoom > 1 ? (drag.current ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
            }`}
            onWheel={(e) => {
              // Ctrl/⌘+wheel is the pinch gesture on a trackpad; plain wheel
              // zooms too, since there is nothing else to scroll in here.
              const rect = e.currentTarget.getBoundingClientRect();
              zoomAt(
                e.deltaY < 0 ? 1.15 : 1 / 1.15,
                e.clientX - rect.left - rect.width / 2,
                e.clientY - rect.top - rect.height / 2,
              );
            }}
            onDoubleClick={() => (zoom > 1 ? reset() : zoomAt(3))}
            onPointerDown={(e) => {
              if (zoom <= 1) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              setPan({ x: d.panX + (e.clientX - d.x), y: d.panY + (e.clientY - d.y) });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
          >
            <img
              src={src}
              alt={`Receipt for ${line.merchant}`}
              draggable={false}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transition: drag.current ? "none" : "transform 120ms ease-out",
              }}
              className="max-h-full max-w-full rounded-lg bg-white object-contain shadow-2xl select-none"
            />
          </div>
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
