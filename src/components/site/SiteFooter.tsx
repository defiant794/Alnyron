import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import NavLink from "@/components/site/NavLink";
import { getPathname } from "@/i18n/navigation";
import { getSiteSettings } from "@/services/content/settings";

export interface SiteFooterProps {
  locale: Locale;
}

const LINK =
  "inline-flex min-h-11 items-center text-small text-muted transition-colors hover:text-fg active:text-fg";

/** The year in Copenhagen, so the copyright rolls over at local midnight. */
const yearFormat = new Intl.DateTimeFormat("da-DK", { year: "numeric", timeZone: "Europe/Copenhagen" });

/**
 * Minimal footer (approved mock): `© {year} {company}`, the contact email
 * and the privacy link, nothing else (no logo, no language switcher).
 * Company and email come from `site_settings`. The privacy link carries
 * `aria-current="page"` on the privacy page.
 */
export default async function SiteFooter({ locale }: SiteFooterProps) {
  const [{ companyName, contactEmail }, t] = await Promise.all([
    getSiteSettings(),
    getTranslations({ locale, namespace: "Nav" }),
  ]);

  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-content flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-8">
        <p className="text-small text-muted">
          © {yearFormat.format(new Date())} {companyName}
        </p>
        <ul className="flex flex-wrap items-center gap-x-4">
          <li>
            <a href={`mailto:${contactEmail}`} className={LINK}>
              {contactEmail}
            </a>
          </li>
          <li>
            <NavLink href={getPathname({ href: "/privacy", locale })} className={LINK}>
              {t("privacy")}
            </NavLink>
          </li>
        </ul>
      </div>
    </footer>
  );
}
