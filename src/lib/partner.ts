/**
 * Which partner account the browser is in.
 *
 * ONE source of truth, and it is the PATH. `/dutchmiller` is Dutch
 * Miller; `/` is the platform, outside any partner. Not a cookie and
 * not a remembered selection, deliberately: a remembered one is shared
 * between tabs, so somebody comparing two partners side by side would
 * have both tabs quietly reading the same account — and would not find
 * out until they acted on it.
 *
 * The slug reaches the server on a HEADER rather than in the URL,
 * because every Dutch Miller route is already mounted under
 * /api/dutch-miller and re-rooting them would break every emailed link
 * and bookmark in existence. It is a preference, never a grant: the
 * server refuses one naming an account the person does not hold.
 *
 * Patching `fetch` is heavier than it looks, and is the point. There
 * are some eighty calls to these routes across the pages, and a header
 * that has to be remembered at each of them is a header that will be
 * missing from the one added next month — which would not fail
 * loudly, it would read the wrong partner's data.
 */

const DM_API = "/api/dutch-miller/";

/** Paths at the root that are the application's, never a partner's. */
const NOT_A_SLUG = new Set([
  "", "api", "auth", "assets", "static", "public", "redeem", "continue",
  "callback", "favicon.ico", "robots.txt", "index.html",
]);

/**
 * The slug in the address bar, or empty for the platform root.
 *
 * Read on every call rather than captured once, so a `history`
 * navigation between partners takes effect on the next request
 * instead of on the next full reload.
 */
export function slugInPath(): string {
  const first = window.location.pathname.split("/")[1] ?? "";
  const slug = decodeURIComponent(first).toLowerCase();
  return NOT_A_SLUG.has(slug) ? "" : slug;
}

/** The address for a page inside an account, keeping the hash route. */
export const pathFor = (slug: string, hash = window.location.hash): string =>
  `/${slug}${hash || ""}`;

/**
 * Go to an account, reloading.
 *
 * A full load rather than a `pushState`: every cached query was
 * answered for the previous partner, and leaving them in place is how
 * one account's member list appears for a moment under another's name.
 */
export function openAccount(slug: string, hash = ""): void {
  window.location.href = `/${slug}${hash}`;
}

let installed = false;

/**
 * Put the partner header on every Dutch Miller API call.
 *
 * Called once from the entry point, before anything renders. Only
 * /api/dutch-miller/ is touched; Emburse's routes and every other
 * request go through untouched, and a caller that has already set the
 * header itself keeps its own value.
 */
export function installPartnerHeader(): void {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input
      : input instanceof URL ? input.pathname
        : input.url;
    if (!url.includes(DM_API)) return original(input, init);
    const slug = slugInPath();
    if (!slug) return original(input, init);
    const headers = new Headers(init?.headers ?? (
      input instanceof Request ? input.headers : undefined));
    if (!headers.has("x-partner-account")) headers.set("x-partner-account", slug);
    return original(input, { ...init, headers });
  };
}
