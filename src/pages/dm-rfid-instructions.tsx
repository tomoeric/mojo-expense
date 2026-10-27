import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrangedPage } from "@/components/buckets";
import { useState } from "react";
import { AlertTriangle, Check, ImageOff, Loader2, X } from "lucide-react";

/**
 * Where the sticker goes, and how to apply it.
 *
 * Written for somebody standing at a vehicle with a sticker in their
 * hand, so the rule comes first and the reasons come after. Every
 * "do not" on the page is a tag that will not read — the reader is in
 * a fixed position at the lane entrance, and a sticker anywhere else
 * is a member who stops at the gate.
 *
 * TWO VARIANTS, chosen by an administrator, because the answer is a
 * property of the tags rather than a preference: an adhesive meant
 * for the inside of the glass fails on the outside and the reverse.
 * Both are kept here together rather than as two pages, so the thing
 * that differs between them is visible to whoever edits either one —
 * and so the confirmation a dealer ticks at submission can be driven
 * by the same value instead of being copy nobody remembers to change.
 */

export type Placement = "inside" | "outside";

type Variant = {
  label: string;
  /** The rule, in one sentence, for somebody at the vehicle. */
  rule: string;
  image: string;
  alt: string;
  caption: string;
  does: string[];
  donts: string[];
};

export const PLACEMENT: Record<Placement, Variant> = {
  inside: {
    label: "Inside the glass",
    rule: "The RFID sticker must be physically attached to the INSIDE of the front "
      + "windshield, at the bottom-left on the driver's side.",
    image: "/rfid-sticker-placement.webp",
    alt: "A vehicle at a wash entrance with the RFID sticker circled at the "
      + "bottom-left corner of the windshield on the driver's side, and an inset "
      + "showing the same sticker seen from the driver's seat.",
    caption: "Bottom-left of the front windshield, driver's side, applied on the "
      + "inside of the glass.",
    does: [
      "Inside the windshield, on the glass itself.",
      "Bottom-left corner, on the driver's side.",
      "Flat and square to the edge of the glass, with no bubbles or creases.",
      "Clear of the wiper sweep, the rain sensor and any shaded or heated strip.",
      "Clean and dry the glass first — a sticker that lifts is one that stops reading.",
    ],
    donts: [
      "Not on the outside of the glass.",
      "Not anywhere it sits in the driver's line of sight.",
      "Not on a tinted band, behind a mirror housing, or over an existing toll tag.",
      "Not folded over an edge, trimmed, or cut down to fit.",
      "Never moved once applied — removing one damages the tag. Ask MOJO for a replacement.",
    ],
  },
  outside: {
    label: "Outside the glass",
    rule: "The RFID sticker must be physically attached to the OUTSIDE of the front "
      + "windshield, at the bottom-left on the driver's side.",
    image: "/rfid-sticker-placement-outside.webp",
    alt: "A vehicle at a wash entrance with the RFID sticker circled at the "
      + "bottom-left corner of the windshield on the driver's side, applied to the "
      + "outer face of the glass.",
    caption: "Bottom-left of the front windshield, driver's side, applied on the "
      + "outside of the glass.",
    does: [
      "Outside the windshield, on the outer face of the glass.",
      "Bottom-left corner, on the driver's side.",
      "Flat and square to the edge of the glass, with no bubbles or creases.",
      // The two that only matter out here, and the reason the pages differ.
      "Clear of the wiper sweep — a blade crossing the edge of a tag lifts it within weeks.",
      "Clean and DRY the glass first, then press firmly for several seconds. Cold or damp "
        + "glass is the usual reason an outside tag comes off.",
      "Leave it unwashed for 24 hours so the adhesive cures before it goes through a wash.",
    ],
    donts: [
      "Not on the inside of the glass.",
      "Not anywhere it sits in the driver's line of sight.",
      "Not on a tinted band, a chip or a crack, or over an existing toll tag.",
      "Not folded over an edge, trimmed, or cut down to fit.",
      "Not where a wiper blade or washer jet crosses it.",
      "Never moved once applied — removing one damages the tag. Ask MOJO for a replacement.",
    ],
  },
};

/** One line, for a checkbox or an email. Shared so the wording cannot drift. */
export const placementLine = (p: Placement): string =>
  `The RFID sticker has been physically attached to the ${
    p === "inside" ? "inside" : "outside"
  } of the front windshield, bottom-left on the driver's side.`;

export function DmRfidInstructionsPage({ isAdmin = false }: { isAdmin?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["dm-placement"],
    queryFn: async () => {
      const res = await fetch("/api/dutch-miller/settings/placement");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load.");
      return (await res.json()) as {
        placement: Placement; updatedAt: string | null; updatedBy: string | null;
      };
    },
  });

  const save = useMutation({
    mutationFn: async (placement: Placement) => {
      const res = await fetch("/api/dutch-miller/settings/placement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ placement }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save it.");
      return body;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dm-placement"] });
      // The signup form's confirmation reads the same value.
      void qc.invalidateQueries({ queryKey: ["dm-me"] });
    },
  });

  const placement = q.data?.placement ?? "inside";
  const v = PLACEMENT[placement];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">RFID Instructions</h1>
          <p className="text-sm text-muted-foreground">
            Where the sticker goes on the vehicle, and how to apply it.
          </p>
        </div>
        {isAdmin && (
          <PlacementToggle
            placement={placement}
            busy={save.isPending}
            updatedAt={q.data?.updatedAt ?? null}
            updatedBy={q.data?.updatedBy ?? null}
            onPick={(p) => save.mutate(p)}
          />
        )}
      </div>

      {save.isError && (
        <p className="text-sm font-semibold text-red-600">{(save.error as Error).message}</p>
      )}

      {/* The page, in whichever buckets this account has arranged. The
          placement rule and the number-match warning cannot be hidden:
          hiding either would not change the rule, only somebody's
          chance of reading it before they stick a tag on glass. */}
      <InstructionBuckets v={v} placement={placement} />
    </div>
  );
}

/**
 * The diagram, or an honest gap where one is not here yet.
 *
 * Falling back to the other variant's photograph would be worse than
 * showing none: it is a picture of the thing the page is telling
 * somebody not to do. So a missing file says so, and says where to
 * put one.
 */
function Diagram({
  src, alt, caption, placement,
}: {
  src: string; alt: string; caption: string; placement: Placement;
}) {
  const [missing, setMissing] = useState(false);

  if (missing) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-center">
        <ImageOff className="mx-auto h-5 w-5 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">No diagram for {placement} placement yet</p>
        <p className="mx-auto mt-1 max-w-lg text-xs text-muted-foreground">
          The written instructions below are complete and correct. To add the picture,
          drop the image at <code>public{src}</code> and rebuild — nothing else needs
          changing. The other variant's photograph is deliberately not shown here: it
          pictures the opposite of what this page is asking for.
        </p>
      </div>
    );
  }

  return (
    <figure className="overflow-hidden rounded-xl border border-border">
      <img
        src={src}
        alt={alt}
        onError={() => setMissing(true)}
        className="block w-full"
      />
      <figcaption className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}

/**
 * Which face of the glass, set by an administrator.
 *
 * On this page rather than in a settings screen, because this page is
 * the thing being changed: you pick, and you are looking at what
 * everybody else will read.
 */
function PlacementToggle({
  placement, busy, updatedAt, updatedBy, onPick,
}: {
  placement: Placement;
  busy: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  onPick: (p: Placement) => void;
}) {
  return (
    <div className="shrink-0 text-right">
      <div
        role="radiogroup"
        aria-label="Where the sticker goes"
        className="inline-flex overflow-hidden rounded-md border border-border"
      >
        {(["inside", "outside"] as const).map((p) => (
          <button
            key={p}
            role="radio"
            type="button"
            aria-checked={placement === p}
            disabled={busy}
            onClick={() => { if (p !== placement) onPick(p); }}
            className={`px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
              placement === p
                ? "bg-foreground font-semibold text-background"
                : "hover:bg-muted"
            }`}
          >
            {busy && placement !== p
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : PLACEMENT[p].label}
          </button>
        ))}
      </div>
      <p className="mt-1 max-w-56 text-[11px] text-muted-foreground">
        Changes this page and the confirmation on every new signup.
        {updatedAt && (
          <> Set {new Date(updatedAt).toLocaleDateString()}
          {updatedBy ? ` by ${updatedBy}` : ""}.</>
        )}
      </p>
    </div>
  );
}

/**
 * The instructions, in the buckets this account has arranged.
 *
 * The variants themselves do not move: inside and outside are two
 * sets of copy for one stored setting, and which one is shown is the
 * placement, never the layout. What an account can change is the
 * order and the width of the pieces, and whether the illustrated
 * guide and the two lists appear at all.
 *
 * The rule and the number-match warning are registered as essential,
 * so neither can be taken off. Hiding "check the number" would not
 * make a mis-stuck tag any easier to undo.
 */
function InstructionBuckets({ v, placement }: { v: Variant; placement: Placement }) {
  const render = (key: string): React.ReactNode => {
    switch (key) {
      case "rule":
        return (
          <p className="text-sm">
            <strong>{v.rule}</strong>{" "}
            Apply it neatly and squarely to the glass, where it does not obstruct the
            driver&rsquo;s view. The reader at the lane entrance is in a fixed position — a
            sticker placed anywhere else may not scan, and the member will be stopped at
            the gate.
          </p>
        );
      case "diagram":
        return <Diagram src={v.image} alt={v.alt} caption={v.caption} placement={placement} />;
      case "dos":
        return (
          <div>
            <h4 className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">
              <Check className="h-4 w-4" />
              Do
            </h4>
            <ul className="mt-2 space-y-1.5 text-sm">
              {v.does.map((line) => (
                <li key={line} className="flex gap-2">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      case "donts":
        return (
          <div>
            <h4 className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400">
              <X className="h-4 w-4" />
              Do not
            </h4>
            <ul className="mt-2 space-y-1.5 text-sm">
              {v.donts.map((line) => (
                <li key={line} className="flex gap-2">
                  <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      case "numberMatch":
        return (
          <p className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Check the number on the sticker against the one on the signup before applying
              it. Each tag is issued to one member and one vehicle, and a tag on the wrong
              windshield cannot be undone from here — it has to be replaced.
            </span>
          </p>
        );
      default: return null;
    }
  };

  // Until the layout lands, the rule and the warning. Not a spinner:
  // somebody is standing at a vehicle holding a sticker.
  return (
    <ArrangedPage
      page="rfid-instructions"
      render={render}
      fallback={(
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            {render("rule")}
          </div>
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            {render("numberMatch")}
          </div>
        </div>
      )}
    />
  );
}
