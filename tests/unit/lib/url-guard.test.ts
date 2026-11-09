/**
 * Unit tests: src/lib/monitor/url-guard.ts — checkMonitorUrl SSRF guard and isBlockedAddress
 * Journey: monitor-web-area  MON-AC27–MON-AC31; monitor-engine  ENG-AC5
 *
 * checkMonitorUrl: accepted URLs and every rejection reason class the contract specifies:
 *   "invalid"       — not parseable as a URL, or missing scheme, or whitespace/<>"
 *   "scheme"        — not http or https
 *   "credentials"   — userinfo in the URL
 *   "port"          — non-standard port (not none/80/443)
 *   "blocked_host"  — private/loopback/link-local/CGNAT/0/multicast/reserved,
 *                     IPv6 private, single-label, *.local, *.internal,
 *                     *.home.arpa, metadata.google.internal, decimal/octal/hex
 *                     IPv4 that normalises to a blocked range
 *   "too_long"      — raw string > 2048 characters
 *
 * isBlockedAddress (a bare IPv4/IPv6 address from a DoH answer): blocked private,
 *   loopback, link-local, CGNAT, multicast and reserved ranges (IPv4-mapped too),
 *   public addresses allowed, both edges of every blocked IPv4 range and IPv6
 *   prefix, the IPv6 allowlist (2000::/3 minus 2001::/23 incl. Teredo and
 *   ORCHIDv2, 2001:db8::/32, 3fff::/20, 6to4 by its IPv4; 5f00::/16 and
 *   IPv4-compatible blocked; IPv4-mapped, IPv4-translated and NAT64 by their
 *   IPv4) on both sides, where the neighbours of the three IPv4-carrying forms
 *   (and the local-use NAT64 64:ff9b:1::/48) embed the public IPv4 8.8.8.8, so
 *   only their prefix can block them and a too-wide prefix match would let them
 *   through; the same allowlist through checkMonitorUrl, parser limits, and
 *   fail-closed for anything unparsable.
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

// ── isBlockedAddress — ENG-AC5 ───────────────────────────────────────────────
// isBlockedAddress is a new export added in the same file by this slice.
import { isBlockedAddress } from "@/lib/monitor/url-guard";

describe("isBlockedAddress — ENG-AC5: IPv4 private/loopback/link-local/CGNAT blocked", () => {
  it("ENG-AC5ip1: 127.0.0.1 (loopback) is blocked", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
  });

  it("ENG-AC5ip2: 10.0.0.1 (private 10/8) is blocked", () => {
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
  });

  it("ENG-AC5ip3: 192.168.1.1 (private 192.168/16) is blocked", () => {
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
  });

  it("ENG-AC5ip4: 172.16.0.1 (private 172.16/12) is blocked", () => {
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
  });

  it("ENG-AC5ip5: 169.254.169.254 (link-local / AWS metadata) is blocked", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it("ENG-AC5ip6: 100.64.0.1 (CGNAT 100.64/10) is blocked", () => {
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
  });

  it("ENG-AC5ip7: 0.0.0.1 (0/8 this-network) is blocked", () => {
    expect(isBlockedAddress("0.0.0.1")).toBe(true);
  });

  it("ENG-AC5ip8: 224.0.0.1 (multicast 224/4) is blocked", () => {
    expect(isBlockedAddress("224.0.0.1")).toBe(true);
  });
});

describe("isBlockedAddress — ENG-AC5: IPv6 blocked ranges (bare, no brackets)", () => {
  it("ENG-AC5ip9: ::1 (loopback) is blocked", () => {
    expect(isBlockedAddress("::1")).toBe(true);
  });

  it("ENG-AC5ip10: fc00::1 (unique-local fc00::/7) is blocked", () => {
    expect(isBlockedAddress("fc00::1")).toBe(true);
  });

  it("ENG-AC5ip11: fe80::1 (link-local fe80::/10) is blocked", () => {
    expect(isBlockedAddress("fe80::1")).toBe(true);
  });

  it("ENG-AC5ip12: ::ffff:10.0.0.1 (IPv4-mapped private) is blocked", () => {
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
  });

  it("ENG-AC5ip13: fd00::1 (unique-local fd00::/8 ⊂ fc00::/7) is blocked", () => {
    expect(isBlockedAddress("fd00::1")).toBe(true);
  });
});

describe("isBlockedAddress — ENG-AC5: public addresses are allowed", () => {
  it("ENG-AC5ip14: 93.184.215.14 (example.com public IPv4) is allowed", () => {
    expect(isBlockedAddress("93.184.215.14")).toBe(false);
  });

  it("ENG-AC5ip15: 2606:4700::1111 (Cloudflare public IPv6) is allowed", () => {
    expect(isBlockedAddress("2606:4700::1111")).toBe(false);
  });

  it("ENG-AC5ip20: 2606:4700:0:0:0:0:0:1111 (uncompressed, eight groups) is allowed", () => {
    expect(isBlockedAddress("2606:4700:0:0:0:0:0:1111")).toBe(false);
  });

  it("ENG-AC5ip21: ::ffff:8.8.8.8 (IPv4-mapped public, dotted tail) is allowed", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("ENG-AC5ip22: ::FFFF:8.8.8.8 (upper-case hex) is allowed", () => {
    expect(isBlockedAddress("::FFFF:8.8.8.8")).toBe(false);
  });

  it("ENG-AC5ip23: ::ffff:808:808 (IPv4-mapped public, hex tail = 8.8.8.8) is allowed", () => {
    expect(isBlockedAddress("::ffff:808:808")).toBe(false);
  });

  it("ENG-AC5ip31: 64:ff9b::808:808 (NAT64 of public 8.8.8.8) is allowed", () => {
    expect(isBlockedAddress("64:ff9b::808:808")).toBe(false);
  });

  it("ENG-AC5ip32: 2001:4860::8888 (public 2001::/16 outside 2001:db8::/32) is allowed", () => {
    expect(isBlockedAddress("2001:4860::8888")).toBe(false);
  });
});

// Each of these parses (the allowed twins above prove the same notation is read), so they are
// blocked by their range, not by the fail-closed fallback.
describe("isBlockedAddress — ENG-AC5: parsed addresses blocked by their range", () => {
  it("ENG-AC5ip24: ::ffff:a00:1 (IPv4-mapped hex tail = 10.0.0.1) is blocked", () => {
    expect(isBlockedAddress("::ffff:a00:1")).toBe(true);
  });

  it("ENG-AC5ip25: 64:ff9b::a00:1 (NAT64 of 10.0.0.1) is blocked", () => {
    expect(isBlockedAddress("64:ff9b::a00:1")).toBe(true);
  });

  it("ENG-AC5ip26: :: (unspecified) is blocked", () => {
    expect(isBlockedAddress("::")).toBe(true);
  });

  it("ENG-AC5ip27: 2001:db8::1 (documentation 2001:db8::/32) is blocked", () => {
    expect(isBlockedAddress("2001:db8::1")).toBe(true);
  });
});

describe("isBlockedAddress — ENG-AC5: unparsable input is blocked (fail-closed)", () => {
  it("ENG-AC5ip16: empty string is blocked", () => {
    expect(isBlockedAddress("")).toBe(true);
  });

  it("ENG-AC5ip17: hostname string (not an IP) is blocked", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
  });

  it("ENG-AC5ip18: bracketed [2606:4700::1111] is blocked although the bare address is allowed (no bracket stripping)", () => {
    // isBlockedAddress expects bare IPs (no brackets); brackets → unparsable → blocked
    expect(isBlockedAddress("2606:4700::1111")).toBe(false);
    expect(isBlockedAddress("[2606:4700::1111]")).toBe(true);
  });

  it("ENG-AC5ip19: garbage string is blocked", () => {
    expect(isBlockedAddress("not-an-ip-address")).toBe(true);
  });

  it("ENG-AC5ip28: two '::' (1::2::3) is blocked", () => {
    expect(isBlockedAddress("1::2::3")).toBe(true);
  });

  it("ENG-AC5ip29: a five-digit group (12345::1) is blocked", () => {
    expect(isBlockedAddress("12345::1")).toBe(true);
  });

  it("ENG-AC5ip30: nine groups (1:2:3:4:5:6:7:8:9) is blocked", () => {
    expect(isBlockedAddress("1:2:3:4:5:6:7:8:9")).toBe(true);
  });
});

// Both sides of every blocked IPv4 range: its first and last address are blocked,
// the public addresses just outside it are allowed.
describe("isBlockedAddress — ENG-AC5: both edges of every blocked IPv4 range", () => {
  it.each<[address: string, blocked: boolean]>([
    // 0.0.0.0/8
    ["0.0.0.0", true], ["0.255.255.255", true], ["1.0.0.0", false],
    // 10.0.0.0/8
    ["9.255.255.255", false], ["10.0.0.0", true], ["10.255.255.255", true], ["11.0.0.0", false],
    // 100.64.0.0/10
    ["100.63.255.255", false], ["100.64.0.0", true], ["100.127.255.255", true], ["100.128.0.0", false],
    // 127.0.0.0/8
    ["126.255.255.255", false], ["127.0.0.0", true], ["127.255.255.255", true], ["128.0.0.0", false],
    // 169.254.0.0/16
    ["169.253.255.255", false], ["169.254.0.0", true], ["169.254.255.255", true], ["169.255.0.0", false],
    // 172.16.0.0/12
    ["172.15.255.255", false], ["172.16.0.0", true], ["172.31.255.255", true], ["172.32.0.0", false],
    // 192.0.0.0/24
    ["191.255.255.255", false], ["192.0.0.0", true], ["192.0.0.255", true], ["192.0.1.0", false],
    // 192.0.2.0/24
    ["192.0.1.255", false], ["192.0.2.0", true], ["192.0.2.255", true], ["192.0.3.0", false],
    // 192.168.0.0/16
    ["192.167.255.255", false], ["192.168.0.0", true], ["192.168.255.255", true], ["192.169.0.0", false],
    // 198.18.0.0/15
    ["198.17.255.255", false], ["198.18.0.0", true], ["198.19.255.255", true], ["198.20.0.0", false],
    // 198.51.100.0/24
    ["198.51.99.255", false], ["198.51.100.0", true], ["198.51.100.255", true], ["198.51.101.0", false],
    // 203.0.113.0/24
    ["203.0.112.255", false], ["203.0.113.0", true], ["203.0.113.255", true], ["203.0.114.0", false],
    // 224.0.0.0/4 and 240.0.0.0/4 (multicast, reserved, broadcast) up to the last address
    ["223.255.255.255", false], ["224.0.0.0", true], ["239.255.255.255", true], ["240.0.0.0", true], ["255.255.255.255", true],
  ])("ENG-AC5ip33: %s → blocked %s", (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });
});

// IPv6 prefixes outside global unicast: first and last address blocked (everything outside
// 2000::/3 is blocked, ENG-AC5ip37). 2001:db8::/32 lies inside 2000::/3, so its neighbours are
// public and allowed.
describe("isBlockedAddress — ENG-AC5: both edges of every blocked IPv6 prefix", () => {
  it.each<[address: string, blocked: boolean]>([
    // fc00::/7
    ["fc00::", true], ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true],
    // fe80::/10
    ["fe80::", true], ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true],
    // fec0::/10
    ["fec0::", true], ["feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true],
    // ff00::/8
    ["ff00::", true], ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true],
    // 100::/64
    ["100::", true], ["100::ffff:ffff:ffff:ffff", true],
    // 64:ff9b:1::/48 (local-use NAT64; with a public IPv4 inside: ENG-AC5ip37)
    ["64:ff9b:1::", true], ["64:ff9b:1:ffff:ffff:ffff:ffff:ffff", true],
    // 2001:db8::/32
    ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2001:db8::", true],
    ["2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2001:db9::", false],
  ])("ENG-AC5ip34: %s → blocked %s", (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });
});

// The IPv6 allowlist (security round 1, S5): only global unicast 2000::/3 passes, minus its
// special-purpose blocks; outside it only the IPv4-mapped, IPv4-translated and well-known NAT64
// forms pass, judged by their embedded IPv4 address. Each range on both sides.
describe("isBlockedAddress — ENG-AC5: IPv6 allowlist, every range on both sides", () => {
  it.each<[address: string, blocked: boolean]>([
    // 2000::/3 (global unicast): just below, first, last, just above
    ["1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2000::", false],
    ["3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["4000::", true],
    // 2001::/23 (IETF protocol assignments): just below, first, last, just above
    ["2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2001::", true],
    ["2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2001:200::", false],
    // Teredo 2001::/32 (a real Teredo address, its last address, the next /32 still in 2001::/23)
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", true], ["2001:0:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2001:1::", true],
    // ORCHIDv2 2001:20::/28 (first and last; both neighbours are inside 2001::/23)
    ["2001:1f:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2001:20::", true],
    ["2001:2f:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2001:30::", true],
    // 6to4 2002::/16, judged by the IPv4 address in groups 2–3: neighbours, public and blocked IPv4
    ["2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2002:808:808::1", false],
    ["2002::", true], ["2002:7f00:1::", true], ["2002:a00:1::", true],
    ["2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2003::", false],
    // 3fff::/20 (documentation): just below, first, last, just above
    ["3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["3fff::", true],
    ["3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["3fff:1000::", false],
    // 5f00::/16 (SRv6 SIDs) lies outside 2000::/3: it and both neighbours are blocked
    ["5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["5f00::", true],
    ["5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["5f01::", true],
    // IPv4-mapped ::ffff:0:0/96: public and blocked IPv4; the /96 just below and just above it,
    // each with the public 8.8.8.8 (blocked: only the prefix can make them so)
    ["::ffff:8.8.8.8", false], ["::ffff:808:808", false], ["::ffff:127.0.0.1", true],
    ["::fffe:808:808", true], ["::1:0:808:808", true],
    // IPv4-translated ::ffff:0:0:0/96: public and blocked IPv4 (hex and dotted); the /96 just
    // below and just above it with 8.8.8.8
    ["::ffff:0:808:808", false], ["::ffff:0:8.8.8.8", false], ["::ffff:0:7f00:1", true],
    ["::ffff:0:127.0.0.1", true], ["::ffff:0:a00:1", true],
    ["::fffe:ffff:808:808", true], ["::ffff:1:808:808", true],
    // IPv4-compatible ::/96 (deprecated) is outside 2000::/3: blocked even for a public IPv4
    ["::8.8.8.8", true], ["::808:808", true],
    // Well-known NAT64 64:ff9b::/96, judged by its IPv4 address (not blocked outright): public and
    // blocked IPv4; with 8.8.8.8 the /96 just below and just above it, the same /96 position one
    // second group lower, and the local-use 64:ff9b:1::/48
    ["64:ff9b::808:808", false], ["64:ff9b::7f00:1", true],
    ["64:ff9a:ffff:ffff:ffff:ffff:808:808", true], ["64:ff9b::1:808:808", true],
    ["64:ff9a::808:808", true], ["64:ff9b:1::808:808", true],
  ])("ENG-AC5ip37: %s → blocked %s", (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it.each<[url: string, ok: boolean]>([
    ["http://[::ffff:0:7f00:1]/", false],
    ["http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", false],
    ["http://[3fff::1]/", false],
    ["http://[5f00::1]/", false],
    ["http://[::8.8.8.8]/", false],
    ["http://[2002:808:808::1]/", true],
    ["http://[2001:200::1]/", true],
  ])("ENG-AC5ip38: checkMonitorUrl(%s) shares the allowlist → ok %s", (url, ok) => {
    expect(checkMonitorUrl(url).ok).toBe(ok);
  });
});

describe("isBlockedAddress — ENG-AC5: parser limits on both sides", () => {
  it("ENG-AC5ip35: an octet of 255 parses (public 8.8.8.255 allowed); 256 does not (blocked)", () => {
    expect(isBlockedAddress("8.8.8.255")).toBe(false);
    expect(isBlockedAddress("8.8.8.256")).toBe(true);
  });

  it("ENG-AC5ip36: '::' standing for one zero group parses; '::' beside eight groups does not (blocked)", () => {
    expect(isBlockedAddress("2606:4700:0:0:0:0::1111")).toBe(false);
    expect(isBlockedAddress("2606:4700:0:0:0:0:0::1111")).toBe(true);
  });
});
