import { allowlistedOrigin, type HostSchemes } from "@/lib/host-origin";

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
const MYLIFE_HOST_SCHEMES: HostSchemes = {
  "mylife.alnyron.dk": "https",
  "mylife.localhost": "http",
};

/**
 * Origin of the MyLife host named by a `Host` header value (case-insensitive,
 * any port, with or without the trailing FQDN dot), or `null` when it is not
 * a MyLife host. The origin is built from the allowlist above, never echoed
 * from the header (`allowlistedOrigin`): `mylife.alnyron.dk:443` and
 * `mylife.alnyron.dk.` -> `https://mylife.alnyron.dk`, `mylife.localhost:3000`
 * -> `http://mylife.localhost:3000`. Those two origins are exactly the
 * `.RedirectTo` values the DA email templates pin their MyLife link to
 * (`supabase/templates/*.html`); any other port gets the Site URL link.
 */
export function myLifeOrigin(host: string | null): string | null {
  return allowlistedOrigin(host, MYLIFE_HOST_SCHEMES);
}

/**
 * Whether a `Host` header value names the MyLife host (`mylife.alnyron.dk`,
 * `mylife.localhost`, any port, with or without the trailing FQDN dot).
 */
export function isMyLifeHost(host: string | null): boolean {
  return myLifeOrigin(host) !== null;
}
