import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import MonitorBrand from "@/components/monitor/MonitorBrand";
import SiteFooter from "@/components/site/SiteFooter";
import Button from "@/components/ui/Button";
import Link from "@/components/ui/Link";
import LinkButton from "@/components/ui/LinkButton";
import { AUTH_LOCALE } from "@/config/auth-areas";
import {
  MONITOR_FREE_LIMIT,
  MONITOR_LOGIN_PATH,
  MONITOR_NEW_PATH,
  MONITOR_ROBOTS,
  MONITOR_SIGNUP_PATH,
  MONITOR_SITE_HOME_HREF,
  MONITOR_URL_MAX_LENGTH,
} from "@/config/monitor";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Monitor.landing" });
  return { title: t("metaTitle"), robots: MONITOR_ROBOTS };
}

const STEPS = ["add", "watch", "mail"] as const;

/**
 * `/monitor`: the public landing page (approved landing mock), framed like
 * the main site: the ALNYRON lockup in the header links to the frontpage
 * (`MONITOR_SITE_HOME_HREF`), and the site footer (Danish) closes the page.
 * The header offers "Log ind" and "Opret gratis"; the hero states the
 * promise and the free cap (`MONITOR_FREE_LIMIT`, the database default) and
 * takes a URL straight away: it opens the add form with the URL filled in
 * (signed-out visitors pass the login page first, which keeps it and links
 * to signup). Three steps explain how it works.
 */
export default async function MonitorLandingPage() {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Monitor" });

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-content flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-4">
        <MonitorBrand href={MONITOR_SITE_HOME_HREF} />
        <nav aria-label={t("shell.navLabel")} className="flex items-center gap-4">
          <Link href={MONITOR_LOGIN_PATH} className="inline-flex min-h-11 items-center">
            {t("landing.ctaLogin")}
          </Link>
          <LinkButton href={MONITOR_SIGNUP_PATH}>{t("landing.ctaSignup")}</LinkButton>
        </nav>
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

      <SiteFooter locale={AUTH_LOCALE} />
    </div>
  );
}
