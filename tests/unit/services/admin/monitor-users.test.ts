/**
 * Unit tests — listMonitorSignups + deleteMonitorUser services (admin-monitor-users-cleanup + admin-monitor-users-sites)
 * Journey: admin-monitor-users       AC-AMU-30, AC-AMU-31, AC-AMU-32, AC-AMU-33
 * Journey: admin-monitor-users-cleanup  AMC-7, AMC-8, AMC-9, AMC-10, AMC-11
 * Journey: admin-monitor-users-sites    AMSS-1, AMSS-2, AMSS-5
 * Journey: payments-slice1-foundation  PAY1-AC6c
 */

import { format } from "node:util";
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

import { listMonitorSignups, deleteMonitorUser } from "@/services/admin/monitor-users";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RAW_ROWS = [
  {
    user_id: "u-newer-uuid",
    email: "newer@example.com",
    created_at: "2026-10-15T09:00:00.000Z",
    confirmed: true,
    monitor_count: 2,
  },
  {
    user_id: "u-older-uuid",
    email: "older@example.com",
    created_at: "2026-09-01T14:30:00.000Z",
    confirmed: false,
    monitor_count: 0,
  },
];

const MAPPED_ROWS = [
  { userId: "u-newer-uuid", email: "newer@example.com", signedUpAt: "2026-10-15T09:00:00.000Z", confirmed: true,  monitorCount: 2, monitors: [] },
  { userId: "u-older-uuid", email: "older@example.com", signedUpAt: "2026-09-01T14:30:00.000Z", confirmed: false, monitorCount: 0, monitors: [] },
];

const TARGET_UUID = "00000000-0000-0000-0a30-000000000001";

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
  it("AC-AMU-31 / AMC-7: result equals exact mapped array (userId included, no extra keys, correct camelCase, same order)", async () => {
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

// ── AMC-7: userId maps user_id ────────────────────────────────────────────────

describe("AMC-7: listMonitorSignups — userId mapped from user_id", () => {
  it("AMC-7a: each row's userId equals the raw user_id string", async () => {
    mockRpc.mockResolvedValue({ data: RAW_ROWS, error: null });

    const result = await listMonitorSignups();

    expect(result[0]!.userId).toBe("u-newer-uuid");
    expect(result[1]!.userId).toBe("u-older-uuid");
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

// ── AMC-8: deleteMonitorUser RPC name and args ────────────────────────────────

describe("AMC-8: deleteMonitorUser — calls rpc('admin_delete_monitor_user', {p_user_id})", () => {
  it("AMC-8: calls .rpc() with 'admin_delete_monitor_user' and { p_user_id: userId }", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    await deleteMonitorUser(TARGET_UUID);

    expect(mockRpc).toHaveBeenCalledWith("admin_delete_monitor_user", {
      p_user_id: TARGET_UUID,
    });
  });

  it("AMC-8b: no extra arguments beyond the two positional ones", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    await deleteMonitorUser(TARGET_UUID);

    expect(mockRpc.mock.calls[0]).toHaveLength(2);
  });

  it("AMC-8c: success (no error) → {ok:true}", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await deleteMonitorUser(TARGET_UUID);

    expect(result).toEqual({ ok: true });
  });
});

// ── AMC-9: P0002 → not-found ─────────────────────────────────────────────────

describe("AMC-9: deleteMonitorUser — P0002 → {ok:false, error:'not-found'}", () => {
  it("AMC-9: RPC returns P0002 → {ok:false, error:'not-found'}", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "not_found" },
    });

    const result = await deleteMonitorUser(TARGET_UUID);

    expect(result).toEqual({ ok: false, error: "not-found" });
  });
});

// ── AMC-10: P0001 not_monitor_user → not-monitor-user ────────────────────────

describe("AMC-10: deleteMonitorUser — P0001 not_monitor_user → {ok:false, error:'not-monitor-user'}", () => {
  it("AMC-10: RPC returns P0001 with message 'not_monitor_user' → {ok:false, error:'not-monitor-user'}", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "not_monitor_user" },
    });

    const result = await deleteMonitorUser(TARGET_UUID);

    expect(result).toEqual({ ok: false, error: "not-monitor-user" });
  });

  it("AMC-10b: P0001 with different message is NOT not-monitor-user", async () => {
    // A different P0001 (e.g. from another guard) should fall through to 'failed'
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "some_other_guard" },
    });

    const result = await deleteMonitorUser(TARGET_UUID);

    expect(result).toEqual({ ok: false, error: "failed" });
  });
});

// ── AMC-11: other errors → failed + console.error ────────────────────────────

describe("AMC-11: deleteMonitorUser — other RPC error → {ok:false, error:'failed'} + console.error", () => {
  it("AMC-11a: unknown error code → {ok:false, error:'failed'}", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "XXXXX", message: "unexpected" },
    });

    const result = await deleteMonitorUser(TARGET_UUID);

    expect(result).toEqual({ ok: false, error: "failed" });
    consoleSpy.mockRestore();
  });

  it("AMC-11b: console.error is called with pinned text 'admin_delete_monitor_user failed: <code>'", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "XXXXX", message: "unexpected" },
    });

    await deleteMonitorUser(TARGET_UUID);

    expect(consoleSpy).toHaveBeenCalledWith("admin_delete_monitor_user failed: XXXXX");
    consoleSpy.mockRestore();
  });

  it("AMC-11b-no-code: missing error code logs 'admin_delete_monitor_user failed: unknown'", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: undefined, message: "unexpected" },
    });

    await deleteMonitorUser(TARGET_UUID);

    expect(consoleSpy).toHaveBeenCalledWith("admin_delete_monitor_user failed: unknown");
    consoleSpy.mockRestore();
  });

  it("AMC-11c: the one console.error line leaves out the userId and email the RPC error carries", async () => {
    const EMAIL = "victim@example.com";
    const logged: string[] = [];
    // util.format renders the arguments as console.error prints them (objects and errors inspected).
    const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(format(...args));
    });
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        code: "XXXXX",
        message: `delete of ${TARGET_UUID} (${EMAIL}) failed`,
        details: `Key (id)=(${TARGET_UUID}) email=${EMAIL}`,
        hint: null,
      },
    });

    await deleteMonitorUser(TARGET_UUID);

    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain(TARGET_UUID);
    expect(logged[0]).not.toContain(EMAIL);
    consoleSpy.mockRestore();
  });

  it("AMC-11-42501: 42501 (forbidden) → {ok:false, error:'failed'}", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "forbidden" },
    });

    const result = await deleteMonitorUser(TARGET_UUID);

    expect(result).toEqual({ ok: false, error: "failed" });
    consoleSpy.mockRestore();
  });
});

// ── AMSS raw fixtures (monitors column, new RPC shape) ───────────────────────

/** Raw RPC row with two monitors: one active (with label), one paused (null label). */
const RAW_ROW_WITH_MONITORS = {
  user_id: "u-sites",
  email: "sites@example.com",
  created_at: "2026-10-20T10:00:00.000Z",
  confirmed: true,
  monitor_count: 2,
  monitors: [
    { url: "https://alpha.example.com", label: "Alpha", status: "active" },
    { url: "https://beta.example.com",  label: null,    status: "paused" },
  ],
};

/** Raw RPC row with no monitors (empty jsonb array). */
const RAW_ROW_NO_MONITORS = {
  user_id: "u-no-sites",
  email: "nosites@example.com",
  created_at: "2026-10-21T10:00:00.000Z",
  confirmed: false,
  monitor_count: 0,
  monitors: [],
};

/**
 * Raw RPC row with three monitors in an order no sort reproduces (by url, label or
 * status, either direction), so any re-sort in the service fails AMSS-5.
 */
const RAW_ROW_MANY_MONITORS = {
  user_id: "u-many-sites",
  email: "many@example.com",
  created_at: "2026-10-22T10:00:00.000Z",
  confirmed: true,
  monitor_count: 3,
  monitors: [
    { url: "https://zulu.example.com",  label: "Zulu", status: "active" },
    { url: "https://alpha.example.com", label: null,   status: "paused" },
    { url: "https://mike.example.com",  label: "Mike", status: "active" },
  ],
};

// ── AMSS-1: monitors array mapped from jsonb ──────────────────────────────────
// Journey: admin-monitor-users-sites   AC: service maps monitors jsonb → MonitorSite[]

describe("AMSS-1: listMonitorSignups — monitors mapped from jsonb monitors column", () => {
  it("AMSS-1: row with two monitors returns monitors array with url/label/status", async () => {
    mockRpc.mockResolvedValueOnce({ data: [RAW_ROW_WITH_MONITORS], error: null });

    const result = await listMonitorSignups();

    expect(result[0]?.monitors).toEqual([
      { url: "https://alpha.example.com", label: "Alpha", status: "active" },
      { url: "https://beta.example.com",  label: null,    status: "paused" },
    ]);
  });
});

// ── AMSS-2: monitors is [] when user has no monitors ─────────────────────────
// Journey: admin-monitor-users-sites   AC: service maps empty monitors to []

describe("AMSS-2: listMonitorSignups — monitors is [] when RPC returns empty monitors jsonb", () => {
  it("AMSS-2: row with monitors=[] returns monitors: []", async () => {
    mockRpc.mockResolvedValueOnce({ data: [RAW_ROW_NO_MONITORS], error: null });

    const result = await listMonitorSignups();

    expect(result[0]?.monitors).toEqual([]);
  });
});

// ── AMSS-5: multiple monitors order preserved ─────────────────────────────────
// Journey: admin-monitor-users-sites   AC: monitors preserve RPC-returned order

describe("AMSS-5: listMonitorSignups — multiple monitors preserve RPC-returned order", () => {
  it("AMSS-5: three monitors are returned in the RPC's order, not re-sorted", async () => {
    mockRpc.mockResolvedValueOnce({ data: [RAW_ROW_MANY_MONITORS], error: null });

    const result = await listMonitorSignups();

    expect(result[0]?.monitors.map((s) => s.url)).toEqual([
      "https://zulu.example.com",
      "https://alpha.example.com",
      "https://mike.example.com",
    ]);
  });
});

// ── PAY1-AC6c: has_active_subscription → has-active-subscription ──────────────
// Journey: payments-slice1-foundation  PAY1-AC6c

describe("PAY1-AC6c: deleteMonitorUser — P0001 has_active_subscription → {ok:false, error:'has-active-subscription'}", () => {
  it("PAY1-AC6c: RPC returns P0001 with message 'has_active_subscription' → {ok:false, error:'has-active-subscription'}", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "has_active_subscription" },
    });

    const result = await deleteMonitorUser(TARGET_UUID);

    expect(result).toEqual({ ok: false, error: "has-active-subscription" });
  });

  it("PAY1-AC6c-no-throw: has_active_subscription does not throw (returned, not thrown)", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "has_active_subscription" },
    });

    await expect(deleteMonitorUser(TARGET_UUID)).resolves.toMatchObject({ ok: false });
  });

  it("PAY1-AC6c-distinct: P0001 'has_active_subscription' maps to 'has-active-subscription', not 'not-monitor-user' or 'failed'", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "has_active_subscription" },
    });

    const result = await deleteMonitorUser(TARGET_UUID);

    expect(result).toEqual({ ok: false, error: "has-active-subscription" });
    expect(result).not.toMatchObject({ error: "not-monitor-user" });
    expect(result).not.toMatchObject({ error: "failed" });
  });

  it("PAY1-AC6c-other-p0001: P0001 with any other message → { ok: false, error: 'failed' } (catch-all)", async () => {
    // Guard: a future P0001 guard must not accidentally map to has-active-subscription.
    // deleteMonitorUser's catch-all returns "failed" for anything unrecognised.
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "some_other_guard" },
    });

    const result = await deleteMonitorUser(TARGET_UUID);

    expect(result).toEqual({ ok: false, error: "failed" });
  });
});
