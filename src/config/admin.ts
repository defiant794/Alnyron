/**
 * Admin and auth routes live outside `[locale]` (architecture §2); the admin UI
 * is Danish only (`AUTH_LOCALE` in `config/auth-areas`, which also holds the
 * per-area table built from these paths).
 */
export const ADMIN_HOME_PATH = "/admin";
export const ADMIN_LOGIN_PATH = "/admin/login";
export const ADMIN_FORGOT_PASSWORD_PATH = "/admin/forgot-password";
export const ADMIN_SET_PASSWORD_PATH = "/admin/set-password";
export const ADMIN_NO_ACCESS_PATH = "/admin/no-access";
export const ADMIN_PAGES_PATH = "/admin/pages";

/** The only admin routes the middleware serves without a session. */
export const ADMIN_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  ADMIN_LOGIN_PATH,
  ADMIN_FORGOT_PASSWORD_PATH,
]);
