/** Single-entry TTL cache with in-flight de-duplication. */
export class TtlCache<T> {
  private entry: { key: string; value: T; expiresAt: number } | null = null;
  private inflight: { key: string; promise: Promise<T> } | null = null;

  constructor(private readonly ttlMs: number) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    if (this.entry && this.entry.key === key && this.entry.expiresAt > Date.now()) {
      return this.entry.value;
    }
    if (this.inflight && this.inflight.key === key) return this.inflight.promise;

    const promise = load()
      .then((value) => {
        this.entry = { key, value, expiresAt: Date.now() + this.ttlMs };
        return value;
      })
      .finally(() => {
        if (this.inflight?.key === key) this.inflight = null;
      });

    this.inflight = { key, promise };
    return promise;
  }

  clear(): void {
    this.entry = null;
  }
}
