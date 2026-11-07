/**
 * Unit tests: src/lib/monitor/url-guard.ts — checkMonitorUrl SSRF guard
 * Journey: monitor-web-area  MON-AC28, MON-AC29, MON-AC30, MON-AC31
 *
 * Covers every rejection reason class the contract specifies:
 *   "invalid"       — not parseable as a URL, or missing scheme, or whitespace/<>"
 *   "scheme"        — not http or https
 *   "credentials"   — userinfo in the URL
 *   "port"          — non-standard port (not none/80/443)
 *   "blocked_host"  — private/loopback/link-local/CGNAT/0/multicast/reserved,
 *                     IPv6 private, single-label, *.local, *.internal,
 *                     *.home.arpa, metadata.google.internal, decimal/octal/hex
 *                     IPv4 that normalises to a blocked range
 *   "too_long"      — raw string > 2048 characters
 */
import { describe, expect, it } from "vitest";
import { checkMonitorUrl } from "@/lib/monitor/url-guard";

// ── Accepted URLs ─────────────────────────────────────────────────────────────

describe("checkMonitorUrl — MON-AC27: accepted URLs", () => {
  it("MON-AC27a: accepts a plain https URL", () => {
    expect(checkMonitorUrl("https://example.com/")).toEqual({ ok: true, url: "https://example.com/" });
  });

  it("MON-AC27b: accepts a plain http URL", () => {
    expect(checkMonitorUrl("http://example.com/")).toEqual({ ok: true, url: "http://example.com/" });
  });

  it("MON-AC27c: accepts https with path, query, and fragment", () => {
    expect(checkMonitorUrl("https://example.com/path?q=1&r=%20#frag")).toMatchObject({ ok: true });
  });

  it("MON-AC27d: accepts URL of exactly 2048 characters", () => {
    const url = `https://example.com/${"a".repeat(2028)}`;
    expect(url.length).toBe(2048);
    expect(checkMonitorUrl(url)).toMatchObject({ ok: true });
  });

  it("MON-AC27e: accepts https on port 443 (standard)", () => {
    expect(checkMonitorUrl("https://example.com:443/")).toMatchObject({ ok: true });
  });

  it("MON-AC27f: accepts http on port 80 (standard)", () => {
    expect(checkMonitorUrl("http://example.com:80/")).toMatchObject({ ok: true });
  });

  it("MON-AC27g: accepts a public multi-label domain", () => {
    expect(checkMonitorUrl("https://sub.example.co.uk/page")).toMatchObject({ ok: true });
  });
});

// ── Too long: MON-AC31 ───────────────────────────────────────────────────────

describe("checkMonitorUrl — MON-AC31: too_long", () => {
  it("MON-AC31a: rejects URL of 2049 characters", () => {
    const url = `https://example.com/${"a".repeat(2029)}`;
    expect(url.length).toBe(2049);
    expect(checkMonitorUrl(url)).toEqual({ ok: false, reason: "too_long" });
  });

  it("MON-AC31b: rejects URL of 3000 characters", () => {
    const url = `https://example.com/${"a".repeat(2980)}`;
    expect(checkMonitorUrl(url)).toEqual({ ok: false, reason: "too_long" });
  });
});

// ── Invalid / scheme: MON-AC28 ───────────────────────────────────────────────

describe("checkMonitorUrl — MON-AC28: invalid / wrong scheme", () => {
  it("MON-AC28a: rejects ftp:// scheme", () => {
    expect(checkMonitorUrl("ftp://example.com/")).toEqual({ ok: false, reason: "scheme" });
  });

  it("MON-AC28b: rejects javascript: URI", () => {
    const result = checkMonitorUrl("javascript:alert(1)");
    expect(result.ok).toBe(false);
  });

  it("MON-AC28c: rejects plain string without scheme", () => {
    expect(checkMonitorUrl("example.com/page")).toMatchObject({ ok: false });
  });

  it("MON-AC28d: rejects empty string", () => {
    expect(checkMonitorUrl("")).toMatchObject({ ok: false });
  });

  it("MON-AC28e: rejects URL with whitespace", () => {
    expect(checkMonitorUrl("https://example.com/pa th")).toMatchObject({ ok: false });
  });

  it("MON-AC28f: rejects URL containing <", () => {
    expect(checkMonitorUrl("https://example.com/<tag>")).toMatchObject({ ok: false });
  });

  it('MON-AC28g: rejects URL containing "', () => {
    expect(checkMonitorUrl('https://example.com/"path"')).toMatchObject({ ok: false });
  });
});

// ── Credentials (userinfo): MON-AC29 ─────────────────────────────────────────

describe("checkMonitorUrl — MON-AC29: credentials in URL", () => {
  it("MON-AC29a: rejects user:pass@host", () => {
    expect(checkMonitorUrl("https://user:pass@example.com/")).toEqual({ ok: false, reason: "credentials" });
  });

  it("MON-AC29b: rejects user@host (no password)", () => {
    expect(checkMonitorUrl("https://user@example.com/")).toEqual({ ok: false, reason: "credentials" });
  });
});

// ── Non-standard port: MON-AC30 ──────────────────────────────────────────────

describe("checkMonitorUrl — MON-AC30: non-standard port", () => {
  it("MON-AC30a: rejects https on port 8443", () => {
    expect(checkMonitorUrl("https://example.com:8443/")).toEqual({ ok: false, reason: "port" });
  });

  it("MON-AC30b: rejects http on port 8080", () => {
    expect(checkMonitorUrl("http://example.com:8080/")).toEqual({ ok: false, reason: "port" });
  });

  it("MON-AC30c: rejects http on port 3000", () => {
    expect(checkMonitorUrl("http://example.com:3000/")).toEqual({ ok: false, reason: "port" });
  });
});

// ── Blocked hosts — loopback / localhost: MON-AC28 ───────────────────────────

describe("checkMonitorUrl — MON-AC28: blocked loopback/localhost hosts", () => {
  it("MON-AC28h: rejects http://localhost/", () => {
    expect(checkMonitorUrl("http://localhost/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28i: rejects http://localhost.localdomain/", () => {
    expect(checkMonitorUrl("http://localhost.localdomain/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28j: rejects single-label host http://intranet/", () => {
    expect(checkMonitorUrl("http://intranet/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28k: rejects *.localhost (sub.localhost)", () => {
    expect(checkMonitorUrl("http://sub.localhost/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28l: rejects *.local (host.local)", () => {
    expect(checkMonitorUrl("http://host.local/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28m: rejects *.internal (host.internal)", () => {
    expect(checkMonitorUrl("http://host.internal/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28n: rejects *.home.arpa", () => {
    expect(checkMonitorUrl("http://host.home.arpa/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28o: rejects metadata.google.internal", () => {
    expect(checkMonitorUrl("http://metadata.google.internal/")).toEqual({ ok: false, reason: "blocked_host" });
  });
});

// ── Blocked hosts — IPv4 loopback / private: MON-AC28 ────────────────────────

describe("checkMonitorUrl — MON-AC28: blocked IPv4 addresses (decimal)", () => {
  it("MON-AC28p: rejects loopback 127.0.0.1", () => {
    expect(checkMonitorUrl("http://127.0.0.1/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28q: rejects 127.0.0.255 (loopback range)", () => {
    expect(checkMonitorUrl("http://127.0.0.255/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28r: rejects 10.0.0.1 (private 10/8)", () => {
    expect(checkMonitorUrl("http://10.0.0.1/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28s: rejects 172.16.0.1 (private 172.16/12)", () => {
    expect(checkMonitorUrl("http://172.16.0.1/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28t: rejects 172.31.255.255 (private 172.16/12 edge)", () => {
    expect(checkMonitorUrl("http://172.31.255.255/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28u: rejects 192.168.1.1 (private 192.168/16)", () => {
    expect(checkMonitorUrl("http://192.168.1.1/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28v: rejects 169.254.169.254 (AWS metadata / link-local)", () => {
    expect(checkMonitorUrl("http://169.254.169.254/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28w: rejects 169.254.0.1 (link-local 169.254/16)", () => {
    expect(checkMonitorUrl("http://169.254.0.1/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28x: rejects 100.64.0.1 (CGNAT 100.64/10)", () => {
    expect(checkMonitorUrl("http://100.64.0.1/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28y: rejects 0.0.0.1 (0/8 range)", () => {
    expect(checkMonitorUrl("http://0.0.0.1/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28z: rejects 224.0.0.1 (multicast 224/4)", () => {
    expect(checkMonitorUrl("http://224.0.0.1/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28z1: rejects 240.0.0.1 (reserved 240/4)", () => {
    expect(checkMonitorUrl("http://240.0.0.1/")).toEqual({ ok: false, reason: "blocked_host" });
  });
});

// ── Blocked hosts — octal/hex/decimal IPv4 normalisation: MON-AC28 ───────────

describe("checkMonitorUrl — MON-AC28: octal/hex IPv4 normalisation to private ranges", () => {
  it("MON-AC28hex1: rejects hex 0x7f000001 (127.0.0.1)", () => {
    // WHATWG URL normalises 0x7f000001 → 127.0.0.1
    expect(checkMonitorUrl("http://0x7f000001/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28hex2: rejects hex 0xc0a80101 (192.168.1.1)", () => {
    expect(checkMonitorUrl("http://0xc0a80101/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28oct1: rejects octal 0177.0.0.1 (127.0.0.1)", () => {
    expect(checkMonitorUrl("http://0177.0.0.1/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28dec1: rejects decimal 2130706433 (127.0.0.1)", () => {
    expect(checkMonitorUrl("http://2130706433/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28dec2: rejects decimal 3232235521 (192.168.1.1)", () => {
    expect(checkMonitorUrl("http://3232235521/")).toEqual({ ok: false, reason: "blocked_host" });
  });
});

// ── Blocked hosts — IPv6: MON-AC28 ───────────────────────────────────────────

describe("checkMonitorUrl — MON-AC28: blocked IPv6 addresses", () => {
  it("MON-AC28ipv6a: rejects [::1] (loopback)", () => {
    expect(checkMonitorUrl("http://[::1]/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28ipv6b: rejects [::] (unspecified)", () => {
    expect(checkMonitorUrl("http://[::]/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28ipv6c: rejects [fc00::1] (fc00::/7 unique-local)", () => {
    expect(checkMonitorUrl("http://[fc00::1]/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28ipv6d: rejects [fd00::1] (fc00::/7 unique-local)", () => {
    expect(checkMonitorUrl("http://[fd00::1]/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28ipv6e: rejects [fe80::1] (fe80::/10 link-local)", () => {
    expect(checkMonitorUrl("http://[fe80::1]/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28ipv6f: rejects IPv4-mapped ::ffff:127.0.0.1", () => {
    expect(checkMonitorUrl("http://[::ffff:127.0.0.1]/")).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("MON-AC28ipv6g: rejects IPv4-mapped ::ffff:192.168.1.1", () => {
    expect(checkMonitorUrl("http://[::ffff:192.168.1.1]/")).toEqual({ ok: false, reason: "blocked_host" });
  });
});
