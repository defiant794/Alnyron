/**
 * App hosts named by a `Host` header (the MyLife host in `config/mylife.ts`,
 * the Monitor host in `config/monitor.ts`), parsed one way for every area.
 */

/** Allowlisted hostnames and the scheme each is served over. Nothing else is accepted. */
export type HostSchemes = Readonly<Record<string, "http" | "https">>;

const DEFAULT_PORTS = { http: "80", https: "443" } as const;

/**
 * `hostname[:port]`, as in a `Host` header. The hostname may end in the one
 * trailing dot of a fully qualified name (`mylife.alnyron.dk.`), which DNS
 * and the browser treat as the same host; the dot stays outside the captured
 * hostname, so the allowlist lookup sees `mylife.alnyron.dk`. A second dot
 * (`mylife.alnyron.dk..`) does not match.
 */
const HOST_PATTERN = /^([a-z0-9.-]*[a-z0-9-])\.?(?::(\d+))?$/;

/**
 * Origin of the host named by a `Host` header value (case-insensitive, any
 * port, with or without the trailing FQDN dot) when its hostname is in
 * `schemes`, or `null` otherwise. The origin is built from the allowlist,
 * never echoed from the header: the scheme comes from `schemes`, a default
 * port is dropped and so is a trailing dot (`mylife.alnyron.dk:443` and
 * `mylife.alnyron.dk.` -> `https://mylife.alnyron.dk`,
 * `mylife.localhost:3000` -> `http://mylife.localhost:3000`). Look-alikes
 * (`evil.mylife.alnyron.dk`, `mylife.alnyron.dk.evil.com`,
 * `mylife.alnyron.dk@evil.com`) are not in the allowlist or fail the pattern.
 */
export function allowlistedOrigin(host: string | null, schemes: HostSchemes): string | null {
  const match = host === null ? null : HOST_PATTERN.exec(host.toLowerCase());
  if (!match) return null;
  const [, hostname = "", port] = match;
  const scheme = Object.hasOwn(schemes, hostname) ? schemes[hostname] : undefined;
  if (!scheme) return null;
  return port && port !== DEFAULT_PORTS[scheme]
    ? `${scheme}://${hostname}:${port}`
    : `${scheme}://${hostname}`;
}
