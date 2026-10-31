/**
 * Unit tests — signIn Server Action: generic error mapping
 * Journey: admin-auth  AC-ADMINAUTH-03
 *
 * The signIn action must NEVER leak the actual Supabase error to the client.
 * Any auth failure must produce "Forkert e-mail eller adgangskode" unless the
 * error indicates rate-limiting (429) or service unavailability (0 / ≥500).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── vi.hoisted: refs initialised before any vi.mock factory runs ──────────────

const { mockCreateServerClient, mockRedirect } = vi.hoisted(() => ({
  mockCreateServerClient: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({ createServerClient: mockCreateServerClient }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

// ── Module under test ────────────────────────────────────────────────────────

import { signIn } from "@/app/admin/(auth)/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const GENERIC_ERROR = "Forkert e-mail eller adgangskode";

function buildFormData(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

function stubAuth(opts: { error: string } | { success: true }): void {
  mockCreateServerClient.mockReturnValue({
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue(
        "error" in opts
          ? { data: null, error: { message: opts.error } }
          : { data: { session: { user: { id: "u1" } } }, error: null },
      ),
    },
  } as never);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("signIn action — AC-ADMINAUTH-03: generic error mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC-ADMINAUTH-03a: returns generic error for invalid credentials", async () => {
    stubAuth({ error: "Invalid login credentials" });
    const state = await signIn(null, buildFormData("test@test.com", "wrongpassword"));
    expect(state).toMatchObject({ error: GENERIC_ERROR });
  });

  it("AC-ADMINAUTH-03b: returns same generic error for email-not-confirmed", async () => {
    stubAuth({ error: "Email not confirmed" });
    const state = await signIn(null, buildFormData("test@test.com", "anypassword123"));
    expect(state).toMatchObject({ error: GENERIC_ERROR });
  });

  it("AC-ADMINAUTH-03c: error does NOT expose the real Supabase error text", async () => {
    stubAuth({ error: "User not found" });
    const state = await signIn(null, buildFormData("ghost@test.com", "anypassword123"));
    expect(state).not.toMatchObject({ error: "User not found" });
    expect(state).toMatchObject({ error: GENERIC_ERROR });
  });

  it("AC-ADMINAUTH-03d: redirects to /admin on success — no error state", async () => {
    stubAuth({ success: true });
    await expect(
      signIn(null, buildFormData("admin@alnyron.dk", "validpassword123")),
    ).rejects.toThrow("NEXT_REDIRECT:/admin");
    expect(mockRedirect).toHaveBeenCalledWith("/admin");
  });
});
