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

export const env = {
  port: int("PORT", 5000),
  isProd: process.env.NODE_ENV === "production",

  /** Neon connection string. Absent = the app has no store and no imports. */
  databaseUrl: str("DATABASE_URL"),

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

  audit: {
    /** Anthropic API key. Absent = receipt auditing is unavailable. */
    apiKey: str("ANTHROPIC_API_KEY"),
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
