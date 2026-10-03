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

async function token(): Promise<string> {
  const tenant = (process.env.AZURE_TENANT_ID ?? "").trim();
  const id = (process.env.AZURE_CLIENT_ID ?? "").trim();
  const secret = (process.env.AZURE_CLIENT_SECRET ?? "").trim();
  if (!tenant || !id || !secret) {
    throw new Error(
      "Microsoft sign-in is not configured (AZURE_TENANT_ID / AZURE_CLIENT_ID / "
      + "AZURE_CLIENT_SECRET), so there is no directory to read titles from.");
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
          ? " — the app registration needs the User.Read.All APPLICATION permission, "
            + "admin-consented. Signing in uses delegated scopes, which cannot read other people."
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
  Boolean((process.env.AZURE_TENANT_ID ?? "").trim()
    && (process.env.AZURE_CLIENT_ID ?? "").trim()
    && (process.env.AZURE_CLIENT_SECRET ?? "").trim() && env);
