import { env, isEmburseConfigured } from "../env.js";
import type { ExpenseLine } from "./types.js";

/**
 * Receipt fetching, kept strictly server-side.
 *
 * The browser never sees an Emburse URL or credential: it asks this app for
 * `/api/receipts/<lineId>`, and the server resolves that line from the cached
 * report set and fetches the bytes itself. Two consequences that matter:
 *
 *  - No SSRF. The client cannot supply a URL. A URL taken from an Emburse
 *    payload is still only fetched when its host matches the configured API
 *    host, so a malicious or mangled record cannot point us at an internal
 *    address.
 *  - No credential leak. The API key/secret stay in this process.
 */

export type Receipt = { contentType: string; body: Buffer };

/**
 * Only these render inline. Anything else is refused rather than echoed back —
 * serving arbitrary content from our own origin would let an HTML payload
 * stored as a "receipt" run as a same-origin page.
 */
const RENDERABLE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf",
]);

function normalizeType(raw: string | null): string | null {
  if (!raw) return null;
  const type = raw.split(";")[0]!.trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  return RENDERABLE.has(type) ? type : null;
}

export class ReceiptError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReceiptError";
  }
}

export async function fetchReceipt(line: ExpenseLine): Promise<Receipt> {
  if (!line.hasReceipt && !line.receiptId && !line.receiptUrl) {
    throw new ReceiptError(404, "This line has no receipt attached.");
  }

  if (!isEmburseConfigured()) return demoReceipt(line);

  const e = env.emburse;
  const url = resolveUrl(line);
  if (!url) {
    throw new ReceiptError(
      404,
      "Emburse returned no receipt reference for this line. If your tenant exposes one under a different field, add it to the alias list in map.ts.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), e.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        [e.apiKeyHeader]: e.apiKey,
        [e.apiSecretHeader]: e.apiSecret,
        accept: "image/*,application/pdf,application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new ReceiptError(
        res.status === 404 ? 404 : 502,
        res.status === 404
          ? "Emburse has no receipt stored for this line."
          : `Emburse returned HTTP ${res.status} for the receipt.`,
      );
    }

    const declared = normalizeType(res.headers.get("content-type"));
    const raw = Buffer.from(await res.arrayBuffer());

    // Some tenants wrap the image in JSON as base64 rather than serving bytes.
    if (!declared) {
      const decoded = decodeJsonReceipt(raw);
      if (decoded) return decoded;
      throw new ReceiptError(
        415,
        `Receipt came back as an unsupported type (${res.headers.get("content-type") ?? "unknown"}).`,
      );
    }

    return { contentType: declared, body: raw };
  } catch (err) {
    if (err instanceof ReceiptError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ReceiptError(504, "Fetching the receipt from Emburse timed out.");
    }
    throw new ReceiptError(502, "Could not fetch the receipt from Emburse.");
  } finally {
    clearTimeout(timer);
  }
}

/** Build the fetch target, refusing any host that is not the Emburse API. */
function resolveUrl(line: ExpenseLine): string | null {
  const e = env.emburse;
  const base = new URL(e.baseUrl.replace(/\/+$/, "") + "/");

  if (line.receiptUrl) {
    let candidate: URL;
    try {
      candidate = new URL(line.receiptUrl, base);
    } catch {
      return null;
    }
    // Host allow-list: only the configured Emburse API host. This is the SSRF
    // guard — a receipt URL is data from an external system, not a destination
    // we trust on sight.
    if (candidate.protocol !== "https:" || candidate.host !== base.host) return null;
    return candidate.toString();
  }

  if (line.receiptId) {
    // encodeURIComponent stops an id containing "/" or ".." from escaping the
    // receipts collection.
    return new URL(
      `${e.receiptsPath.replace(/^\/+|\/+$/g, "")}/${encodeURIComponent(line.receiptId)}`,
      base,
    ).toString();
  }

  return null;
}

/** `{ "image": "<base64>", "contentType": "image/jpeg" }` and friends. */
function decodeJsonReceipt(raw: Buffer): Receipt | null {
  try {
    const json = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    const lower = new Map(Object.entries(json).map(([k, v]) => [k.toLowerCase(), v]));

    let data: string | null = null;
    for (const key of ["image", "imagedata", "receipt", "data", "content", "filecontents", "base64"]) {
      const v = lower.get(key);
      if (typeof v === "string" && v.length > 0) {
        data = v;
        break;
      }
    }
    if (!data) return null;

    // Tolerate a full data: URI as well as bare base64.
    const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(data);
    const declared = dataUri
      ? normalizeType(dataUri[1] ?? null)
      : normalizeType(
          typeof lower.get("contenttype") === "string"
            ? (lower.get("contenttype") as string)
            : typeof lower.get("mimetype") === "string"
              ? (lower.get("mimetype") as string)
              : null,
        );

    const body = Buffer.from(dataUri ? (dataUri[2] ?? "") : data, "base64");
    if (body.length === 0) return null;

    return { contentType: declared ?? sniff(body) ?? "application/pdf", body };
  } catch {
    return null;
  }
}

/** Magic-byte sniff, for a payload that arrived without a usable type. */
function sniff(b: Buffer): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (b.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  return null;
}

/**
 * A drawn placeholder for demo mode, so the viewer is exercisable before
 * Emburse is connected. Rendered as SVG and labelled SAMPLE — it must never be
 * mistaken for a real receipt.
 */
function demoReceipt(line: ExpenseLine): Receipt {
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const amount = line.amount.toFixed(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="520" viewBox="0 0 380 520">
  <rect width="380" height="520" fill="#fff"/>
  <rect x="20" y="20" width="340" height="480" fill="#fafafa" stroke="#e4e4e7"/>
  <text x="190" y="70" text-anchor="middle" font-family="monospace" font-size="19" font-weight="bold" fill="#18181b">${esc(line.merchant)}</text>
  <text x="190" y="94" text-anchor="middle" font-family="monospace" font-size="12" fill="#71717a">${esc(line.date ?? "")}</text>
  <line x1="50" y1="118" x2="330" y2="118" stroke="#d4d4d8" stroke-dasharray="4 4"/>
  <text x="50" y="152" font-family="monospace" font-size="13" fill="#3f3f46">${esc(line.category)}</text>
  <text x="330" y="152" text-anchor="end" font-family="monospace" font-size="13" fill="#3f3f46">$${amount}</text>
  <line x1="50" y1="176" x2="330" y2="176" stroke="#d4d4d8" stroke-dasharray="4 4"/>
  <text x="50" y="208" font-family="monospace" font-size="15" font-weight="bold" fill="#18181b">TOTAL</text>
  <text x="330" y="208" text-anchor="end" font-family="monospace" font-size="15" font-weight="bold" fill="#18181b">$${amount}</text>
  <text x="190" y="300" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="34" font-weight="bold" fill="#e4e4e7" transform="rotate(-18 190 300)">SAMPLE</text>
  <text x="190" y="452" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="11" fill="#a1a1aa">Placeholder — Emburse is not connected</text>
  <text x="190" y="470" text-anchor="middle" font-family="monospace" font-size="10" fill="#a1a1aa">${esc(line.id)}</text>
</svg>`;
  return { contentType: "image/svg+xml", body: Buffer.from(svg, "utf8") };
}
