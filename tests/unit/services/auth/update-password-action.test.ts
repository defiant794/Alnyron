/**
 * Unit tests: updatePassword Server Action (/admin/set-password, the end of
 * the invite and reset links).
 * Journey: admin-auth  AC-ADMINAUTH-01 / 05 / 06 (requireAdmin on every admin action);
 * mylife-login  ML-AC29 (the admin action keeps its own gate and home after the
 * set-password core was shared with MyLife).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateUser, mockRequireAdmin, mockRedirect } = vi.hoisted(() => ({
  updateUser: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({ auth: { updateUser } })),
}));
vi.mock("@/services/auth/require-admin", () => ({ requireAdmin: mockRequireAdmin }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

import { updatePassword } from "@/app/admin/(panel)/set-password/actions";

const PASSWORD = "NewPassword456!";

function form(password: string, confirm: string): FormData {
  const data = new FormData();
  data.set("password", password);
  data.set("confirm", confirm);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({ userId: "u1", email: "admin@alnyron.dk", role: "admin" });
  updateUser.mockResolvedValue({ data: { user: {} }, error: null });
});

describe("updatePassword (admin): ML-AC29 admin gate and home unchanged", () => {
  it("AC-ADMINAUTH-05f / ML-AC29: runs requireAdmin first; a redirect there stops the action", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT:/admin/no-access"));

    await expect(updatePassword(null, form(PASSWORD, PASSWORD))).rejects.toThrow(
      "NEXT_REDIRECT:/admin/no-access",
    );
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("AC-ADMINAUTH-06c / ML-AC29: saves the password and redirects to exactly /admin", async () => {
    await expect(updatePassword(null, form(PASSWORD, PASSWORD))).rejects.toThrow("NEXT_REDIRECT:/admin");
    expect(updateUser).toHaveBeenCalledWith({ password: PASSWORD });
    expect(mockRedirect.mock.calls).toEqual([["/admin"]]);
  });

  it("AC-ADMINAUTH-01q: a short or mismatched password gets Danish field errors before Supabase", async () => {
    await expect(updatePassword(null, form("short", "short"))).resolves.toEqual({
      fieldErrors: { password: "Adgangskoden skal være på mindst 12 tegn." },
    });
    await expect(updatePassword(null, form(PASSWORD, `${PASSWORD}x`))).resolves.toEqual({
      fieldErrors: { confirm: "De to adgangskoder er ikke ens." },
    });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("AC-ADMINAUTH-01m: 37 æ (74 bytes) is too long; the message says æ, ø, å count for more", async () => {
    const password = "æ".repeat(37);
    await expect(updatePassword(null, form(password, password))).resolves.toEqual({
      fieldErrors: {
        password:
          "Adgangskoden er for lang. Den må højst være på 72 tegn, og færre hvis den indeholder æ, ø, å eller lignende tegn.",
      },
    });
  });

  it.each([
    ["same_password", "Den nye adgangskode skal være forskellig fra den nuværende."],
    ["weak_password", "Adgangskoden er for let at gætte. Vælg en længere adgangskode."],
    [
      "reauthentication_needed",
      "Af sikkerhedshensyn skal du bruge et nyt link for at skifte adgangskode. Log ud, og bed om et nulstillingslink på log ind-siden.",
    ],
    ["unexpected_failure", "Adgangskoden kunne ikke gemmes. Prøv igen om lidt."],
  ])("AC-ADMINAUTH-06d: maps Supabase error code %s to Danish copy", async (code, message) => {
    updateUser.mockResolvedValue({ data: null, error: { code, message: "raw" } });

    await expect(updatePassword(null, form(PASSWORD, PASSWORD))).resolves.toEqual({ error: message });
  });
});
