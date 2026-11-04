/**
 * Unit tests — catalogVisibilityBadge helper (F2.3 catalog-admin)
 * Journey: catalog-admin
 * Acceptance IDs: AC-CATADM-02, AC-CATADM-03, AC-CATADM-04
 *
 * The helper is a pure function:
 *   catalogVisibilityBadge(status, publishedItemCount) → badge variant
 *
 * Logic (from mock and design brief §6):
 *   draft  + any count          → "skjult"    (red)
 *   published + 0 published     → "vises-ved-forste" (neutral)
 *   published + ≥1 published    → "synlig"    (green)
 */

import { describe, it, expect } from "vitest";
import { catalogVisibilityBadge } from "@/lib/catalog-visibility-badge";

// ── AC-CATADM-04: draft category is always Skjult ────────────────────────────

describe("AC-CATADM-04: catalogVisibilityBadge — draft category → skjult", () => {
  it("AC-CATADM-04a: draft + 0 published items → skjult", () => {
    expect(catalogVisibilityBadge("draft", 0)).toBe("skjult");
  });

  it("AC-CATADM-04b: draft + 3 published items → skjult (status wins)", () => {
    expect(catalogVisibilityBadge("draft", 3)).toBe("skjult");
  });

  it("AC-CATADM-04c: draft + 100 published items → skjult", () => {
    expect(catalogVisibilityBadge("draft", 100)).toBe("skjult");
  });
});

// ── AC-CATADM-03: published category, no published items ─────────────────────

describe("AC-CATADM-03: catalogVisibilityBadge — published, 0 published items → vises-ved-forste", () => {
  it("AC-CATADM-03a: published + 0 published items → vises-ved-forste", () => {
    expect(catalogVisibilityBadge("published", 0)).toBe("vises-ved-forste");
  });
});

// ── AC-CATADM-02: published category with published items ────────────────────

describe("AC-CATADM-02: catalogVisibilityBadge — published with published items → synlig", () => {
  it("AC-CATADM-02a: published + 1 published item → synlig", () => {
    expect(catalogVisibilityBadge("published", 1)).toBe("synlig");
  });

  it("AC-CATADM-02b: published + 5 published items → synlig", () => {
    expect(catalogVisibilityBadge("published", 5)).toBe("synlig");
  });

  it("AC-CATADM-02c: published + 0 draft + 1 published → synlig (draft count irrelevant)", () => {
    // Draft item count is not a parameter — publishedItemCount alone determines synlig vs vises-ved-forste.
    expect(catalogVisibilityBadge("published", 1)).toBe("synlig");
  });
});

// ── Exhaustive boundary ───────────────────────────────────────────────────────

describe("AC-CATADM-02/03/04: boundary — transition at publishedItemCount=1", () => {
  it("published + 0 → vises-ved-forste (boundary low)", () => {
    expect(catalogVisibilityBadge("published", 0)).toBe("vises-ved-forste");
  });

  it("published + 1 → synlig (boundary high)", () => {
    expect(catalogVisibilityBadge("published", 1)).toBe("synlig");
  });
});
