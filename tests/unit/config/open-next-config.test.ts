/**
 * Unit tests: open-next.config.ts puts the KV incremental cache behind
 * skipNotFoundWrites, for the server and for the external middleware.
 * Journey: catalog-public  security M1 residual (404s never written to KV)
 *
 * The real `defineCloudflareConfig` resolves the overrides; only the KV cache
 * module is replaced by a fake, so the tests see which writes reach KV.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OverrideOptions } from "@opennextjs/aws/types/open-next.js";
import type { CacheValue, IncrementalCache } from "@opennextjs/aws/types/overrides.js";

const kv = vi.hoisted(() => ({
  name: "cf-kv-incremental-cache",
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
}));
vi.mock("@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache", () => ({ default: kv }));

import openNextConfig from "../../../open-next.config";

const notFoundPage: CacheValue<"cache"> = {
  type: "app",
  html: "<h1>Siden findes ikke</h1>",
  rsc: "0:not-found",
  meta: { status: 404 },
  revalidate: 3600,
};

const okPage: CacheValue<"cache"> = {
  type: "app",
  html: "<h1>Ydelser</h1>",
  rsc: "0:section",
  meta: { status: 200 },
  revalidate: 3600,
};

/** The incremental cache OpenNext loads from `override` (a lazy-loaded override). */
async function loadIncrementalCache(override: OverrideOptions | undefined): Promise<IncrementalCache> {
  const incrementalCache = override?.incrementalCache;
  if (typeof incrementalCache !== "function") {
    throw new Error(`incrementalCache is ${String(incrementalCache)}, not a lazy-loaded override`);
  }
  return incrementalCache();
}

const middleware = openNextConfig.middleware;
const overrides = {
  server: openNextConfig.default.override,
  middleware: middleware?.external ? middleware.override : undefined,
};

// The KV spies are shared module state and the server and middleware cases
// make identical calls: clear them before every case (explicitly, whatever
// the vitest clearMocks setting) so each case asserts only on its own calls.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("open-next.config: security M1 residual, 404s never reach the KV incremental cache", () => {
  it.each(Object.entries(overrides))("%s: a 404 page is not written to KV", async (_target, override) => {
    const cache = await loadIncrementalCache(override);

    await cache.set("/da/not-a-page", notFoundPage, "cache");

    // The 404 reached KV through this override (its existence check) and wrote nothing.
    expect(kv.get).toHaveBeenCalledExactlyOnceWith("/da/not-a-page", "cache");
    expect(kv.set).not.toHaveBeenCalled();
  });

  it.each(Object.entries(overrides))("%s: a 200 page is written to KV as given", async (_target, override) => {
    const cache = await loadIncrementalCache(override);

    await cache.set("/da/services", okPage, "cache");

    expect(kv.set).toHaveBeenCalledExactlyOnceWith("/da/services", okPage, "cache");
  });

  it.each(Object.entries(overrides))(
    "%s: keeps the KV cache's name (deploy populates the KV cache by name)",
    async (_target, override) => {
      expect((await loadIncrementalCache(override)).name).toBe("cf-kv-incremental-cache");
    },
  );
});
