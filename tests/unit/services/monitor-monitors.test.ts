/**
 * Unit tests: src/services/monitor/monitors.ts — monitors service (mocked Supabase).
 * Journey: monitor-web-area  MON-AC23, MON-AC26, MON-AC27, MON-AC32, MON-AC35,
 *   MON-AC36, MON-AC37, MON-AC38, MON-AC39
 * Journey: payments-slice1-foundation  PAY1-AC2e, PAY1-AC2f, PAY1-AC2g, PAY1-AC7a, PAY1-AC7b, PAY1-AC7c
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Supabase mock setup ───────────────────────────────────────────────────────

const mockFrom = vi.fn();
const mockRpc  = vi.fn();

const TEST_USER_ID = "00000000-0000-0000-0000-000000000099";
const TEST_MONITOR_ID = "00000000-0000-0000-0000-000000000011";

// The session's user (the service takes user_id and the role from requireMonitor()).
const { mockRequireMonitor } = vi.hoisted(() => ({
  mockRequireMonitor: vi.fn(async () => ({
    userId: "00000000-0000-0000-0000-000000000099",
    email: "mon@test.local",
    role: "monitor_user" as const,
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({ from: mockFrom, rpc: mockRpc })),
}));
vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));

import {
  createMonitor,
  deleteMonitor,
  getMonitor,
  getMonitorUsage,
  listMonitorEvents,
  listMonitors,
  setMonitorStatus,
  updateMonitor,
} from "@/services/monitor/monitors";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── listMonitors — MON-AC23/MON-AC26 ─────────────────────────────────────────

describe("listMonitors — MON-AC23/MON-AC26: own monitors only via RLS", () => {
  const row = { id: TEST_MONITOR_ID, url: "https://example.com/", label: "Site", status: "active", interval_minutes: 1440, last_checked_at: null, consecutive_errors: 0, created_at: "2026-11-01T10:00:00Z" };

  function listStub(result: { data: unknown; error: unknown }) {
    return {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(result),
    };
  }

  it("MON-AC23a: reads the user's monitors oldest first with each one's latest change time", async () => {
    const tableStub = listStub({
      data: [
        { ...row, monitor_events: [{ detected_at: "2026-11-05T10:00:00Z" }] },
        { ...row, id: "00000000-0000-0000-0000-000000000012", monitor_events: [] },
      ],
      error: null,
    });
    mockFrom.mockReturnValue(tableStub);

    const result = await listMonitors();
    expect(mockFrom).toHaveBeenCalledWith("monitors");
    expect(tableStub.select).toHaveBeenCalledWith(expect.stringContaining("monitor_events(detected_at)"));
    expect(tableStub.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: true });
    expect(result).toEqual([
      { ...row, last_change_at: "2026-11-05T10:00:00Z" },
      { ...row, id: "00000000-0000-0000-0000-000000000012", last_change_at: null },
    ]);
  });

  it("MON-AC23g: embeds only the newest event per monitor (ordered newest first, limited to one)", async () => {
    const tableStub = listStub({ data: [], error: null });
    mockFrom.mockReturnValue(tableStub);

    await listMonitors();
    expect(tableStub.order).toHaveBeenCalledWith("detected_at", { ascending: false, referencedTable: "monitor_events" });
    expect(tableStub.limit).toHaveBeenCalledExactlyOnceWith(1, { referencedTable: "monitor_events" });
  });

  it("MON-AC23b: propagates Supabase errors", async () => {
    mockFrom.mockReturnValue(listStub({ data: null, error: { message: "db error", code: "PGRST" } }));
    await expect(listMonitors()).rejects.toThrow("Monitor list failed: PGRST db error");
  });
});

// ── getMonitor — MON-AC39 ─────────────────────────────────────────────────────

describe("getMonitor — MON-AC39: not-found / not-own → notFound()", () => {
  it("MON-AC39a: validates id as UUID; throws for non-UUID", async () => {
    await expect(getMonitor("not-a-uuid")).rejects.toThrow();
  });

  it("MON-AC39b: no row (missing, or another user's monitor hidden by RLS) → resolves null", async () => {
    // The service reports "not found" as null; the pages and actions turn it into notFound().
    const tableStub = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mockFrom.mockReturnValue(tableStub);
    await expect(getMonitor(TEST_MONITOR_ID)).resolves.toBeNull();
    expect(tableStub.eq).toHaveBeenCalledWith("id", TEST_MONITOR_ID);
  });

  it("MON-AC39c: returns the monitor when found", async () => {
    const monitor = { id: TEST_MONITOR_ID, url: "https://example.com/", user_id: TEST_USER_ID };
    const tableStub = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: monitor, error: null }),
    };
    mockFrom.mockReturnValue(tableStub);
    const result = await getMonitor(TEST_MONITOR_ID);
    expect(result).toEqual(monitor);
  });
});

// ── getMonitorUsage — MON-AC23/MON-AC25 ──────────────────────────────────────

describe("getMonitorUsage — MON-AC23/MON-AC25: count + limit", () => {
  it("MON-AC23c: returns { count, limit } where limit comes from rpc('my_monitor_limit')", async () => {
    mockRpc.mockResolvedValueOnce({ data: 5, error: null });
    const countStub = {
      select: vi.fn().mockResolvedValue({ count: 2, data: [], error: null }),
    };
    mockFrom.mockReturnValueOnce(countStub);
    const result = await getMonitorUsage();
    expect(result).toMatchObject({ count: 2, limit: 5 });
  });

  it("MON-AC25a: rpc returns NULL (unlimited) → { limit: null }", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    const countStub = {
      select: vi.fn().mockResolvedValue({ count: 3, data: [], error: null }),
    };
    mockFrom.mockReturnValueOnce(countStub);
    const result = await getMonitorUsage();
    expect(result).toMatchObject({ limit: null });
  });
});

// ── createMonitor — MON-AC27/MON-AC32 ────────────────────────────────────────

describe("createMonitor — MON-AC27/MON-AC32: insert + cap error", () => {
  it("MON-AC27p: inserts a valid monitor and returns the new row", async () => {
    const newRow = { id: TEST_MONITOR_ID, url: "https://example.com/", label: null, interval_minutes: 1440 };
    const tableStub = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: newRow, error: null }),
    };
    mockFrom.mockReturnValue(tableStub);
    const result = await createMonitor({ url: "https://example.com/", label: null, interval_minutes: 1440 });
    expect(result).toEqual(newRow);
  });

  it("MON-AC32a: P0001 monitor_limit_reached → typed limit_reached result", async () => {
    const tableStub = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "P0001", message: "monitor_limit_reached" },
      }),
    };
    mockFrom.mockReturnValue(tableStub);
    const result = await createMonitor({ url: "https://example.com/", label: null, interval_minutes: 1440 });
    // The service should return a typed { error: "limit_reached" } result, not throw
    expect(result).toMatchObject({ error: "limit_reached" });
  });

  it("MON-AC35a: user_id comes from the session (requireMonitor), never from the caller", async () => {
    // monitors.user_id is NOT NULL without a default and the monitors_insert
    // policy requires auth.uid() = user_id, so the insert must name the
    // session's user; the caller's input has no user_id field at all.
    const insertMock = vi.fn().mockReturnThis();
    const tableStub = {
      insert: insertMock,
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: TEST_MONITOR_ID }, error: null }),
    };
    mockFrom.mockReturnValue(tableStub);
    await createMonitor({ url: "https://example.com/", label: null, interval_minutes: 1440 });
    expect(mockRequireMonitor).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledExactlyOnceWith({
      url: "https://example.com/",
      label: null,
      interval_minutes: 1440,
      user_id: TEST_USER_ID,
    });
  });
});

// ── updateMonitor — MON-AC36 ──────────────────────────────────────────────────

describe("updateMonitor — MON-AC36: update own monitor", () => {
  it("MON-AC36a: calls from('monitors').update(...).eq('id', id).select().single()", async () => {
    const updated = { id: TEST_MONITOR_ID, url: "https://new.com/", label: "New", interval_minutes: 60 };
    const tableStub = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: updated, error: null }),
    };
    mockFrom.mockReturnValue(tableStub);
    const result = await updateMonitor(TEST_MONITOR_ID, { url: "https://new.com/", label: "New", interval_minutes: 60 });
    expect(result).toEqual(updated);
  });

  it("MON-AC36b: validates id as UUID", async () => {
    await expect(updateMonitor("bad-id", { url: "https://new.com/", label: null, interval_minutes: 60 })).rejects.toThrow();
  });
});

// ── setMonitorStatus — MON-AC37 ───────────────────────────────────────────────

describe("setMonitorStatus — MON-AC37: pause/resume", () => {
  it("MON-AC37a: sets status to 'paused'", async () => {
    const tableStub = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: TEST_MONITOR_ID, status: "paused" }, error: null }),
    };
    mockFrom.mockReturnValue(tableStub);
    const result = await setMonitorStatus(TEST_MONITOR_ID, "paused");
    expect(result).toMatchObject({ status: "paused" });
  });

  it("MON-AC37b: sets status to 'active'", async () => {
    const tableStub = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: TEST_MONITOR_ID, status: "active" }, error: null }),
    };
    mockFrom.mockReturnValue(tableStub);
    const result = await setMonitorStatus(TEST_MONITOR_ID, "active");
    expect(result).toMatchObject({ status: "active" });
  });
});

// ── deleteMonitor — MON-AC38/MON-AC39 ─────────────────────────────────────────

describe("deleteMonitor — MON-AC38/MON-AC39: delete own monitor", () => {
  function deleteStub(result: { data: unknown; error: unknown }) {
    return {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue(result),
    };
  }

  it("MON-AC38a: deletes by id and returns the deleted monitor's id", async () => {
    const tableStub = deleteStub({ data: { id: TEST_MONITOR_ID }, error: null });
    mockFrom.mockReturnValue(tableStub);
    await expect(deleteMonitor(TEST_MONITOR_ID)).resolves.toBe(TEST_MONITOR_ID);
    expect(tableStub.delete).toHaveBeenCalledTimes(1);
    expect(tableStub.eq).toHaveBeenCalledWith("id", TEST_MONITOR_ID);
    expect(tableStub.select).toHaveBeenCalledWith("id");
  });

  it("MON-AC39g: nothing deleted (missing, or another user's monitor hidden by RLS) → null", async () => {
    mockFrom.mockReturnValue(deleteStub({ data: null, error: null }));
    await expect(deleteMonitor(TEST_MONITOR_ID)).resolves.toBeNull();
  });

  it("MON-AC38d: a database error throws (never reported as not found)", async () => {
    mockFrom.mockReturnValue(deleteStub({ data: null, error: { code: "42501", message: "permission denied" } }));
    await expect(deleteMonitor(TEST_MONITOR_ID)).rejects.toThrow("Monitor delete failed: 42501 permission denied");
  });
});

// ── listMonitorEvents — MON-AC40 ──────────────────────────────────────────────

describe("listMonitorEvents — MON-AC40: newest first", () => {
  it("MON-AC40a: orders by detected_at descending", async () => {
    const orderMock = vi.fn().mockResolvedValue({ data: [], error: null });
    const tableStub = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: orderMock,
    };
    mockFrom.mockReturnValue(tableStub);
    await listMonitorEvents(TEST_MONITOR_ID);
    // order must be called with detected_at descending
    const [col, opts] = orderMock.mock.calls[0] ?? [];
    expect(col).toBe("detected_at");
    expect(opts).toMatchObject({ ascending: false });
  });
});

// ── getMonitorUsage — PAY1-AC7: uses rpc('my_monitor_limit') ─────────────────

describe("getMonitorUsage — PAY1-AC7a/b/c: rpc-based limit, no owner special-case", () => {
  it("PAY1-AC7a: getMonitorUsage calls rpc('my_monitor_limit') for the limit — not from('profiles')", async () => {
    mockRpc.mockResolvedValue({ data: 20, error: null });
    const countStub = {
      select: vi.fn().mockResolvedValue({ count: 3, data: [], error: null }),
    };
    mockFrom.mockReturnValue(countStub);
    await getMonitorUsage();
    expect(mockRpc).toHaveBeenCalledWith("my_monitor_limit");
    // The profiles table must NOT be queried for the limit
    expect(mockFrom).not.toHaveBeenCalledWith("profiles");
  });

  it("PAY1-AC7b: rpc returns NULL → getMonitorUsage returns { limit: null } (unlimited)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const countStub = {
      select: vi.fn().mockResolvedValue({ count: 1, data: [], error: null }),
    };
    mockFrom.mockReturnValue(countStub);
    const result = await getMonitorUsage();
    expect(result).toMatchObject({ limit: null });
  });

  it("PAY1-AC7c: no role special-case in TS — limit is the rpc value; requireMonitor not called", async () => {
    // getMonitorUsage calls rpc("my_monitor_limit") directly — it does not call
    // requireMonitor. The rpc result passes through regardless of session role.
    mockRpc.mockResolvedValue({ data: 42, error: null });
    const countStub = {
      select: vi.fn().mockResolvedValue({ count: 5, data: [], error: null }),
    };
    mockFrom.mockReturnValue(countStub);
    const result = await getMonitorUsage();
    expect(result).toMatchObject({ limit: 42 });
    expect(mockRequireMonitor).not.toHaveBeenCalled();
  });
});

describe("getMonitorUsage — PAY1-AC7a-err: rpc error rejects (not silently unlimited)", () => {
  it("PAY1-AC7a-err: rpc('my_monitor_limit') error → getMonitorUsage rejects", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    const countStub = {
      select: vi.fn().mockResolvedValue({ count: 1, data: [], error: null }),
    };
    mockFrom.mockReturnValue(countStub);
    await expect(getMonitorUsage()).rejects.toThrow();
  });
});

// ── setMonitorStatus — PAY1-AC2: P0001 monitor_limit_reached mapping ─────────

describe("setMonitorStatus — PAY1-AC2e/f/g: limit_reached mapping, PGRST116 null, and other-error throw", () => {
  it("PAY1-AC2e: P0001 monitor_limit_reached → { error: 'limit_reached' } (not thrown)", async () => {
    const tableStub = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "P0001", message: "monitor_limit_reached" },
      }),
    };
    mockFrom.mockReturnValue(tableStub);
    const result = await setMonitorStatus(TEST_MONITOR_ID, "active");
    expect(result).toEqual({ error: "limit_reached" });
  });

  it("PAY1-AC2f: PGRST116 (no rows) → null", async () => {
    const tableStub = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "PGRST116", message: "no rows" },
      }),
    };
    mockFrom.mockReturnValue(tableStub);
    const result = await setMonitorStatus(TEST_MONITOR_ID, "active");
    expect(result).toBeNull();
  });

  it("PAY1-AC2g: other Postgres error throws", async () => {
    const tableStub = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "42501", message: "permission denied" },
      }),
    };
    mockFrom.mockReturnValue(tableStub);
    await expect(setMonitorStatus(TEST_MONITOR_ID, "active")).rejects.toThrow();
  });

  it("PAY1-AC2g-p0001-other: P0001 with a different message is NOT limit_reached (falls through to throw)", async () => {
    const tableStub = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "P0001", message: "some_other_guard" },
      }),
    };
    mockFrom.mockReturnValue(tableStub);
    await expect(setMonitorStatus(TEST_MONITOR_ID, "active")).rejects.toThrow();
  });
});
