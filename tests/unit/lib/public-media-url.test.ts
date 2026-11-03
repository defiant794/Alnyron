/**
 * Unit tests: public URL of a catalog image (src/lib/public-media-url.ts).
 * Journey: catalog-public (item cards and the item gallery show these URLs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicMediaUrl } from "@/lib/public-media-url";

const SUPABASE_URL = "https://e2eprojectref0000000.supabase.co";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key-fixture");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publicMediaUrl: the media bucket's public object URL", () => {
  it("points a storage path at the public media bucket of the configured project", () => {
    expect(publicMediaUrl("items/item-web/1f0c.webp")).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/media/items/item-web/1f0c.webp`,
    );
  });

  it("URL-encodes each path segment and keeps the slashes between them", () => {
    expect(publicMediaUrl("items/item web/a#b?c.webp")).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/media/items/item%20web/a%23b%3Fc.webp`,
    );
  });

  it("encodes a non-ASCII file name", () => {
    expect(publicMediaUrl("items/item-web/rådgivning.webp")).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/media/items/item-web/r%C3%A5dgivning.webp`,
    );
  });

  it("throws when the Supabase URL is not configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    expect(() => publicMediaUrl("items/item-web/1f0c.webp")).toThrow();
  });
});
