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

/** A dotted-quad hostname as a 32-bit number (the WHATWG parser already turned hex, octal and decimal forms into it). */
function parseIpv4(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const [a = 0, b = 0, c = 0, d = 0] = parts.map(Number);
  return ipv4(a, b, c, d);
}

/**
 * The eight 16-bit groups of a bracketed IPv6 hostname as the WHATWG URL
 * parser serialises it (lower-case hex groups, at most one `::`, no dotted
 * IPv4 tail), or null for anything else.
 */
function parseIpv6(hostname: string): number[] | null {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
  const [head = "", tail, ...rest] = hostname.slice(1, -1).split("::");
  if (rest.length > 0) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16)));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
  const all = [...left, ...Array<number>(zeros).fill(0), ...right];
  return all.length === 8 && all.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? all
    : null;
}

/** The IPv4 address held in two 16-bit groups. */
function ipv4FromGroups(high: number, low: number): number {
  return ((high << 16) | low) >>> 0;
}

/**
 * Whether an IPv6 address is not public unicast: unspecified, loopback,
 * unique-local (fc00::/7), link-local (fe80::/10), deprecated site-local
 * (fec0::/10), multicast (ff00::/8), documentation (2001:db8::/32), the
 * discard prefix (100::/64) and local-use NAT64 (64:ff9b:1::/48). Forms that
 * carry an IPv4 address (IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96,
 * NAT64 64:ff9b::/96, 6to4 2002::/16) are judged by that IPv4 address.
 */
function isBlockedIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  if (firstFiveZero && g5 === 0) {
    // ::, ::1 and the IPv4-compatible ::a.b.c.d.
    return g6 === 0 || isBlockedIpv4(ipv4FromGroups(g6, g7));
  }
  if (firstFiveZero && g5 === 0xffff) return isBlockedIpv4(ipv4FromGroups(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(ipv4FromGroups(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  if (g0 === 0x2002) return isBlockedIpv4(ipv4FromGroups(g1, g2));
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  return g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0;
}

/** Whether a (WHATWG-normalised) hostname may not be monitored. */
function isBlockedHost(hostname: string): boolean {
  const ipv6 = parseIpv6(hostname);
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
 * Input check for a URL a user wants monitored (first line of the SSRF
 * defence): an absolute `http:` or `https:` URL without credentials, on the
 * default port, 80 or 443, at most {@link MONITOR_URL_MAX_LENGTH} characters
 * and free of whitespace and `<>"` (what `monitors.url` stores), whose host is
 * neither a private, loopback, link-local, CGNAT, multicast or reserved IP
 * address (IPv4 in any notation the WHATWG parser accepts, IPv6 including
 * IPv4-mapped and NAT64 forms) nor a single-label or local-network name
 * (`localhost`, `*.local`, `*.internal`, `metadata.google.internal`, ...).
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
