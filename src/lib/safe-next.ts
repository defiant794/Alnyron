import { AREA_CONFIG, AUTH_AREAS, type AuthArea } from "@/config/auth-areas";

// Placeholder origin used only to let the URL parser resolve the path.
const PROBE_ORIGIN = "http://safe-next.invalid";

/** The area a pathname belongs to (`/admin`, `/admin/...`, `/mylife`, `/mylife/...`), if any. */
export function areaOfPath(pathname: string): AuthArea | null {
  return (
    AUTH_AREAS.find((area) => {
      const { home } = AREA_CONFIG[area];
      return pathname === home || pathname.startsWith(`${home}/`);
    }) ?? null
  );
}

/**
 * Open-redirect guard for a `next` redirect target taken from a URL or a form
 * field (`/auth/confirm`, the sign-in actions, the middleware login redirect).
 *
 * Accepts only a same-origin path under `/admin/` or `/mylife/` and returns
 * it in the normalized form the browser would request; everything else
 * (including a file upload in place of the field) returns `null` so the
 * caller falls back to its own default. With `area`, only that area's prefix
 * is accepted (a sign-in form never sends the user into the other area);
 * without it, both are (`/auth/confirm`, which serves both areas' email
 * links). The string check rejects absolute URLs (`https://evil.com/admin/x`),
 * protocol-relative (`//evil.com`) and backslash (`\evil.com`) forms and
 * look-alikes (`/adminx`, `/mylife`); the parse check rejects paths that only
 * start with an accepted prefix before dot segments are resolved
 * (`/admin/../`, `/mylife/%2e%2e/admin/x`).
 */
export function safeNext(
  next: FormDataEntryValue | null | undefined,
  area?: AuthArea,
): string | null {
  if (typeof next !== "string") return null;
  const areas: readonly AuthArea[] = area ? [area] : AUTH_AREAS;
  const prefix = areas
    .map((candidate) => `${AREA_CONFIG[candidate].home}/`)
    .find((candidate) => next.startsWith(candidate));
  if (!prefix) return null;

  const url = new URL(next, PROBE_ORIGIN);
  if (url.origin !== PROBE_ORIGIN || !url.pathname.startsWith(prefix)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
