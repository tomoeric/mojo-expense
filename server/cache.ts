/**
 * A small TTL cache, keyed, with in-flight de-duplication.
 *
 * It held exactly ONE entry, which was right when the app had one queue and
 * quietly wrong the moment it had two. Two people polling every few seconds
 * evict each other on every request — each poll misses, re-queries, and
 * stores an entry the next poll throws away. The cache does not serve the
 * wrong person's data (the key is checked before it is returned), it simply
 * stops being a cache, silently, exactly when the load doubles.
 *
 * Keyed, with a cap, so one person's windows cannot crowd out another's.
 */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  private inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    /** Oldest-first eviction above this, so a long session cannot grow it. */
    private readonly most = 64,
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    // Expired is as good as absent, and leaving it would make `most` count
    // entries nothing will ever return.
    if (hit) this.entries.delete(key);

    const running = this.inflight.get(key);
    if (running) return running;

    const promise = load()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        while (this.entries.size > this.most) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.entries.delete(oldest);
        }
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Everything, for when the data underneath has changed for everybody. */
  clear(): void {
    this.entries.clear();
  }
}
