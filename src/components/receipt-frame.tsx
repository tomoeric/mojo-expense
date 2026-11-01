import { useEffect, useState } from "react";
import { Loader2, Maximize2, X } from "lucide-react";

/**
 * A receipt, fetched and shown — or the reason it could not be.
 *
 * FETCHED, not handed to an <object> to figure out. The first
 * version of this pointed an <object> at the route with an <img>
 * inside as a fallback. When the route FAILED — and for a
 * body-only receipt it always did, because the renderer launched
 * Chromium without the flags a container needs — the browser got
 * a JSON error body, could not display it, fell through to the
 * <img>, which could not display it either, and drew a
 * broken-image icon. No message, no status, nothing to act on.
 *
 * So the fetch is explicit: a bad response is read and SHOWN, and
 * a good one becomes a blob URL whose type decides the element —
 * an <img> for an image, an <object> for the usual case, a PDF.
 *
 * It loads on mount, which is only affordable because the places
 * that use it show ONE at a time: the detail pane of the matching
 * page, and a card the reviewer has scrolled to. A list that
 * mounted three hundred of these would start three hundred Graph
 * calls and, for the body-only ones, three hundred browsers.
 */
export function ReceiptFrame({ src, alt, height = "h-80", loading }: {
  src: string;
  alt: string;
  /** Tailwind height for the frame; images are capped at the same. */
  height?: string;
  /** What to say while it is coming, when the wait has a reason. */
  loading?: string;
}) {
  const [state, setState] = useState<
    { kind: "loading" }
    | { kind: "ok"; url: string; type: string }
    | { kind: "error"; why: string }>({ kind: "loading" });
  const [open, setOpen] = useState(false);

  // Escape closes it, as it closes everything else on this screen.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // A different receipt is a different picture: never inherit the
  // last one's open state.
  useEffect(() => { setOpen(false); }, [src]);

  useEffect(() => {
    let dropped = false;
    let made = "";
    setState({ kind: "loading" });
    void (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          if (!dropped) {
            setState({
              kind: "error",
              why: body.error ?? `The receipt could not be fetched (${res.status}).`,
            });
          }
          return;
        }
        const blob = await res.blob();
        if (dropped) return;
        /*
         * WHAT IT ACTUALLY IS, not what the header claimed.
         *
         * A receipt arrives as an attachment whose declared type is
         * whatever the sending client felt like — Navan's came
         * through in a way that left the <object> below showing
         * "This plug-in isn't supported" and nothing else. The first
         * five bytes of a PDF are %PDF- and the first eight of a PNG
         * are fixed, so the file is asked rather than its label.
         */
        const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
        const text = (n: number) => String.fromCharCode(...head.slice(0, n));
        const sniffed =
          text(5) === "%PDF-" ? "application/pdf"
            : text(8) === "\x89PNG\r\n\x1a\n" ? "image/png"
              : head[0] === 0xff && head[1] === 0xd8 ? "image/jpeg"
                : blob.type;
        made = URL.createObjectURL(blob);
        setState({ kind: "ok", url: made, type: sniffed || "application/pdf" });
      } catch (e) {
        if (!dropped) setState({ kind: "error", why: (e as Error).message });
      }
    })();
    return () => {
      dropped = true;
      // Every load makes an object URL; without this they accumulate
      // for the life of the page as somebody works down a list.
      if (made) URL.revokeObjectURL(made);
    };
  }, [src]);

  if (state.kind === "loading") {
    return (
      <p data-receipt="loading"
         className={`flex items-center justify-center gap-1.5 rounded-md border
                     border-border bg-muted/30 text-xs text-muted-foreground ${height}`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {loading ?? "Fetching the receipt."}
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p data-receipt="error"
         className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs
                    text-red-700 dark:text-red-300">
        {state.why}
      </p>
    );
  }
  /*
   * FULL SCREEN ON A CLICK.
   *
   * Asked for directly: *"need to be able to click receipt image and
   * it enlarges to full screen"*. The card's frame is a thumbnail —
   * big enough to tell one receipt from another, nowhere near big
   * enough to read a folio's line items, which is the thing you are
   * being asked to judge.
   *
   * The same blob, so opening it costs nothing: no second fetch, no
   * second Graph call, and a PDF keeps the browser's own viewer with
   * its zoom and its page controls.
   */
  const full = open && (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      data-receipt-full="open"
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-50 flex flex-col bg-black/80 p-3 backdrop-blur-sm"
    >
      <div className="flex items-center gap-2 pb-2 text-xs text-white">
        <span className="truncate font-semibold">{alt}</span>
        <a href={state.url} target="_blank" rel="noreferrer"
           onClick={(e) => e.stopPropagation()}
           className="ml-auto underline underline-offset-2">
          Open it in a new tab
        </a>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex items-center gap-1 rounded-lg border border-white/40
                     px-2 py-1 font-semibold hover:bg-white/10"
        >
          <X className="h-3.5 w-3.5" />
          Close
        </button>
      </div>
      {/* Stops a click on the receipt itself from closing it — the
          backdrop closes, the document does not. */}
      <div className="min-h-0 flex-1" onClick={(e) => e.stopPropagation()}>
        {state.type.startsWith("image/") ? (
          <img src={state.url} alt={alt}
               className="h-full w-full rounded-md bg-white object-contain" />
        ) : (
          <iframe src={state.url} title={alt}
                  className="h-full w-full rounded-md border-0 bg-white" />
        )}
      </div>
    </div>
  );

  return (
    <div data-receipt="ok" className="space-y-1">
      {full}
      {/*
        * AN IFRAME FOR A PDF, NOT AN OBJECT.
        *
        * `<object type="application/pdf">` is how you get Chrome's
        * grey jigsaw and **"This plug-in isn't supported"** — it
        * asks for a plug-in by that MIME type and the built-in
        * viewer is not one. An iframe pointed at the same blob
        * opens the viewer, which is what every other PDF on the
        * web does. The lesson is narrow and worth keeping: object
        * is for plug-ins, iframe is for documents.
        */}
      <div className="group relative">
        {state.type.startsWith("image/") ? (
          <img src={state.url} alt={alt}
               onClick={() => setOpen(true)}
               className={`w-full cursor-zoom-in rounded-md border border-border
                           object-contain ${height}`} />
        ) : (
          <>
            <iframe src={state.url} title={alt}
                    className={`w-full rounded-md border border-border bg-muted/30 ${height}`} />
            {/*
              * A PDF's own viewer swallows the click, so the whole
              * frame cannot be the target — the iframe would eat it
              * and scroll instead. A corner button is the honest
              * answer, and it sits over the viewer's own chrome
              * rather than fighting it.
              */}
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Show the receipt full screen"
              className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg
                         border border-border bg-background/90 px-2 py-1 text-[11px]
                         font-semibold shadow-sm hover:bg-muted"
            >
              <Maximize2 className="h-3 w-3" />
              Full screen
            </button>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[11px] text-muted-foreground underline underline-offset-2"
        >
          Show it full screen
        </button>
        <a href={state.url} target="_blank" rel="noreferrer"
           className="text-[11px] text-muted-foreground underline underline-offset-2">
          Open it in a new tab
        </a>
      </div>
    </div>
  );
}
