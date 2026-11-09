/**
 * Unit tests: src/lib/host-origin.ts
 * Journey: monitor-ship-routing  SHIP-AC1a..SHIP-AC2f (shared helper)
 *
 * Verifies:
 *   allowlistedOrigin(host, schemes) — the shared HOST_PATTERN + origin builder
 *   extracted from config/mylife.ts so both myLifeOrigin and monitorOrigin
 *   use the same logic.
 *
 *   - Case-insensitive hostname lookup
 *   - Trailing FQDN dot accepted, double dot rejected
 *   - Default port dropped, non-default port kept
 *   - Look-alike hostnames rejected (subdomain prefix, suffix, @ injection)
 *   - null input → null
 *   - myLifeOrigin / isMyLifeHost keep identical behavior via allowlistedOrigin
 */
import { describe, expect, it } from "vitest";
import { allowlistedOrigin, type HostSchemes } from "@/lib/host-origin";
import { myLifeOrigin, isMyLifeHost } from "@/config/mylife";

// ── Fixture schemes ───────────────────────────────────────────────────────────

const TEST_SCHEMES: HostSchemes = {
  "example.alnyron.dk": "https",
  "example.localhost": "http",
};

// ── allowlistedOrigin — basic lookup ─────────────────────────────────────────

describe("allowlistedOrigin — SHIP-AC1a: basic origin building", () => {
  it("SHIP-AC1a-1: returns https origin for a known HTTPS host", () => {
    expect(allowlistedOrigin("example.alnyron.dk", TEST_SCHEMES)).toBe(
      "https://example.alnyron.dk",
    );
  });

  it("SHIP-AC1a-2: returns http origin for a known HTTP host", () => {
    expect(allowlistedOrigin("example.localhost", TEST_SCHEMES)).toBe(
      "http://example.localhost",
    );
  });

  it("SHIP-AC1a-3: returns null for an unknown hostname", () => {
    expect(allowlistedOrigin("unknown.alnyron.dk", TEST_SCHEMES)).toBeNull();
  });

  it("SHIP-AC1a-4: returns null for null input", () => {
    expect(allowlistedOrigin(null, TEST_SCHEMES)).toBeNull();
  });
});

// ── allowlistedOrigin — case-insensitive ────────────────────────────────────

describe("allowlistedOrigin — SHIP-AC1a: case-insensitive hostname", () => {
  it("SHIP-AC1a-5: uppercase host matches", () => {
    expect(allowlistedOrigin("EXAMPLE.ALNYRON.DK", TEST_SCHEMES)).toBe(
      "https://example.alnyron.dk",
    );
  });

  it("SHIP-AC1a-6: mixed-case host matches", () => {
    expect(allowlistedOrigin("Example.Localhost", TEST_SCHEMES)).toBe(
      "http://example.localhost",
    );
  });
});

// ── allowlistedOrigin — trailing FQDN dot ───────────────────────────────────

describe("allowlistedOrigin — SHIP-AC1a: trailing FQDN dot", () => {
  it("SHIP-AC1a-7: single trailing dot accepted; dot dropped from origin", () => {
    expect(allowlistedOrigin("example.alnyron.dk.", TEST_SCHEMES)).toBe(
      "https://example.alnyron.dk",
    );
  });

  it("SHIP-AC1a-8: double trailing dot rejected", () => {
    expect(allowlistedOrigin("example.alnyron.dk..", TEST_SCHEMES)).toBeNull();
  });
});

// ── allowlistedOrigin — port handling ────────────────────────────────────────

describe("allowlistedOrigin — SHIP-AC1a: port handling", () => {
  it("SHIP-AC1a-9: default HTTPS port (443) is dropped", () => {
    expect(allowlistedOrigin("example.alnyron.dk:443", TEST_SCHEMES)).toBe(
      "https://example.alnyron.dk",
    );
  });

  it("SHIP-AC1a-10: default HTTP port (80) is dropped", () => {
    expect(allowlistedOrigin("example.localhost:80", TEST_SCHEMES)).toBe(
      "http://example.localhost",
    );
  });

  it("SHIP-AC1a-11: non-default port 3000 is kept", () => {
    expect(allowlistedOrigin("example.localhost:3000", TEST_SCHEMES)).toBe(
      "http://example.localhost:3000",
    );
  });

  it("SHIP-AC1a-12: non-default port 8443 on HTTPS is kept", () => {
    expect(allowlistedOrigin("example.alnyron.dk:8443", TEST_SCHEMES)).toBe(
      "https://example.alnyron.dk:8443",
    );
  });
});

// ── allowlistedOrigin — look-alike hostnames rejected ───────────────────────

describe("allowlistedOrigin — SHIP-AC1a: look-alike rejection", () => {
  it("SHIP-AC1a-13: subdomain of known host (prefix) → null", () => {
    // evil.example.alnyron.dk is not in the allowlist
    expect(allowlistedOrigin("evil.example.alnyron.dk", TEST_SCHEMES)).toBeNull();
  });

  it("SHIP-AC1a-14: known host as a subdomain of attacker domain → null", () => {
    // example.alnyron.dk.evil.com
    expect(allowlistedOrigin("example.alnyron.dk.evil.com", TEST_SCHEMES)).toBeNull();
  });

  it("SHIP-AC1a-15: known hostname prefixed (evilexample.alnyron.dk) → null", () => {
    expect(allowlistedOrigin("evilexample.alnyron.dk", TEST_SCHEMES)).toBeNull();
  });

  it("SHIP-AC1a-16: @ injection attempt → null", () => {
    expect(allowlistedOrigin("example.alnyron.dk@evil.com", TEST_SCHEMES)).toBeNull();
  });
});

// ── myLifeOrigin parity ───────────────────────────────────────────────────────
// These tests prove myLifeOrigin keeps identical behavior when implemented via
// allowlistedOrigin (they mirror the mylife.ts unit tests in config/monitor-host.test.ts).

describe("myLifeOrigin — SHIP-AC1a: parity after allowlistedOrigin refactor", () => {
  it("myLifeOrigin('mylife.alnyron.dk') = https://mylife.alnyron.dk", () => {
    expect(myLifeOrigin("mylife.alnyron.dk")).toBe("https://mylife.alnyron.dk");
  });

  it("myLifeOrigin('mylife.localhost') = http://mylife.localhost", () => {
    expect(myLifeOrigin("mylife.localhost")).toBe("http://mylife.localhost");
  });

  it("myLifeOrigin('mylife.localhost:3000') = http://mylife.localhost:3000", () => {
    expect(myLifeOrigin("mylife.localhost:3000")).toBe("http://mylife.localhost:3000");
  });

  it("myLifeOrigin('mylife.alnyron.dk:443') drops default port", () => {
    expect(myLifeOrigin("mylife.alnyron.dk:443")).toBe("https://mylife.alnyron.dk");
  });

  it("myLifeOrigin(null) = null", () => {
    expect(myLifeOrigin(null)).toBeNull();
  });

  it("myLifeOrigin('alnyron.dk') = null", () => {
    expect(myLifeOrigin("alnyron.dk")).toBeNull();
  });

  it("isMyLifeHost('mylife.alnyron.dk') = true", () => {
    expect(isMyLifeHost("mylife.alnyron.dk")).toBe(true);
  });

  it("isMyLifeHost('mylife.localhost') = true", () => {
    expect(isMyLifeHost("mylife.localhost")).toBe(true);
  });

  it("isMyLifeHost(null) = false", () => {
    expect(isMyLifeHost(null)).toBe(false);
  });

  it("isMyLifeHost('alnyron.dk') = false", () => {
    expect(isMyLifeHost("alnyron.dk")).toBe(false);
  });
});
