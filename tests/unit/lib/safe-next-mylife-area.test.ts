/**
 * Unit tests — safeNext(next, area?) area-restriction
 * Journey: mylife-login  ML-AC21..ML-AC25
 *
 * New optional `area` param restricts which prefix is accepted.
 * Omitting area accepts both /admin/ and /mylife/ (for /auth/confirm).
 * Existing safe-next.test.ts and safe-next-normalize.test.ts are untouched;
 * this file covers new mylife-area behaviour only.
 */
import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

// ── ML-AC21: mylife area accepts /mylife/ paths ───────────────────────────────

describe('safeNext(next, "mylife") — ML-AC21: accepts /mylife/ paths', () => {
  it("ML-AC21a: returns /mylife/ exactly", () => {
    expect(safeNext("/mylife/", "mylife")).toBe("/mylife/");
  });

  it("ML-AC21b: returns /mylife/login", () => {
    expect(safeNext("/mylife/login", "mylife")).toBe("/mylife/login");
  });

  it("ML-AC21c: returns /mylife/set-password", () => {
    expect(safeNext("/mylife/set-password", "mylife")).toBe("/mylife/set-password");
  });

  it("ML-AC21d: returns /mylife/forgot-password", () => {
    expect(safeNext("/mylife/forgot-password", "mylife")).toBe("/mylife/forgot-password");
  });

  it("ML-AC21e: preserves query and hash on accepted mylife path", () => {
    expect(safeNext("/mylife/page?foo=bar#section", "mylife")).toBe(
      "/mylife/page?foo=bar#section",
    );
  });
});

// ── ML-AC22: mylife area rejects /admin/ paths ────────────────────────────────

describe('safeNext(next, "mylife") — ML-AC22: rejects /admin/ paths', () => {
  it("ML-AC22a: rejects /admin/ with mylife area", () => {
    expect(safeNext("/admin/", "mylife")).toBeNull();
  });

  it("ML-AC22b: rejects /admin/set-password with mylife area", () => {
    expect(safeNext("/admin/set-password", "mylife")).toBeNull();
  });

  it("ML-AC22c: rejects /admin/dashboard with mylife area", () => {
    expect(safeNext("/admin/dashboard", "mylife")).toBeNull();
  });
});

// ── ML-AC23: admin area rejects /mylife/ paths ────────────────────────────────

describe('safeNext(next, "admin") — ML-AC23: rejects /mylife/ paths', () => {
  it("ML-AC23a: rejects /mylife/ with admin area", () => {
    expect(safeNext("/mylife/", "admin")).toBeNull();
  });

  it("ML-AC23b: rejects /mylife/set-password with admin area", () => {
    expect(safeNext("/mylife/set-password", "admin")).toBeNull();
  });

  it("ML-AC23c: rejects /mylife/login with admin area", () => {
    expect(safeNext("/mylife/login", "admin")).toBeNull();
  });

  it("ML-AC23d: /admin/ still accepted with admin area (regression)", () => {
    expect(safeNext("/admin/set-password", "admin")).toBe("/admin/set-password");
  });
});

// ── ML-AC24: no area accepts both prefixes (for /auth/confirm) ───────────────

describe("safeNext(next) no area — ML-AC24: accepts both /mylife/ and /admin/", () => {
  it("ML-AC24a: accepts /mylife/ with no area", () => {
    expect(safeNext("/mylife/")).toBe("/mylife/");
  });

  it("ML-AC24b: accepts /mylife/set-password with no area", () => {
    expect(safeNext("/mylife/set-password")).toBe("/mylife/set-password");
  });

  it("ML-AC24c: accepts /admin/set-password with no area (regression)", () => {
    expect(safeNext("/admin/set-password")).toBe("/admin/set-password");
  });

  it("ML-AC24d: accepts /mylife/forgot-password with no area", () => {
    expect(safeNext("/mylife/forgot-password")).toBe("/mylife/forgot-password");
  });
});

// ── ML-AC25: open-redirect attacks rejected with mylife area ─────────────────

describe("safeNext mylife-area — ML-AC25: open-redirect attacks all rejected", () => {
  it("ML-AC25a: rejects absolute URL even with /mylife/ path component", () => {
    expect(safeNext("https://evil.com/mylife/steal", "mylife")).toBeNull();
  });

  it("ML-AC25l: rejects protocol-relative //evil.com", () => {
    expect(safeNext("//evil.com/mylife/x", "mylife")).toBeNull();
  });

  it("ML-AC25m: rejects /mylifex (look-alike, missing trailing slash)", () => {
    expect(safeNext("/mylifex", "mylife")).toBeNull();
  });

  it("ML-AC25d: rejects bare /mylife (no trailing slash)", () => {
    expect(safeNext("/mylife", "mylife")).toBeNull();
  });

  it("ML-AC25e: rejects /mylife/../admin/x (cross-area dot-segment escape)", () => {
    expect(safeNext("/mylife/../admin/x", "mylife")).toBeNull();
  });

  it("ML-AC25f: rejects /mylife/%2e%2e/admin/x (encoded dot-segment escape)", () => {
    expect(safeNext("/mylife/%2e%2e/admin/x", "mylife")).toBeNull();
  });

  it("ML-AC25g: rejects backslash variant \\evil.com", () => {
    expect(safeNext("\\evil.com", "mylife")).toBeNull();
  });

  it("ML-AC25h: rejects null with mylife area", () => {
    expect(safeNext(null, "mylife")).toBeNull();
  });

  it("ML-AC25i: rejects undefined with mylife area", () => {
    expect(safeNext(undefined, "mylife")).toBeNull();
  });

  it("ML-AC25j: rejects empty string with mylife area", () => {
    expect(safeNext("", "mylife")).toBeNull();
  });

  it("ML-AC25k: rejects data: URI", () => {
    expect(safeNext("data:text/html,<script>alert(1)</script>", "mylife")).toBeNull();
  });

  it("ML-AC24-no-area: /public/page still rejected with no area (not a known prefix)", () => {
    expect(safeNext("/public/page")).toBeNull();
  });
});
