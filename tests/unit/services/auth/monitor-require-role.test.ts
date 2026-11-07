/**
 * Unit tests: getMonitorAccess / requireMonitor
 * (src/services/auth/require-role.ts, getAreaAccess("monitor")).
 * Journey: monitor-web-area  MON-AC44, MON-AC45, MON-AC46, MON-AC47, MON-AC48,
 *   MON-AC49, MON-AC50
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetClaims, mockProfilesSelect, mockRedirect } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
  mockProfilesSelect: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    auth: { getClaims: mockGetClaims },
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockProfilesSelect })) })) })),
  })),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

vi.mock("react", async (importOriginal) => {
  // avoid server-only React import issues in jsdom-less env
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

import { getAreaAccess, requireMonitor } from "@/services/auth/require-role";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000099";

function validClaims(email = "user@test.local") {
  return {
    data: {
      claims: { sub: TEST_USER_ID, role: "authenticated", email },
    },
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getAreaAccess("monitor") ──────────────────────────────────────────────────

describe('getAreaAccess("monitor"): MON-AC44/MON-AC45/MON-AC46/MON-AC47', () => {
  it("MON-AC44f: anonymous → { status: 'anonymous' }", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });
    const result = await getAreaAccess("monitor");
    expect(result.status).toBe("anonymous");
  });

  it("MON-AC46a: mylife_user → { status: 'forbidden' }", async () => {
    mockGetClaims.mockResolvedValue(validClaims("ml@test.local"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "mylife_user" }, error: null });
    const result = await getAreaAccess("monitor");
    expect(result.status).toBe("forbidden");
  });

  it("MON-AC45a: admin (non-owner) → { status: 'forbidden' }", async () => {
    mockGetClaims.mockResolvedValue(validClaims("admin@test.local"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "admin" }, error: null });
    const result = await getAreaAccess("monitor");
    expect(result.status).toBe("forbidden");
  });

  it("MON-AC47a: monitor_user → { status: 'allowed' }", async () => {
    mockGetClaims.mockResolvedValue(validClaims("mon@test.local"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "monitor_user" }, error: null });
    const result = await getAreaAccess("monitor");
    expect(result.status).toBe("allowed");
  });

  it("MON-AC47b: owner → { status: 'allowed' }", async () => {
    mockGetClaims.mockResolvedValue(validClaims("owner@test.local"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "owner" }, error: null });
    const result = await getAreaAccess("monitor");
    expect(result.status).toBe("allowed");
  });
});

// ── requireMonitor() ──────────────────────────────────────────────────────────

describe("requireMonitor(): MON-AC44/MON-AC45/MON-AC46/MON-AC47", () => {
  it("MON-AC44g: anonymous → redirects to /monitor/login", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });
    await expect(requireMonitor()).rejects.toThrow(/NEXT_REDIRECT:\/monitor\/login/);
  });

  it("MON-AC45b: admin → redirects to /monitor/no-access", async () => {
    mockGetClaims.mockResolvedValue(validClaims("admin@test.local"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "admin" }, error: null });
    await expect(requireMonitor()).rejects.toThrow(/NEXT_REDIRECT:\/monitor\/no-access/);
  });

  it("MON-AC46b: mylife_user → redirects to /monitor/no-access", async () => {
    mockGetClaims.mockResolvedValue(validClaims("ml@test.local"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "mylife_user" }, error: null });
    await expect(requireMonitor()).rejects.toThrow(/NEXT_REDIRECT:\/monitor\/no-access/);
  });

  it("MON-AC47c: monitor_user → returns session info", async () => {
    mockGetClaims.mockResolvedValue(validClaims("mon@test.local"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "monitor_user" }, error: null });
    const result = await requireMonitor();
    expect(result).toMatchObject({ userId: TEST_USER_ID, role: "monitor_user" });
  });

  it("MON-AC47d: owner → returns session info", async () => {
    mockGetClaims.mockResolvedValue(validClaims("owner@test.local"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "owner" }, error: null });
    const result = await requireMonitor();
    expect(result).toMatchObject({ userId: TEST_USER_ID, role: "owner" });
  });
});

// ── privilege bleed: MON-AC48/MON-AC49 ───────────────────────────────────────

describe("getAreaAccess privilege bleed: MON-AC48/MON-AC49", () => {
  it("MON-AC48a: monitor_user in admin area → forbidden", async () => {
    mockGetClaims.mockResolvedValue(validClaims("mon@test.local"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "monitor_user" }, error: null });
    const result = await getAreaAccess("admin");
    expect(result.status).toBe("forbidden");
  });

  it("MON-AC49a: monitor_user in mylife area → forbidden", async () => {
    mockGetClaims.mockResolvedValue(validClaims("mon@test.local"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "monitor_user" }, error: null });
    const result = await getAreaAccess("mylife");
    expect(result.status).toBe("forbidden");
  });
});
