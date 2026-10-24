/**
 * Which APP a signed-in person is using.
 *
 * One deployment, one VM, one sign-in — and more than one product inside it.
 * Emburse is the expense reviewer this app began as; Dutch Miller is a
 * second, separate thing that happens to run on the same machine. Somebody
 * assigned to one must not see the other's pages at all: not a hidden nav
 * item, not a page that 403s when opened, but a shell that is simply not
 * theirs.
 *
 * Assignment is by email, in Secrets, in the same forgiving format as
 * AUTH_ALLOWED — because it is typed into a box by hand and a stray quote
 * or newline must not lock somebody out.
 *
 *   DUTCH_MILLER_ALLOWED=paul.d@mojocarwash.com, eric.s@mojocarwash.com
 *   EMBURSE_ALLOWED=eric.s@mojocarwash.com, brian.c@mojocarwash.com
 *
 * THE RULE, in one sentence: Dutch Miller is opt-in by list, and Emburse is
 * open to everyone who may sign in EXCEPT people assigned to Dutch Miller,
 * unless they are assigned to Emburse as well.
 *
 * That shape is deliberate. Emburse has reviewers already using it and a
 * list that starts out empty would lock every one of them out on the deploy
 * that introduced it, so its default is "carry on as before". Dutch Miller
 * has nobody yet, so its default is "nobody but the two people named below".
 * The exception at the end is what lets one person hold both.
 */
import { isAllowed, parseEmailList } from "./allow.js";

/** Where the chosen app is remembered. A preference, never a grant. */
export const APP_COOKIE = "mojo_app";

export const APPS = ["emburse", "dutch-miller"] as const;
export type AppKey = (typeof APPS)[number];

export const APP_LABEL: Record<AppKey, string> = {
  emburse: "Emburse",
  "dutch-miller": "Dutch Miller",
};

export const isAppKey = (v: unknown): v is AppKey =>
  typeof v === "string" && (APPS as readonly string[]).includes(v);

/**
 * Who holds Dutch Miller before anybody sets the secret.
 *
 * Named here rather than left empty so the feature works on the deploy that
 * introduces it, with no Secrets step between shipping and signing in. The
 * secret replaces this list outright once it is set — it does not add to it,
 * because a default nobody can remove is a backdoor.
 */
const DUTCH_MILLER_DEFAULT = ["eric.s@mojocarwash.com", "paul.d@mojocarwash.com"];

/**
 * Who holds Emburse as well as Dutch Miller, before anybody sets the secret.
 *
 * Only Eric. Paul is Dutch Miller alone, which is the whole reason this
 * carve-out exists: without it, being assigned to Dutch Miller would take
 * Emburse away from the one person who needs both.
 */
const EMBURSE_ALSO_DEFAULT = ["eric.s@mojocarwash.com"];

const listFor = (raw: string | undefined, fallback: string[]): string[] => {
  const set = parseEmailList(raw);
  return set.length > 0 ? set : fallback;
};

const on = (email: string, list: string[]): boolean => {
  const lower = email.trim().toLowerCase();
  if (!lower) return false;
  const domain = lower.split("@")[1] ?? "";
  return list.includes(lower) || list.includes(domain);
};

export function hasDutchMiller(email: string): boolean {
  return on(email, listFor(process.env.DUTCH_MILLER_ALLOWED, DUTCH_MILLER_DEFAULT));
}

export function hasEmburse(email: string): boolean {
  const explicit = parseEmailList(process.env.EMBURSE_ALLOWED);
  if (explicit.length > 0) return on(email, explicit);
  // Unset: everyone who may sign in keeps Emburse, except somebody whose
  // assignment is Dutch Miller — and even then, not if they are one of the
  // people who hold both.
  if (hasDutchMiller(email)) return on(email, EMBURSE_ALSO_DEFAULT);
  return isAllowed(email);
}

/** Every app this person may use, in the order they are offered. */
export function appsFor(email: string): AppKey[] {
  const out: AppKey[] = [];
  if (hasEmburse(email)) out.push("emburse");
  if (hasDutchMiller(email)) out.push("dutch-miller");
  return out;
}

/**
 * The app a request is acting in.
 *
 * The cookie is a PREFERENCE, never a grant: it is read only to choose
 * between apps the person already holds, and anything else falls back to
 * their first one. A cookie naming an app they do not hold has to be
 * ignored rather than honoured — it is the one value here a browser can
 * set.
 */
export function appFor(email: string, preferred: string | undefined): AppKey | null {
  const mine = appsFor(email);
  if (mine.length === 0) return null;
  return isAppKey(preferred) && mine.includes(preferred) ? preferred : mine[0]!;
}

/** For the boot log: how many are assigned, never who. */
export function appListSizes(): { emburse: number | "all"; dutchMiller: number } {
  const explicit = parseEmailList(process.env.EMBURSE_ALLOWED);
  return {
    emburse: explicit.length > 0 ? explicit.length : "all",
    dutchMiller: listFor(process.env.DUTCH_MILLER_ALLOWED, DUTCH_MILLER_DEFAULT).length,
  };
}
