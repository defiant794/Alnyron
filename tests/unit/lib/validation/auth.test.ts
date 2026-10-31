/**
 * Unit tests — auth validation schemas (zod)
 * Journey: admin-auth  AC-ADMINAUTH-01
 *
 * Covers signInSchema and resetPasswordSchema exported from
 * @/lib/validation/auth.
 */

import { describe, expect, it } from "vitest";
import { signInSchema, resetPasswordSchema } from "@/lib/validation/auth";

// ── signInSchema ──────────────────────────────────────────────────────────────

describe("signInSchema — AC-ADMINAUTH-01: sign-in field validation", () => {
  it("AC-ADMINAUTH-01a: accepts valid email and non-empty password", () => {
    const result = signInSchema.safeParse({ email: "admin@alnyron.dk", password: "supersecret1234" });
    expect(result.success).toBe(true);
  });

  it("AC-ADMINAUTH-01b: rejects an invalid email address", () => {
    const result = signInSchema.safeParse({ email: "not-an-email", password: "supersecret1234" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i: { path: unknown[] }) => i.path[0])).toContain("email");
    }
  });

  it("AC-ADMINAUTH-01c: rejects an empty password", () => {
    const result = signInSchema.safeParse({ email: "admin@alnyron.dk", password: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i: { path: unknown[] }) => i.path[0])).toContain("password");
    }
  });

  it("AC-ADMINAUTH-01d: rejects when both fields are empty", () => {
    expect(signInSchema.safeParse({ email: "", password: "" }).success).toBe(false);
  });

  it("AC-ADMINAUTH-01e: rejects when email field is missing", () => {
    expect(signInSchema.safeParse({ password: "supersecret1234" }).success).toBe(false);
  });

  it("AC-ADMINAUTH-01f: rejects when password field is missing", () => {
    expect(signInSchema.safeParse({ email: "admin@alnyron.dk" }).success).toBe(false);
  });
});

// ── resetPasswordSchema ───────────────────────────────────────────────────────

describe("resetPasswordSchema — AC-ADMINAUTH-01g/h: password-reset field validation", () => {
  it("AC-ADMINAUTH-01g: accepts a valid email", () => {
    expect(resetPasswordSchema.safeParse({ email: "admin@alnyron.dk" }).success).toBe(true);
  });

  it("AC-ADMINAUTH-01h: rejects an invalid email", () => {
    const result = resetPasswordSchema.safeParse({ email: "not-an-email" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i: { path: unknown[] }) => i.path[0])).toContain("email");
    }
  });

  it("AC-ADMINAUTH-01i: rejects an empty email", () => {
    expect(resetPasswordSchema.safeParse({ email: "" }).success).toBe(false);
  });
});
