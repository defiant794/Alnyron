import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import MonitorBrand from "@/components/monitor/MonitorBrand";
import MonitorLocaleSwitcher from "@/components/monitor/MonitorLocaleSwitcher";
import MonitorMainNav from "@/components/monitor/MonitorMainNav";
import SiteFooter from "@/components/site/SiteFooter";
import SiteMenu from "@/components/site/SiteMenu";
import Button from "@/components/ui/Button";
import Link from "@/components/ui/Link";
import LinkButton from "@/components/ui/LinkButton";
import {
  MONITOR_FREE_LIMIT,
  MONITOR_HOME_PATH,
  MONITOR_LOGIN_PATH,
  MONITOR_NEW_PATH,
  MONITOR_ROBOTS,
  MONITOR_SIGNUP_PATH,
  MONITOR_URL_MAX_LENGTH,
  monitorSiteOrigin,
} from "@/config/monitor";
import { siteHomeUrl, siteOrigin } from "@/config/site-origin";
import { getMonitorLocale } from "@/i18n/monitor-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getMonitorLocale(), namespace: "Monitor.landing" });
  return { title: t("metaTitle"), robots: MONITOR_ROBOTS };
}

const STEPS = ["add", "watch", "mail"] as const;

/** Where the landing page is served: the Monitor host's root (the main host redirects `/monitor` there). */
const LANDING_PATH = "/";

/**
 * `/monitor` (the Monitor host's `/`): the public landing page (approved
 * landing mock), framed like the main site: the ALNYRON lockup in the header
 * links to the main site's frontpage in the page's language and the site
 * footer closes the page, both with the main site's absolute URL
 * (`siteHomeUrl`, `siteOrigin`, from `NEXT_PUBLIC_SITE_URL`): on the Monitor
 * host a path would stay there.
 * The two-row header mirrors `MonitorShell`: the first row offers the
 * admin-controlled main-site nav and `DA | EN` switcher inside `SiteMenu`,
 * collapsed below 768px. "Log ind" and "Opret gratis" stay visible in their
 * own right-aligned row below it. The page follows the visitor's Monitor
 * language. The hero states the promise and free cap
 * (`MONITOR_FREE_LIMIT`, the database default) and takes a URL straight away:
 * it opens the add form with the URL
 * filled in (signed-out visitors pass the login page first, which keeps it
 * and links to signup). Three steps explain how it works.
 */
export default async function MonitorLandingPage() {
  const locale = await getMonitorLocale();
  const [t, tNav] = await Promise.all([
    getTranslations({ locale, namespace: "Monitor" }),
    getTranslations({ locale, namespace: "Nav" }),
  ]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="relative z-10 mx-auto flex w-full max-w-content flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-3">
          <MonitorBrand href={siteHomeUrl(locale)} />
          <SiteMenu toggleLabel={tNav("menu")}>
            <MonitorMainNav locale={locale} currentHref={new URL(LANDING_PATH, monitorSiteOrigin(siteOrigin())).href} />
            <MonitorLocaleSwitcher locale={locale} currentPath={MONITOR_HOME_PATH} />
          </SiteMenu>
        </div>
        <div className="border-t border-border">
          <div className="mx-auto flex w-full max-w-content items-center justify-end px-6 py-2">
            <nav aria-label={t("shell.navLabel")} className="flex items-center gap-4">
              <Link href={MONITOR_LOGIN_PATH} className="inline-flex min-h-11 items-center whitespace-nowrap">
                {t("landing.ctaLogin")}
              </Link>
              <LinkButton href={MONITOR_SIGNUP_PATH} className="whitespace-nowrap">{t("landing.ctaSignup")}</LinkButton>
            </nav>
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="flex flex-1 flex-col focus:outline-none">
        <section className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-6 pt-16 pb-12 text-center sm:pt-24">
          <h1 className="text-h1 font-bold tracking-tight sm:text-display">{t("landing.title")}</h1>
          <p className="max-w-prose text-body text-muted sm:text-h3">
            {t("landing.lead", { limit: MONITOR_FREE_LIMIT })}
          </p>
          <form
            action={MONITOR_NEW_PATH}
            method="get"
            className="flex w-full max-w-xl flex-col gap-3 sm:flex-row"
          >
            <label htmlFor="monitor-capture-url" className="sr-only">
              {t("landing.captureLabel")}
            </label>
            <input
              id="monitor-capture-url"
              name="url"
              required
              type="text"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={MONITOR_URL_MAX_LENGTH}
              placeholder={t("landing.capturePlaceholder")}
              className="min-h-12 w-full flex-1 rounded-input border border-border-input bg-bg px-3 py-control-y text-body text-fg transition-[border-color] placeholder:text-muted hover:border-muted focus:border-accent"
            />
            <Button type="submit">{t("landing.captureSubmit")}</Button>
          </form>
        </section>

        <section className="mx-auto flex w-full max-w-content flex-col gap-12 px-6 pb-16">
          <h2 className="sr-only">{t("landing.stepsTitle")}</h2>
          <ol className="grid gap-6 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step} className="flex flex-col gap-3 rounded-card border border-border bg-surface p-6">
                <span
                  aria-hidden="true"
                  className="flex size-8 items-center justify-center rounded-pill bg-accent text-small font-semibold text-accent-ink"
                >
                  {index + 1}
                </span>
                <h3 className="text-h3 font-semibold">{t(`landing.steps.${step}.title`)}</h3>
                <p className="text-small text-muted">{t(`landing.steps.${step}.body`)}</p>
              </li>
            ))}
          </ol>
          <p className="text-center text-small text-muted">{t("landing.note")}</p>
        </section>
      </main>

      <SiteFooter locale={locale} siteOrigin={siteOrigin()} />
    </div>
  );
}
