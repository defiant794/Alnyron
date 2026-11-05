/**
 * Unit tests: open-next.config.ts puts the KV incremental cache behind
 * skipNotFoundWrites, for the server and for the external middleware.
 * Journey: catalog-public — security M1 residual (404s never written to KV);
 * cache-infra AC-CACHE-12 (the wrapper survives the F2.0 change).
 *
 * The real `defineCloudflareConfig` resolves the overrides; only the KV cache
 * module is replaced by a fake, so the tests see which writes reach KV.
 *
 * F2.0 cache-infra (AC-CACHE-10, AC-CACHE-11):
 *   tagCache is the D1 next-mode tag cache (name + mode);
 *   queue is the DO revalidation queue (not "direct").
 * The D1 tag cache and DO queue are NOT mocked: their `name` / `mode` are plain
 * properties, and getCloudflareContext() is only called inside their methods, so
 * importing the real modules in Node is safe and the tests assert on the values
 * the installed package actually has.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OverrideOptions } from "@opennextjs/aws/types/open-next.js";
import type { CacheValue, IncrementalCache, Queue, TagCache } from "@opennextjs/aws/types/overrides.js";

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

/** Load the tag-cache override; throws a descriptive error when it is not a lazy loader. */
async function loadTagCache(override: OverrideOptions | undefined): Promise<TagCache> {
  const tagCache = override?.tagCache;
  if (typeof tagCache !== "function") {
    throw new Error(
      `tagCache is ${String(tagCache)}, not a lazy-loaded override — expected d1-next-mode-tag-cache (AC-CACHE-10)`,
    );
  }
  return tagCache();
}

/** Load the queue override; throws a descriptive error when it is not a lazy loader. */
async function loadQueue(override: OverrideOptions | undefined): Promise<Queue> {
  const queue = override?.queue;
  if (typeof queue !== "function") {
    throw new Error(
      `queue is ${String(queue)}, not a lazy-loaded override — expected durable-queue (AC-CACHE-11)`,
    );
  }
  return queue();
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

describe("open-next.config: security M1 residual + AC-CACHE-12, 404s never reach the KV incremental cache", () => {
  it.each(Object.entries(overrides))("%s: AC-CACHE-12 a 404 page is not written to KV", async (_target, override) => {
    const cache = await loadIncrementalCache(override);

    await cache.set("/da/not-a-page", notFoundPage, "cache");

    // The 404 reached KV through this override (its existence check) and wrote nothing.
    expect(kv.get).toHaveBeenCalledExactlyOnceWith("/da/not-a-page", "cache");
    expect(kv.set).not.toHaveBeenCalled();
  });

  it.each(Object.entries(overrides))("%s: AC-CACHE-12 a 200 page is written to KV as given", async (_target, override) => {
    const cache = await loadIncrementalCache(override);

    await cache.set("/da/services", okPage, "cache");

    expect(kv.set).toHaveBeenCalledExactlyOnceWith("/da/services", okPage, "cache");
  });

  it.each(Object.entries(overrides))(
    "%s: AC-CACHE-12 keeps the KV cache's name (deploy populates the KV cache by name)",
    async (_target, override) => {
      expect((await loadIncrementalCache(override)).name).toBe("cf-kv-incremental-cache");
    },
  );
});

// ── F2.0 cache-infra: D1 tag cache and DO revalidation queue overrides ──────────────────────────

describe("open-next.config: F2.0 cache-infra, D1 tag cache (AC-CACHE-10)", () => {
  it.each(Object.entries(overrides))(
    "%s: AC-CACHE-10 tagCache name is 'd1-next-mode-tag-cache'",
    async (_target, override) => {
      const tc = await loadTagCache(override);
      expect(tc.name).toBe("d1-next-mode-tag-cache");
    },
  );

  it.each(Object.entries(overrides))(
    "%s: AC-CACHE-10 tagCache mode is 'nextMode'",
    async (_target, override) => {
      const tc = await loadTagCache(override);
      expect(tc.mode).toBe("nextMode");
    },
  );
});

describe("open-next.config: F2.0 cache-infra, DO revalidation queue (AC-CACHE-11)", () => {
  it.each(Object.entries(overrides))(
    "%s: AC-CACHE-11 queue name is 'durable-queue' (not 'direct')",
    async (_target, override) => {
      const q = await loadQueue(override);
      expect(q.name).toBe("durable-queue");
    },
  );
});
