/**
 * Unit tests: src/app/monitor/(panel)/actions.ts — panel server actions.
 * Journey: monitor-web-area  MON-AC27, MON-AC32, MON-AC35, MON-AC36,
 *   MON-AC37, MON-AC38, MON-AC39
 *
 * Each action must call requireMonitor() first; user_id comes from the
 * session, never from FormData.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireMonitor,
  mockCreateMonitor,
  mockUpdateMonitor,
  mockDeleteMonitor,
  mockSetMonitorStatus,
  mockRedirect,
  mockNotFound,
  mockRevalidatePath,
} = vi.hoisted(() => ({
  mockRequireMonitor: vi.fn(),
  mockCreateMonitor: vi.fn(),
  mockUpdateMonitor: vi.fn(),
  mockDeleteMonitor: vi.fn(),
  mockSetMonitorStatus: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  mockRevalidatePath: vi.fn(),
}));

vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));
vi.mock("@/services/monitor/monitors", () => ({
  createMonitor: mockCreateMonitor,
  updateMonitor: mockUpdateMonitor,
  deleteMonitor: mockDeleteMonitor,
  setMonitorStatus: mockSetMonitorStatus,
}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

import {
  createMonitorAction,
  updateMonitorAction,
  deleteMonitorAction,
  pauseMonitorAction,
  resumeMonitorAction,
} from "@/app/monitor/(panel)/actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const VALID_MONITOR_ID = "00000000-0000-0000-0000-000000000011";
const SESSION = { userId: "00000000-0000-0000-0000-000000000099", email: "mon@test.local", role: "monitor_user" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMonitor.mockResolvedValue(SESSION);
});

// ── createMonitorAction — MON-AC35a user_id from session ─────────────────────

describe("createMonitorAction — MON-AC27/MON-AC32/MON-AC35", () => {
  it("MON-AC35b: calls requireMonitor before anything else", async () => {
    mockRequireMonitor.mockRejectedValue(new Error("NEXT_REDIRECT:/monitor/login"));
    await expect(
      createMonitorAction(
        {},
        form({ url: "https://example.com/", intervalValue: "1", intervalUnit: "days" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/monitor/login");
    expect(mockCreateMonitor).not.toHaveBeenCalled();
  });

  it("MON-AC35c: user_id is NOT taken from form data", async () => {
    mockCreateMonitor.mockResolvedValue({ id: VALID_MONITOR_ID });
    await expect(
      createMonitorAction(
        {},
        form({ url: "https://example.com/", intervalValue: "1", intervalUnit: "days", user_id: "EVIL" }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/); // redirect on success
    // The service gets exactly the validated columns; it adds the session's user itself.
    expect(mockCreateMonitor).toHaveBeenCalledExactlyOnceWith({
      url: "https://example.com/",
      label: null,
      interval_minutes: 1440,
    });
  });

  it("MON-AC32b: cap reached → returns friendly error state, no row", async () => {
    mockCreateMonitor.mockResolvedValue({ error: "limit_reached" });
    const result = await createMonitorAction(
      {},
      form({ url: "https://example.com/", intervalValue: "1", intervalUnit: "days" }),
    );
    expect(result).toMatchObject({ type: "limit_reached" });
    // No redirect thrown = no row created path
  });

  it("MON-AC28b: SSRF-blocked URL → returns validation error state", async () => {
    const result = await createMonitorAction(
      {},
      form({ url: "http://localhost/", intervalValue: "1", intervalUnit: "days" }),
    );
    expect(result).toMatchObject({ type: "field_error", field: "url" });
    expect(mockCreateMonitor).not.toHaveBeenCalled();
  });

  it("MON-AC27q: valid URL → createMonitor called; redirects to detail", async () => {
    mockCreateMonitor.mockResolvedValue({ id: VALID_MONITOR_ID });
    await expect(
      createMonitorAction(
        {},
        form({ url: "https://example.com/", intervalValue: "1", intervalUnit: "days" }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT.*\/monitor\/monitors\//);
  });
});

// ── updateMonitorAction — MON-AC36 ───────────────────────────────────────────

describe("updateMonitorAction — MON-AC36", () => {
  it("MON-AC36c: calls requireMonitor first", async () => {
    mockRequireMonitor.mockRejectedValue(new Error("NEXT_REDIRECT:/monitor/login"));
    await expect(
      updateMonitorAction(
        { monitorId: VALID_MONITOR_ID },
        form({ url: "https://example.com/", intervalValue: "1", intervalUnit: "days" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/monitor/login");
    expect(mockUpdateMonitor).not.toHaveBeenCalled();
  });

  it("MON-AC36d: valid changes → updateMonitor(id, columns); redirects to the detail page", async () => {
    mockUpdateMonitor.mockResolvedValue({ id: VALID_MONITOR_ID });
    await expect(
      updateMonitorAction(
        { monitorId: VALID_MONITOR_ID },
        form({ url: "https://example.com/new", label: "Ny", intervalValue: "6", intervalUnit: "hours" }),
      ),
    ).rejects.toThrow(`NEXT_REDIRECT:/monitor/monitors/${VALID_MONITOR_ID}`);
    expect(mockUpdateMonitor).toHaveBeenCalledExactlyOnceWith(VALID_MONITOR_ID, {
      url: "https://example.com/new",
      label: "Ny",
      interval_minutes: 360,
    });
  });

  it("MON-AC28ed: SSRF-blocked URL on edit → url field error; updateMonitor not called", async () => {
    const result = await updateMonitorAction(
      { monitorId: VALID_MONITOR_ID },
      form({ url: "http://169.254.169.254/latest/meta-data/", intervalValue: "1", intervalUnit: "days" }),
    );
    expect(result).toMatchObject({ type: "field_error", field: "url", monitorId: VALID_MONITOR_ID });
    expect(mockUpdateMonitor).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("MON-AC39e: invalid UUID monitorId → notFound() without calling the service", async () => {
    await expect(
      updateMonitorAction(
        { monitorId: "not-a-uuid" },
        form({ url: "https://example.com/", intervalValue: "1", intervalUnit: "days" }),
      ),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockUpdateMonitor).not.toHaveBeenCalled();
  });

  it("MON-AC39h: another user's (or a missing) monitor → notFound(); nothing refreshed, no redirect", async () => {
    // RLS scopes the update, so another account's monitor matches no row: updateMonitor resolves null.
    mockUpdateMonitor.mockResolvedValue(null);
    await expect(
      updateMonitorAction(
        { monitorId: VALID_MONITOR_ID },
        form({ url: "https://example.com/", intervalValue: "1", intervalUnit: "days" }),
      ),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ── deleteMonitorAction — MON-AC38 ───────────────────────────────────────────

describe("deleteMonitorAction — MON-AC38", () => {
  it("MON-AC38b: calls requireMonitor first", async () => {
    mockRequireMonitor.mockRejectedValue(new Error("NEXT_REDIRECT:/monitor/login"));
    await expect(deleteMonitorAction({ monitorId: VALID_MONITOR_ID }, new FormData())).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/login",
    );
    expect(mockDeleteMonitor).not.toHaveBeenCalled();
  });

  it("MON-AC38c: deletes and redirects to dashboard", async () => {
    mockDeleteMonitor.mockResolvedValue(VALID_MONITOR_ID);
    await expect(deleteMonitorAction({ monitorId: VALID_MONITOR_ID }, new FormData())).rejects.toThrow(
      "NEXT_REDIRECT:/monitor/dashboard",
    );
    expect(mockDeleteMonitor).toHaveBeenCalledExactlyOnceWith(VALID_MONITOR_ID);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("MON-AC39i: another user's (or a missing) monitor → notFound(); nothing refreshed, no redirect", async () => {
    mockDeleteMonitor.mockResolvedValue(null);
    await expect(deleteMonitorAction({ monitorId: VALID_MONITOR_ID }, new FormData())).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("MON-AC39j: invalid UUID monitorId → notFound() without calling the service", async () => {
    await expect(deleteMonitorAction({ monitorId: "not-a-uuid" }, new FormData())).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockDeleteMonitor).not.toHaveBeenCalled();
  });
});

// ── pauseMonitorAction / resumeMonitorAction — MON-AC37 ───────────────────────

describe("pauseMonitorAction / resumeMonitorAction — MON-AC37", () => {
  it("MON-AC37c: pauseMonitorAction calls setMonitorStatus('paused')", async () => {
    mockSetMonitorStatus.mockResolvedValue({ id: VALID_MONITOR_ID, status: "paused" });
    await expect(pauseMonitorAction({ monitorId: VALID_MONITOR_ID }, new FormData())).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(mockSetMonitorStatus).toHaveBeenCalledWith(VALID_MONITOR_ID, "paused");
  });

  it("MON-AC37d: resumeMonitorAction calls setMonitorStatus('active')", async () => {
    mockSetMonitorStatus.mockResolvedValue({ id: VALID_MONITOR_ID, status: "active" });
    await expect(resumeMonitorAction({ monitorId: VALID_MONITOR_ID }, new FormData())).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(mockSetMonitorStatus).toHaveBeenCalledWith(VALID_MONITOR_ID, "active");
  });
});
