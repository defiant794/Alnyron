// Unit tests for the F1.1 auth-cookie hardening (senior review): every
// @supabase/ssr client sets httpOnly + sameSite=lax auth cookies, secure in
// production. The admin-auth e2e login scenario checks the real cookie flags.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockCreateServerClient } = vi.hoisted(() => ({
  mockCreateServerClient: vi.fn(() => ({
    auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: "u1" } }, error: null })) },
  })),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: mockCreateServerClient }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ getAll: () => [], set: vi.fn() })),
}));

import { AUTH_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import { createServerClient } from "@/lib/supabase/server";
import { updateSession } from "@/lib/supabase/middleware";

/** The options object (third argument) of the only createServerClient call. */
function passedOptions(): Record<string, unknown> {
  expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
  const call = mockCreateServerClient.mock.calls[0] as unknown[];
  return call[2] as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AUTH_COOKIE_OPTIONS", () => {
  it("keeps the session cookie away from page scripts (httpOnly) and cross-site subrequests (lax)", () => {
    expect(AUTH_COOKIE_OPTIONS).toMatchObject({ httpOnly: true, sameSite: "lax" });
  });

  it("is not secure outside production, so the http dev server keeps its session", () => {
    expect(AUTH_COOKIE_OPTIONS.secure).toBe(false);
  });

  it("is secure (HTTPS only) in a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    // Re-evaluate the module: `secure` is fixed when it loads (Next inlines NODE_ENV at build).
    const fresh = await import("@/lib/supabase/cookie-options");
    expect(fresh.AUTH_COOKIE_OPTIONS.secure).toBe(true);
  });
});

describe("Supabase SSR clients pass AUTH_COOKIE_OPTIONS", () => {
  it("createServerClient (Server Components, Server Actions, /auth/confirm)", async () => {
    await createServerClient();
    expect(passedOptions().cookieOptions).toEqual(AUTH_COOKIE_OPTIONS);
  });

  it("updateSession (middleware session refresh)", async () => {
    await updateSession(new NextRequest(new URL("/admin", "http://localhost:3000")));
    expect(passedOptions().cookieOptions).toEqual(AUTH_COOKIE_OPTIONS);
  });
});
