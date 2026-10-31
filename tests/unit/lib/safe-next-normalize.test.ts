/**
 * Unit tests: safeNext() rejects targets that only look like /admin/ paths
 * before the URL parser resolves them, and returns the normalized path.
 * Journey: admin-auth  AC-ADMINAUTH-02 (open-redirect guard, hardening).
 */
import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext: AC-ADMINAUTH-02 dot segments and normalization", () => {
  it("AC-ADMINAUTH-02q: rejects /admin/../ (resolves outside /admin/)", () => {
    expect(safeNext("/admin/../kontakt")).toBeNull();
  });

  it("AC-ADMINAUTH-02r: rejects percent-encoded dot segments /admin/%2e%2e/", () => {
    expect(safeNext("/admin/%2e%2e/kontakt")).toBeNull();
  });

  it("AC-ADMINAUTH-02s: rejects a backslash dot segment /admin/..\\evil", () => {
    expect(safeNext("/admin/..\\evil")).toBeNull();
  });

  it("AC-ADMINAUTH-02t: keeps query and hash of an accepted admin path", () => {
    expect(safeNext("/admin/pages?status=draft#list")).toBe("/admin/pages?status=draft#list");
  });

  it("AC-ADMINAUTH-02u: strips tab/newline characters instead of passing them to a Location header", () => {
    expect(safeNext("/admin/pa\nges")).toBe("/admin/pages");
  });
});
