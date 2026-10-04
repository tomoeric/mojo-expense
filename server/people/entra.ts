/**
 * Job titles from Microsoft Entra, which is where this company keeps them.
 *
 * The same call the sister app makes (`leadership-entra.ts` there):
 * `/users?$select=…jobTitle…`, paged. Two differences, both deliberate.
 *
 * It asks for displayName and jobTitle and NOTHING else. The sister app
 * also takes mail, office and the manager chain because it uses them;
 * this one does not, and reading a directory of email addresses to throw
 * them away is collecting somebody's data for no reason.
 *
 * And it needs an APPLICATION permission — User.Read.All, admin-consented
 * on the app registration. Signing in here uses delegated scopes
 * ("openid email profile"), which cannot read other people. If the
 * consent is missing, Graph says so and that message is passed straight
 * through rather than being reported as "no titles found".
 */

import { env } from "../env.js";
import { setTitles } from "./titles.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

/**
 * Which app registration reads the directory.
 *
 * TITLES_AZURE_* first, falling back to the sign-in app. They are
 * different jobs and often different registrations: signing in needs
 * delegated scopes and a redirect URI, reading the directory needs
 * User.Read.All as an APPLICATION permission with admin consent. This
 * tenant already has an app that does the second — the sister app reads
 * jobTitle from Graph every day — so pointing at it is a secret to
 * paste, where granting a new consent is a wait on somebody else.
 *
 * Keeping them separate also keeps the sign-in app as small as it is.
 * Nothing that only signs people in should acquire the ability to read
 * every person in the company because this feature needed it.
 */
const pick = (a: string, b: string): string =>
  (process.env[a] ?? "").trim() || (process.env[b] ?? "").trim();

async function token(): Promise<string> {
  const tenant = pick("TITLES_AZURE_TENANT_ID", "AZURE_TENANT_ID");
  const id = pick("TITLES_AZURE_CLIENT_ID", "AZURE_CLIENT_ID");
  const secret = pick("TITLES_AZURE_CLIENT_SECRET", "AZURE_CLIENT_SECRET");
  if (!tenant || !id || !secret) {
    throw new Error(
      "No Microsoft credentials are configured (TITLES_AZURE_* or AZURE_*), so there is no "
      + "directory to read titles from.");
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: id, client_secret: secret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Microsoft would not issue a token for the directory: ${body.error_description ?? res.status}`);
  }
  return body.access_token;
}

export type EntraPull = { read: number; stored: number; withoutTitle: number };

/** Read every enabled user's name and title, and store them. */
export async function pullEntraTitles(): Promise<EntraPull> {
  const access = await token();
  const people: { name: string; title: string }[] = [];
  let read = 0;
  let withoutTitle = 0;
  let next: string | null =
    `${GRAPH}/users?$select=displayName,jobTitle,accountEnabled&$top=500`;

  // A guard rather than a trust: a paging bug that never terminates would
  // otherwise spin against Graph until something else gave way.
  for (let page = 0; next && page < 200; page++) {
    const res: Response = await fetch(next, {
      headers: { authorization: `Bearer ${access}` },
    });
    const body = (await res.json()) as {
      value?: { displayName?: string; jobTitle?: string; accountEnabled?: boolean }[];
      "@odata.nextLink"?: string;
      error?: { message?: string; code?: string };
    };
    if (!res.ok) {
      throw new Error(
        `Graph refused to list users: ${body.error?.message ?? res.status}`
        + (body.error?.code === "Authorization_RequestDenied"
          ? " — this app registration needs User.Read.All as an APPLICATION permission, "
            + "admin-consented. Signing in uses delegated scopes, which cannot read other "
            + "people. Either grant it, or point TITLES_AZURE_TENANT_ID / _CLIENT_ID / "
            + "_CLIENT_SECRET at an app that already has it."
          : ""));
    }
    for (const u of body.value ?? []) {
      const name = String(u.displayName ?? "").trim();
      if (!name || u.accountEnabled === false) continue;
      read++;
      const title = String(u.jobTitle ?? "").trim();
      if (!title) { withoutTitle++; continue; }
      people.push({ name, title });
    }
    next = body["@odata.nextLink"] ?? null;
  }

  const stored = await setTitles(people, "entra");
  console.log(`titles: read ${read} from Entra, stored ${stored}, ${withoutTitle} had none`);
  return { read, stored, withoutTitle };
}

/** Whether this deployment could even try. */
export const canReadDirectory = (): boolean =>
  Boolean(pick("TITLES_AZURE_TENANT_ID", "AZURE_TENANT_ID")
    && pick("TITLES_AZURE_CLIENT_ID", "AZURE_CLIENT_ID")
    && pick("TITLES_AZURE_CLIENT_SECRET", "AZURE_CLIENT_SECRET") && env);

/** Whether a credential of its own is in use, for the card to say so. */
export const ownCredential = (): boolean =>
  Boolean((process.env.TITLES_AZURE_CLIENT_ID ?? "").trim());
