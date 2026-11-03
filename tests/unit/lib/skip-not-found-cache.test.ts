/**
 * Unit tests: 404 responses are never written to the KV incremental cache.
 * Journey: catalog-public  security M1 residual (junk GETs must not use up
 * the free plan's 1,000 KV writes a day)
 *
 * Module: src/lib/skip-not-found-cache.ts
 *
 * The wrapped cache is a fake: every test asserts which calls reach it.
 */
import { describe, expect, it, vi } from "vitest";
import type { CacheValue, IncrementalCache } from "@opennextjs/aws/types/overrides.js";
import { skipNotFoundWrites } from "@/lib/skip-not-found-cache";

const KV_CACHE_NAME = "cf-kv-incremental-cache";

/** An entry the underlying cache already holds for a key. */
const STORED = { lastModified: 1_700_000_000_000 };

const notFoundPage: CacheValue<"cache"> = {
  type: "app",
  html: "<h1>Siden findes ikke</h1>",
  rsc: "0:not-found",
  meta: { status: 404, headers: {} },
  revalidate: 3600,
};

const okPage: CacheValue<"cache"> = {
  type: "app",
  html: "<h1>Ydelser</h1>",
  rsc: "0:section",
  meta: { status: 200, headers: {} },
  revalidate: 3600,
};

/** A fake underlying cache holding `stored` for every key, with spies on each method. */
function underlyingCache(stored: typeof STORED | null) {
  const cache: IncrementalCache = {
    name: KV_CACHE_NAME,
    get: async () => stored,
    set: async () => {},
    delete: async () => {},
  };
  return {
    cache,
    get: vi.spyOn(cache, "get"),
    set: vi.spyOn(cache, "set"),
    delete: vi.spyOn(cache, "delete"),
  };
}

describe("security M1 residual: a 404 response is never written to the KV incremental cache", () => {
  it("does not write a 404 page entry for a path that has no entry", async () => {
    const underlying = underlyingCache(null);

    await skipNotFoundWrites(underlying.cache).set("/da/ikke-en-side", notFoundPage, "cache");

    expect(underlying.set).not.toHaveBeenCalled();
    expect(underlying.delete).not.toHaveBeenCalled();
  });

  it("does not write a 404 route-handler entry", async () => {
    const underlying = underlyingCache(null);
    const notFoundRoute: CacheValue<"cache"> = { type: "route", body: "", meta: { status: 404 }, revalidate: 3600 };

    await skipNotFoundWrites(underlying.cache).set("/feed", notFoundRoute, "cache");

    expect(underlying.set).not.toHaveBeenCalled();
  });

  it("deletes the entry a key already holds when it now renders a 404 (an unpublished section is not served stale)", async () => {
    const underlying = underlyingCache(STORED);

    await skipNotFoundWrites(underlying.cache).set("/da/ydelser", notFoundPage, "cache");

    expect(underlying.get).toHaveBeenCalledWith("/da/ydelser", "cache");
    expect(underlying.delete).toHaveBeenCalledWith("/da/ydelser");
    expect(underlying.set).not.toHaveBeenCalled();
  });
});

describe("security M1 residual: every other cache call passes through unchanged", () => {
  it("writes a 200 page entry as given", async () => {
    const underlying = underlyingCache(null);

    await skipNotFoundWrites(underlying.cache).set("/da/ydelser", okPage, "cache");

    expect(underlying.set).toHaveBeenCalledWith("/da/ydelser", okPage, "cache");
    expect(underlying.get).not.toHaveBeenCalled();
    expect(underlying.delete).not.toHaveBeenCalled();
  });

  it("writes entries without a response status (redirect, fetch) as given", async () => {
    const underlying = underlyingCache(null);
    const wrapped = skipNotFoundWrites(underlying.cache);
    const redirect: CacheValue<"cache"> = { type: "redirect", props: {}, revalidate: 3600 };
    const fetchEntry: CacheValue<"fetch"> = {
      kind: "FETCH",
      data: { headers: {}, body: "", url: "https://example.supabase.co/rest/v1/pages", status: 404 },
      revalidate: 60,
    };

    await wrapped.set("/en/ydelser", redirect, "cache");
    await wrapped.set("fetch-key", fetchEntry, "fetch");

    expect(underlying.set).toHaveBeenNthCalledWith(1, "/en/ydelser", redirect, "cache");
    expect(underlying.set).toHaveBeenNthCalledWith(2, "fetch-key", fetchEntry, "fetch");
  });

  it("reads through to the underlying cache", async () => {
    const underlying = underlyingCache(STORED);

    const entry = await skipNotFoundWrites(underlying.cache).get("/da/ydelser", "cache");

    expect(entry).toBe(STORED);
    expect(underlying.get).toHaveBeenCalledWith("/da/ydelser", "cache");
  });

  it("deletes through to the underlying cache", async () => {
    const underlying = underlyingCache(STORED);

    await skipNotFoundWrites(underlying.cache).delete("/da/ydelser");

    expect(underlying.delete).toHaveBeenCalledWith("/da/ydelser");
  });

  it("keeps the underlying cache's name (opennextjs-cloudflare deploy populates the KV cache by name)", () => {
    expect(skipNotFoundWrites(underlyingCache(null).cache).name).toBe(KV_CACHE_NAME);
  });

  it("calls every underlying method on the cache itself (the KV cache reads `this.getKVKey`)", async () => {
    const receivers: unknown[] = [];
    const cache: IncrementalCache = {
      name: KV_CACHE_NAME,
      async get() {
        receivers.push(this);
        return STORED;
      },
      async set() {
        receivers.push(this);
      },
      async delete() {
        receivers.push(this);
      },
    };
    const wrapped = skipNotFoundWrites(cache);

    await wrapped.get("/da/ydelser", "cache");
    await wrapped.set("/da/ydelser", okPage, "cache");
    await wrapped.set("/da/ydelser", notFoundPage, "cache");
    await wrapped.delete("/da/ydelser");

    // get, set, then get + delete for the 404, then delete.
    expect(receivers).toEqual([cache, cache, cache, cache, cache]);
    expect(receivers.every((receiver) => receiver === cache)).toBe(true);
  });
});
