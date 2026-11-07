/**
 * Unit tests — safeNext(next, "monitor") area-restriction
 * Journey: monitor-web-area  MON-AC22
 *
 * New "monitor" area restricts accepted paths to /monitor/.
 * Mirrors safe-next-mylife-area.test.ts; does NOT duplicate the existing
 * generic open-redirect or no-area tests.
 */
import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

// ── MON-AC22a: monitor area accepts /monitor/ paths ──────────────────────────

describe('safeNext(next, "monitor") — MON-AC22a: accepts /monitor/ paths', () => {
  it("MON-AC22a1: returns /monitor/ exactly", () => {
    expect(safeNext("/monitor/", "monitor")).toBe("/monitor/");
  });

  it("MON-AC22a2: returns /monitor/login", () => {
    expect(safeNext("/monitor/login", "monitor")).toBe("/monitor/login");
  });

  it("MON-AC22a3: returns /monitor/dashboard", () => {
    expect(safeNext("/monitor/dashboard", "monitor")).toBe("/monitor/dashboard");
  });

  it("MON-AC22a4: returns /monitor/reset", () => {
    expect(safeNext("/monitor/reset", "monitor")).toBe("/monitor/reset");
  });

  it("MON-AC22a5: returns /monitor/monitors/abc-123", () => {
    expect(safeNext("/monitor/monitors/abc-123", "monitor")).toBe("/monitor/monitors/abc-123");
  });
});

// ── MON-AC22b: monitor area rejects /admin/ paths ────────────────────────────

describe('safeNext(next, "monitor") — MON-AC22b: rejects /admin/ paths', () => {
  it("MON-AC22b1: returns null for /admin/", () => {
    expect(safeNext("/admin/", "monitor")).toBeNull();
  });

  it("MON-AC22b2: returns null for /admin/set-password", () => {
    expect(safeNext("/admin/set-password", "monitor")).toBeNull();
  });
});

// ── MON-AC22c: monitor area rejects /mylife/ paths ───────────────────────────

describe('safeNext(next, "monitor") — MON-AC22c: rejects /mylife/ paths', () => {
  it("MON-AC22c1: returns null for /mylife/", () => {
    expect(safeNext("/mylife/", "monitor")).toBeNull();
  });

  it("MON-AC22c2: returns null for /mylife/login", () => {
    expect(safeNext("/mylife/login", "monitor")).toBeNull();
  });
});

// ── MON-AC22d: bare /monitor without trailing slash rejected ─────────────────

describe('safeNext(next, "monitor") — MON-AC22d: bare /monitor without trailing slash rejected', () => {
  it("MON-AC22d1: returns null for bare /monitor", () => {
    expect(safeNext("/monitor", "monitor")).toBeNull();
  });
});

// ── MON-AC22e: open-redirect attacks rejected with monitor area ──────────────

describe('safeNext(next, "monitor") — MON-AC22e: open-redirect attacks all rejected', () => {
  it("MON-AC22e1: absolute URL rejected", () => {
    expect(safeNext("https://evil.com/monitor/x", "monitor")).toBeNull();
  });

  it("MON-AC22e2: protocol-relative rejected", () => {
    expect(safeNext("//evil.com/monitor/x", "monitor")).toBeNull();
  });

  it("MON-AC22e3: backslash rejected", () => {
    expect(safeNext("\\evil.com", "monitor")).toBeNull();
  });

  it("MON-AC22e4: dot-segment escape /monitor/../admin/x rejected", () => {
    expect(safeNext("/monitor/../admin/x", "monitor")).toBeNull();
  });

  it("MON-AC22e5: percent-encoded dot-segment /monitor/%2e%2e/ rejected", () => {
    expect(safeNext("/monitor/%2e%2e/", "monitor")).toBeNull();
  });

  it("MON-AC22e6: look-alike /monitorx rejected (requires /monitor/ prefix)", () => {
    expect(safeNext("/monitorx", "monitor")).toBeNull();
  });

  it("MON-AC22e7: null input returns null", () => {
    expect(safeNext(null, "monitor")).toBeNull();
  });

  it("MON-AC22e8: undefined input returns null", () => {
    expect(safeNext(undefined, "monitor")).toBeNull();
  });
});
