import { MONITOR_URL_MAX_LENGTH } from "@/config/monitor";

/** Why {@link checkMonitorUrl} refused a URL. */
export type MonitorUrlRejection = "invalid" | "scheme" | "credentials" | "port" | "blocked_host" | "too_long";

export type MonitorUrlCheck = { ok: true; url: string } | { ok: false; reason: MonitorUrlRejection };

/** Characters `monitors.url` refuses (its CHECK: `^https?://[^[:space:]<>"]+$`). */
const FORBIDDEN_CHARACTERS = /[\s<>"]/;

/**
 * Name suffixes that never lead to a public website: special-use and
 * private-network names (RFC 6761, RFC 6762 `.local`, RFC 8375 `.home.arpa`,
 * the `.internal` private-use TLD that also holds `metadata.google.internal`)
 * and the common LAN suffixes `localdomain` and `lan`.
 */
const BLOCKED_NAME_SUFFIXES = ["localhost", "localdomain", "local", "internal", "home.arpa", "lan", "invalid", "test"];

/** An IPv4 address (four octets) as an unsigned 32-bit number. */
function ipv4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** An IPv4 range as [first address as a 32-bit number, prefix length 1..32]. */
type Ipv4Range = readonly [base: number, prefix: number];

/**
 * IPv4 ranges that are not public unicast (IANA special-purpose registry):
 * "this network", private, CGNAT, loopback, link-local (cloud metadata at
 * 169.254.169.254), IETF protocol assignments, documentation, benchmarking,
 * multicast and reserved (incl. broadcast).
 */
const BLOCKED_IPV4: readonly Ipv4Range[] = [
  [ipv4(0, 0, 0, 0), 8],
  [ipv4(10, 0, 0, 0), 8],
  [ipv4(100, 64, 0, 0), 10],
  [ipv4(127, 0, 0, 0), 8],
  [ipv4(169, 254, 0, 0), 16],
  [ipv4(172, 16, 0, 0), 12],
  [ipv4(192, 0, 0, 0), 24],
  [ipv4(192, 0, 2, 0), 24],
  [ipv4(192, 168, 0, 0), 16],
  [ipv4(198, 18, 0, 0), 15],
  [ipv4(198, 51, 100, 0), 24],
  [ipv4(203, 0, 113, 0), 24],
  [ipv4(224, 0, 0, 0), 4],
  [ipv4(240, 0, 0, 0), 4],
];

function isBlockedIpv4(address: number): boolean {
  return BLOCKED_IPV4.some(([base, prefix]) => ((address & (0xffffffff << (32 - prefix))) >>> 0) === base);
}

/**
 * A dotted quad (four decimal octets 0..255) as a 32-bit number, or null. The
 * WHATWG parser has already turned a hostname's hex, octal and decimal forms
 * into a dotted quad; DNS answers are dotted quads too.
 */
function parseIpv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  const [a = 0, b = 0, c = 0, d = 0] = parts.map(Number);
  return ipv4(a, b, c, d);
}

/**
 * The eight 16-bit groups of a bare IPv6 address (no brackets, hex groups in
 * any case, at most one `::`, optionally a dotted IPv4 tail as in
 * `::ffff:10.0.0.1`), or null for anything else (zone ids included).
 */
function parseIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const embedded = parseIpv4(tail);
    if (embedded === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const hex = part.split(":");
    return hex.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? hex.map((group) => Number.parseInt(group, 16)) : null;
  };
  const left = groups(halves[0] ?? "");
  const right = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (left === null || right === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeros = 8 - left.length - right.length;
  return zeros >= 1 ? [...left, ...Array<number>(zeros).fill(0), ...right] : null;
}

/** The IPv4 address held in two 16-bit groups. */
function ipv4FromGroups(high: number, low: number): number {
  return ((high << 16) | low) >>> 0;
}

/**
 * Whether an IPv6 address may not be fetched. An allowlist: only global
 * unicast (2000::/3) passes, minus the IANA special-purpose blocks inside it:
 * the IETF protocol assignments 2001::/23 (Teredo 2001::/32, ORCHIDv2
 * 2001:20::/28 and the rest), documentation 2001:db8::/32 and 3fff::/20, and
 * 6to4 2002::/16, which is judged by the IPv4 address it embeds. Everything
 * outside 2000::/3 is blocked (unspecified, loopback, IPv4-compatible ::/96,
 * discard 100::/64, local-use NAT64 64:ff9b:1::/48, unique-local, link-local,
 * site-local, multicast, the SRv6 SID block 5f00::/16, unassigned space),
 * except the three forms that carry an IPv4 address and are judged by it:
 * IPv4-mapped ::ffff:a.b.c.d (::ffff:0:0/96), IPv4-translated
 * ::ffff:0:a.b.c.d (::ffff:0:0:0/96) and well-known NAT64 64:ff9b::/96.
 */
function isBlockedIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const first64Zero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  if (first64Zero && ((g4 === 0 && g5 === 0xffff) || (g4 === 0xffff && g5 === 0))) {
    return isBlockedIpv4(ipv4FromGroups(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(ipv4FromGroups(g6, g7));
  }
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2002) return isBlockedIpv4(ipv4FromGroups(g1, g2));
  // 2001::/23 leaves the second group's top seven bits zero.
  if (g0 === 0x2001 && (g1 < 0x0200 || g1 === 0x0db8)) return true;
  // 3fff::/20 leaves the second group's top four bits zero.
  return g0 === 0x3fff && g1 < 0x1000;
}

/** Whether a (WHATWG-normalised) hostname may not be monitored. */
function isBlockedHost(hostname: string): boolean {
  // The WHATWG parser serialises an IPv6 host in brackets (`[::1]`).
  const ipv6 = hostname.startsWith("[") && hostname.endsWith("]") ? parseIpv6(hostname.slice(1, -1)) : null;
  if (ipv6) return isBlockedIpv6(ipv6);

  // One trailing dot names the same host (fully qualified form).
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  const ipv4Address = parseIpv4(name);
  if (ipv4Address !== null) return isBlockedIpv4(ipv4Address);

  // A single label (`intranet`) resolves only through a local search domain.
  if (!name.includes(".")) return true;
  return BLOCKED_NAME_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/**
 * Whether a resolved IP address may not be fetched (second line of the SSRF
 * defence: the checker runs every DNS answer for a monitored host through it).
 * Takes a bare IPv4 dotted quad or a bare IPv6 address (no brackets, any case,
 * `::` compression, optionally a dotted IPv4 tail) and judges it with the same
 * ranges as {@link checkMonitorUrl}. Anything it cannot parse counts as
 * blocked (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  const ipv4Address = parseIpv4(ip);
  if (ipv4Address !== null) return isBlockedIpv4(ipv4Address);
  const ipv6 = parseIpv6(ip);
  return ipv6 === null || isBlockedIpv6(ipv6);
}

/**
 * Input check for a URL a user wants monitored (first line of the SSRF
 * defence): an absolute `http:` or `https:` URL without credentials, on the
 * default port, 80 or 443, at most {@link MONITOR_URL_MAX_LENGTH} characters
 * and free of whitespace and `<>"` (what `monitors.url` stores), whose host is
 * neither a private, loopback, link-local, CGNAT, multicast or reserved IPv4
 * address (in any notation the WHATWG parser accepts), nor an IPv6 address
 * outside global unicast or in one of its special-purpose blocks (IPv4-mapped,
 * IPv4-translated, NAT64 and 6to4 forms judged by their IPv4 address), nor a
 * single-label or local-network name (`localhost`, `*.local`, `*.internal`,
 * `metadata.google.internal`, ...).
 *
 * A public name can still resolve to a private address, so the checker must
 * re-check the resolved address when it fetches (the change-detection
 * engine); this only refuses what is visibly not a public website.
 *
 * @returns The URL as the WHATWG parser serialises it (what gets stored and
 * fetched), or why it was refused.
 */
export function checkMonitorUrl(raw: string): MonitorUrlCheck {
  if (raw.length > MONITOR_URL_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (raw === "" || FORBIDDEN_CHARACTERS.test(raw) || !URL.canParse(raw)) return { ok: false, reason: "invalid" };

  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  // Empty: the scheme's default port (the parser drops an explicit default).
  if (url.port !== "" && url.port !== "80" && url.port !== "443") return { ok: false, reason: "port" };
  if (isBlockedHost(url.hostname)) return { ok: false, reason: "blocked_host" };
  // Normalising can lengthen a URL (punycode, percent-encoding).
  if (url.href.length > MONITOR_URL_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, url: url.href };
}
