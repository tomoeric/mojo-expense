import { env } from "../env.js";
import { getJson, HttpError } from "../http.js";
import { rowsOf } from "./normalize.js";
import { groupLines, toReport } from "./map.js";
import type { EmburseProvider, ExpenseLine, FetchWindow, ProviderResult } from "./types.js";

type Row = Record<string, unknown>;

/**
 * Emburse Professional (formerly Certify) — https://api.certify.com/v1
 *
 * This is the product where employees submit expense reports and a reviewer
 * approves them, so it is the default for MOJO Expense. Auth is an API
 * key/secret header pair issued per tenant.
 *
 * Paths and parameter names come from `env.emburse` rather than being inlined,
 * because Emburse's docs sit behind a tenant login and the exact spellings vary
 * by contract. If a call 404s, fix the env var — not this file.
 */
export class ProfessionalProvider implements EmburseProvider {
  readonly id: string = "professional";
  readonly label: string = "Emburse Professional";

  protected headers(): Record<string, string> {
    const e = env.emburse;
    return { [e.apiKeyHeader]: e.apiKey, [e.apiSecretHeader]: e.apiSecret };
  }

  protected url(path: string, params: Record<string, string>): string {
    const base = env.emburse.baseUrl.replace(/\/+$/, "");
    const u = new URL(`${base}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return u.toString();
  }

  /** Walk the `index`-style pager until a page comes back empty or short. */
  protected async collect(path: string, params: Record<string, string>): Promise<Row[]> {
    const e = env.emburse;
    const headers = this.headers();
    const out: Row[] = [];

    for (let page = e.pageStart; page < e.pageStart + e.maxPages; page++) {
      const payload = await getJson<unknown>(this.url(path, { ...params, [e.pageParam]: String(page) }), {
        headers,
        timeoutMs: e.timeoutMs,
      });
      const rows = rowsOf(payload);
      if (rows.length === 0) break;
      out.push(...rows);
      // A short page means we have reached the end of the collection.
      if (rows.length < 50) break;
    }
    return out;
  }

  async fetchReports(window: FetchWindow): Promise<ProviderResult> {
    const e = env.emburse;
    const warnings: string[] = [];
    const dateParams = { [e.dateStartParam]: window.startDate, [e.dateEndParam]: window.endDate };

    const reportRows = await this.collect(e.reportsPath, dateParams);

    // Expense lines come from a sibling collection keyed by report id. If the
    // tenant does not expose it, reports still render — just without lines, so
    // the policy flags degrade instead of the whole page failing.
    let linesByReport = new Map<string, ExpenseLine[]>();
    try {
      linesByReport = groupLines(await this.collect(e.expensesPath, dateParams));
    } catch (err) {
      warnings.push(
        `Expense lines unavailable (${describe(err)}). Reports are shown without line detail, so receipt and duplicate flags are incomplete.`,
      );
    }

    return {
      reports: reportRows.map((row) => toReport(row, linesByReport)),
      warnings,
      fetchedAt: new Date().toISOString(),
    };
  }
}

function describe(err: unknown): string {
  if (err instanceof HttpError) return `HTTP ${err.status}`;
  return err instanceof Error ? err.message : String(err);
}
