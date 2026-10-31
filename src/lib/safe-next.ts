/** Every accepted redirect target lives under this prefix. */
const ADMIN_PREFIX = "/admin/";

// Placeholder origin used only to let the URL parser resolve the path.
const PROBE_ORIGIN = "http://safe-next.invalid";

/**
 * Open-redirect guard for a `next` redirect target taken from a URL or form
 * (`/auth/confirm`, the sign-in action).
 *
 * Accepts only a same-origin path under `/admin/` and returns it in the
 * normalized form the browser would request; everything else returns `null`
 * so the caller falls back to its own default. The string check rejects
 * absolute URLs (`https://evil.com/admin/x`), protocol-relative (`//evil.com`)
 * and backslash (`\evil.com`) forms and look-alikes (`/adminx`, `/admin`);
 * the parse check rejects paths that only start with `/admin/` before dot
 * segments are resolved (`/admin/../`, `/admin/%2e%2e/`).
 */
export function safeNext(next: string | null | undefined): string | null {
  if (typeof next !== "string" || !next.startsWith(ADMIN_PREFIX)) return null;

  const url = new URL(next, PROBE_ORIGIN);
  if (url.origin !== PROBE_ORIGIN || !url.pathname.startsWith(ADMIN_PREFIX)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
