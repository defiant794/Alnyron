// OpenNext -> Cloudflare Workers adapter config.
// ISR incremental cache = Workers KV (binding NEXT_INC_CACHE_KV in wrangler.jsonc).
// No R2 / D1 / Durable Objects, so the stack stays on free tiers (no payment card).
// queue:"direct" revalidates in-request instead of via a Durable Object queue.
// On-demand ISR (revalidatePath/revalidateTag on admin publish) + a KV/D1 tag
// cache are revisited with F1.2 (admin-pages); time-based ISR works with KV alone.
// 404 responses are never written to KV (src/lib/skip-not-found-cache.ts), so
// junk paths cannot use up the free plan's daily KV writes.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";
import { skipNotFoundWrites } from "./src/lib/skip-not-found-cache";

export default defineCloudflareConfig({
  incrementalCache: skipNotFoundWrites(kvIncrementalCache),
  queue: "direct",
});
