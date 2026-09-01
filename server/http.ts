/** Small fetch wrapper: timeout, one retry on a transient failure, typed JSON. */
export async function getJson<T>(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs: number },
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new HttpError(res.status, `${res.status} ${res.statusText}`, body.slice(0, 400));
        // 4xx is a config or permission problem — retrying cannot help.
        if (res.status < 500 && res.status !== 429) throw err;
        lastErr = err;
      } else {
        return (await res.json()) as T;
      }
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 750));
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body = "",
  ) {
    super(message);
    this.name = "HttpError";
  }
}
