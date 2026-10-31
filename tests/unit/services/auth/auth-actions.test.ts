/**
 * Unit tests: auth Server Actions beyond the generic sign-in error
 * (sign-in-action.test.ts): no-enumeration password reset, the sign-in
 * `next` target, status-specific sign-in messages, sign-out.
 * Journey: admin-auth  AC-ADMINAUTH-01 / 02 / 03 / 08.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, cookieStore, mockRedirect } = vi.hoisted(() => ({
  auth: {
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    signOut: vi.fn(),
  },
  cookieStore: { getAll: vi.fn(), delete: vi.fn() },
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({ createServerClient: vi.fn(async () => ({ auth })) }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));

import { requestPasswordReset, signIn, signOut } from "@/app/admin/(auth)/actions";

/** The success state: always `sent`, plus the submitted (trimmed) address echoed back. */
const sent = (email: string) => ({ sent: true, email });

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  auth.signOut.mockResolvedValue({ error: null });
  cookieStore.getAll.mockReturnValue([]);
});

describe("requestPasswordReset: AC-ADMINAUTH-08 no account enumeration", () => {
  it("AC-ADMINAUTH-08a: sends the reset without redirectTo; the DA templates link to /auth/confirm -> /admin/set-password on the Site URL", async () => {
    await expect(requestPasswordReset(null, form({ email: " admin@alnyron.dk " }))).resolves.toEqual(
      sent("admin@alnyron.dk"),
    );
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("admin@alnyron.dk");

    // Supabase ignores redirectTo for these links: the email body is the template.
    for (const type of ["recovery", "invite"]) {
      const template = readFileSync(join(process.cwd(), `supabase/templates/${type}.html`), "utf-8");
      expect(template).toContain(
        `href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=${type}&amp;next=/admin/set-password"`,
      );
    }
  });

  it("AC-ADMINAUTH-08b: answers exactly the same when Supabase fails (unknown address, rate limit)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: { code: "over_email_send_rate_limit", status: 429, message: "rate limited" },
    });

    await expect(requestPasswordReset(null, form({ email: "nobody@nowhere.test" }))).resolves.toEqual(
      sent("nobody@nowhere.test"),
    );
  });

  it("AC-RESET-02: echoes the submitted address on success, the same for a known and an unknown account", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const known = await requestPasswordReset(null, form({ email: "admin@alnyron.dk" }));
    auth.resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: { code: "user_not_found", status: 400, message: "not found" },
    });
    const unknown = await requestPasswordReset(null, form({ email: "nobody@nowhere.test" }));

    expect(known).toEqual(sent("admin@alnyron.dk"));
    expect(unknown).toEqual(sent("nobody@nowhere.test"));
    // Only the echoed address differs: nothing in the state reveals whether an account exists.
    expect({ ...known, email: undefined }).toEqual({ ...unknown, email: undefined });
  });

  it("AC-ADMINAUTH-08c: an invalid address gets a Danish field error and never reaches Supabase", async () => {
    const state = await requestPasswordReset(null, form({ email: "not-an-email" }));

    expect(state).toEqual({
      email: "not-an-email",
      fieldErrors: { email: "Skriv en gyldig e-mailadresse." },
    });
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("signIn: AC-ADMINAUTH-01/02/03 validation, next target, status messages", () => {
  it("AC-ADMINAUTH-01p: invalid input returns Danish field errors without calling Supabase", async () => {
    const state = await signIn(null, form({ email: "nope", password: "" }));

    expect(state).toEqual({
      email: "nope",
      fieldErrors: { email: "Skriv en gyldig e-mailadresse.", password: "Skriv din adgangskode." },
    });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("AC-ADMINAUTH-02v: redirects to an accepted /admin/ next target after signing in", async () => {
    await expect(
      signIn(null, form({ email: "admin@alnyron.dk", password: "pw", next: "/admin/settings" })),
    ).rejects.toThrow("NEXT_REDIRECT:/admin/settings");
  });

  it("AC-ADMINAUTH-02w: ignores an external next target and goes to /admin", async () => {
    await expect(
      signIn(null, form({ email: "admin@alnyron.dk", password: "pw", next: "https://evil.com/admin/x" })),
    ).rejects.toThrow("NEXT_REDIRECT:/admin");
    expect(mockRedirect).toHaveBeenCalledWith("/admin");
  });

  it("AC-ADMINAUTH-03e: a rate-limited attempt (429) says to wait, not that the password is wrong", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: null, error: { status: 429, message: "x" } });

    const state = await signIn(null, form({ email: "admin@alnyron.dk", password: "pw" }));

    expect(state.error).toBe("For mange forsøg på kort tid. Vent et par minutter, og prøv igen.");
  });

  it("AC-ADMINAUTH-03f: an unreachable auth service (5xx / network) says login is unavailable", async () => {
    for (const status of [0, 503]) {
      auth.signInWithPassword.mockResolvedValue({ data: null, error: { status, message: "x" } });
      const state = await signIn(null, form({ email: "admin@alnyron.dk", password: "pw" }));
      expect(state.error).toBe("Login virker ikke lige nu. Prøv igen om lidt.");
    }
  });

  it("AC-ADMINAUTH-03g: a 400 credential error keeps the generic message and the typed email", async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: null,
      error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
    });

    await expect(signIn(null, form({ email: "admin@alnyron.dk", password: "pw" }))).resolves.toEqual({
      email: "admin@alnyron.dk",
      error: "Forkert e-mail eller adgangskode",
    });
  });
});

describe("signOut — AC-LOGIN-02: ends this browser's local session", () => {
  it("AC-LOGIN-02a: revokes the local session and redirects to /admin/login", async () => {
    await expect(signOut()).rejects.toThrow("NEXT_REDIRECT:/admin/login");
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });

  it("AC-LOGIN-02b: still removes the Supabase auth cookies when the revoke call fails", async () => {
    auth.signOut.mockResolvedValue({ error: { status: 0, message: "network" } });
    cookieStore.getAll.mockReturnValue([
      { name: "sb-ref-auth-token.0", value: "a" },
      { name: "sb-ref-auth-token.1", value: "b" },
      { name: "unrelated", value: "c" },
    ]);

    await expect(signOut()).rejects.toThrow("NEXT_REDIRECT:/admin/login");
    expect(cookieStore.delete.mock.calls).toEqual([["sb-ref-auth-token.0"], ["sb-ref-auth-token.1"]]);
  });
});
