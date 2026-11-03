/**
 * Unit tests — catalog validation schemas (F2.1 catalog-model)
 * Journey: catalog-model  AC-CAT-75, AC-CAT-76, AC-CAT-77, AC-CAT-78, AC-CAT-79;
 * security hardening (f21-security-1 L3) AC-CAT-S13, AC-CAT-S14
 *
 * Module: src/lib/validation/catalog.ts
 */

import { describe, it, expect } from "vitest";
import { ITEMS_REORDER_MAX, MEDIA_ALT_MAX, RESERVED_ROUTE_SLUGS } from "@/config/catalog";
import {
  slugSchema,
  saveCategorySchema,
  saveItemSchema,
  mediaUploadSchema,
  attachMediaSchema,
  reorderItemsSchema,
  DA_TITLE_REQUIRED,
  SLUG_INVALID,
  PRICE_INVALID,
  LINKS_INVALID,
  ALT_REQUIRED,
  TOO_MANY_MEDIA,
} from "@/lib/validation/catalog";

// RFC 4122-compliant v4 UUIDs (version nibble '4', variant nibble '8'-'b').
const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
const VALID_ITEM_UUID = "550e8400-e29b-41d4-a716-446655440001";
const VALID_CATEGORY_UUID = "550e8400-e29b-41d4-a716-446655440002";
// Used only in a path string (not as a zod uuid field); just needs hex format.
const DIFFERENT_ITEM_UUID = "99999999-9999-4999-8999-999999999999";

// ── AC-CAT-75: slugSchema ─────────────────────────────────────────────────────

describe("AC-CAT-75: slugSchema validates slug format", () => {
  it("accepts a valid lowercase slug", () => {
    expect(slugSchema.safeParse("my-slug-1").success).toBe(true);
  });

  it("accepts a single word", () => {
    expect(slugSchema.safeParse("hello").success).toBe(true);
  });

  it("accepts a slug with digits", () => {
    expect(slugSchema.safeParse("app2024").success).toBe(true);
  });

  it("rejects uppercase letters", () => {
    expect(slugSchema.safeParse("My-Slug").success).toBe(false);
  });

  it("rejects trailing dash", () => {
    expect(slugSchema.safeParse("hello-").success).toBe(false);
  });

  it("rejects leading dash", () => {
    expect(slugSchema.safeParse("-hello").success).toBe(false);
  });

  it("rejects spaces", () => {
    expect(slugSchema.safeParse("hello world").success).toBe(false);
  });

  it("rejects underscore", () => {
    expect(slugSchema.safeParse("hello_world").success).toBe(false);
  });

  it("rejects consecutive dashes", () => {
    expect(slugSchema.safeParse("hello--world").success).toBe(false);
  });

  it("rejects slug longer than 80 chars", () => {
    const long = "a-" + "b".repeat(79);
    expect(long.length).toBeGreaterThan(80);
    expect(slugSchema.safeParse(long).success).toBe(false);
  });

  it("accepts exactly 80-char slug", () => {
    const s80 = "a".repeat(39) + "-" + "b".repeat(40); // 80 chars exactly
    expect(s80.length).toBe(80);
    expect(slugSchema.safeParse(s80).success).toBe(true);
  });
});

// ── AC-CAT-76: saveCategorySchema ─────────────────────────────────────────────

describe("AC-CAT-76: saveCategorySchema validates category payloads", () => {
  const validInsert = {
    kind: "apps" as const,
    translations: {
      da: { title: "Test kategori", description: "", seo_title: "", seo_description: "" },
    },
  };

  it("accepts a valid insert payload with kind", () => {
    expect(saveCategorySchema.safeParse(validInsert).success).toBe(true);
  });

  it("rejects an insert payload without kind (kind-required on kind)", () => {
    const result = saveCategorySchema.safeParse({ translations: validInsert.translations });
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.map((i) => [i.path.join("."), i.message])).toEqual([["kind", "kind-required"]]);
  });

  it("accepts an update payload with id (kind not required)", () => {
    const update = { id: VALID_UUID, translations: { da: { title: "Updated", description: "", seo_title: "", seo_description: "" } } };
    expect(saveCategorySchema.safeParse(update).success).toBe(true);
  });

  it("raises DA_TITLE_REQUIRED issue for blank DA title", () => {
    const payload = { ...validInsert, translations: { da: { title: "  ", description: "", seo_title: "", seo_description: "" } } };
    const result = saveCategorySchema.safeParse(payload);
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.some((i) => i.message === DA_TITLE_REQUIRED)).toBe(true);
  });

  it("raises SLUG_INVALID for a DA translation slug that fails the slug format", () => {
    const payload = {
      ...validInsert,
      translations: { da: { title: "Test", description: "", seo_title: "", seo_description: "", slug: "Invalid Slug!" } },
    };
    const result = saveCategorySchema.safeParse(payload);
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.some((i) => i.message === SLUG_INVALID)).toBe(true);
  });

  it("accepts a translation slug that matches the slug format", () => {
    const payload = {
      ...validInsert,
      translations: { da: { title: "Test", description: "", seo_title: "", seo_description: "", slug: "test-slug" } },
    };
    expect(saveCategorySchema.safeParse(payload).success).toBe(true);
  });

  it.each(RESERVED_ROUTE_SLUGS)("raises SLUG_INVALID for the reserved route slug '%s' (routes_slug_reserved)", (slug) => {
    const payload = {
      ...validInsert,
      translations: {
        da: { title: "Test", description: "", seo_title: "", seo_description: "", slug: "test-da" },
        en: { title: "Test", description: "", seo_title: "", seo_description: "", slug },
      },
    };
    const result = saveCategorySchema.safeParse(payload);
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.map((i) => [i.path.join("."), i.message])).toEqual([["translations.en.slug", SLUG_INVALID]]);
  });

  it("accepts a slug that only starts with a reserved word (admin-tools, mylife-app)", () => {
    for (const slug of ["admin-tools", "mylife-app", "api2"]) {
      const payload = {
        ...validInsert,
        translations: { da: { title: "Test", description: "", seo_title: "", seo_description: "", slug } },
      };
      expect(saveCategorySchema.safeParse(payload).success).toBe(true);
    }
  });
});

// ── AC-CAT-77: saveItemSchema ──────────────────────────────────────────────────

describe("AC-CAT-77: saveItemSchema validates item payloads", () => {
  const validInsert = {
    category_id: VALID_CATEGORY_UUID,
    price_type: null,
    price_amount: null,
    price_currency: "DKK",
    external_links: {},
    translations: {
      da: { slug: "test-item", title: "Test Item", summary: "", body_md: "", seo_title: "", seo_description: "" },
    },
  };

  it("accepts a valid insert payload", () => {
    expect(saveItemSchema.safeParse(validInsert).success).toBe(true);
  });

  it("rejects an insert payload without category_id (category-required on category_id)", () => {
    const { price_type, price_amount, price_currency, external_links, translations } = validInsert;
    const result = saveItemSchema.safeParse({ price_type, price_amount, price_currency, external_links, translations });
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.map((i) => [i.path.join("."), i.message])).toEqual([["category_id", "category-required"]]);
  });

  it("raises PRICE_INVALID when price_type=fixed but price_amount=null", () => {
    const payload = { ...validInsert, price_type: "fixed" as const, price_amount: null };
    const result = saveItemSchema.safeParse(payload);
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.some((i) => i.message === PRICE_INVALID)).toBe(true);
  });

  it("raises PRICE_INVALID when price_type=contact but price_amount is set", () => {
    const payload = { ...validInsert, price_type: "contact" as const, price_amount: 100 };
    const result = saveItemSchema.safeParse(payload);
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.some((i) => i.message === PRICE_INVALID)).toBe(true);
  });

  it("accepts price_type=fixed with a valid price_amount", () => {
    const payload = { ...validInsert, price_type: "fixed" as const, price_amount: 1000 };
    expect(saveItemSchema.safeParse(payload).success).toBe(true);
  });

  it("raises LINKS_INVALID for an http:// external link value", () => {
    const payload = { ...validInsert, external_links: { website: "http://example.com" } };
    const result = saveItemSchema.safeParse(payload);
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.some((i) => i.message === LINKS_INVALID)).toBe(true);
  });

  it("raises LINKS_INVALID for an unknown external_links key", () => {
    const payload = { ...validInsert, external_links: { unknown_key: "https://example.com" } };
    const result = saveItemSchema.safeParse(payload);
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.map((i) => i.message)).toEqual([LINKS_INVALID]);
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["protocol-relative", "//example.com"],
    ["https URL with a space", "https://example.com/a b"],
    ["https URL longer than 2048 characters", `https://example.com/${"a".repeat(2029)}`],
  ])("raises LINKS_INVALID for a %s external link", (_label, url) => {
    const payload = { ...validInsert, external_links: { demo: url } };
    const result = saveItemSchema.safeParse(payload);
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.message === LINKS_INVALID)).toBe(true);
  });

  it("raises LINKS_INVALID for a non-string link value or a non-object external_links", () => {
    for (const external_links of [{ website: 42 }, [], null, "https://example.com"]) {
      const result = saveItemSchema.safeParse({ ...validInsert, external_links });
      expect(result.success).toBe(false);
      const issues = !result.success ? result.error.issues : [];
      expect(issues.map((i) => i.message)).toEqual([LINKS_INVALID]);
    }
  });

  it("accepts an https link of exactly 2048 characters", () => {
    const url = `https://example.com/${"a".repeat(2028)}`;
    expect(url).toHaveLength(2048);
    expect(saveItemSchema.safeParse({ ...validInsert, external_links: { download: url } }).success).toBe(true);
  });

  it.each([
    ["three decimals", 10.005],
    ["more than numeric(12,2) holds", 10_000_000_000],
    ["a negative amount", -1],
  ])("raises PRICE_INVALID for a fixed price with %s", (_label, amount) => {
    const payload = { ...validInsert, price_type: "fixed" as const, price_amount: amount };
    const result = saveItemSchema.safeParse(payload);
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.map((i) => i.message)).toEqual([PRICE_INVALID]);
  });

  it("accepts the largest numeric(12,2) amount with two decimals", () => {
    const payload = { ...validInsert, price_type: "from" as const, price_amount: 9_999_999_999.99 };
    expect(saveItemSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts a reserved route word as an item slug (item slugs are not routes)", () => {
    const payload = {
      ...validInsert,
      translations: { da: { ...validInsert.translations.da, slug: "admin" } },
    };
    expect(saveItemSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts all 5 valid external_link keys with https values", () => {
    const payload = {
      ...validInsert,
      external_links: {
        website: "https://example.com",
        demo: "https://demo.example.com",
        app_store: "https://apps.apple.com/app",
        google_play: "https://play.google.com/store/apps",
        download: "https://example.com/download",
      },
    };
    expect(saveItemSchema.safeParse(payload).success).toBe(true);
  });

  it("raises TOO_MANY_MEDIA when media array has more than 8 entries", () => {
    const mediaEntry = { id: VALID_UUID, alt_da: "Alt", alt_en: "", sort_order: 10 };
    const payload = { ...validInsert, media: Array(9).fill(mediaEntry) };
    const result = saveItemSchema.safeParse(payload);
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.some((i) => i.message === TOO_MANY_MEDIA)).toBe(true);
  });

  it("accepts a media array with exactly 8 entries", () => {
    const mediaEntry = { id: VALID_UUID, alt_da: "Alt", alt_en: "", sort_order: 10 };
    const payload = { ...validInsert, media: Array(8).fill(mediaEntry) };
    expect(saveItemSchema.safeParse(payload).success).toBe(true);
  });
});

// ── AC-CAT-78: mediaUploadSchema ─────────────────────────────────────────────

describe("AC-CAT-78: mediaUploadSchema validates upload params", () => {
  const valid = { itemId: VALID_UUID, mimeType: "image/webp", size: 1024 };

  it("accepts a valid upload params object", () => {
    expect(mediaUploadSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unsupported MIME type", () => {
    expect(mediaUploadSchema.safeParse({ ...valid, mimeType: "image/gif" }).success).toBe(false);
  });

  it("rejects size of 0", () => {
    expect(mediaUploadSchema.safeParse({ ...valid, size: 0 }).success).toBe(false);
  });

  it("rejects size greater than 5242880", () => {
    expect(mediaUploadSchema.safeParse({ ...valid, size: 5242881 }).success).toBe(false);
  });

  it("accepts size of exactly 5242880", () => {
    expect(mediaUploadSchema.safeParse({ ...valid, size: 5242880 }).success).toBe(true);
  });

  it("accepts all supported MIME types", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp", "image/avif"]) {
      expect(mediaUploadSchema.safeParse({ ...valid, mimeType: mime }).success).toBe(true);
    }
  });
});

// ── AC-CAT-79: attachMediaSchema ──────────────────────────────────────────────

describe("AC-CAT-79: attachMediaSchema validates attach params", () => {
  const itemId = VALID_ITEM_UUID;
  const fileId = VALID_UUID;
  const validPath = `items/${itemId}/${fileId}.webp`;

  const valid = {
    itemId,
    path: validPath,
    alt_da: "Alt text DA",
    alt_en: "",
    width: 800,
    height: 600,
  };

  it("accepts a valid attach params object", () => {
    expect(attachMediaSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a path that does not match items/{uuid}/{uuid}.ext", () => {
    expect(attachMediaSchema.safeParse({ ...valid, path: "other/path/file.webp" }).success).toBe(false);
  });

  it("rejects a path with bad extension", () => {
    expect(attachMediaSchema.safeParse({ ...valid, path: `items/${itemId}/${fileId}.gif` }).success).toBe(false);
  });

  it("rejects a path where the item segment does not match itemId", () => {
    expect(
      attachMediaSchema.safeParse({ ...valid, path: `items/${DIFFERENT_ITEM_UUID}/${fileId}.webp` }).success,
    ).toBe(false);
  });

  it("rejects blank alt_da with ALT_REQUIRED", () => {
    const result = attachMediaSchema.safeParse({ ...valid, alt_da: "  " });
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.map((i) => i.message)).toEqual([ALT_REQUIRED]);
  });

  it("accepts blank alt_en (defaults to empty string)", () => {
    expect(attachMediaSchema.safeParse({ ...valid, alt_en: "" }).success).toBe(true);
  });

  it("rejects width of 0", () => {
    expect(attachMediaSchema.safeParse({ ...valid, width: 0 }).success).toBe(false);
  });

  it("rejects height of 0", () => {
    expect(attachMediaSchema.safeParse({ ...valid, height: 0 }).success).toBe(false);
  });
});

// ── AC-CAT-S13: alt texts are capped at MEDIA_ALT_MAX (media_alt_*_length) ────

describe("AC-CAT-S13: alt_da / alt_en are at most MEDIA_ALT_MAX characters", () => {
  const atMax = "a".repeat(MEDIA_ALT_MAX);
  const overMax = "a".repeat(MEDIA_ALT_MAX + 1);
  const attach = {
    itemId: VALID_ITEM_UUID,
    path: `items/${VALID_ITEM_UUID}/${VALID_UUID}.webp`,
    alt_da: "Alt",
    alt_en: "",
    width: 800,
    height: 600,
  };
  const item = {
    id: VALID_ITEM_UUID,
    price_type: null,
    price_amount: null,
    external_links: {},
    translations: {
      da: { slug: "test-item", title: "Test Item", summary: "", body_md: "", seo_title: "", seo_description: "" },
    },
  };
  const mediaEntry = { id: VALID_UUID, alt_da: "Alt", alt_en: "", sort_order: 10 };

  it("MEDIA_ALT_MAX matches the media_alt_*_length CHECKs (300)", () => {
    expect(MEDIA_ALT_MAX).toBe(300);
  });

  it("attachMediaSchema accepts alt_da and alt_en of exactly MEDIA_ALT_MAX", () => {
    expect(attachMediaSchema.safeParse({ ...attach, alt_da: atMax, alt_en: atMax }).success).toBe(true);
  });

  it("attachMediaSchema rejects alt_da or alt_en over MEDIA_ALT_MAX at that field", () => {
    for (const field of ["alt_da", "alt_en"] as const) {
      const result = attachMediaSchema.safeParse({ ...attach, [field]: overMax });
      expect(result.success).toBe(false);
      const issues = !result.success ? result.error.issues : [];
      expect(issues.map((i) => [i.path.join("."), i.code])).toEqual([[field, "too_big"]]);
    }
  });

  it("saveItemSchema accepts media alt texts of exactly MEDIA_ALT_MAX", () => {
    const payload = { ...item, media: [{ ...mediaEntry, alt_da: atMax, alt_en: atMax }] };
    expect(saveItemSchema.safeParse(payload).success).toBe(true);
  });

  it("saveItemSchema rejects a media alt_da or alt_en over MEDIA_ALT_MAX at that field", () => {
    for (const field of ["alt_da", "alt_en"] as const) {
      const result = saveItemSchema.safeParse({ ...item, media: [{ ...mediaEntry, [field]: overMax }] });
      expect(result.success).toBe(false);
      const issues = !result.success ? result.error.issues : [];
      expect(issues.map((i) => [i.path.join("."), i.code])).toEqual([[`media.0.${field}`, "too_big"]]);
    }
  });
});

// ── AC-CAT-S14: reorderItemsSchema caps the id list at ITEMS_REORDER_MAX ─────

describe("AC-CAT-S14: reorderItemsSchema accepts at most ITEMS_REORDER_MAX item ids", () => {
  const ids = (count: number) =>
    Array.from({ length: count }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`);

  it("ITEMS_REORDER_MAX matches the admin_reorder_items bound (1000)", () => {
    expect(ITEMS_REORDER_MAX).toBe(1000);
  });

  it("accepts exactly ITEMS_REORDER_MAX distinct ids", () => {
    expect(reorderItemsSchema.safeParse({ categoryId: VALID_CATEGORY_UUID, itemIds: ids(ITEMS_REORDER_MAX) }).success).toBe(true);
  });

  it("rejects ITEMS_REORDER_MAX + 1 distinct ids with too_big on itemIds", () => {
    const result = reorderItemsSchema.safeParse({ categoryId: VALID_CATEGORY_UUID, itemIds: ids(ITEMS_REORDER_MAX + 1) });
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.map((i) => [i.path.join("."), i.code])).toEqual([["itemIds", "too_big"]]);
  });
});
