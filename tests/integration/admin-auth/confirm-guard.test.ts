/**
 * Integration tests — /auth/confirm route handler: next-param open-redirect guard
 * Journey: admin-auth  AC-ADMINAUTH-07
 *
 * The Route Handler GET /auth/confirm must:
 *   - call verifyOtp and redirect to `next` only when safeNext() accepts it
 *   - fall back to /admin/login for rejected / missing `next` values (no error= param)
 *   - redirect to /admin/login with error=link_invalid when verifyOtp fails
 *   - redirect to /admin/login with error=link_invalid for unsupported type or missing token_hash
 *
 * NextRequest from next/server is used directly (next IS installed).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── vi.hoisted ────────────────────────────────────────────────────────────────

const { mockVerifyOtp } = vi.hoisted(() => ({
  mockVerifyOtp: vi.fn(),
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(() => ({
    auth: { verifyOtp: mockVerifyOtp },
  })),
}));

// ── Module under test ────────────────────────────────────────────────────────

import { GET } from "@/app/auth/confirm/route";

// ── Helpers ───────────────────────────────────────────────────────────────────
// confirmRequest has multiple call sites — kept as a named helper (lockstep base URL).

function confirmRequest(params: Record<string, string>): NextRequest {
  const url = new URL("/auth/confirm", "http://localhost:3000");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const VALID_TOKEN = { token_hash: "abc123", type: "invite" };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("/auth/confirm route — AC-ADMINAUTH-07: open-redirect guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyOtp.mockResolvedValue({
      data: { session: { user: { id: "u1" } } },
      error: null,
    });
  });

  it("AC-ADMINAUTH-07a: valid /admin/* next → redirects there after OTP verify", async () => {
    const response = await GET(confirmRequest({ ...VALID_TOKEN, next: "/admin/set-password" }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/admin/set-password");
  });

  it("AC-ADMINAUTH-07b: external URL in next → redirects to /admin/login, not external", async () => {
    const response = await GET(confirmRequest({ ...VALID_TOKEN, next: "https://evil.com/steal" }));

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/admin/login");
    expect(location).not.toContain("evil.com");
  });

  it("AC-ADMINAUTH-07c: non-admin path in next → redirects to /admin/login, no error= param", async () => {
    const response = await GET(confirmRequest({ ...VALID_TOKEN, next: "/public/page" }));

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/admin/login");
    expect(location).not.toContain("error=");
  });

  it("AC-ADMINAUTH-07d: missing next param → redirects to /admin/login, no error= param", async () => {
    const response = await GET(confirmRequest({ token_hash: "abc123", type: "invite" }));

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/admin/login");
    expect(location).not.toContain("error=");
  });

  it("AC-ADMINAUTH-07e: verifyOtp failure → redirects to /admin/login with error=link_invalid", async () => {
    mockVerifyOtp.mockResolvedValue({ data: null, error: { message: "Token expired" } });
    const response = await GET(confirmRequest({ ...VALID_TOKEN, next: "/admin/set-password" }));

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/admin/login");
    expect(location).toContain("error=link_invalid");
  });

  it("AC-ADMINAUTH-07f: unsupported type param → redirects to /admin/login with error=link_invalid", async () => {
    // "magic_link" is not in CONFIRM_TYPES; the guard rejects before verifyOtp is called.
    const response = await GET(
      confirmRequest({ token_hash: "abc123", type: "magic_link", next: "/admin/set-password" }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/admin/login");
    expect(location).toContain("error=link_invalid");
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("AC-ADMINAUTH-07g: missing token_hash → redirects to /admin/login with error=link_invalid", async () => {
    const response = await GET(
      confirmRequest({ type: "invite", next: "/admin/set-password" }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/admin/login");
    expect(location).toContain("error=link_invalid");
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("AC-ADMINAUTH-07: every redirect is Cache-Control private, no-store (session cookies, one-time token)", async () => {
    const verified = await GET(confirmRequest({ ...VALID_TOKEN, next: "/admin/set-password" }));
    const malformed = await GET(confirmRequest({ type: "invite" }));
    mockVerifyOtp.mockResolvedValue({ data: null, error: { message: "Token expired" } });
    const rejected = await GET(confirmRequest({ ...VALID_TOKEN, next: "/admin/set-password" }));

    for (const response of [verified, malformed, rejected]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});
