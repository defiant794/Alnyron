// OpenNext -> Cloudflare Workers adapter config (bindings in wrangler.jsonc).
// - Incremental cache = Workers KV (NEXT_INC_CACHE_KV). 404 responses are never
//   written (src/lib/skip-not-found-cache.ts), so junk paths cannot use up the
//   free plan's daily KV writes.
// - Tag cache = D1 in next mode (NEXT_TAG_CACHE_D1): revalidatePath/revalidateTag
//   on an admin publish mark cache entries stale for every isolate, not just the
//   one that handled the publish.
// - Queue = Durable Object (NEXT_CACHE_DO_QUEUE, SQLite-backed, free tier) +
//   WORKER_SELF_REFERENCE: stale ISR pages are regenerated in the background.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
import d1NextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache";
import { skipNotFoundWrites } from "./src/lib/skip-not-found-cache";

export default defineCloudflareConfig({
  incrementalCache: skipNotFoundWrites(kvIncrementalCache),
  tagCache: d1NextTagCache,
  queue: doQueue,
});
