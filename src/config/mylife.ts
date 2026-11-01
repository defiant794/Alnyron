/**
 * MyLife login gateway: a route group outside `[locale]` (like the admin),
 * Danish only (`AUTH_LOCALE` in `config/auth-areas`), served at `/mylife/*` on
 * the main host and at the root of the MyLife host (the middleware rewrites
 * `mylife.alnyron.dk/login` to `/mylife/login`).
 */
export const MYLIFE_HOME_PATH = "/mylife";
export const MYLIFE_LOGIN_PATH = "/mylife/login";
export const MYLIFE_FORGOT_PASSWORD_PATH = "/mylife/forgot-password";
export const MYLIFE_SET_PASSWORD_PATH = "/mylife/set-password";
export const MYLIFE_NO_ACCESS_PATH = "/mylife/no-access";

/** The only MyLife routes the middleware serves without a session. */
export const MYLIFE_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  MYLIFE_LOGIN_PATH,
  MYLIFE_FORGOT_PASSWORD_PATH,
]);

/**
 * The MyLife hostnames and the scheme each is served over: production behind
 * Cloudflare (HTTPS) and the local dev/e2e host (HTTP). Nothing else is a
 * MyLife host.
 */
const MYLIFE_HOST_SCHEMES: Readonly<Record<string, "http" | "https">> = {
  "mylife.alnyron.dk": "https",
  "mylife.localhost": "http",
};

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
 * Origin of the MyLife host named by a `Host` header value (case-insensitive,
 * any port, with or without the trailing FQDN dot), or `null` when it is not
 * a MyLife host. The origin is built from the allowlist above, never echoed
 * from the header: the scheme comes from the allowlist, a default port is
 * dropped and so is a trailing dot (`mylife.alnyron.dk:443` and
 * `mylife.alnyron.dk.` -> `https://mylife.alnyron.dk`, `mylife.localhost:3000`
 * -> `http://mylife.localhost:3000`). Those two origins are exactly the
 * `.RedirectTo` values the DA email templates pin their MyLife link to
 * (`supabase/templates/*.html`); any other port gets the Site URL link.
 */
export function myLifeOrigin(host: string | null): string | null {
  const match = host === null ? null : HOST_PATTERN.exec(host.toLowerCase());
  if (!match) return null;
  const [, hostname = "", port] = match;
  const scheme = Object.hasOwn(MYLIFE_HOST_SCHEMES, hostname) ? MYLIFE_HOST_SCHEMES[hostname] : undefined;
  if (!scheme) return null;
  return port && port !== DEFAULT_PORTS[scheme]
    ? `${scheme}://${hostname}:${port}`
    : `${scheme}://${hostname}`;
}

/**
 * Whether a `Host` header value names the MyLife host (`mylife.alnyron.dk`,
 * `mylife.localhost`, any port, with or without the trailing FQDN dot).
 */
export function isMyLifeHost(host: string | null): boolean {
  return myLifeOrigin(host) !== null;
}
