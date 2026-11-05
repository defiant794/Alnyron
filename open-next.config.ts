// OpenNext -> Cloudflare Workers adapter config.
// ISR incremental cache = Workers KV (binding NEXT_INC_CACHE_KV in wrangler.jsonc).
// No R2 / D1 / Durable Objects, so the stack stays on free tiers (no payment card).
// queue:"direct" revalidates in-request instead of via a Durable Object queue.
// Time-based ISR works with KV alone: pages refresh on their `revalidate`
// window (~5 min). On-demand ISR (revalidatePath/revalidateTag) needs a tag
// cache, which is not configured, so it is a no-op on the Worker.
// 404 responses are never written to KV (src/lib/skip-not-found-cache.ts), so
// junk paths cannot use up the free plan's daily KV writes.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";
import { skipNotFoundWrites } from "./src/lib/skip-not-found-cache";

export default defineCloudflareConfig({
  incrementalCache: skipNotFoundWrites(kvIncrementalCache),
  queue: "direct",
});
