/**
 * Unit tests: setPasswordSchema (invite + reset landing form) and the
 * message keys every auth schema issue carries.
 * Journey: admin-auth  AC-ADMINAUTH-01 (zod validation before Supabase).
 */
import { describe, expect, it } from "vitest";
import da from "../../../../messages/da.json";
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  resetPasswordSchema,
  setPasswordSchema,
  signInSchema,
} from "@/lib/validation/auth";

const issuesOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.error?.issues.map((issue) => ({ field: issue.path[0], key: issue.message })) ?? [];

describe("setPasswordSchema: AC-ADMINAUTH-01 password rules", () => {
  it("AC-ADMINAUTH-01j: accepts a 12-character password repeated exactly", () => {
    const password = "a".repeat(MIN_PASSWORD_LENGTH);
    expect(setPasswordSchema.safeParse({ password, confirm: password }).success).toBe(true);
  });

  it("AC-ADMINAUTH-01k: rejects 11 characters on the password field", () => {
    const password = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(issuesOf(setPasswordSchema.safeParse({ password, confirm: password }))).toContainEqual({
      field: "password",
      key: "passwordTooShort",
    });
  });

  it("AC-ADMINAUTH-01l: rejects a repeat that differs, on the confirm field", () => {
    const result = setPasswordSchema.safeParse({ password: "a".repeat(14), confirm: "b".repeat(14) });
    expect(issuesOf(result)).toEqual([{ field: "confirm", key: "passwordMismatch" }]);
  });

  it("AC-ADMINAUTH-01m: rejects more than 72 bytes (bcrypt limit), counting æøå as 2 bytes", () => {
    const password = "æ".repeat(MAX_PASSWORD_BYTES / 2 + 1); // 37 characters, 74 bytes
    expect(issuesOf(setPasswordSchema.safeParse({ password, confirm: password }))).toContainEqual({
      field: "password",
      key: "passwordTooLong",
    });
  });
});

describe("auth schemas: AC-ADMINAUTH-01 messages and input cleanup", () => {
  it("AC-ADMINAUTH-01n: trims surrounding whitespace from the email", () => {
    const result = signInSchema.safeParse({ email: "  admin@alnyron.dk ", password: "x" });
    expect(result.success && result.data.email).toBe("admin@alnyron.dk");
  });

  it("AC-ADMINAUTH-01o: every issue message is a key of Auth.validation in da.json", () => {
    const keys = [
      ...issuesOf(signInSchema.safeParse({ email: "nope", password: "" })),
      ...issuesOf(resetPasswordSchema.safeParse({})),
      ...issuesOf(setPasswordSchema.safeParse({ password: "short", confirm: 3 })),
    ].map((issue) => issue.key);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(Object.keys(da.Auth.validation)).toContain(key);
  });
});
