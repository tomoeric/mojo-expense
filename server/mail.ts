/**
 * Sending mail, through Microsoft Graph.
 *
 * The same Entra app registration that signs people in, with `Mail.Send`
 * added and `MAIL_FROM` naming the mailbox to send as. No new vendor, no
 * second bill, and the messages come from a real MOJO address, which is
 * most of deliverability.
 *
 * `Mail.Send` as an APPLICATION permission lets the app send as ANY mailbox
 * in the tenant, which is far more than this needs. Scope it down with an
 * application access policy so it can only send as the one address:
 *
 *   New-ApplicationAccessPolicy -AppId <AZURE_CLIENT_ID> `
 *     -PolicyScopeGroupId <a mail-enabled group holding only MAIL_FROM> `
 *     -AccessRight RestrictAccess -Description "mojo-expense login mail"
 *
 * Without that policy a compromise of the client secret is a compromise of
 * every mailbox in the tenant, not just this one.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

const tenantId = () => (process.env.AZURE_TENANT_ID ?? "").trim();
const clientId = () => (process.env.AZURE_CLIENT_ID ?? "").trim();
const clientSecret = () => (process.env.AZURE_CLIENT_SECRET ?? "").trim();
const sender = () => (process.env.MAIL_FROM ?? "").trim();

export function isMailConfigured(): boolean {
  return Boolean(tenantId() && clientId() && clientSecret() && sender());
}

/** The sending mailbox, for the settings page. Never a secret. */
export const mailFrom = (): string => sender();

let token: { value: string; expiresAt: number } | null = null;

async function appToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
  if (!res.ok) {
    throw new Error(`Could not get a Graph token (${res.status}). `
      + "Check AZURE_CLIENT_SECRET has not expired.");
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  // A minute of slack, so a token never expires mid-request.
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return token.value;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

export async function sendMail(to: string, subject: string, html: string): Promise<void> {
  if (!isMailConfigured()) {
    throw new Error(
      "Email is not configured. Set MAIL_FROM and grant the app Mail.Send.");
  }
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(sender())}/sendMail`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await appToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // 403 here is almost always the access policy or a missing Mail.Send
    // grant rather than anything about this message.
    throw new Error(`Graph refused to send (${res.status}). ${detail.slice(0, 300)}`);
  }
}

/** One house style for every message, so they look like they came from us. */
export function layout(heading: string, body: string, footer?: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
      max-width:520px;margin:0 auto;padding:24px;color:#18181b">
    <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#71717a">
      MOJO Car Wash</p>
    <h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(heading)}</h1>
    ${body}
    <hr style="margin:28px 0 12px;border:none;border-top:1px solid #e4e4e7">
    <p style="margin:0;font-size:12px;color:#71717a">
      ${footer ?? "If you were not expecting this, you can ignore it — nothing happens until the link is used."}
    </p>
  </div>`;
}

/** A button that still works in clients that strip CSS. */
export function button(href: string, label: string): string {
  return `<p style="margin:0 0 20px">
    <a href="${escapeHtml(href)}"
       style="display:inline-block;background:#0284c7;color:#fff;text-decoration:none;
              padding:11px 20px;border-radius:8px;font-weight:600;font-size:15px">
      ${escapeHtml(label)}</a></p>
  <p style="margin:0 0 20px;font-size:12px;color:#71717a;word-break:break-all">
    Or paste this into your browser:<br>${escapeHtml(href)}</p>`;
}

export { escapeHtml };
