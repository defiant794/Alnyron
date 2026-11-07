/**
 * Unit tests: signUpWithPassword (src/services/auth/session.ts or sibling).
 * Journey: monitor-web-area  MON-AC4, MON-AC5, MON-AC6, MON-AC7, MON-AC8,
 *   MON-AC10, MON-AC52
 *
 * Success, existing-email, hook-rejection (allowlisted email), and GoTrue
 * error branches ALL return the same generic "Tjek din e-mail" state.
 * No Supabase error text is ever echoed; no session is created on success.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSignUp } = vi.hoisted(() => ({
  mockSignUp: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    auth: { signUp: mockSignUp },
  })),
}));

import { signUpWithPassword } from "@/services/auth/session";

function form(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

const VALID_EMAIL = "new@alnyron-test.local";
const VALID_PASSWORD = "ValidPassword1!";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── MON-AC4: success → generic confirmation ───────────────────────────────────

describe("signUpWithPassword — MON-AC4: success → generic confirmation", () => {
  it("MON-AC4a: returns generic confirmation state on GoTrue success", async () => {
    mockSignUp.mockResolvedValue({ data: { user: { id: "u1" }, session: null }, error: null });
    const result = await signUpWithPassword(form(VALID_EMAIL, VALID_PASSWORD));
    expect(result).toMatchObject({ type: "confirmation" });
  });

  it("MON-AC4b: no session is included in the success state", async () => {
    mockSignUp.mockResolvedValue({ data: { user: { id: "u1" }, session: null }, error: null });
    const result = await signUpWithPassword(form(VALID_EMAIL, VALID_PASSWORD));
    expect(result).not.toHaveProperty("session");
  });
});

// ── MON-AC4/MON-AC10: existing email → same generic confirmation ──────────────

describe("signUpWithPassword — MON-AC4/MON-AC10: existing email → generic (no enumeration)", () => {
  it("MON-AC10a: GoTrue user-already-registered returns same confirmation state", async () => {
    // GoTrue returns HTTP 400 with error code 'user_already_exists' for existing email
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 400, code: "user_already_exists", message: "User already registered" },
    });
    const result = await signUpWithPassword(form(VALID_EMAIL, VALID_PASSWORD));
    expect(result).toMatchObject({ type: "confirmation" });
  });

  it("MON-AC10b: response never echoes Supabase error message text", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 400, code: "user_already_exists", message: "User already registered SECRET" },
    });
    const result = await signUpWithPassword(form(VALID_EMAIL, VALID_PASSWORD));
    expect(JSON.stringify(result)).not.toContain("User already registered SECRET");
  });
});

// ── MON-AC52: hook-rejected (allowlisted) email → same generic confirmation ───

describe("signUpWithPassword — MON-AC52: hook rejection → generic (no admission hint)", () => {
  it("MON-AC52a: hook 403 rejection returns same confirmation state", async () => {
    // The hook returns 403 without a rate-limit code (use a plain 403 with no code)
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 403, message: "Adgang kræver en invitation." },
    });
    const result = await signUpWithPassword(form(VALID_EMAIL, VALID_PASSWORD));
    expect(result).toMatchObject({ type: "confirmation" });
    // Generic message must not reveal allowlist rejection
    expect(JSON.stringify(result)).not.toMatch(/allowlist|invitation|admin|mylife/i);
  });

  it("MON-AC52b: response never reveals that the email is allowlisted", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 403, message: "ALLOWLIST INTERNAL DETAIL" },
    });
    const result = await signUpWithPassword(form(VALID_EMAIL, VALID_PASSWORD));
    expect(JSON.stringify(result)).not.toContain("ALLOWLIST INTERNAL DETAIL");
  });

  it("MON-AC52c: signUp call never includes user_metadata from form fields", async () => {
    // The service must not forward form user_metadata to GoTrue, even when present.
    mockSignUp.mockResolvedValue({ data: { user: { id: "u1" }, session: null }, error: null });
    const fd = form(VALID_EMAIL, VALID_PASSWORD);
    fd.set("user_metadata[area]", "admin");
    fd.set("user_metadata[invited]", "true");
    await signUpWithPassword(fd);
    expect(mockSignUp).toHaveBeenCalledTimes(1);
    const callArg = mockSignUp.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    // No user_metadata or area/role override should appear in the signUp call
    expect(JSON.stringify(callArg ?? {})).not.toMatch(/area.*admin|invited.*true/);
  });
});

// ── MON-AC7: 429 rate limit ───────────────────────────────────────────────────

describe("signUpWithPassword — MON-AC7: 429 rate limited", () => {
  it("MON-AC7a: GoTrue 429 → rate-limited copy state", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 429, message: "over_request_rate_limit" },
    });
    const result = await signUpWithPassword(form(VALID_EMAIL, VALID_PASSWORD));
    expect(result).toMatchObject({ type: "rate_limited" });
  });
});

// ── MON-AC8: status 0 / >=500 → unavailable ──────────────────────────────────

describe("signUpWithPassword — MON-AC8: service unavailable", () => {
  it("MON-AC8a: status 0 → unavailable copy state", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 0, message: "Failed to fetch" },
    });
    const result = await signUpWithPassword(form(VALID_EMAIL, VALID_PASSWORD));
    expect(result).toMatchObject({ type: "unavailable" });
  });

  it("MON-AC8b: status 500 → unavailable copy state", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 500, message: "Internal server error" },
    });
    const result = await signUpWithPassword(form(VALID_EMAIL, VALID_PASSWORD));
    expect(result).toMatchObject({ type: "unavailable" });
  });

  it("MON-AC8c: status 503 → unavailable copy state", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 503, message: "Service unavailable" },
    });
    const result = await signUpWithPassword(form(VALID_EMAIL, VALID_PASSWORD));
    expect(result).toMatchObject({ type: "unavailable" });
  });
});

// ── MON-AC6: weak_password → password field error ────────────────────────────

describe("signUpWithPassword — MON-AC6: weak_password → field error", () => {
  it("MON-AC6a: weak_password → error targets the password field", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 422, code: "weak_password", message: "Password should be at least 8 chars" },
    });
    const result = await signUpWithPassword(form(VALID_EMAIL, "weak"));
    expect(result).toMatchObject({ type: "field_error", field: "password" });
  });

  it("MON-AC6b: weak_password error never echoes GoTrue message text", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { status: 422, code: "weak_password", message: "INTERNAL GOTRUETEXT" },
    });
    const result = await signUpWithPassword(form(VALID_EMAIL, "weak"));
    expect(JSON.stringify(result)).not.toContain("INTERNAL GOTRUETEXT");
  });
});

// ── MON-AC5: validation rejects short / missing passwords ────────────────────

describe("signUpWithPassword — MON-AC5: client-side validation", () => {
  it("MON-AC5a: empty email → field error before calling GoTrue", async () => {
    const result = await signUpWithPassword(form("", VALID_PASSWORD));
    expect(result).toMatchObject({ type: "field_error", field: "email" });
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it("MON-AC5b: invalid email (no @) → field error before GoTrue", async () => {
    const result = await signUpWithPassword(form("notanemail", VALID_PASSWORD));
    expect(result).toMatchObject({ type: "field_error", field: "email" });
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it("MON-AC5c: password shorter than 12 chars → field error before GoTrue", async () => {
    const result = await signUpWithPassword(form(VALID_EMAIL, "Short1!"));
    expect(result).toMatchObject({ type: "field_error", field: "password" });
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it("MON-AC5d: password over 72 bytes → field error before GoTrue (37×'æ' = 74 UTF-8 bytes)", async () => {
    // "æ" is 2 UTF-8 bytes; 37 × "æ" = 74 bytes > MAX_PASSWORD_BYTES (72)
    const longPwd = "æ".repeat(37);
    const result = await signUpWithPassword(form(VALID_EMAIL, longPwd));
    expect(result).toMatchObject({ type: "field_error", field: "password" });
    expect(mockSignUp).not.toHaveBeenCalled();
  });
});
