import { useMemo } from "react";
import { marked } from "marked";
// Imported at BUILD time, straight from the repo, so the page cannot drift
// from the document. A copy pasted into a component is a second version of
// the truth, and the one nobody edits is the one people read.
import source from "../../docs/EMBURSE.md?raw";

/**
 * How the app drives Emburse, rendered where the questions get asked.
 *
 * The document lived only in `docs/`, which means GitHub — relative links
 * from the README do not resolve in Replit's editor, so clicking through to
 * it simply failed. A reference nobody can open is a reference nobody uses,
 * and every question it answers comes back as a question.
 *
 * Rendered from the file rather than duplicated: `?raw` is Vite inlining the
 * repo's own bytes at build time, so shipping an edit to the document ships
 * the page.
 */
export function HowEmburseWorksPage() {
  const html = useMemo(() => {
    // Trusted input — this is our own checked-in file, inlined at build
    // time, not anything a request can influence. Nothing here is reachable
    // by a user of the app.
    marked.setOptions({ gfm: true, breaks: false });
    return marked.parse(source) as string;
  }, []);

  return (
    <article
      className="prose-emburse max-w-3xl text-sm leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
