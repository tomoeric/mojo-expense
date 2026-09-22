/**
 * Every Emburse wire detail is env-overridable on purpose.
 *
 * Emburse publishes its API docs behind a tenant login, so the exact paths and
 * query-parameter names can differ per product tier and per contract. The
 * defaults below are the documented Emburse Professional (Certify) shape; if a
 * tenant's Swagger disagrees, it is a config change, not a code change.
 */

export type EmburseProduct = "professional" | "enterprise" | "spend";

function str(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function num(name: string, fallback: number): number {
  const raw = str(name);
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function int(name: string, fallback: number): number {
  const raw = str(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** "HH:MM" into its parts, falling back when unset or malformed. */
function hhmm(name: string, hour: number, minute: number): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(name));
  if (!m) return { hour, minute };
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { hour: h, minute: min } : { hour, minute };
}

const PRODUCTS: readonly EmburseProduct[] = ["professional", "enterprise", "spend"];

function product(): EmburseProduct {
  const raw = str("EMBURSE_PRODUCT", "spend").toLowerCase();
  return (PRODUCTS as readonly string[]).includes(raw) ? (raw as EmburseProduct) : "professional";
}

/** Each product answers on its own host. */
function defaultBaseUrl(): string {
  switch (product()) {
    case "professional":
      return "https://api.certify.com/v1";
    case "spend":
    case "enterprise":
    default:
      return "https://api.emburse.com/v1";
  }
}

/**
 * Emburse Spend is transaction-shaped, not report-shaped: its primary
 * collection is transactions rather than expense reports. The path defaults
 * follow the selected product.
 */
function defaultReportsPath(): string {
  return product() === "professional" ? "expensereports" : "transactions";
}

/**
 * Connection string, in precedence order.
 *
 * `DATABASE_URL` is checked LAST on purpose. Replit injects that name itself
 * whenever a managed Postgres is attached to a Repl, and the injected value
 * can win over a hand-set secret — so an app pointed at an external Neon
 * project silently talks to the wrong database instead of failing. Setting
 * NEON_DATABASE_URL sidesteps the collision entirely.
 */
const DB_VARS = ["NEON_DATABASE_URL", "EXTERNAL_DATABASE_URL", "DATABASE_URL"] as const;

function databaseUrl(): string {
  for (const name of DB_VARS) {
    const value = str(name);
    if (value) return value;
  }
  return "";
}

/** Which variable supplied it — for the boot log. Never the value. */
export function databaseUrlSource(): string {
  return DB_VARS.find((n) => str(n)) ?? "none";
}

/** Host only, so the boot log can prove which database it reached. */
export function databaseHost(): string {
  try {
    return new URL(env.databaseUrl).host;
  } catch {
    return "unparseable";
  }
}

export const env = {
  port: int("PORT", 5000),
  isProd: process.env.NODE_ENV === "production",

  /** Neon connection string. Absent = the app has no store and no imports. */
  databaseUrl: databaseUrl(),

  emburse: {
    product: product(),

    /** Emburse Professional (Certify): key/secret header pair. */
    apiKey: str("EMBURSE_API_KEY"),
    apiSecret: str("EMBURSE_API_SECRET"),
    /** Header names, in case a tenant is provisioned with different ones. */
    apiKeyHeader: str("EMBURSE_API_KEY_HEADER", "x-api-key"),
    apiSecretHeader: str("EMBURSE_API_SECRET_HEADER", "x-api-secret"),

    /** Emburse Spend / Enterprise: OAuth2 client credentials. */
    clientId: str("EMBURSE_CLIENT_ID"),
    clientSecret: str("EMBURSE_CLIENT_SECRET"),
    tokenUrl: str("EMBURSE_TOKEN_URL"),
    scope: str("EMBURSE_SCOPE"),
    /**
     * A ready-made bearer token, used INSTEAD of the client-credentials
     * exchange when present. Emburse issues these directly, and it is usually
     * the fastest way to a first successful call — no token endpoint needed.
     */
    accessToken: str("EMBURSE_ACCESS_TOKEN"),

    baseUrl: str("EMBURSE_API_URL", defaultBaseUrl()),

    /** Resource paths, relative to baseUrl. */
    reportsPath: str("EMBURSE_REPORTS_PATH", defaultReportsPath()),
    expensesPath: str("EMBURSE_EXPENSES_PATH", "expenses"),
    receiptsPath: str("EMBURSE_RECEIPTS_PATH", "receipts"),
    usersPath: str("EMBURSE_USERS_PATH", "users"),
    departmentsPath: str("EMBURSE_DEPARTMENTS_PATH", "departments"),

    /** Paging + date filter parameter names. */
    pageParam: str("EMBURSE_PAGE_PARAM", "index"),
    pageStart: int("EMBURSE_PAGE_START", 0),
    dateStartParam: str("EMBURSE_DATE_START_PARAM", "startDate"),
    dateEndParam: str("EMBURSE_DATE_END_PARAM", "endDate"),
    maxPages: int("EMBURSE_MAX_PAGES", 25),

    timeoutMs: int("EMBURSE_TIMEOUT_MS", 20_000),
    /** Server-side cache TTL for a fetched window, in seconds. */
    cacheTtlSec: int("EMBURSE_CACHE_TTL_SEC", 300),
  },

  /** Entra app registration — shared with sign-in, but app-only for Graph. */
  azure: {
    tenantId: str("AZURE_TENANT_ID"),
    clientId: str("AZURE_CLIENT_ID"),
    clientSecret: str("AZURE_CLIENT_SECRET"),
  },

  /**
   * The SharePoint folder the daily export lands in. Defaults point at
   * AI Projects → Shared Documents → Emburse Transactions.
   */
  sharepoint: {
    driveId: str("SHAREPOINT_DRIVE_ID", "b!VegnEte7u0m9UoLreL1k7gzPwGK6nyJEhvVReyQS-aNV3-A-6WbnQamyPpjTyWnK"),
    folderId: str("SHAREPOINT_FOLDER_ID", "01AKEC4WI273BYVMAHNZAJEEVRTHS5DFSA"),
    /** Minutes between automatic syncs; 0 disables the timer (manual only). */
    pollMinutes: int("SHAREPOINT_POLL_MINUTES", 60),
  },

  /**
   * When the server runs the export, and how it retries.
   *
   * Only the starting point: the live schedule is a stored setting, editable in
   * the app and re-read on every scheduler tick, so it can be corrected without
   * a redeploy. These values seed a database that has never been written to.
   */
  schedule: {
    timezone: str("EXPORT_TIMEZONE", "America/Chicago"),
    firstRun: hhmm("EXPORT_FIRST_RUN", 6, 0),
    /** Gap between retries within a day. */
    retryHours: int("EXPORT_RETRY_HOURS", 3),
    /** Attempts before the day is written off and the next is tomorrow. */
    attemptsPerDay: Math.max(1, int("EXPORT_ATTEMPTS_PER_DAY", 2)),
    /**
     * How long after an attempt to keep waiting before calling it a miss.
     * Emburse queues the export and emails when it is ready, then the folder
     * poll picks it up, so an attempt that fired on time still lands late.
     * Default covers the export wait plus one full SHAREPOINT_POLL_MINUTES.
     */
    graceMinutes: int("EXPORT_GRACE_MINUTES", 90),
  },

  /**
   * The Emburse account the browser automation signs in as.
   *
   * A dedicated service account, not a person: a password change by a human
   * would otherwise stop the export, and its actions stay distinguishable in
   * Emburse's audit trail. MFA has to be off for it — no bot can satisfy a
   * challenge — which is exactly why it should be an account that can do
   * nothing but read and export.
   */
  /** Signs the session cookie, and by default derives the credential key. */
  sessionSecret: str("SESSION_SECRET"),
  /** Optional dedicated key for stored Emburse passwords. */
  credentialKey: str("EMBURSE_CREDENTIAL_KEY"),

  emburseLogin: {
    url: str("EMBURSE_LOGIN_URL", "https://spend.emburse.com"),
    email: str("EMBURSE_LOGIN_EMAIL"),
    password: str("EMBURSE_LOGIN_PASSWORD"),
    /** Per-step patience. Emburse's grid re-renders are not instant. */
    stepTimeoutMs: int("EMBURSE_STEP_TIMEOUT_MS", 30_000),
    /** How long to keep polling for the queued export to finish. */
    exportWaitMs: int("EMBURSE_EXPORT_WAIT_MS", 15 * 60_000),
    /**
     * A Chromium binary to use instead of the one Playwright downloaded.
     * Needed wherever the host supplies its own browser, since Playwright
     * insists on the exact build it shipped with and fails outright otherwise.
     */
    chromiumPath: str("PLAYWRIGHT_CHROMIUM_PATH"),
    /**
     * Where the browser keeps its cookies between runs.
     *
     * Without it every run is a new device to Emburse, so a device trusted
     * once is a stranger again the next morning and the verification never
     * stops being asked. On a Reserved VM the filesystem persists, so this is
     * simply somewhere to put it.
     */
    profileDir: str("EMBURSE_PROFILE_DIR", ".emburse-profile"),
    /**
     * How long a sign-in will wait for somebody to type a verification code.
     *
     * A parked run holds a live browser and the profile lock, so this cannot be
     * generous. Five minutes is long enough to unlock a phone and read a text,
     * and short enough that a run abandoned mid-way frees itself.
     */
    challengeTimeoutMs: int("EMBURSE_CHALLENGE_TIMEOUT_MS", 5 * 60_000),
    /**
     * How long to let the app paint after the password goes in.
     *
     * Deliberately much longer than a step timeout. This is the slowest moment
     * in the whole run: Emburse hands back from its identity host and the
     * dashboard cold-renders, which has been seen to take past thirty seconds
     * on a fresh browser profile. Giving up at the step timeout meant judging a
     * blank page and calling a successful sign-in a failure.
     */
    signInWaitMs: int("EMBURSE_SIGN_IN_WAIT_MS", 120_000),
  },

  audit: {
    /**
     * Anthropic credentials. Two shapes are accepted, checked in this order:
     *
     *   1. Replit's Anthropic AI integration — AI_INTEGRATIONS_ANTHROPIC_API_KEY
     *      plus AI_INTEGRATIONS_ANTHROPIC_BASE_URL. This is what
     *      ninja-live-status already uses, so provisioning the integration on
     *      this Repl needs no new account and no separate billing.
     *   2. A direct key from console.anthropic.com in ANTHROPIC_API_KEY.
     *
     * The integration key only works against its own gateway, which is why the
     * base URL travels with it.
     */
    apiKey: str("AI_INTEGRATIONS_ANTHROPIC_API_KEY") || str("ANTHROPIC_API_KEY"),
    baseUrl: str("AI_INTEGRATIONS_ANTHROPIC_BASE_URL") || str("ANTHROPIC_BASE_URL"),
    /**
     * Opus 5 is the default. Vision extraction is cheap at low effort, and a
     * misread receipt costs a reviewer more than the tokens save. Override to
     * trade accuracy for cost.
     */
    model: str("RECEIPT_AUDIT_MODEL", "claude-opus-5"),
    /** Absolute dollar slack before a difference counts (rounding, cents). */
    toleranceAbs: num("RECEIPT_AUDIT_TOLERANCE", 0.02),
    /** Proportional slack, for currency conversion and rounding on big lines. */
    tolerancePct: num("RECEIPT_AUDIT_TOLERANCE_PCT", 0.01),
  },

  policy: {
    /** A line at or above this amount needs an itemised receipt. */
    receiptRequiredOver: int("POLICY_RECEIPT_REQUIRED_OVER", 25),
    /** A line at or above this amount is flagged for reviewer attention. */
    largeLineOver: int("POLICY_LARGE_LINE_OVER", 500),
    /** A report older than this many days in the queue is flagged as ageing. */
    ageingAfterDays: int("POLICY_AGEING_AFTER_DAYS", 5),
  },
} as const;

/** True once the selected product has enough credentials to make a live call. */
/** Receipt auditing needs an Anthropic key; everything else works without it. */
export function isAuditConfigured(): boolean {
  return Boolean(env.audit.apiKey);
}

export function isEmburseConfigured(): boolean {
  const e = env.emburse;
  if (e.product === "professional") return Boolean(e.apiKey && e.apiSecret);
  // A directly-issued bearer token is enough on its own.
  if (e.accessToken) return true;
  return Boolean(e.clientId && e.clientSecret && e.tokenUrl);
}
