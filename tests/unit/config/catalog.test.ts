/**
 * Unit tests — catalog config constants (F2.1 catalog-model)
 * Journey: catalog-model  AC-CAT-80
 *
 * Module: src/config/catalog.ts
 */

import { describe, it, expect } from "vitest";
import {
  CATALOG_KINDS,
  EXTERNAL_LINK_KEYS,
  MEDIA_MAX_PER_ITEM,
  MEDIA_MAX_BYTES,
  KIND_GLYPH,
  KIND_MONOGRAM,
  PRICE_CURRENCY,
  RESERVED_ROUTE_SLUGS,
} from "@/config/catalog";

// ── AC-CAT-80: config constants ───────────────────────────────────────────────

describe("AC-CAT-80: catalog config constants are correct and complete", () => {
  describe("CATALOG_KINDS", () => {
    it("has exactly 4 values", () => {
      expect(CATALOG_KINDS).toHaveLength(4);
    });

    it("contains apps, websites, services, models3d", () => {
      expect(CATALOG_KINDS).toContain("apps");
      expect(CATALOG_KINDS).toContain("websites");
      expect(CATALOG_KINDS).toContain("services");
      expect(CATALOG_KINDS).toContain("models3d");
    });
  });

  describe("EXTERNAL_LINK_KEYS", () => {
    it("has exactly 5 values", () => {
      expect(EXTERNAL_LINK_KEYS).toHaveLength(5);
    });

    it("contains website, demo, app_store, google_play, download", () => {
      expect(EXTERNAL_LINK_KEYS).toContain("website");
      expect(EXTERNAL_LINK_KEYS).toContain("demo");
      expect(EXTERNAL_LINK_KEYS).toContain("app_store");
      expect(EXTERNAL_LINK_KEYS).toContain("google_play");
      expect(EXTERNAL_LINK_KEYS).toContain("download");
    });
  });

  describe("MEDIA_MAX_PER_ITEM", () => {
    it("equals 8", () => {
      expect(MEDIA_MAX_PER_ITEM).toBe(8);
    });
  });

  describe("MEDIA_MAX_BYTES", () => {
    it("equals 5242880 (5 MiB)", () => {
      expect(MEDIA_MAX_BYTES).toBe(5242880);
    });

    it("equals 5 * 1024 * 1024", () => {
      expect(MEDIA_MAX_BYTES).toBe(5 * 1024 * 1024);
    });
  });

  describe("KIND_GLYPH", () => {
    it("has an entry for each of the 4 catalog kinds", () => {
      expect(KIND_GLYPH).toHaveProperty("apps");
      expect(KIND_GLYPH).toHaveProperty("websites");
      expect(KIND_GLYPH).toHaveProperty("services");
      expect(KIND_GLYPH).toHaveProperty("models3d");
    });

    it("each glyph is a non-empty string", () => {
      for (const kind of CATALOG_KINDS) {
        expect(typeof KIND_GLYPH[kind]).toBe("string");
        expect(KIND_GLYPH[kind].length).toBeGreaterThan(0);
      }
    });

    it("apps glyph is ◱", () => {
      expect(KIND_GLYPH["apps"]).toBe("◱");
    });

    it("websites glyph is ◫", () => {
      expect(KIND_GLYPH["websites"]).toBe("◫");
    });

    it("services glyph is ▣", () => {
      expect(KIND_GLYPH["services"]).toBe("▣");
    });

    it("models3d glyph is ◈", () => {
      expect(KIND_GLYPH["models3d"]).toBe("◈");
    });
  });

  describe("KIND_MONOGRAM (home page category cards)", () => {
    it("maps every kind to its letter mark from the approved home mock", () => {
      expect(KIND_MONOGRAM).toEqual({ apps: "A", websites: "W", services: "S", models3d: "3D" });
    });
  });

  describe("RESERVED_ROUTE_SLUGS", () => {
    it("lists exactly the routes_slug_reserved slugs, including mylife", () => {
      expect([...RESERVED_ROUTE_SLUGS]).toEqual([
        "admin",
        "auth",
        "api",
        "da",
        "en",
        "kontakt",
        "contact",
        "privatliv",
        "privacy",
        "mylife",
      ]);
    });
  });

  describe("PRICE_CURRENCY", () => {
    it("equals 'DKK'", () => {
      expect(PRICE_CURRENCY).toBe("DKK");
    });
  });
});
