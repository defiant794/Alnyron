/**
 * Unit tests: MyLife auth Server Actions signIn, requestPasswordReset, signOut.
 * Journey: mylife-login  ML-AC2, ML-AC3, ML-AC4, ML-AC10, ML-AC16, ML-AC22, ML-AC25
 *
 * The expected Danish copy comes from the message keys (`authT`), the same
 * no-enumeration mapping the admin actions use.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, cookieStore, mockRedirect, requestHost } = vi.hoisted(() => ({
  auth: {
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    signOut: vi.fn(),
  },
  cookieStore: { getAll: vi.fn(), delete: vi.fn() },
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  requestHost: { value: "localhost:3000" },
}));

vi.mock("@/lib/supabase/server", () => ({ createServerClient: vi.fn(async () => ({ auth })) }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
  headers: vi.fn(async () => new Headers({ host: requestHost.value })),
}));

import { requestPasswordReset, signIn, signOut } from "@/app/mylife/(auth)/actions";
import { authT } from "@/services/auth/form-feedback";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const CREDENTIALS = { email: "ml@alnyron.dk", password: "ValidPass1!" };

beforeEach(() => {
  vi.clearAllMocks();
  auth.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  auth.signOut.mockResolvedValue({ error: null });
  cookieStore.getAll.mockReturnValue([]);
  requestHost.value = "localhost:3000";
});

// ── signIn: error mapping (ML-AC4) ───────────────────────────────────────────

describe("signIn: ML-AC4 no account enumeration", () => {
  it("ML-AC4a: wrong credentials get the generic Danish error and keep the typed email", async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: null,
      error: { message: "Invalid login credentials", status: 400 },
    });
    await expect(signIn(null, form({ email: "x@x.dk", password: "wrong" }))).resolves.toEqual({
      email: "x@x.dk",
      error: authT("login.invalidCredentials"),
    });
  });

  it("ML-AC4b: an unknown email gets exactly the same answer as a wrong password", async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: null,
      error: { message: "User not found", status: 400 },
    });
    const unknown = await signIn(null, form({ email: "ghost@x.dk", password: "pw" }));

    auth.signInWithPassword.mockResolvedValue({
      data: null,
      error: { message: "Invalid login credentials", status: 400 },
    });
    const wrong = await signIn(null, form({ email: "real@x.dk", password: "wrong" }));

    expect(unknown.error).toBe(authT("login.invalidCredentials"));
    expect(wrong.error).toBe(unknown.error);
  });

  it("ML-AC4c: the Supabase error text never reaches the client", async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: null,
      error: { message: "supabase_secret_internal_error", status: 400 },
    });
    const state = await signIn(null, form({ email: "x@x.dk", password: "pw" }));
    expect(state.error).toBe(authT("login.invalidCredentials"));
    expect(JSON.stringify(state)).not.toContain("supabase_secret");
  });

  it("ML-AC4d: a rate-limited attempt (429) says to wait, not that the password is wrong", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: null, error: { status: 429, message: "x" } });
    const state = await signIn(null, form(CREDENTIALS));
    expect(state.error).toBe(authT("login.rateLimited"));
  });

  it("ML-AC4e: an unreachable auth service (network 0 / 5xx) says login is unavailable", async () => {
    for (const status of [0, 500, 503]) {
      auth.signInWithPassword.mockResolvedValue({ data: null, error: { status, message: "x" } });
      const state = await signIn(null, form(CREDENTIALS));
      expect(state.error).toBe(authT("login.unavailable"));
    }
  });

  it("ML-AC4f: invalid input gets Danish field errors without calling Supabase", async () => {
    await expect(signIn(null, form({ email: "nope", password: "" }))).resolves.toEqual({
      email: "nope",
      fieldErrors: {
        email: authT("validation.emailInvalid"),
        password: authT("validation.passwordRequired"),
      },
    });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});

// ── signIn: success redirects (ML-AC2, ML-AC22, ML-AC25) ────────────────────

describe("signIn: ML-AC2 success redirects into MyLife only", () => {
  it("ML-AC2a: success without next redirects to exactly /mylife", async () => {
    await expect(signIn(null, form(CREDENTIALS))).rejects.toThrow("NEXT_REDIRECT:/mylife");
    expect(mockRedirect.mock.calls).toEqual([["/mylife"]]);
  });

  it("ML-AC2b: success with next=/mylife/set-password redirects there", async () => {
    await expect(
      signIn(null, form({ ...CREDENTIALS, next: "/mylife/set-password" })),
    ).rejects.toThrow("NEXT_REDIRECT:/mylife/set-password");
    expect(mockRedirect.mock.calls).toEqual([["/mylife/set-password"]]);
  });

  it("ML-AC22: an /admin/ next (other area) falls back to exactly /mylife", async () => {
    await expect(signIn(null, form({ ...CREDENTIALS, next: "/admin/dashboard" }))).rejects.toThrow();
    expect(mockRedirect.mock.calls).toEqual([["/mylife"]]);
  });

  it("ML-AC25n: an external next falls back to exactly /mylife (open-redirect guard)", async () => {
    await expect(signIn(null, form({ ...CREDENTIALS, next: "https://evil.com" }))).rejects.toThrow();
    expect(mockRedirect.mock.calls).toEqual([["/mylife"]]);
  });

  it("ML-AC25o: a dot-segment escape /mylife/../admin/x falls back to exactly /mylife", async () => {
    await expect(signIn(null, form({ ...CREDENTIALS, next: "/mylife/../admin/x" }))).rejects.toThrow();
    expect(mockRedirect.mock.calls).toEqual([["/mylife"]]);
  });
});

// ── requestPasswordReset (ML-AC10, ML-AC16) ──────────────────────────────────

describe("requestPasswordReset: ML-AC10 no account enumeration", () => {
  it("ML-AC10a: answers {sent, email} for any address", async () => {
    await expect(requestPasswordReset(null, form({ email: "anyone@x.dk" }))).resolves.toEqual({
      sent: true,
      email: "anyone@x.dk",
    });
  });

  it("ML-AC10b: answers exactly the same when Supabase fails, logging only the code", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    auth.resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: { code: "user_not_found", status: 400, message: "fail" },
    });
    await expect(requestPasswordReset(null, form({ email: "anyone@x.dk" }))).resolves.toEqual({
      sent: true,
      email: "anyone@x.dk",
    });
    expect(log).toHaveBeenCalledWith("requestPasswordReset failed: user_not_found");
  });

  it("ML-AC10c: an invalid address gets the Danish field error before Supabase", async () => {
    await expect(requestPasswordReset(null, form({ email: "not-an-email" }))).resolves.toEqual({
      email: "not-an-email",
      fieldErrors: { email: authT("validation.emailInvalid") },
    });
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("requestPasswordReset: ML-AC16 redirectTo is the MyLife origin of the Host header", () => {
  it("ML-AC16a: on mylife.localhost:3000 it passes redirectTo http://mylife.localhost:3000", async () => {
    requestHost.value = "mylife.localhost:3000";
    await requestPasswordReset(null, form({ email: "ml@alnyron.dk" }));
    expect(auth.resetPasswordForEmail.mock.calls).toEqual([
      ["ml@alnyron.dk", { redirectTo: "http://mylife.localhost:3000" }],
    ]);
  });

  it("ML-AC16b: on mylife.alnyron.dk it passes redirectTo https://mylife.alnyron.dk", async () => {
    requestHost.value = "mylife.alnyron.dk";
    await requestPasswordReset(null, form({ email: "ml@alnyron.dk" }));
    expect(auth.resetPasswordForEmail.mock.calls).toEqual([
      ["ml@alnyron.dk", { redirectTo: "https://mylife.alnyron.dk" }],
    ]);
  });

  it("ML-AC16c: on the main host it passes no options at all (Supabase uses the Site URL)", async () => {
    await requestPasswordReset(null, form({ email: "ml@alnyron.dk" }));
    expect(auth.resetPasswordForEmail.mock.calls).toEqual([["ml@alnyron.dk"]]);
  });

  it("ML-AC16d: form fields never influence redirectTo", async () => {
    requestHost.value = "mylife.localhost:3000";
    await requestPasswordReset(
      null,
      form({ email: "ml@alnyron.dk", next: "https://evil.com", redirectTo: "https://evil.com" }),
    );
    expect(auth.resetPasswordForEmail.mock.calls).toEqual([
      ["ml@alnyron.dk", { redirectTo: "http://mylife.localhost:3000" }],
    ]);
  });

  it("ML-AC16g: on the FQDN host mylife.alnyron.dk. it passes the dotless origin https://mylife.alnyron.dk", async () => {
    requestHost.value = "mylife.alnyron.dk.";
    await requestPasswordReset(null, form({ email: "ml@alnyron.dk" }));
    expect(auth.resetPasswordForEmail.mock.calls).toEqual([
      ["ml@alnyron.dk", { redirectTo: "https://mylife.alnyron.dk" }],
    ]);
  });
});

// ── signOut (ML-AC3) ─────────────────────────────────────────────────────────

describe("signOut: ML-AC3 ends this browser's session and shows the MyLife login", () => {
  it("ML-AC3a: revokes the local session and redirects to exactly /mylife/login", async () => {
    await expect(signOut()).rejects.toThrow("NEXT_REDIRECT:/mylife/login");
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mockRedirect.mock.calls).toEqual([["/mylife/login"]]);
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });

  it("ML-AC3b: still removes the Supabase auth cookies when the revoke call fails", async () => {
    auth.signOut.mockResolvedValue({ error: { status: 0, message: "network" } });
    cookieStore.getAll.mockReturnValue([
      { name: "sb-ref-auth-token", value: "a" },
      { name: "unrelated", value: "b" },
    ]);

    await expect(signOut()).rejects.toThrow("NEXT_REDIRECT:/mylife/login");
    expect(cookieStore.delete.mock.calls).toEqual([["sb-ref-auth-token"]]);
  });
});
