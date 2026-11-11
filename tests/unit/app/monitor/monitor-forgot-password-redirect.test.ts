/**
 * Unit tests: src/app/monitor/(auth)/actions.ts — requestPasswordReset
 * Journey: monitor-ship-routing  SHIP-AC5a..SHIP-AC5c
 *
 * Verifies:
 *   SHIP-AC5a: on monitor.localhost:3000 → sendPasswordResetLink(form, "http://monitor.localhost:3000")
 *   SHIP-AC5b: on monitor.alnyron.dk → sendPasswordResetLink(form, "https://monitor.alnyron.dk")
 *   SHIP-AC5c: on main host (localhost:3000) → sendPasswordResetLink(form, null)
 *
 * Mirrors the MyLife pattern in src/app/mylife/(auth)/actions.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSendPasswordResetLink, mockHeaders, mockGetMonitorLocale } = vi.hoisted(() => ({
  mockSendPasswordResetLink: vi.fn(),
  mockHeaders: vi.fn(),
  mockGetMonitorLocale: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/services/auth/session", () => ({
  sendPasswordResetLink: mockSendPasswordResetLink,
  signInWithPassword: vi.fn(),
  signUpWithPassword: vi.fn(),
  endSession: vi.fn(),
}));
vi.mock("@/services/auth/require-role", () => ({ requireMonitor: vi.fn() }));
vi.mock("@/services/auth/set-password", () => ({ setPassword: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));
// The visitor's Monitor language (a cookie; there is no request here).
vi.mock("@/i18n/monitor-locale", () => ({ getMonitorLocale: mockGetMonitorLocale }));
import { requestPasswordReset } from "@/app/monitor/(auth)/actions";

function form(email: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  return fd;
}

function fakeHeaders(host: string) {
  return { get: (key: string) => (key === "host" ? host : null) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendPasswordResetLink.mockResolvedValue(null);
  mockGetMonitorLocale.mockResolvedValue("da");
});

// ── SHIP-AC5a: monitor.localhost:3000 → redirectTo = http://monitor.localhost:3000 ─

describe("requestPasswordReset — SHIP-AC5a: monitor.localhost:3000 redirectTo", () => {
  beforeEach(() => {
    mockHeaders.mockResolvedValue(fakeHeaders("monitor.localhost:3000"));
  });

  it("SHIP-AC5a-1: sendPasswordResetLink called with redirectTo='http://monitor.localhost:3000'", async () => {
    await requestPasswordReset(null, form("user@example.dk"));
    expect(mockSendPasswordResetLink).toHaveBeenCalledWith(
      expect.any(FormData),
      "http://monitor.localhost:3000",
      "da",
    );
  });
});

// ── SHIP-AC5b: monitor.alnyron.dk → redirectTo = https://monitor.alnyron.dk ──

describe("requestPasswordReset — SHIP-AC5b: monitor.alnyron.dk redirectTo", () => {
  beforeEach(() => {
    mockHeaders.mockResolvedValue(fakeHeaders("monitor.alnyron.dk"));
  });

  it("SHIP-AC5b-1: sendPasswordResetLink called with redirectTo='https://monitor.alnyron.dk'", async () => {
    await requestPasswordReset(null, form("user@example.dk"));
    expect(mockSendPasswordResetLink).toHaveBeenCalledWith(
      expect.any(FormData),
      "https://monitor.alnyron.dk",
      "da",
    );
  });
});

// ── SHIP-AC5c: main host → redirectTo = null ─────────────────────────────────

describe("requestPasswordReset — SHIP-AC5c: main host (localhost:3000) → redirectTo=null", () => {
  beforeEach(() => {
    mockHeaders.mockResolvedValue(fakeHeaders("localhost:3000"));
  });

  it("SHIP-AC5c-1: sendPasswordResetLink called with redirectTo=null", async () => {
    await requestPasswordReset(null, form("user@example.dk"));
    expect(mockSendPasswordResetLink).toHaveBeenCalledWith(expect.any(FormData), null, "da");
  });
});

// ── monitor-i18n: the form's messages follow the visitor's Monitor language ──

describe("requestPasswordReset — the visitor's Monitor language", () => {
  it("AC-I18N-MON-act-d: an English visitor's request is answered in English", async () => {
    mockHeaders.mockResolvedValue(fakeHeaders("monitor.alnyron.dk"));
    mockGetMonitorLocale.mockResolvedValue("en");
    await requestPasswordReset(null, form("user@example.dk"));
    expect(mockSendPasswordResetLink).toHaveBeenCalledWith(expect.any(FormData), "https://monitor.alnyron.dk", "en");
  });
});
