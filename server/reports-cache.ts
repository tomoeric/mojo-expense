/**
 * The one cache the reports are served from, shared rather than owned.
 *
 * It lived inside `routes.ts`, which meant the import — the one thing that
 * changes every number in it — had no way to say so. A finished import left
 * the queue showing what it showed five minutes ago: Eric's import brought
 * 158 expenses at 5:31pm and his Review Queue sat on "0 expenses awaiting a
 * decision · updated 5:29 PM", which reads exactly like the separation
 * having taken his queue away from him.
 *
 * Its own module so both can reach it without `ingest` importing `routes`.
 */

import { TtlCache } from "./cache.js";
import { env } from "./env.js";
import type { ProviderResult } from "./emburse/types.js";

export const reportsCache =
  new TtlCache<ProviderResult & { demo: boolean }>(env.emburse.cacheTtlSec * 1000);

/** The numbers underneath have changed; stop serving the old ones. */
export function reportsChanged(): void {
  reportsCache.clear();
}
