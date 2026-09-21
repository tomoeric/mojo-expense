import { env } from "../env.js";

/**
 * Reads export files out of a SharePoint document library via Microsoft Graph.
 *
 * App-only auth (client credentials), so the sync runs without a signed-in
 * user. That needs the APPLICATION permission `Sites.Read.All` (or
 * `Sites.Selected` scoped to this site) with admin consent — the delegated
 * scopes used for sign-in are not enough, and this is the usual reason a
 * freshly-configured sync returns 403.
 */

export type DriveFile = {
  id: string;
  name: string;
  size: number;
  eTag: string;
  lastModified: string;
  downloadUrl: string | null;
};

export function isSharePointConfigured(): boolean {
  const s = env.sharepoint;
  return Boolean(s.driveId && s.folderId && env.azure.tenantId && env.azure.clientId && env.azure.clientSecret);
}

type Token = { value: string; expiresAt: number };
let cached: Token | null = null;
let inflight: Promise<Token> | null = null;

async function token(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  inflight ??= request().finally(() => {
    inflight = null;
  });
  cached = await inflight;
  return cached.value;
}

async function request(): Promise<Token> {
  const { tenantId, clientId, clientSecret } = env.azure;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // Never echo the body — a failed exchange can reflect the client secret.
    throw new Error(`Graph token request failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Graph token response had no access_token.");
  return { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
}

async function graph<T>(path: string): Promise<T> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { authorization: `Bearer ${await token()}`, accept: "application/json" },
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(
        "Graph refused the request (403). The app registration needs the APPLICATION permission " +
          "Sites.Read.All (or Sites.Selected for this site) with admin consent — delegated sign-in scopes are not enough.",
      );
    }
    if (res.status === 404) throw new Error(`Graph could not find ${path} (404). Check SHAREPOINT_DRIVE_ID and SHAREPOINT_FOLDER_ID.`);
    throw new Error(`Graph returned ${res.status} for ${path}.`);
  }
  return (await res.json()) as T;
}

/** Files sitting in the watched folder, newest first. */
export async function listExports(): Promise<DriveFile[]> {
  const { driveId, folderId } = env.sharepoint;
  const data = await graph<{
    value: {
      id: string; name: string; size: number; eTag: string; lastModifiedDateTime: string;
      file?: unknown; "@microsoft.graph.downloadUrl"?: string;
    }[];
  }>(`/drives/${driveId}/items/${folderId}/children?$top=200&$orderby=lastModifiedDateTime desc`);

  return data.value
    .filter((i) => i.file)
    .map((i) => ({
      id: i.id,
      name: i.name,
      size: i.size,
      eTag: i.eTag ?? "",
      lastModified: i.lastModifiedDateTime,
      downloadUrl: i["@microsoft.graph.downloadUrl"] ?? null,
    }));
}

export async function downloadFile(file: DriveFile): Promise<Buffer> {
  // The pre-authenticated download URL is short-lived; fall back to the
  // content endpoint if Graph did not hand one out.
  const url = file.downloadUrl ?? `https://graph.microsoft.com/v1.0/drives/${env.sharepoint.driveId}/items/${file.id}/content`;
  const headers: Record<string, string> = file.downloadUrl ? {} : { authorization: `Bearer ${await token()}` };

  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`Downloading ${file.name} failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}
