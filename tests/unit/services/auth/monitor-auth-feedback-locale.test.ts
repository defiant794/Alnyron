/**
 * Unit tests: the Monitor auth Server Actions answer in the visitor's Monitor
 * language (the `monitor-locale` cookie), while the admin area stays Danish.
 * Journey: monitor-i18n  (Monitor UI in the chosen language; AC-I18N-MON-27 admin unaffected).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, cookieValues, mockRedirect } = vi.hoisted(() => ({
  auth: { signInWithPassword: vi.fn(), signUp: vi.fn(), updateUser: vi.fn() },
  cookieValues: new Map<string, string>(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({ createServerClient: vi.fn(async () => ({ auth })) }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieValues.has(name) ? { name, value: cookieValues.get(name) } : undefined),
    getAll: () => [],
    delete: vi.fn(),
  })),
  headers: vi.fn(async () => new Headers({ host: "monitor.localhost:3000" })),
}));
vi.mock("@/services/auth/require-role", () => ({ requireMonitor: vi.fn(async () => ({ email: "mon@test.local" })) }));

import { signIn as adminSignIn } from "@/app/admin/(auth)/actions";
import { signIn, signUp, updatePassword } from "@/app/monitor/(auth)/actions";
import { loadMessages } from "@/i18n/messages";
import { MONITOR_LOCALE_COOKIE } from "@/i18n/monitor-locale";

const da = loadMessages("da");
const en = loadMessages("en");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const WRONG_PASSWORD = { data: null, error: { status: 400, code: "invalid_credentials", message: "x" } };

beforeEach(() => {
  vi.clearAllMocks();
  cookieValues.clear();
  auth.signInWithPassword.mockResolvedValue(WRONG_PASSWORD);
});

describe("Monitor auth actions — messages in the visitor's Monitor language", () => {
  it("AC-I18N-MON-auth-0: the English copy compared below is not the Danish fallback (loadMessages merges DA)", () => {
    for (const pick of [
      (m: typeof da) => m.Auth.login.invalidCredentials,
      (m: typeof da) => m.Auth.validation.emailInvalid,
      (m: typeof da) => m.Auth.validation.passwordRequired,
      (m: typeof da) => m.Auth.setPassword.samePassword,
    ]) {
      expect(pick(en)).not.toBe(pick(da));
    }
  });

  it("AC-I18N-MON-auth-a: without the cookie, a failed sign-in is answered in Danish", async () => {
    const state = await signIn(null, form({ email: "x@x.dk", password: "pw" }));
    expect(state.error).toBe(da.Auth.login.invalidCredentials);
  });

  it("AC-I18N-MON-auth-b: with monitor-locale=en, a failed sign-in is answered in English", async () => {
    cookieValues.set(MONITOR_LOCALE_COOKIE, "en");
    const state = await signIn(null, form({ email: "x@x.dk", password: "pw" }));
    expect(state.error).toBe(en.Auth.login.invalidCredentials);
  });

  it("AC-I18N-MON-auth-c: with monitor-locale=en, field errors are in English", async () => {
    cookieValues.set(MONITOR_LOCALE_COOKIE, "en");
    const state = await signIn(null, form({ email: "not-an-email", password: "" }));
    expect(state.fieldErrors).toEqual({
      email: en.Auth.validation.emailInvalid,
      password: en.Auth.validation.passwordRequired,
    });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("AC-I18N-MON-auth-d: with monitor-locale=en, a signup field error is in English", async () => {
    cookieValues.set(MONITOR_LOCALE_COOKIE, "en");
    const result = await signUp(null, form({ email: "not-an-email", password: "LongEnough123!" }));
    expect(result).toMatchObject({ type: "field_error", fieldErrors: { email: en.Auth.validation.emailInvalid } });
  });

  it("AC-I18N-MON-auth-e: with monitor-locale=en, a refused new password is explained in English", async () => {
    cookieValues.set(MONITOR_LOCALE_COOKIE, "en");
    auth.updateUser.mockResolvedValue({ data: null, error: { code: "same_password", message: "x" } });
    const state = await updatePassword(null, form({ password: "LongEnough123!", confirm: "LongEnough123!" }));
    expect(state.error).toBe(en.Auth.setPassword.samePassword);
  });
});

describe("AC-I18N-MON-27: the admin area stays Danish whatever the Monitor cookie says", () => {
  it("AC-I18N-MON-27c: admin sign-in answers in Danish with monitor-locale=en", async () => {
    cookieValues.set(MONITOR_LOCALE_COOKIE, "en");
    const state = await adminSignIn(null, form({ email: "x@x.dk", password: "pw" }));
    expect(state.error).toBe(da.Auth.login.invalidCredentials);
  });
});
