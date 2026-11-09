/**
 * Unit tests: src/config/monitor.ts — host helpers
 * Journey: monitor-ship-routing  SHIP-AC1a..SHIP-AC2a
 *
 * Verifies:
 *   monitorOrigin(host)   — same logic as myLifeOrigin, keyed to monitor hosts
 *   isMonitorHost(host)   — boolean wrapper
 *   monitorSiteOrigin(siteUrl) — builds <scheme>://monitor.<host>[:port] and
 *     throws when the result does not round-trip through monitorOrigin
 */
import { describe, expect, it } from "vitest";
import { monitorOrigin, isMonitorHost, monitorSiteOrigin } from "@/config/monitor";

// ── monitorOrigin — basic lookup ──────────────────────────────────────────────

describe("monitorOrigin — SHIP-AC1a: basic origin building", () => {
  it("SHIP-AC1a-m1: 'monitor.alnyron.dk' → https://monitor.alnyron.dk", () => {
    expect(monitorOrigin("monitor.alnyron.dk")).toBe("https://monitor.alnyron.dk");
  });

  it("SHIP-AC1a-m2: 'monitor.localhost' → http://monitor.localhost", () => {
    expect(monitorOrigin("monitor.localhost")).toBe("http://monitor.localhost");
  });

  it("SHIP-AC1a-m3: 'monitor.localhost:3000' → http://monitor.localhost:3000", () => {
    expect(monitorOrigin("monitor.localhost:3000")).toBe("http://monitor.localhost:3000");
  });

  it("SHIP-AC1a-m4: null → null", () => {
    expect(monitorOrigin(null)).toBeNull();
  });
});

// ── monitorOrigin — case-insensitive ─────────────────────────────────────────

describe("monitorOrigin — SHIP-AC1a: case-insensitive", () => {
  it("SHIP-AC1a-m5: 'MONITOR.ALNYRON.DK' → https://monitor.alnyron.dk", () => {
    expect(monitorOrigin("MONITOR.ALNYRON.DK")).toBe("https://monitor.alnyron.dk");
  });

  it("SHIP-AC1a-m6: 'Monitor.Localhost' → http://monitor.localhost", () => {
    expect(monitorOrigin("Monitor.Localhost")).toBe("http://monitor.localhost");
  });
});

// ── monitorOrigin — trailing FQDN dot ────────────────────────────────────────

describe("monitorOrigin — SHIP-AC1a: trailing FQDN dot", () => {
  it("SHIP-AC1a-m7: 'monitor.alnyron.dk.' (single dot) → https://monitor.alnyron.dk", () => {
    expect(monitorOrigin("monitor.alnyron.dk.")).toBe("https://monitor.alnyron.dk");
  });

  it("SHIP-AC1a-m8: 'monitor.alnyron.dk..' (double dot) → null", () => {
    expect(monitorOrigin("monitor.alnyron.dk..")).toBeNull();
  });
});

// ── monitorOrigin — port handling ─────────────────────────────────────────────

describe("monitorOrigin — SHIP-AC1a: port handling", () => {
  it("SHIP-AC1a-m9: 'monitor.alnyron.dk:443' drops default HTTPS port", () => {
    expect(monitorOrigin("monitor.alnyron.dk:443")).toBe("https://monitor.alnyron.dk");
  });

  it("SHIP-AC1a-m10: 'monitor.localhost:80' drops default HTTP port", () => {
    expect(monitorOrigin("monitor.localhost:80")).toBe("http://monitor.localhost");
  });

  it("SHIP-AC1a-m11: 'monitor.localhost:3000' keeps non-default port", () => {
    expect(monitorOrigin("monitor.localhost:3000")).toBe("http://monitor.localhost:3000");
  });
});

// ── monitorOrigin — look-alike hostnames rejected ─────────────────────────────

describe("monitorOrigin — SHIP-AC1a: look-alike rejection", () => {
  it("SHIP-AC1a-m12: 'monitor.alnyron.dk.evil.com' → null", () => {
    expect(monitorOrigin("monitor.alnyron.dk.evil.com")).toBeNull();
  });

  it("SHIP-AC1a-m13: 'evilmonitor.alnyron.dk' → null", () => {
    expect(monitorOrigin("evilmonitor.alnyron.dk")).toBeNull();
  });

  it("SHIP-AC1a-m14: 'monitor.alnyron.dk@evil.com' → null", () => {
    expect(monitorOrigin("monitor.alnyron.dk@evil.com")).toBeNull();
  });

  it("SHIP-AC1a-m15: 'alnyron.dk' → null (not a monitor host)", () => {
    expect(monitorOrigin("alnyron.dk")).toBeNull();
  });

  it("SHIP-AC1a-m16: 'mylife.alnyron.dk' → null (mylife is not monitor)", () => {
    expect(monitorOrigin("mylife.alnyron.dk")).toBeNull();
  });
});

// ── isMonitorHost ─────────────────────────────────────────────────────────────

describe("isMonitorHost — SHIP-AC1a: boolean wrapper", () => {
  it("SHIP-AC1a-b1: 'monitor.alnyron.dk' → true", () => {
    expect(isMonitorHost("monitor.alnyron.dk")).toBe(true);
  });

  it("SHIP-AC1a-b2: 'monitor.localhost' → true", () => {
    expect(isMonitorHost("monitor.localhost")).toBe(true);
  });

  it("SHIP-AC1a-b3: 'monitor.localhost:3000' → true", () => {
    expect(isMonitorHost("monitor.localhost:3000")).toBe(true);
  });

  it("SHIP-AC1a-b4: null → false", () => {
    expect(isMonitorHost(null)).toBe(false);
  });

  it("SHIP-AC1a-b5: 'alnyron.dk' → false", () => {
    expect(isMonitorHost("alnyron.dk")).toBe(false);
  });

  it("SHIP-AC1a-b6: 'mylife.alnyron.dk' → false", () => {
    expect(isMonitorHost("mylife.alnyron.dk")).toBe(false);
  });

  it("SHIP-AC1a-b7: 'localhost:3000' → false", () => {
    expect(isMonitorHost("localhost:3000")).toBe(false);
  });
});

// ── monitorSiteOrigin — mappings ──────────────────────────────────────────────

describe("monitorSiteOrigin — SHIP-AC2a: builds monitor subdomain from site URL", () => {
  it("SHIP-AC2a-s1: 'https://alnyron.dk' → 'https://monitor.alnyron.dk'", () => {
    expect(monitorSiteOrigin("https://alnyron.dk")).toBe("https://monitor.alnyron.dk");
  });

  it("SHIP-AC2a-s2: 'http://localhost:3000' → 'http://monitor.localhost:3000'", () => {
    expect(monitorSiteOrigin("http://localhost:3000")).toBe("http://monitor.localhost:3000");
  });
});

// ── monitorSiteOrigin — throws for non-round-trippable URLs ──────────────────

describe("monitorSiteOrigin — SHIP-AC2a: throws when result is not a Monitor host", () => {
  it("SHIP-AC2a-s3: 'https://www.alnyron.dk' throws — derived host not in Monitor allowlist", () => {
    // The implementation should throw a descriptive Error (not a plain TypeError).
    // The pattern below matches the expected message shape and is not satisfied by "not a function".
    expect(() => monitorSiteOrigin("https://www.alnyron.dk")).toThrow(/does not map to a Monitor host/i);
  });

  it("SHIP-AC2a-s4: 'https://evil.com' throws — derived host not in Monitor allowlist", () => {
    expect(() => monitorSiteOrigin("https://evil.com")).toThrow(/does not map to a Monitor host/i);
  });

  it("SHIP-AC2a-s5: 'https://alnyron.dk.evil.com' throws — look-alike site URL rejected", () => {
    expect(() => monitorSiteOrigin("https://alnyron.dk.evil.com")).toThrow(/does not map to a Monitor host/i);
  });

  it("SHIP-AC2a-s6: 'http://alnyron.dk' throws — the production Monitor host is served over https only", () => {
    expect(() => monitorSiteOrigin("http://alnyron.dk")).toThrow(/does not map to a Monitor host/i);
  });

  it("SHIP-AC2a-s7: 'https://localhost:3000' throws — the local Monitor host is served over http only", () => {
    expect(() => monitorSiteOrigin("https://localhost:3000")).toThrow(/does not map to a Monitor host/i);
  });

  it("SHIP-AC2a-s8: 'http://alnyron.dk:443' throws — the port does not round-trip (443 is the https default)", () => {
    expect(() => monitorSiteOrigin("http://alnyron.dk:443")).toThrow(/does not map to a Monitor host/i);
  });
});
