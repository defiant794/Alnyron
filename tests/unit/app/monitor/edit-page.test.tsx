// @vitest-environment jsdom
/**
 * Unit tests: src/app/monitor/(panel)/monitors/[id]/edit/page.tsx — generateMetadata
 * Journey: a11y-polish  A11Y-09, A11Y-10, A11Y-11
 *
 * generateMetadata({ params }) must:
 *   - found monitor   → title "Rediger overvågning" (unchanged behaviour)
 *   - non-UUID id     → title "Siden findes ikke", no DB query
 *   - UUID, null      → title "Siden findes ikke"
 *   - robots always   → "noindex, nofollow"
 *   - never throw or call notFound()
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Metadata } from "next";

const { mockRequireMonitor, mockGetMonitor } = vi.hoisted(() => ({
  mockRequireMonitor: vi.fn(),
  mockGetMonitor: vi.fn(),
}));

vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  usePathname: () => "/monitor",
}));
vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));
vi.mock("@/services/monitor/monitors", () => ({
  getMonitor: mockGetMonitor,
  listMonitorEvents: vi.fn(),
}));
vi.mock("@/app/monitor/(panel)/actions", () => ({ updateMonitorAction: vi.fn() }));
vi.mock("@/components/monitor/MonitorShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/monitor/MonitorFormScreen", () => ({
  default: () => <div data-testid="form-screen" />,
}));
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/env")>()),
  parseSiteEnv: () => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }),
}));

import { generateMetadata as generateEditMetadata } from "@/app/monitor/(panel)/monitors/[id]/edit/page";

// Called with the route params the page receives.
type EditMetaFn = (p: { params: Promise<{ id: string }> }) => Promise<Metadata>;
const callEditMeta = (id: string) =>
  (generateEditMetadata as unknown as EditMetaFn)({ params: Promise.resolve({ id }) });

const TEST_MONITOR_ID = "00000000-0000-0000-0000-000000000011";
const TEST_MONITOR = {
  id: TEST_MONITOR_ID,
  url: "https://example.com/",
  label: null,
  status: "active" as const,
  interval_minutes: 1440,
  last_checked_at: null,
  consecutive_errors: 0,
  created_at: "2026-11-01T10:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMonitor.mockResolvedValue({ userId: "u1", email: "mon@test.local", role: "monitor_user" });
  mockGetMonitor.mockResolvedValue(TEST_MONITOR);
});

// ── A11Y-11: found monitor keeps "Rediger overvågning" ───────────────────────

describe("A11Y-11: edit generateMetadata — found monitor returns 'Rediger overvågning'", () => {
  it("A11Y-11a: title is 'Rediger overvågning'", async () => {
    const metadata = await callEditMeta(TEST_MONITOR_ID);
    expect(metadata.title).toBe("Rediger overvågning");
  });

  it("A11Y-11b: robots is 'noindex, nofollow'", async () => {
    const metadata = await callEditMeta(TEST_MONITOR_ID);
    expect(metadata.robots).toBe("noindex, nofollow");
  });
});

// ── A11Y-09: non-UUID id → "Siden findes ikke", no query ────────────────────

describe("A11Y-09: edit generateMetadata — non-UUID id resolves 'Siden findes ikke' without querying DB", () => {
  it("A11Y-09a: title is 'Siden findes ikke'", async () => {
    expect((await callEditMeta("not-a-uuid")).title).toBe("Siden findes ikke");
  });

  it("A11Y-09b: robots is 'noindex, nofollow'", async () => {
    expect((await callEditMeta("not-a-uuid")).robots).toBe("noindex, nofollow");
  });

  it("A11Y-09c: getMonitor is NOT called for a non-UUID id", async () => {
    await callEditMeta("not-a-uuid");
    expect(mockGetMonitor).not.toHaveBeenCalled();
  });

  it("A11Y-09d: does not throw for a non-UUID id", async () => {
    await expect(callEditMeta("not-a-uuid")).resolves.toBeDefined();
  });
});

// ── A11Y-10: valid UUID, getMonitor returns null → "Siden findes ikke" ───────

describe("A11Y-10: edit generateMetadata — valid UUID, getMonitor returns null, resolves 'Siden findes ikke'", () => {
  const MISSING_ID = "00000000-0000-0000-0000-000000000099";

  beforeEach(() => {
    mockGetMonitor.mockResolvedValue(null);
  });

  it("A11Y-10a: title is 'Siden findes ikke'", async () => {
    expect((await callEditMeta(MISSING_ID)).title).toBe("Siden findes ikke");
  });

  it("A11Y-10b: robots is 'noindex, nofollow'", async () => {
    expect((await callEditMeta(MISSING_ID)).robots).toBe("noindex, nofollow");
  });

  it("A11Y-10c: does not throw when monitor is null", async () => {
    await expect(callEditMeta(MISSING_ID)).resolves.toBeDefined();
  });
});
