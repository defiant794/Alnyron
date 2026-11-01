/**
 * Unit tests: MyLife updatePassword Server Action (/mylife/set-password, the
 * end of the MyLife invite and reset links).
 * Journey: mylife-login  ML-AC12
 *
 * The action gates with requireMyLife() and on success redirects to /mylife.
 * The expected Danish copy comes from the message keys (`authT`), so the
 * tests follow the copy instead of repeating it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateUser, mockRequireMyLife, mockRedirect } = vi.hoisted(() => ({
  updateUser: vi.fn(),
  mockRequireMyLife: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({ auth: { updateUser } })),
}));
vi.mock("@/services/auth/require-role", () => ({ requireMyLife: mockRequireMyLife }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

import { updatePassword } from "@/app/mylife/(panel)/set-password/actions";
import { MIN_PASSWORD_LENGTH } from "@/lib/validation/auth";
import { authT } from "@/services/auth/form-feedback";

const VALID_PASSWORD = "NewPassword456!";

function form(password: string, confirm: string): FormData {
  const fd = new FormData();
  fd.set("password", password);
  fd.set("confirm", confirm);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMyLife.mockResolvedValue({ userId: "u1", email: "ml@alnyron.dk", role: "mylife_user" });
  updateUser.mockResolvedValue({ data: { user: {} }, error: null });
});

describe("MyLife updatePassword: ML-AC12", () => {
  it("ML-AC12a: runs requireMyLife first; an anonymous redirect there stops the action", async () => {
    mockRequireMyLife.mockRejectedValue(new Error("NEXT_REDIRECT:/mylife/login"));
    await expect(updatePassword(null, form(VALID_PASSWORD, VALID_PASSWORD))).rejects.toThrow(
      "NEXT_REDIRECT:/mylife/login",
    );
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("ML-AC12b: a forbidden role's redirect to /mylife/no-access stops the action", async () => {
    mockRequireMyLife.mockRejectedValue(new Error("NEXT_REDIRECT:/mylife/no-access"));
    await expect(updatePassword(null, form(VALID_PASSWORD, VALID_PASSWORD))).rejects.toThrow(
      "NEXT_REDIRECT:/mylife/no-access",
    );
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("ML-AC12c: saves the password and redirects to exactly /mylife", async () => {
    await expect(updatePassword(null, form(VALID_PASSWORD, VALID_PASSWORD))).rejects.toThrow(
      "NEXT_REDIRECT:/mylife",
    );
    expect(mockRequireMyLife).toHaveBeenCalledTimes(1);
    expect(updateUser).toHaveBeenCalledWith({ password: VALID_PASSWORD });
    expect(mockRedirect.mock.calls).toEqual([["/mylife"]]);
  });

  it("ML-AC12d: a too short password gets the Danish field error before Supabase", async () => {
    await expect(updatePassword(null, form("short", "short"))).resolves.toEqual({
      fieldErrors: { password: authT("validation.passwordTooShort", { min: MIN_PASSWORD_LENGTH }) },
    });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("ML-AC12e: a mismatched repeat gets the Danish field error before Supabase", async () => {
    await expect(updatePassword(null, form(VALID_PASSWORD, `${VALID_PASSWORD}x`))).resolves.toEqual({
      fieldErrors: { confirm: authT("validation.passwordMismatch") },
    });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it.each([
    ["same_password", "setPassword.samePassword"],
    ["weak_password", "setPassword.weakPassword"],
    ["reauthentication_needed", "setPassword.reauthenticationNeeded"],
    ["unexpected_failure", "setPassword.failed"],
  ] as const)("ML-AC12f: maps Supabase error code %s to the Danish %s copy", async (code, key) => {
    updateUser.mockResolvedValue({ data: null, error: { code, message: "raw" } });
    await expect(updatePassword(null, form(VALID_PASSWORD, VALID_PASSWORD))).resolves.toEqual({
      error: authT(key),
    });
  });
});
