import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import NavLink from "@/components/site/NavLink";
import { getPathname } from "@/i18n/navigation";
import { getSiteSettings } from "@/services/content/settings";

export interface SiteFooterProps {
  locale: Locale;
  /**
   * The main site's origin, given where the footer is rendered on another
   * host (Monitor): the privacy link is then absolute, as a path would
   * resolve against that host. Without it the link is a path.
   */
  siteOrigin?: string;
}

const LINK =
  "inline-flex min-h-11 items-center text-small text-muted transition-colors hover:text-fg active:text-fg";

/** The year in Copenhagen, so the copyright rolls over at local midnight. */
const yearFormat = new Intl.DateTimeFormat("da-DK", { year: "numeric", timeZone: "Europe/Copenhagen" });

/**
 * Minimal footer (approved mock): `© {year} {company} · CVR {cvr}`, the
 * contact email and the privacy link, nothing else (no logo, no language
 * switcher). Company, CVR and email come from `site_settings`; the CVR part
 * is left out while `site_settings.cvr` is not set. The middot is hidden
 * from assistive technology and a visually hidden comma takes its place, so
 * screen readers pause between company and CVR. The privacy link carries
 * `aria-current="page"` on the privacy page.
 */
export default async function SiteFooter({ locale, siteOrigin }: SiteFooterProps) {
  const [{ companyName, contactEmail, cvr }, t, tNav] = await Promise.all([
    getSiteSettings(),
    getTranslations({ locale, namespace: "Footer" }),
    getTranslations({ locale, namespace: "Nav" }),
  ]);
  const privacyPath = getPathname({ href: "/privacy", locale });

  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-content flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-8">
        <p className="text-small text-muted">
          © {yearFormat.format(new Date())} {companyName}
          {cvr !== null && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
              <span className="whitespace-nowrap">{t("cvr", { cvr })}</span>
            </>
          )}
        </p>
        <ul className="flex flex-wrap items-center gap-x-4">
          <li>
            <a href={`mailto:${contactEmail}`} className={LINK}>
              {contactEmail}
            </a>
          </li>
          <li>
            <NavLink href={siteOrigin ? new URL(privacyPath, siteOrigin).href : privacyPath} className={LINK}>
              {tNav("privacy")}
            </NavLink>
          </li>
        </ul>
      </div>
    </footer>
  );
}
