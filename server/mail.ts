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

export const GRAPH = "https://graph.microsoft.com/v1.0";

/**
 * Its own app registration, or the one that signs people in.
 *
 * `MAIL_CLIENT_ID` / `MAIL_CLIENT_SECRET` point at a registration whose
 * only permission is `Mail.Send`, which is the better arrangement: the
 * sign-in app also holds `Sites.ReadWrite.All` and `Mail.Read`, so adding
 * mail to it widens a secret that already reaches SharePoint and the
 * receipt inbox. Falling back keeps a single-app setup working, and the
 * boot log says which one is in use so nobody has to guess.
 */
const envOf = (name: string): string => (process.env[name] ?? "").trim();

/**
 * The credentials are a SET, not three independent values.
 *
 * Falling back one variable at a time looks tidy and is a trap: a
 * `MAIL_CLIENT_ID` entered without its secret would be paired with the
 * sign-in app's secret, and Entra answers that with a 401 that names
 * neither. So the moment `MAIL_CLIENT_ID` exists, the mail app is what we
 * use and its own secret is required — `MAIL_TENANT_ID` may still fall
 * back, because both registrations live in the same tenant.
 */
function creds(): { tenantId: string; clientId: string; clientSecret: string } {
  const mailClient = envOf("MAIL_CLIENT_ID");
  if (mailClient) {
    return {
      tenantId: envOf("MAIL_TENANT_ID") || envOf("AZURE_TENANT_ID"),
      clientId: mailClient,
      clientSecret: envOf("MAIL_CLIENT_SECRET"),
    };
  }
  return {
    tenantId: envOf("AZURE_TENANT_ID"),
    clientId: envOf("AZURE_CLIENT_ID"),
    clientSecret: envOf("AZURE_CLIENT_SECRET"),
  };
}

const tenantId = () => creds().tenantId;
const clientId = () => creds().clientId;
const clientSecret = () => creds().clientSecret;
const sender = () => envOf("MAIL_FROM");

/** The Microsoft app credentials, without the sending mailbox. */
export const isGraphConfigured = (): boolean => {
  const c = creds();
  return Boolean(c.tenantId && c.clientId && c.clientSecret);
};

export function isMailConfigured(): boolean {
  const c = creds();
  return Boolean(c.tenantId && c.clientId && c.clientSecret && sender());
}

/**
 * Why it is not configured, in words somebody can act on.
 *
 * Shown on the Users page. "Email is not set up" with nothing further is
 * the message that sends people back through four settings screens.
 */
export function mailProblem(): string {
  if (envOf("MAIL_CLIENT_ID") && !envOf("MAIL_CLIENT_SECRET")) {
    return "MAIL_CLIENT_ID is set but MAIL_CLIENT_SECRET is missing — add it, or remove "
      + "MAIL_CLIENT_ID to use the sign-in app registration instead.";
  }
  const c = creds();
  if (!c.tenantId || !c.clientId || !c.clientSecret) {
    return "The Microsoft app credentials are not set.";
  }
  if (!sender()) {
    return "MAIL_FROM is not set — it should be the mailbox invitations are sent from, "
      + "such as noreply@mojocarwash.com.";
  }
  return "";
}

/** The sending mailbox, for the settings page. Never a secret. */
export const mailFrom = (): string => sender();

export const mailAppIsSeparate = (): boolean =>
  Boolean((process.env.MAIL_CLIENT_ID ?? "").trim());

let token: { value: string; expiresAt: number } | null = null;

/**
 * A Graph token for the app's own credentials.
 *
 * Exported because reading a mailbox needs the same one. Kept
 * here rather than copied: two token caches would mean two sets
 * of expiry arithmetic and one of them going stale unnoticed.
 */
/**
 * Throw the cached token away, so the next call mints a fresh one.
 *
 * A token carries the app's ROLES as claims, frozen at the moment it was
 * issued, and this one is cached for most of an hour. So granting
 * Mail.Read to a running app changes nothing until that hour is up: every
 * call keeps failing with the same 403 it failed with before the grant,
 * and the obvious conclusion — "the permission did not take" — is wrong.
 * Called on a 403 so a grant takes effect on the next press instead of
 * on the next restart.
 */
export function forgetGraphToken(): void {
  token = null;
}

export async function graphToken(): Promise<string> {
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
    const which = mailAppIsSeparate() ? "MAIL_CLIENT_SECRET" : "AZURE_CLIENT_SECRET";
    throw new Error(`Could not get a Graph token (${res.status}). `
      + `Check ${which} has not expired.`);
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
  if (!isMailConfigured()) throw new Error(`Email is not configured. ${mailProblem()}`);
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(sender())}/sendMail`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await graphToken()}`,
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
    // Two failures account for nearly all of these, and the raw Graph text
    // names neither, so say them out loud rather than making somebody
    // search for the error code.
    const hint = res.status === 403
      ? " — usually the application access policy has not applied yet (give it an hour), "
        + "or admin consent for Mail.Send was never granted."
      : res.status === 404
        ? ` — no mailbox at ${sender()}.`
        : "";
    throw new Error(`Graph refused to send (${res.status})${hint} ${detail.slice(0, 300)}`);
  }
}

/** One house style for every message, so they look like they came from us. */
export function layout(heading: string, body: string, footer?: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
      max-width:560px;margin:0 auto;padding:28px 24px;color:#18181b;line-height:1.5">
    <p style="margin:0 0 2px;font-size:11px;letter-spacing:.11em;text-transform:uppercase;
       color:#a1a1aa;font-weight:600">MOJO Car Wash</p>
    <h1 style="margin:0 0 18px;font-size:21px;font-weight:700;letter-spacing:-.01em">
      ${escapeHtml(heading)}</h1>
    ${body}
    <hr style="margin:30px 0 12px;border:none;border-top:1px solid #e4e4e7">
    <p style="margin:0;font-size:12px;color:#a1a1aa">
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
