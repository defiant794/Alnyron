/**
 * Unit tests — safeNext() open-redirect guard
 * Journey: admin-auth  AC-ADMINAUTH-02
 *
 * safeNext(next: string | null | undefined): string | null
 * Returns the path only when it starts with '/admin/', null in every other
 * case.  Accepts null/undefined from searchParams.get("next").
 * This is the sole defence against open redirects in /auth/confirm and
 * in the signIn Server Action's `next` param.
 */

import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext — AC-ADMINAUTH-02: open-redirect guard", () => {
  // ── allowed paths ──────────────────────────────────────────────────────

  it("AC-ADMINAUTH-02a: returns /admin/ exactly", () => {
    expect(safeNext("/admin/")).toBe("/admin/");
  });

  it("AC-ADMINAUTH-02b: returns /admin/set-password", () => {
    expect(safeNext("/admin/set-password")).toBe("/admin/set-password");
  });

  it("AC-ADMINAUTH-02c: returns a nested admin path", () => {
    expect(safeNext("/admin/pages/123")).toBe("/admin/pages/123");
  });

  it("AC-ADMINAUTH-02d: returns /admin/settings", () => {
    expect(safeNext("/admin/settings")).toBe("/admin/settings");
  });

  // ── rejected paths ────────────────────────────────────────────────────

  it("AC-ADMINAUTH-02e: returns null for the root path /", () => {
    expect(safeNext("/")).toBeNull();
  });

  it("AC-ADMINAUTH-02f: returns null for a public path /public/page", () => {
    expect(safeNext("/public/page")).toBeNull();
  });

  it("AC-ADMINAUTH-02g: returns null for /adminx (must start with /admin/)", () => {
    expect(safeNext("/adminx")).toBeNull();
  });

  it("AC-ADMINAUTH-02h: returns null for an absolute URL https://evil.com", () => {
    expect(safeNext("https://evil.com")).toBeNull();
  });

  it("AC-ADMINAUTH-02i: returns null for a protocol-relative URL //evil.com", () => {
    expect(safeNext("//evil.com")).toBeNull();
  });

  it("AC-ADMINAUTH-02j: returns null for https://evil.com/admin/path (external)", () => {
    expect(safeNext("https://evil.com/admin/path")).toBeNull();
  });

  it("AC-ADMINAUTH-02k: returns null for an empty string", () => {
    expect(safeNext("")).toBeNull();
  });

  it("AC-ADMINAUTH-02l: returns null for bare /admin without trailing slash", () => {
    expect(safeNext("/admin")).toBeNull();
  });

  it("AC-ADMINAUTH-02m: returns null for null (searchParams.get returns null)", () => {
    expect(safeNext(null)).toBeNull();
  });

  it("AC-ADMINAUTH-02n: returns null for undefined", () => {
    expect(safeNext(undefined)).toBeNull();
  });

  it("AC-ADMINAUTH-02o: returns null for backslash variant \\evil.com (browsers normalise to //)", () => {
    expect(safeNext("\\evil.com")).toBeNull();
  });

  it("AC-ADMINAUTH-02p: returns null for encoded double-slash /%2F%2Fevil.com", () => {
    expect(safeNext("/%2F%2Fevil.com")).toBeNull();
  });

  it("AC-ADMINAUTH-02x: returns null for a data: URI", () => {
    expect(safeNext("data:text/html,<script>alert(1)</script>")).toBeNull();
  });
});
