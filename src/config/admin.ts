import type { CatalogKind } from "@/config/catalog";

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
export const ADMIN_CATALOG_PATH = "/admin/catalog";

/** Sidebar shortcut to a kind's section editor (`catalog/[kind]` redirects to its category). */
export function adminCatalogKindPath(kind: CatalogKind): string {
  return `${ADMIN_CATALOG_PATH}/${kind}`;
}

/** Section editor of one category. */
export function adminCategoryPath(categoryId: string): string {
  return `${ADMIN_CATALOG_PATH}/categories/${categoryId}`;
}

/** Editor of one saved item. */
export function adminItemPath(itemId: string): string {
  return `${ADMIN_CATALOG_PATH}/items/${itemId}`;
}

/** Editor for a new item in `categoryId`. */
export function adminNewItemPath(categoryId: string): string {
  return `${ADMIN_CATALOG_PATH}/items/new?category=${encodeURIComponent(categoryId)}`;
}

/** The only admin routes the middleware serves without a session. */
export const ADMIN_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  ADMIN_LOGIN_PATH,
  ADMIN_FORGOT_PASSWORD_PATH,
]);
