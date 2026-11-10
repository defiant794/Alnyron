/**
 * Unit tests — deleteMonitorSignup server action (admin-monitor-users-cleanup)
 * Journey: admin-monitor-users-cleanup  AMC-12, AMC-13, AMC-14, AMC-15, AMC-15b
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockRequireAdmin, mockDeleteMonitorUser, mockRevalidatePath } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => ({
    userId: "admin-uuid",
    email: "admin@example.com",
    role: "admin" as const,
  })),
  mockDeleteMonitorUser: vi.fn<
    (id: string) => Promise<{ ok: true } | { ok: false; error: "not-found" | "not-monitor-user" | "failed" }>
  >(),
  mockRevalidatePath: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@/services/auth/require-admin", () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock("@/services/admin/monitor-users", () => ({
  deleteMonitorUser: mockDeleteMonitorUser,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

// ── Module under test ──────────────────────────────────────────────────────────

import { deleteMonitorSignup } from "@/app/admin/(panel)/monitor-users/actions";
import { ADMIN_MONITOR_USERS_PATH } from "@/config/admin";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const VALID_UUID = "00000000-0000-0000-0a30-000000000001";
const ADMIN_USER = { userId: "admin-uuid", email: "admin@example.com", role: "admin" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(ADMIN_USER);
  mockDeleteMonitorUser.mockResolvedValue({ ok: true });
});

// ── AMC-12: requireAdmin called first ─────────────────────────────────────────

describe("AMC-12: deleteMonitorSignup — requireAdmin is called before any RPC", () => {
  it("AMC-12a: requireAdmin is awaited strictly before deleteMonitorUser", async () => {
    const callOrder: string[] = [];
    mockRequireAdmin.mockImplementation(async () => {
      callOrder.push("requireAdmin");
      return ADMIN_USER;
    });
    mockDeleteMonitorUser.mockImplementation(async () => {
      callOrder.push("deleteMonitorUser");
      return { ok: true };
    });

    await deleteMonitorSignup(VALID_UUID);

    // Both must be called in this exact order (not just an index comparison)
    expect(callOrder).toEqual(["requireAdmin", "deleteMonitorUser"]);
  });

  it("AMC-12b: when requireAdmin throws/redirects, deleteMonitorUser is not called", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT:/admin/login"));

    await expect(deleteMonitorSignup(VALID_UUID)).rejects.toThrow("NEXT_REDIRECT");
    expect(mockDeleteMonitorUser).not.toHaveBeenCalled();
  });
});

// ── AMC-13: invalid UUID short-circuit ────────────────────────────────────────

describe("AMC-13: deleteMonitorSignup — invalid userId input returns {ok:false,error:'not-found'} without RPC", () => {
  it("AMC-13a: non-string input → {ok:false, error:'not-found'}; requireAdmin still called", async () => {
    const result = await deleteMonitorSignup(null);
    expect(result).toEqual({ ok: false, error: "not-found" });
    expect(mockDeleteMonitorUser).not.toHaveBeenCalled();
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
  });

  it("AMC-13b: empty string → {ok:false, error:'not-found'}; requireAdmin still called", async () => {
    const result = await deleteMonitorSignup("");
    expect(result).toEqual({ ok: false, error: "not-found" });
    expect(mockDeleteMonitorUser).not.toHaveBeenCalled();
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
  });

  it("AMC-13c: non-UUID string → {ok:false, error:'not-found'}; requireAdmin still called", async () => {
    const result = await deleteMonitorSignup("not-a-uuid");
    expect(result).toEqual({ ok: false, error: "not-found" });
    expect(mockDeleteMonitorUser).not.toHaveBeenCalled();
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
  });

  it("AMC-13d: valid UUID passes through to deleteMonitorUser", async () => {
    await deleteMonitorSignup(VALID_UUID);
    expect(mockDeleteMonitorUser).toHaveBeenCalledWith(VALID_UUID);
  });
});

// ── AMC-14: revalidatePath on ok ──────────────────────────────────────────────

describe("AMC-14: deleteMonitorSignup — revalidatePath called on {ok:true}", () => {
  it("AMC-14: success → revalidatePath(ADMIN_MONITOR_USERS_PATH)", async () => {
    mockDeleteMonitorUser.mockResolvedValue({ ok: true });

    await deleteMonitorSignup(VALID_UUID);

    expect(mockRevalidatePath).toHaveBeenCalledWith(ADMIN_MONITOR_USERS_PATH);
  });
});

// ── AMC-15: revalidatePath on not-found ───────────────────────────────────────

describe("AMC-15: deleteMonitorSignup — revalidatePath called on {ok:false,error:'not-found'}", () => {
  it("AMC-15: not-found → revalidatePath(ADMIN_MONITOR_USERS_PATH)", async () => {
    mockDeleteMonitorUser.mockResolvedValue({ ok: false, error: "not-found" });

    await deleteMonitorSignup(VALID_UUID);

    expect(mockRevalidatePath).toHaveBeenCalledWith(ADMIN_MONITOR_USERS_PATH);
  });
});

// ── AMC-15b: no revalidatePath on failed or not-monitor-user ─────────────────

describe("AMC-15b: deleteMonitorSignup — revalidatePath NOT called on {ok:false,error:'failed'|'not-monitor-user'}", () => {
  it("AMC-15b-failed: {ok:false, error:'failed'} → revalidatePath not called", async () => {
    mockDeleteMonitorUser.mockResolvedValue({ ok: false, error: "failed" });

    await deleteMonitorSignup(VALID_UUID);

    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("AMC-15b-notMonitorUser: {ok:false, error:'not-monitor-user'} → revalidatePath not called", async () => {
    mockDeleteMonitorUser.mockResolvedValue({ ok: false, error: "not-monitor-user" });

    await deleteMonitorSignup(VALID_UUID);

    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

// ── Return values pass through ────────────────────────────────────────────────

describe("AMC-14/15/15b: deleteMonitorSignup — result forwarded from deleteMonitorUser", () => {
  it("AMC-14: forwards {ok:true}", async () => {
    mockDeleteMonitorUser.mockResolvedValue({ ok: true });
    const result = await deleteMonitorSignup(VALID_UUID);
    expect(result).toEqual({ ok: true });
  });

  it("AMC-15: forwards {ok:false, error:'not-found'}", async () => {
    mockDeleteMonitorUser.mockResolvedValue({ ok: false, error: "not-found" });
    const result = await deleteMonitorSignup(VALID_UUID);
    expect(result).toEqual({ ok: false, error: "not-found" });
  });

  it("AMC-15b: forwards {ok:false, error:'not-monitor-user'}", async () => {
    mockDeleteMonitorUser.mockResolvedValue({ ok: false, error: "not-monitor-user" });
    const result = await deleteMonitorSignup(VALID_UUID);
    expect(result).toEqual({ ok: false, error: "not-monitor-user" });
  });

  it("AMC-15b: forwards {ok:false, error:'failed'}", async () => {
    mockDeleteMonitorUser.mockResolvedValue({ ok: false, error: "failed" });
    const result = await deleteMonitorSignup(VALID_UUID);
    expect(result).toEqual({ ok: false, error: "failed" });
  });
});

// ── AMC-14-da: ADMIN_MONITOR_USERS_PATH pin ──────────────────────────────────

describe("AMC-14-da: ADMIN_MONITOR_USERS_PATH is '/admin/monitor-users'", () => {
  it("AMC-14-da: ADMIN_MONITOR_USERS_PATH === '/admin/monitor-users'", () => {
    expect(ADMIN_MONITOR_USERS_PATH).toBe("/admin/monitor-users");
  });
});
