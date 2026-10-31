import type { Locale } from "next-intl";

/**
 * Admin and auth routes live outside `[locale]` (architecture §2); the admin UI
 * is Danish only.
 */
export const ADMIN_LOCALE: Locale = "da";

export const ADMIN_HOME_PATH = "/admin";
export const ADMIN_LOGIN_PATH = "/admin/login";
export const ADMIN_FORGOT_PASSWORD_PATH = "/admin/forgot-password";
export const ADMIN_NO_ACCESS_PATH = "/admin/no-access";

/** The only admin routes the middleware serves without a session. */
export const ADMIN_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  ADMIN_LOGIN_PATH,
  ADMIN_FORGOT_PASSWORD_PATH,
]);

/** Values of the `error` query param `/admin/login` shows a message for. */
export const LOGIN_ERROR_LINK_INVALID = "link_invalid";
