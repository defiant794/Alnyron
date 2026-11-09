/**
 * Unit tests: getNavItems — Monitor nav item href is an absolute Monitor subdomain URL.
 * Journey: monitor-ship-routing  SHIP-AC8a, SHIP-AC8b
 *
 * Verifies:
 *   SHIP-AC8a: a monitor page row produces a NavItem whose href is
 *              `${monitorSiteOrigin(NEXT_PUBLIC_SITE_URL)}/` (absolute)
 *   SHIP-AC8b: the env is read at call time — changing it between calls
 *              changes the href
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ──────────────────────────────────────────────────────────────

const { mockPagesQuery, mockParseSiteEnv } = vi.hoisted(() => ({
  mockPagesQuery: vi.fn(),
  mockParseSiteEnv: vi.fn(),
}));

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);

vi.mock("@/lib/supabase/public", () => ({
  getPublicClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => mockPagesQuery()),
        })),
      })),
    })),
  })),
}));

vi.mock("@/services/content/categories", () => ({
  getPublicCategories: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/config/env", () => ({
  parseSiteEnv: mockParseSiteEnv,
}));

import { getNavItems } from "@/services/content/nav";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const monitorRow = {
  id: "00000000-0000-0000-0000-000000000099",
  system_key: "monitor",
  nav_order: 1100,
  page_translations: [],
  routes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPagesQuery.mockResolvedValue({ data: [monitorRow], error: null });
  mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
});

// ── SHIP-AC8a: monitor item href is absolute monitor subdomain URL ────────────

describe("getNavItems — SHIP-AC8a: Monitor nav item href is absolute subdomain URL", () => {
  it("SHIP-AC8a-1: monitor item href = 'http://monitor.localhost:3000/' (local dev)", async () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
    const items = await getNavItems("da");
    const monitorItem = items.find((i) => i.key === "system-monitor");
    expect(monitorItem?.href).toBe("http://monitor.localhost:3000/");
  });

  it("SHIP-AC8a-2: monitor item href = 'https://monitor.alnyron.dk/' (production)", async () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk" });
    const items = await getNavItems("da");
    const monitorItem = items.find((i) => i.key === "system-monitor");
    expect(monitorItem?.href).toBe("https://monitor.alnyron.dk/");
  });
});

// ── SHIP-AC8b: env read at call time ─────────────────────────────────────────

describe("getNavItems — SHIP-AC8b: Monitor href reflects env at call time", () => {
  it("SHIP-AC8b-1: href changes when NEXT_PUBLIC_SITE_URL changes between calls", async () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
    const first = await getNavItems("da");
    const firstHref = first.find((i) => i.key === "system-monitor")?.href;

    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk" });
    const second = await getNavItems("da");
    const secondHref = second.find((i) => i.key === "system-monitor")?.href;

    expect(firstHref).toBe("http://monitor.localhost:3000/");
    expect(secondHref).toBe("https://monitor.alnyron.dk/");
    expect(firstHref).not.toBe(secondHref);
  });
});
