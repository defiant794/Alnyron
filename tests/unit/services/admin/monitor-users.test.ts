/**
 * Unit tests — listMonitorSignups service (admin-monitor-users)
 * Journey: admin-monitor-users  AC-AMU-30, AC-AMU-31, AC-AMU-32, AC-AMU-33
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockRpc } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    rpc: mockRpc,
  })),
}));

// ── Module under test ──────────────────────────────────────────────────────────

import { listMonitorSignups } from "@/services/admin/monitor-users";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RAW_ROWS = [
  {
    email: "newer@example.com",
    created_at: "2026-10-15T09:00:00.000Z",
    confirmed: true,
    monitor_count: 2,
  },
  {
    email: "older@example.com",
    created_at: "2026-09-01T14:30:00.000Z",
    confirmed: false,
    monitor_count: 0,
  },
];

const MAPPED_ROWS = [
  { email: "newer@example.com", signedUpAt: "2026-10-15T09:00:00.000Z", confirmed: true,  monitorCount: 2 },
  { email: "older@example.com", signedUpAt: "2026-09-01T14:30:00.000Z", confirmed: false, monitorCount: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ── AC-AMU-30: RPC name — exact call, no extra args ──────────────────────────

describe("AC-AMU-30: listMonitorSignups — calls rpc with 'admin_list_monitor_signups'", () => {
  it("AC-AMU-30: calls .rpc() with exactly ['admin_list_monitor_signups'] and nothing else", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listMonitorSignups();

    expect(mockRpc.mock.calls).toEqual([["admin_list_monitor_signups"]]);
  });
});

// ── AC-AMU-31: exact output shape — snake→camel, order preserved ──────────────

describe("AC-AMU-31: listMonitorSignups — exact output shape, snake→camel, order preserved", () => {
  it("AC-AMU-31: result equals exact mapped array (no extra keys, correct camelCase, same order)", async () => {
    mockRpc.mockResolvedValue({ data: RAW_ROWS, error: null });

    const result = await listMonitorSignups();

    expect(result).toEqual(MAPPED_ROWS);
  });

  it("AC-AMU-31a: signedUpAt is the ISO string as returned by the RPC (no re-parsing)", async () => {
    mockRpc.mockResolvedValue({ data: RAW_ROWS, error: null });

    const result = await listMonitorSignups();

    expect(result[0]!.signedUpAt).toBe("2026-10-15T09:00:00.000Z");
    expect(result[1]!.signedUpAt).toBe("2026-09-01T14:30:00.000Z");
  });

  it("AC-AMU-31b: monitorCount maps monitor_count", async () => {
    mockRpc.mockResolvedValue({ data: RAW_ROWS, error: null });

    const result = await listMonitorSignups();

    expect(result[0]!.monitorCount).toBe(2);
    expect(result[1]!.monitorCount).toBe(0);
  });
});

// ── AC-AMU-32: empty array ────────────────────────────────────────────────────

describe("AC-AMU-32: listMonitorSignups — empty array when RPC returns []", () => {
  it("AC-AMU-32: returns [] when the RPC returns an empty array", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const result = await listMonitorSignups();

    expect(result).toEqual([]);
  });
});

// ── AC-AMU-33: RPC error throws ───────────────────────────────────────────────

describe("AC-AMU-33: listMonitorSignups — throws on RPC error", () => {
  it("AC-AMU-33: throws an Error whose message includes the RPC error message", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });

    await expect(listMonitorSignups()).rejects.toThrow(/forbidden/);
  });
});
