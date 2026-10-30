// Unit tests for F0.5 home-page — public Supabase client factory
// Acceptance ID: AC-HOME-PUBLIC-01
//
// Strategy: mock @supabase/supabase-js createClient and assert the factory
// passes the correct URL, publishable key, and persistSession:false.
//
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock @supabase/supabase-js before importing the module under test ─────────
// vi.hoisted: vi.mock and the imports below are hoisted above plain top-level
// consts, and the factory runs while public.ts is imported.

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn().mockReturnValue({ from: vi.fn() }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

import { getPublicClient } from "@/lib/supabase/public";

const TEST_URL = "https://xmgpixhxecamtryohgmk.supabase.co";
const TEST_KEY = "test-publishable-key";

beforeEach(() => {
  vi.clearAllMocks();
  // Set env vars that the factory reads
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", TEST_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── AC-HOME-PUBLIC-01: factory calls createClient with correct args ───────────

describe("AC-HOME-PUBLIC-01: getPublicClient — createClient call contract", () => {
  it("calls createClient exactly once per invocation", () => {
    getPublicClient();
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("passes NEXT_PUBLIC_SUPABASE_URL as the first argument", () => {
    getPublicClient();
    expect(mockCreateClient).toHaveBeenCalledWith(
      TEST_URL,
      expect.anything(),
      expect.anything(),
    );
  });

  it("passes NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as the second argument", () => {
    getPublicClient();
    expect(mockCreateClient).toHaveBeenCalledWith(
      expect.anything(),
      TEST_KEY,
      expect.anything(),
    );
  });

  it("passes auth.persistSession: false in options (cookie-less, static-safe)", () => {
    getPublicClient();
    const options = mockCreateClient.mock.calls[0]![2] as Record<string, unknown>;
    expect(options).toMatchObject({ auth: { persistSession: false } });
  });

  it("returns the client returned by createClient", () => {
    const fakeClient = { from: vi.fn() };
    mockCreateClient.mockReturnValueOnce(fakeClient);
    const result = getPublicClient();
    expect(result).toBe(fakeClient);
  });
});

// ── Options must not enable cookies / session storage ─────────────────────────

describe("getPublicClient — no session/cookie options", () => {
  it("does not pass autoRefreshToken: true (would try to refresh without cookies)", () => {
    getPublicClient();
    const options = mockCreateClient.mock.calls[0]![2] as Record<string, unknown>;
    const auth = (options?.auth ?? {}) as Record<string, unknown>;
    // Either autoRefreshToken is absent or explicitly false — never true
    expect(auth.autoRefreshToken).not.toBe(true);
  });
});
