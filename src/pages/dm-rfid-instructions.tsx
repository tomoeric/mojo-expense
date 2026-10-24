import { AlertTriangle, Check, X } from "lucide-react";

/**
 * Where the sticker goes, and how to apply it.
 *
 * Written for somebody standing at a vehicle with a sticker in their
 * hand, so the rule comes first and the reasons come after. Every
 * "do not" on the page is a tag that will not read — the reader is in
 * a fixed position at the lane entrance, and a sticker anywhere else
 * is a member who stops at the gate.
 */

const DO = [
  "Inside the windshield, on the glass itself.",
  "Bottom-left corner, on the driver's side.",
  "Flat and square to the edge of the glass, with no bubbles or creases.",
  "Clear of the wiper sweep, the rain sensor and any shaded or heated strip.",
  "Clean and dry the glass first — a sticker that lifts is one that stops reading.",
];

const DONT = [
  "Not on the outside of the glass.",
  "Not anywhere it sits in the driver's line of sight.",
  "Not on a tinted band, behind a mirror housing, or over an existing toll tag.",
  "Not folded over an edge, trimmed, or cut down to fit.",
  "Never moved once applied — removing one damages the tag. Ask MOJO for a replacement.",
];

export function DmRfidInstructionsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">RFID Instructions</h1>
        <p className="text-sm text-muted-foreground">
          Where the sticker goes on the vehicle, and how to apply it.
        </p>
      </div>

      <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
        <strong>The RFID sticker must be physically attached to the inside of the front
        windshield, at the bottom-left on the driver's side.</strong>{" "}
        Apply it neatly and squarely to the glass, where it does not obstruct the driver's
        view. The reader at the lane entrance is in a fixed position — a sticker placed
        anywhere else may not scan, and the member will be stopped at the gate.
      </p>

      <figure className="overflow-hidden rounded-xl border border-border">
        <img
          src="/rfid-sticker-placement.webp"
          alt="A vehicle at a wash entrance with the RFID sticker circled at the
               bottom-left corner of the windshield on the driver's side, and an inset
               showing the same sticker seen from the driver's seat."
          className="block w-full"
        />
        <figcaption className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Bottom-left of the front windshield, driver's side, applied on the inside of
          the glass.
        </figcaption>
      </figure>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">
            <Check className="h-4 w-4" />
            Do
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {DO.map((line) => (
              <li key={line} className="flex gap-2">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-red-500/40 bg-red-500/5 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400">
            <X className="h-4 w-4" />
            Do not
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {DONT.map((line) => (
              <li key={line} className="flex gap-2">
                <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* The one mistake that is expensive rather than merely annoying:
          a tag read onto the wrong vehicle is a membership nobody can
          trace back without going through the pool by hand. */}
      <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Check the number on the sticker against the one on the signup before applying it.
          Each tag is issued to one member and one vehicle, and a tag on the wrong
          windshield cannot be undone from here — it has to be replaced.
        </span>
      </p>
    </div>
  );
}
