import { graphToken, isGraphConfigured } from "./mail.js";

/**
 * The staff directory, read from Microsoft Graph.
 *
 * So that adding somebody is picking them off a list rather than typing
 * an address and hoping. A typo in an invited address is worse than
 * annoying: the invite goes somewhere real, and nobody finds out until
 * the person says they never got it.
 *
 * Needs `User.Read.All` as an APPLICATION permission on the same app the
 * mail goes through. Without it this returns `available: false` and the
 * page falls back to typing an address, which is exactly what it did
 * before — a missing permission degrades the feature rather than
 * breaking the page.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

export type DirectoryPerson = {
  email: string;
  name: string;
  jobTitle: string | null;
  department: string | null;
  enabled: boolean;
};

type GraphUser = {
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  jobTitle: string | null;
  department: string | null;
  accountEnabled: boolean | null;
  userType: string | null;
};

/**
 * Cached for ten minutes.
 *
 * A directory of a few hundred people does not change between two clicks
 * of the same dialog, and the page that uses it is opened repeatedly
 * while somebody works through a list of names.
 */
let cache: { at: number; people: DirectoryPerson[] } | null = null;
const TTL_MS = 10 * 60 * 1000;

export type DirectoryResult = {
  available: boolean;
  people: DirectoryPerson[];
  /** Why it is empty, when it is. Shown to an administrator, not a user. */
  problem: string;
};

export function forgetDirectory(): void {
  cache = null;
}

export async function listDirectory(domains: string[]): Promise<DirectoryResult> {
  if (!isGraphConfigured()) {
    return { available: false, people: [], problem: "The Microsoft app is not configured." };
  }
  if (cache && Date.now() - cache.at < TTL_MS) {
    return { available: true, people: cache.people, problem: "" };
  }

  const people: DirectoryPerson[] = [];
  // Graph pages at 999; a tenant larger than a few thousand would want a
  // search box that queries rather than a list that downloads, so the
  // page count is capped rather than followed forever.
  let url: string | null = `${GRAPH}/users?$top=999&$select=`
    + "id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled,userType";

  try {
    const token = await graphToken();
    for (let page = 0; url && page < 10; page++) {
      const res: Response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, consistencylevel: "eventual" },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return {
          available: false,
          people: [],
          problem: res.status === 403
            ? "The app does not have User.Read.All, so the staff list cannot be read. "
              + "Add it as an application permission and grant admin consent."
            : `Graph refused the directory (${res.status}). ${detail.slice(0, 200)}`,
        };
      }
      const body = (await res.json()) as { value: GraphUser[]; "@odata.nextLink"?: string };
      for (const u of body.value) {
        const email = (u.mail ?? u.userPrincipalName ?? "").trim().toLowerCase();
        const domain = email.split("@")[1] ?? "";
        // Our own domains only. A guest account in the tenant is somebody
        // else's person, and inviting one here would be a surprise.
        if (!email || !domains.includes(domain)) continue;
        if (u.userType === "Guest") continue;
        people.push({
          email,
          name: u.displayName?.trim() || email,
          jobTitle: u.jobTitle,
          department: u.department,
          enabled: u.accountEnabled !== false,
        });
      }
      url = body["@odata.nextLink"] ?? null;
    }
  } catch (err) {
    return {
      available: false,
      people: [],
      problem: err instanceof Error ? err.message : String(err),
    };
  }

  people.sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), people };
  return { available: true, people, problem: "" };
}
