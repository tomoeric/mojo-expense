/**
 * Reading an allow-list out of a Secrets box.
 *
 * Its own module because more than one list uses it now — who may sign in,
 * who is an admin, and which app each person is assigned to — and the app
 * assignment needs to ask "may this person sign in at all" without importing
 * the router that answers it.
 */

/**
 * Parsing is deliberately forgiving, because this is typed into a Secrets box
 * by hand: entries may be separated by commas, spaces or newlines; surrounding
 * quotes are stripped (pasting `"a@b.com"` should not silently lock everyone
 * out); and a domain written `@mojocarwash.com` is accepted as well as bare.
 */
export function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^["']|["']$/g, ""))
    .map((s) => (s.startsWith("@") ? s.slice(1) : s))
    .filter(Boolean);
}

/** An empty list means no restriction — see the callers for why that is right. */
export function matchesList(email: string, list: string[]): boolean {
  if (list.length === 0) return true;
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1] ?? "";
  return list.includes(lower) || list.includes(domain);
}

/**
 * Optional allow-list, on top of the tenant restriction the issuer already
 * enforces. Emails and/or domains:
 *   AUTH_ALLOWED=ap@mojocarwash.com, eric.s@mojocarwash.com
 *   AUTH_ALLOWED=mojocarwash.com
 * Empty (the default) means anyone in the tenant may sign in.
 */
export function allowList(): string[] {
  return parseEmailList(process.env.AUTH_ALLOWED);
}

export function isAllowed(email: string): boolean {
  return matchesList(email, allowList());
}
