import type { IncrementalCache } from "@opennextjs/aws/types/overrides.js";

const NOT_FOUND = 404;

/**
 * True for a cache entry holding a 404 response. Page and route entries carry
 * the rendered status in `meta.status`; fetch and composable entries have no
 * `meta`, so they never match.
 */
function isNotFoundEntry(value: object): boolean {
  if (!("meta" in value)) return false;
  const { meta } = value;
  return typeof meta === "object" && meta !== null && "status" in meta && meta.status === NOT_FOUND;
}

/**
 * Wraps an OpenNext incremental cache so 404 responses are never persisted.
 *
 * A path that renders a 404 under ISR (malformed slug, well-formed but absent
 * slug) otherwise becomes its own no-expiry Workers KV entry, so anonymous
 * junk GETs can use up the free plan's 1,000 KV writes a day, after which
 * real pages stop caching. A 404 is re-rendered on every request instead.
 *
 * A key that already holds an entry when it renders a 404 (a section that
 * was unpublished, a build-time 404) has that entry deleted: skipping the
 * write alone would keep serving the stale page (stale-while-revalidate)
 * forever. The existence check is a KV read, so a path that never had an
 * entry costs no delete.
 *
 * Reads, deletes and every other write pass through unchanged. `name` is
 * kept so `opennextjs-cloudflare deploy` still recognises the KV cache and
 * populates it with the build-time entries.
 */
export function skipNotFoundWrites(cache: IncrementalCache): IncrementalCache {
  return {
    name: cache.name,
    get: (key, cacheType) => cache.get(key, cacheType),
    async set(key, value, cacheType) {
      if (!isNotFoundEntry(value)) return cache.set(key, value, cacheType);
      if (await cache.get(key, cacheType)) await cache.delete(key);
    },
    delete: (key) => cache.delete(key),
  };
}
