import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

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
  return (
    <div data-receipt="ok" className="space-y-1">
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
      {state.type.startsWith("image/") ? (
        <img src={state.url} alt={alt}
             className={`w-full rounded-md border border-border object-contain ${height}`} />
      ) : (
        <iframe src={state.url} title={alt}
                className={`w-full rounded-md border border-border bg-muted/30 ${height}`} />
      )}
      <a href={state.url} target="_blank" rel="noreferrer"
         className="text-[11px] text-muted-foreground underline underline-offset-2">
        Open it in a new tab
      </a>
    </div>
  );
}
