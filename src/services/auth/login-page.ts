import type { Metadata } from "next";
import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { AUTH_LOCALE, LOGIN_ERROR_LINK_INVALID } from "@/config/auth-areas";

/** Query of the admin, MyLife and Monitor login pages. */
export type LoginSearchParams = { next?: string | string[]; error?: string | string[] };

/**
 * Whether a login page explains the error it was sent with. Only
 * `error=link_invalid` (set by `/auth/confirm` for a dead invite or reset
 * link) is known; any other value is ignored.
 */
export function showsLinkInvalid({ error }: LoginSearchParams): boolean {
  return error === LOGIN_ERROR_LINK_INVALID;
}

/**
 * Metadata of the login pages: "Log ind", or "Fejl: Log ind" while the page
 * shows the invalid-link message, so the title (read first on arrival) says
 * something went wrong. Danish (admin, MyLife) unless Monitor passes its
 * visitor's `locale`.
 */
export async function loginMetadata(searchParams: LoginSearchParams, locale: Locale = AUTH_LOCALE): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: "Auth.login" });
  const title = t("title");
  return { title: showsLinkInvalid(searchParams) ? t("errorTitle", { title }) : title };
}
